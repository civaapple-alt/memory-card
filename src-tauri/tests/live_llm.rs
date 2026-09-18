//! 真·联网集成测试：证明 reqwest（换成 schannel 之后）确实连得上 DeepSeek，
//! 返回的释义是领域义而不是通用义，而且前缀缓存真的命中。
//!
//! 没配 API Key 就直接跳过 —— 不算失败，否则没网/没 key 的人会被卡住。
//! 跑法（仓库根目录有 .env）：cargo test --test live_llm -- --nocapture

use memory_card_lib::llm::{self, LlmConfig};

fn config() -> Option<LlmConfig> {
    // 集成测试的 cwd 是 src-tauri，dotenvy 会往上层目录找到仓库根的 .env。
    let _ = dotenvy::dotenv();

    let pick = |keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| std::env::var(k).ok())
            .filter(|v| !v.trim().is_empty())
    };

    Some(LlmConfig {
        api_key: pick(&["DEEPSEEK_API_KEY", "OPENAI_API_KEY"])?,
        base_url: pick(&["DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"])
            .unwrap_or_else(|| "https://api.deepseek.com".to_string()),
        model: pick(&["DEEPSEEK_MODEL", "OPENAI_MODEL"])
            .unwrap_or_else(|| "deepseek-flash".to_string()),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn live_lookup_is_domain_correct_and_prefix_cache_hits() {
    let Some(cfg) = config() else {
        eprintln!("跳过 live_llm：没有配置 API Key（DEEPSEEK_API_KEY / OPENAI_API_KEY）");
        return;
    };

    let client = llm::default_client().expect("建 HTTP client");
    let keywords: Vec<String> = ["rust", "async", "tokio"].iter().map(|s| s.to_string()).collect();

    let first = llm::define(
        &client,
        &cfg,
        "handle",
        Some("the runtime hands you a handle that you can await"),
        &keywords,
    )
    .await
    .expect("第一次调用必须成功");

    let dm = first.definition.domain_meaning.trim();
    assert!(!dm.is_empty(), "领域释义不能为空");
    assert!(
        !dm.contains("把手"),
        "释义退回了通用义（把手），说明卡包关键词没起作用：{dm}"
    );
    assert!(
        first.definition.lemma.trim().len() > 1,
        "lemma 是卡片词形的来源，不能是空的"
    );
    eprintln!(
        "[live] handle -> {} | {}ms | 输出 {} tokens",
        dm, first.elapsed_ms, first.usage.completion_tokens
    );

    // 固定 preamble + 卡包作用域在最前面且字节不变，第二次必须吃到前缀缓存
    //（命中部分按 1/50 计价，这是省钱的全部来源）。
    let second = llm::define(&client, &cfg, "bounded", None, &keywords)
        .await
        .expect("第二次调用必须成功");

    eprintln!(
        "[live] bounded -> cache_hit={} cache_miss={}",
        second.usage.cache_hit_tokens, second.usage.cache_miss_tokens
    );
    assert!(
        second.usage.cache_hit_tokens > 0,
        "前缀缓存没命中：换个词就重新算了 preamble，价格差 50 倍"
    );
}
