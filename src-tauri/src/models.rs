use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deck {
    pub id: i64,
    pub name: String,
    pub keywords: Vec<String>,
    pub description: Option<String>,
    pub card_count: i64,
    pub due_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Definition {
    pub id: i64,
    pub lookup_id: i64,
    pub pos: Option<String>,
    pub domain_meaning: String,
    pub general_meaning: Option<String>,
    pub why_translation_fails: Option<String>,
    pub in_context: Option<String>,
    pub examples: Vec<String>,
    pub collocations: Vec<String>,
    pub confidence: Option<String>,
    pub is_user_edited: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: i64,
    pub term_key: String,
    pub display_term: String,
    pub deck_id: i64,
    pub deck_name: String,
    pub primary_definition_id: Option<i64>,
    pub state: String,
    pub due_at: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
    pub last_reviewed_at: Option<i64>,
    pub created_at: i64,
}

/// 模型返回的释义。字段全部 default，避免模型少给一个字段就整条失败。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmDefinition {
    #[serde(default)]
    pub lemma: String,
    #[serde(default)]
    pub pos: String,
    #[serde(default)]
    pub domain_meaning: String,
    #[serde(default)]
    pub general_meaning: String,
    #[serde(default)]
    pub why_translation_fails: String,
    #[serde(default)]
    pub in_context: String,
    #[serde(default)]
    pub examples: Vec<String>,
    #[serde(default)]
    pub collocations: Vec<String>,
    #[serde(default)]
    pub confidence: String,
}

/// 已存在卡片时给前端的提示信息（PRD §4.4 要点）。
#[derive(Debug, Clone, Serialize)]
pub struct ExistingCard {
    pub card_id: i64,
    pub deck_id: i64,
    pub deck_name: String,
    pub term_key: String,
    pub last_reviewed_at: Option<i64>,
    pub reps: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LookupResult {
    pub term: String,
    pub norm_term: String,
    pub deck_id: i64,
    pub deck_name: String,
    pub sentence: Option<String>,
    pub definition: LlmDefinition,
    pub from_cache: bool,
    pub elapsed_ms: u64,
    pub attempts: u32,
    pub cache_hit_tokens: i64,
    pub cache_miss_tokens: i64,
    /// 输出 token —— 这是真正花钱的那部分，调试面板要能看到。
    pub completion_tokens: i64,
    /// 同一个词在**当前卡包**里已有的卡
    pub existing_in_deck: Option<ExistingCard>,
    /// 同一个词在**其他卡包**里已有的卡（PRD：提示复用或新建）
    pub existing_elsewhere: Vec<ExistingCard>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewCard {
    pub card: Card,
    pub context_sentence: Option<String>,
    pub pos: Option<String>,
    pub domain_meaning: String,
    pub general_meaning: Option<String>,
    pub why_translation_fails: Option<String>,
    pub in_context: Option<String>,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryItem {
    pub lookup_id: i64,
    pub term: String,
    pub deck_id: i64,
    pub deck_name: String,
    pub context_sentence: Option<String>,
    pub domain_meaning: String,
    pub created_at: i64,
    pub has_card: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Stats {
    pub total_cards: i64,
    pub due_now: i64,
    pub learning: i64,
    pub review: i64,
    pub suspended: i64,
    pub total_lookups: i64,
    /// 重复查询率：被查过 2 次以上的词占全部词的比例（PRD §12 的滞后指标）
    pub repeat_lookup_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub daily_review_limit: i64,
    pub reminder_time: String,
}
