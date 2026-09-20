//! DeepSeek 调用层。
//!
//! 这里的 prompt 布局和参数是 `scripts/probe-deepseek.ps1` 实测验证过的，改动前先看
//! docs/PRD.md §9：
//!   - `thinking` 必须显式 disabled（默认是开启且 effort=high，实测慢 1.9x）
//!   - 固定 preamble + 卡包范围声明放在最前面且逐字不变，才能命中前缀缓存（1/50 价格）
//!   - JSON 模式要求 prompt 里出现 "json" 字样并给出格式示例
//!
//! 超时与中断也归这里管（都在 `select!` 里，见 `define` / `ping`），
//! 不要把它们挪回 `reqwest::Client` 的构造参数里 —— 那样设置页那个数字就不生效了。

use crate::error::{AppError, AppResult};
use crate::models::LlmDefinition;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// 改动这个值会让所有本地释义缓存失效，必须与 prompt 内容同步 bump。
pub const PROMPT_VERSION: &str = "v1";

/// 超时预算的默认值与上下界（秒）。用户能在设置页改。
///
/// **这是整次查词的总预算**（含重试），不是每个 HTTP 请求一份 —— 否则"重试一次"就让用户
/// 等两份时间，设置页那个数字也就没法解释成"最多等多久"。
pub const DEFAULT_TIMEOUT_SECS: u64 = 45;
pub const MIN_TIMEOUT_SECS: u64 = 5;
pub const MAX_TIMEOUT_SECS: u64 = 300;

/// 连上服务器和"连上了但一直不回"是两回事，所以连接超时单独给一个值。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次用户操作最多发几次请求。空 content / 解析失败 / 传输层出错都算"值得再试一次"。
const MAX_ATTEMPTS: u32 = 2;

/// 超时是用户填的数字，可能是负数，也可能是 9999999。落库前和用之前都过一遍这里。
pub fn clamp_timeout_secs(raw: i64) -> u64 {
    raw.clamp(MIN_TIMEOUT_SECS as i64, MAX_TIMEOUT_SECS as i64) as u64
}

/// 一次请求的取消句柄。
///
/// 真正的"停止"发生在 `select!` 里：命中取消时，那个 `send()` / `text()` 的 future 直接被丢掉，
/// reqwest 随之关掉连接。**服务端可能还在算**，但我们不再等、不再收 —— 这就是点「停止」
/// 能立刻回到可输入状态的原因。
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // 用 notify_one 而不是 notify_waiters：前者会把许可存下来，
        // 于是"取消发生在 cancelled() 注册之前"也不会丢唤醒（notify_waiters 会丢）。
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

pub const SYSTEM_PREAMBLE: &str = r#"你是一位面向中文程序员的技术英语释义助手。读者是中文母语、英语约 CEFR A2-B1 的开发者，正在阅读英文技术资料（GitHub、X、技术博客、源码注释）。

任务：给定一个英文词或短语，以及读者在哪个技术领域遇到它，判断它在该领域、该句子中的准确含义。

要求：
1. 必须区分"通用义"与"领域义"。当通用义会误导读者时，在 why_translation_fails 中明确指出误导点；若不构成误导，该字段留空字符串。
2. 所有释义用中文，例句保留英文原文。
3. 只输出 json，不要任何解释性文字，不要 markdown 代码块围栏。
4. 若该词在该领域不常见、或你不确定，把 confidence 设为 "low"，不要编造。
5. examples 与 collocations 每个最多 3 条。

输出 json 格式示例：
{
  "lemma": "handler",
  "pos": "n.",
  "domain_meaning": "处理请求或事件的代码单元，即被调用去响应某个输入的函数或对象",
  "general_meaning": "把手；动词义为「处理、应付」",
  "why_translation_fails": "通用词典给出「把手」，但此处 handler 指一个可被调用的实体，不是实物",
  "in_context": "在这句话里，handler 指处理该请求的那个函数",
  "examples": ["the request handler returns a promise"],
  "collocations": ["request handler", "error handler"],
  "confidence": "high"
}"#;

#[derive(Clone, Debug)]
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// 整次查词的总预算，来自设置页（见 `clamp_timeout_secs`）。
    pub timeout: Duration,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LlmUsage {
    pub cache_hit_tokens: i64,
    pub cache_miss_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug)]
