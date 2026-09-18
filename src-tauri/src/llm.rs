//! DeepSeek 调用层。
//!
//! 这里的 prompt 布局和参数是 `scripts/probe-deepseek.ps1` 实测验证过的，改动前先看
//! docs/PRD.md §9：
//!   - `thinking` 必须显式 disabled（默认是开启且 effort=high，实测慢 1.9x）
//!   - 固定 preamble + 卡包范围声明放在最前面且逐字不变，才能命中前缀缓存（1/50 价格）
//!   - JSON 模式要求 prompt 里出现 "json" 字样并给出格式示例

use crate::error::{AppError, AppResult};
use crate::models::LlmDefinition;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// 改动这个值会让所有本地释义缓存失效，必须与 prompt 内容同步 bump。
pub const PROMPT_VERSION: &str = "v1";

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
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LlmUsage {
    pub cache_hit_tokens: i64,
    pub cache_miss_tokens: i64,
    pub completion_tokens: i64,
}

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
) -> AppResult<LlmOutcome> {
    let body = build_body(term, sentence, keywords, &cfg.model);
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let started = Instant::now();
    let mut last_err = String::from("未发起请求");

    // 文档说明 JSON 模式偶发返回空 content，所以必须重试。
    for attempt in 1..=2u32 {
        let resp = client
            .post(&url)
            .bearer_auth(&cfg.api_key)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

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
                last_err = format!("第 {attempt} 次响应不是合法 JSON：{e}");
                continue;
            }
        };

        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        if content.trim().is_empty() {
            last_err = format!("第 {attempt} 次返回空 content");
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
            Ok(_) => last_err = format!("第 {attempt} 次 domain_meaning 为空"),
            Err(e) => last_err = format!("第 {attempt} 次解析失败：{e}"),
        }
    }

    Err(AppError::Parse(format!("重试后仍失败：{last_err}")))
}

pub fn default_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
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
}