pub struct LlmOutcome {
    pub definition: LlmDefinition,
    pub usage: LlmUsage,
    pub elapsed_ms: u64,
    pub attempts: u32,
}

pub fn build_body(term: &str, sentence: Option<&str>, keywords: &[String], model: &str) -> Value {
    let deck_scope = format!(
        "当前领域范围关键词：{}\n读者正在这个技术范围内阅读，请按该范围解释下面的内容。",
        keywords.join(", ")
    );
    let user_prompt = format!(
        "term: {}\nsentence: {}\n\n请输出 json。",
        term,
        sentence.filter(|s| !s.trim().is_empty()).unwrap_or("(无上下文，仅给出该词)")
    );

    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PREAMBLE },
            { "role": "system", "content": deck_scope },
            { "role": "user", "content": user_prompt }
        ],
        "thinking": { "type": "disabled" },
        "temperature": 0.3,
        "max_tokens": 1200,
        "response_format": { "type": "json_object" },
        "stream": false
    })
}

/// 模型有时仍会套一层 markdown 围栏，剥掉再解析。
fn strip_fences(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

pub fn cache_key(norm_term: &str, deck_id: i64, keywords: &[String], sentence: Option<&str>) -> String {
    // 只做去重键，不需要密码学强度。
    let mut ctx = String::from(sentence.unwrap_or(""));
    ctx.truncate(ctx.len().min(200));
    format!(
        "{PROMPT_VERSION}|{norm_term}|{deck_id}|{}|{ctx}",
        keywords.join(",")
    )
}

pub async fn define(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    term: &str,
    sentence: Option<&str>,
    keywords: &[String],
    cancel: &Cancel,
) -> AppResult<LlmOutcome> {
    let budget = cfg.timeout;
    // 两道闸都在这里：手动停止，和"等太久了自动放弃"。数量级不同（前者毫秒、后者几十秒），
    // 但对调用方是同一个结果 —— 不再等下去。
    tokio::select! {
        // biased：请求已经取消就不该再去碰网络。
        biased;
        _ = cancel.cancelled() => Err(AppError::Cancelled),
        r = tokio::time::timeout(budget, define_inner(client, cfg, term, sentence, keywords)) => {
            match r {
                Ok(outcome) => outcome,
                Err(_) => Err(AppError::Timeout(budget.as_secs())),
            }
        }
    }
}

async fn define_inner(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    term: &str,
    sentence: Option<&str>,
    keywords: &[String],
) -> AppResult<LlmOutcome> {
    let body = build_body(term, sentence, keywords, &cfg.model);
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let mut last_err = AppError::Other(format!("第 0/{MAX_ATTEMPTS} 次尝试：没有发起请求"));

    // 文档说明 JSON 模式偶发返回空 content，所以必须重试；传输层错误同样要重试 ——
    // 用户报的 `error decoding response body`（响应被代理截断）就属于这一类。
    for attempt in 1..=MAX_ATTEMPTS {
        let (status, text) = match send_attempt(client, cfg, &url, &body).await {
            Ok(v) => v,
            Err(e) => {
                last_err = transport_error(&e, attempt);
                continue;
            }
        };

        // HTTP 层面失败（401 / 429 / 5xx）不重试：再试一次也不会让 key 变对。
        if !status.is_success() {
            return Err(AppError::Config(format!(
                "DeepSeek 返回 HTTP {}：{}",
                status.as_u16(),
                truncate(&text, 300)
            )));
        }

        let payload: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                last_err = parse_error(attempt, format!("响应不是合法 JSON：{e}"));
                continue;
            }
        };

        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        if content.trim().is_empty() {
            last_err = parse_error(attempt, "返回空 content".to_string());
            continue;
        }

        match serde_json::from_str::<LlmDefinition>(&strip_fences(&content)) {
            Ok(def) if !def.domain_meaning.trim().is_empty() => {
                let usage = LlmUsage {
                    cache_hit_tokens: payload["usage"]["prompt_cache_hit_tokens"].as_i64().unwrap_or(0),
                    cache_miss_tokens: payload["usage"]["prompt_cache_miss_tokens"].as_i64().unwrap_or(0),
                    completion_tokens: payload["usage"]["completion_tokens"].as_i64().unwrap_or(0),
                };
                return Ok(LlmOutcome {
                    definition: def,
                    usage,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    attempts: attempt,
                });
            }
            Ok(_) => last_err = parse_error(attempt, "domain_meaning 为空".to_string()),
            Err(e) => last_err = parse_error(attempt, format!("释义解析失败：{e}")),
        }
    }

    Err(last_err)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PingOutcome {
    /// 模型回的话（正常是 pong）。空字符串也能说明是通的，界面自行处理。
    pub reply: String,
    /// **响应里回报的**模型名，不是我们传进去的那个 —— 传错模型名时这里会露马脚。
    pub model: String,
    pub elapsed_ms: u64,
}

/// 连通性测试的请求体。
///
/// 故意不用 JSON 模式、也不带那两段固定前言：这一条要验的是"这个 key + 这个地址 + 这个模型名
/// 现在通不通"，不是释义质量。顺带也**不去污染前缀缓存** —— 混进一个别的前缀只会把命中率冲散。
pub fn build_ping_body(model: &str) -> Value {
    json!({
        "model": model,
        "messages": [
            { "role": "user", "content": "连通性测试。只回复 pong，不要别的字。" }
        ],
        "thinking": { "type": "disabled" },
        "temperature": 0.0,
        "max_tokens": 16,
        "stream": false
    })
}

/// 设置页「测试连接」用的最小请求：发一次，报回耗时、真实模型名和回复。
pub async fn ping(client: &reqwest::Client, cfg: &LlmConfig, cancel: &Cancel) -> AppResult<PingOutcome> {
    let budget = cfg.timeout;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(AppError::Cancelled),
        r = tokio::time::timeout(budget, ping_inner(client, cfg)) => match r {
            Ok(v) => v,
            Err(_) => Err(AppError::Timeout(budget.as_secs())),
        }
    }
}

async fn ping_inner(client: &reqwest::Client, cfg: &LlmConfig) -> AppResult<PingOutcome> {
    let body = build_ping_body(&cfg.model);
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let mut last_err = AppError::Other(format!("第 0/{MAX_ATTEMPTS} 次尝试：没有发起请求"));

    // 和 define 一样：一次用户操作最多发 MAX_ATTEMPTS 次。
    for attempt in 1..=MAX_ATTEMPTS {
        let (status, text) = match send_attempt(client, cfg, &url, &body).await {
            Ok(v) => v,
            Err(e) => {
                last_err = transport_error(&e, attempt);
                continue;
            }
        };

        if !status.is_success() {
            return Err(AppError::Other(format!(
                "接口返回 HTTP {}：{}",
                status.as_u16(),
                truncate(&text, 300)
            )));
        }

        let payload: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Parse(format!("响应不是合法 JSON：{e}")))?;
        return Ok(PingOutcome {
            reply: payload["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string(),
            model: payload["model"].as_str().unwrap_or(&cfg.model).to_string(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    Err(last_err)
}

/// 一次 HTTP 往返：发出请求，并把响应体读完。
///
/// 超时和取消不在这里管 —— 它们由 `define` / `ping` 的 `select!` 统一负责，
/// 这样"超时"才等于整次查词的预算，而不是每个请求各一份。
async fn send_attempt(
    client: &reqwest::Client,
    cfg: &LlmConfig,
    url: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, String), reqwest::Error> {
    let resp = client
        .post(url)
        .bearer_auth(&cfg.api_key)
        .json(body)
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await?;
    Ok((status, text))
}

/// 传输层错误的分类。中文说清"能做什么"，英文原文缀在后面给排障用。
fn transport_detail(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "连接或读取超时"
    } else if e.is_connect() {
        "连不上服务器（检查 Base URL、网络或代理）"
    } else if e.is_decode() || e.is_body() {
        "响应被中途截断或解码失败（常见于代理改写了响应）"
    } else {
        "网络错误"
    }
}

/// 失败信息统一带"第几次"：只写一句"响应被截断"会让人以为只发了一次请求，
/// 而重试是这一层的行为，用户有权知道。
fn transport_error(e: &reqwest::Error, attempt: u32) -> AppError {
    AppError::Other(format!(
        "第 {attempt}/{MAX_ATTEMPTS} 次尝试：{} —— {e}",
        transport_detail(e)
    ))
}

fn parse_error(attempt: u32, detail: String) -> AppError {
    AppError::Parse(format!("第 {attempt}/{MAX_ATTEMPTS} 次尝试：{detail}"))
}

/// 注意：**不要**在这里设总超时（`ClientBuilder::timeout`）。
///
/// 超时的唯一来源是 `LlmConfig.timeout`（设置页可改，见 `define` / `ping` 的 `select!`）。
/// 这里再设一个，就成了"设置页改了也不生效"的隐形天花板 —— 45 秒那条老 bug 就是这么来的。
pub fn default_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_disables_thinking() {
        let body = build_body("handle", Some("returns a handle"), &["rust".into()], "deepseek-flash");
        assert_eq!(body["thinking"]["type"], "disabled", "thinking 默认开启会慢 1.9x，必须关");
    }

    #[test]
    fn body_asks_for_json_and_says_the_word_json() {
        let body = build_body("handle", None, &[], "deepseek-flash");
        assert_eq!(body["response_format"]["type"], "json_object");
        let sys = body["messages"][0]["content"].as_str().unwrap();
        assert!(sys.contains("json"), "文档要求 prompt 里必须出现 json 字样");
    }

    #[test]
    fn cache_prefix_is_stable_across_terms_in_same_deck() {
        let kw = vec!["rust".to_string(), "tokio".to_string()];
        let a = build_body("handle", None, &kw, "deepseek-flash");
        let b = build_body("borrow", None, &kw, "deepseek-flash");
        // preamble 与 deck scope 两段必须逐字相同，否则前缀缓存失效
        assert_eq!(a["messages"][0]["content"], b["messages"][0]["content"]);
        assert_eq!(a["messages"][1]["content"], b["messages"][1]["content"]);
    }

    #[test]
    fn fences_are_stripped() {
        let raw = "```json\n{\"domain_meaning\":\"x\"}\n```";
        let parsed: LlmDefinition = serde_json::from_str(&strip_fences(raw)).unwrap();
        assert_eq!(parsed.domain_meaning, "x");
    }

    #[test]
    fn timeout_setting_is_clamped_on_both_ends() {
        assert_eq!(clamp_timeout_secs(45), 45);
        // 0 秒会让每次查词立刻失败；负数更是。
        assert_eq!(clamp_timeout_secs(0), MIN_TIMEOUT_SECS);
        assert_eq!(clamp_timeout_secs(-5), MIN_TIMEOUT_SECS);
        assert_eq!(clamp_timeout_secs(99_999), MAX_TIMEOUT_SECS);
    }

    // ---------------------------------------------------------------- 假服务器
    //
    // 下面几个测试故意在 **127.0.0.1** 上起一个只按剧本说话的假服务器：不联网、
    // 不花 token、不依赖模型今天的心情，却能精确复现"卡住"和"响应被截断"这两种真实故障。

    fn test_cfg(base_url: String, timeout_ms: u64) -> LlmConfig {
        LlmConfig {
            api_key: "sk-test".into(),
            base_url,
            model: "fake-model".into(),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    /// 测试专用客户端：**必须绕开系统代理**。
    ///
    /// 这台机器的环境变量里有 `HTTP_PROXY=http://127.0.0.1:7890`（Clash），reqwest 会照用，
    /// 于是请求被代理转走、由代理替我们回 502 —— 那测到的就不是这份代码了。
    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("建测试用 HTTP client")
    }

    /// 收下连接但永远不回话 —— 复现"卡住"。
    ///
    /// 必须**阻塞住这条线程**：reply 一返回，socket 就被丢掉（发 FIN），
    /// 客户端看到的是"连接被关掉"，而不是我们要复现的"等不到响应"。
    fn hang(_n: usize, _stream: &mut std::net::TcpStream) {
        std::thread::sleep(Duration::from_secs(120));
    }

    /// 起假服务器。`reply` 拿到（第几个连接，请求读干净之后的 socket）：
    /// 什么都不写 = "连上了但永远不回"；写一半就关 = "响应被截断"。
    fn fake_server(
        reply: impl Fn(usize, &mut std::net::TcpStream) + Send + Sync + 'static,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::Read;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定本机端口");
        let addr = listener.local_addr().expect("取端口");
        let conns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&conns);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                // 先把请求读干净再回话：否则我们一关 socket，Windows 会发 RST，
                // 客户端看到的是"连接被重置"，而不是我们要复现的那个错。
                let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
                let mut buf = [0u8; 4096];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                }
                reply(counter.fetch_add(1, Ordering::SeqCst), &mut stream);
            }
        });
        (format!("http://{addr}"), conns)
    }

    fn respond(stream: &mut std::net::TcpStream, body: &str) {
        use std::io::Write;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
    }

    #[tokio::test]
    async fn cancel_returns_at_once_instead_of_waiting_out_the_budget() {
        // 接受连接、一个字都不回 —— 用户截图里那种"卡住"。
        let (base_url, _conns) = fake_server(hang);
        let client = test_client();
        let cancel = Cancel::new();

        let from_elsewhere = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            from_elsewhere.cancel();
        });

        let started = Instant::now();
        let err = define(
            &client,
            &test_cfg(base_url, 30_000),
            "handle",
            None,
            &[],
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled), "应是取消，而不是：{err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "取消必须立刻回来，不该等那 30 秒的预算"
        );
    }

    #[tokio::test]
    async fn already_cancelled_token_never_touches_the_network() {
        // 对应"停止比请求先到"的竞态：前端发停止 → 后端还没登记 → 请求才起来。
        let (base_url, conns) = fake_server(hang);
        let client = test_client();
        let cancel = Cancel::new();
        cancel.cancel();

        let err = define(
            &client,
            &test_cfg(base_url, 5_000),
            "handle",
            None,
            &[],
            &cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Cancelled), "应是取消，而不是：{err}");
        assert_eq!(conns.load(Ordering::SeqCst), 0, "已取消的请求不该再连出去");
    }

    #[tokio::test]
    async fn hung_request_times_out_with_a_readable_message() {
        let (base_url, _conns) = fake_server(hang);
        let client = test_client();
        let err = define(
            &client,
            &test_cfg(base_url, 300),
            "handle",
            None,
            &[],
            &Cancel::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Timeout(_)), "应是超时，而不是：{err}");
        assert!(err.to_string().contains("请求超时"), "超时信息要能看懂：{err}");
    }

    #[tokio::test]
    async fn truncated_response_is_retried_then_reported() {
        // 声明 200 字节、只给 20 字节就关：reqwest 报 `error decoding response body`，
        // 正是用户截图里那条。
        let (base_url, conns) = fake_server(|_, stream| {
            use std::io::Write;
            let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(b"{\"choices\":[{\"mess");
            let _ = stream.flush();
        });
        let client = test_client();
        let err = define(
            &client,
            &test_cfg(base_url, 20_000),
            "handle",
            None,
            &[],
            &Cancel::new(),
        )
        .await
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("2/2"), "传输层错误要重试到第 2 次才认输：{msg}");
        assert!(msg.contains("截断"), "错误信息要说清是响应被截断：{msg}");
        assert!(
            conns.load(Ordering::SeqCst) >= 2,
            "重试要真的再连一次，而不是只多打一行日志"
        );
    }

    #[tokio::test]
    async fn ping_reports_reply_and_the_model_the_server_actually_used() {
        let (base_url, _conns) = fake_server(|_, stream| {
            respond(
                stream,
                r#"{"model":"fake-model-2026","choices":[{"message":{"content":"pong"}}]}"#,
            );
        });
        let client = test_client();
        let out = ping(&client, &test_cfg(base_url, 5_000), &Cancel::new())
            .await
            .expect("测试连接应成功");
        assert_eq!(out.reply, "pong");
        assert_eq!(out.model, "fake-model-2026", "要报服务端真正用的模型名");
    }

    #[tokio::test]
    async fn ping_surfaces_http_errors_instead_of_pretending_it_connected() {
        let (base_url, _conns) = fake_server(|_, stream| {
            use std::io::Write;
            let body = r#"{"error":{"message":"Authentication Fails"}}"#;
            let head = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
        });
        let client = test_client();
        let err = ping(&client, &test_cfg(base_url, 5_000), &Cancel::new())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("401"), "要把 HTTP 状态带出来：{msg}");
        assert!(msg.contains("Authentication Fails"), "要把接口原话带出来：{msg}");
    }
}
