/**
 * 与 src-tauri/src/models.rs 一一对应。
 *
 * 字段名保持 snake_case：Tauri 只把命令的**顶层参数名**转成 camelCase，
 * 结构体内部字段是 serde 原样反序列化的，改了名字就对不上。
 */

export interface Deck {
  id: number;
  name: string;
  keywords: string[];
  description: string | null;
  card_count: number;
  due_count: number;
  created_at: number;
}

/** 模型返回的释义。所有字段都可能缺失，后端已用 serde(default) 兜底。 */
export interface LlmDefinition {
  lemma: string;
  pos: string;
  domain_meaning: string;
  general_meaning: string;
  why_translation_fails: string;
  in_context: string;
  examples: string[];
  collocations: string[];
  confidence: string;
}

export interface ExistingCard {
  card_id: number;
  deck_id: number;
  deck_name: string;
  term_key: string;
  last_reviewed_at: number | null;
  reps: number;
  created_at: number;
}

export interface LookupResult {
  term: string;
  norm_term: string;
  deck_id: number;
  deck_name: string;
  sentence: string | null;
  definition: LlmDefinition;
  from_cache: boolean;
  elapsed_ms: number;
  attempts: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  /** 输出 token —— 真正花钱的部分 */
  completion_tokens: number;
  /** 同一个词在当前卡包里已有的卡 */
  existing_in_deck: ExistingCard | null;
  /** 同一个词在其他卡包里已有的卡 */
  existing_elsewhere: ExistingCard[];
}

export interface Card {
  id: number;
  term_key: string;
  display_term: string;
  deck_id: number;
  deck_name: string;
  primary_definition_id: number | null;
  state: string;
  due_at: number;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_reviewed_at: number | null;
  created_at: number;
}

export interface ReviewCard {
  card: Card;
  context_sentence: string | null;
  pos: string | null;
  domain_meaning: string;
  general_meaning: string | null;
  why_translation_fails: string | null;
  in_context: string | null;
  examples: string[];
}

export interface HistoryItem {
  lookup_id: number;
  term: string;
  deck_id: number;
  deck_name: string;
  context_sentence: string | null;
  domain_meaning: string;
  created_at: number;
  has_card: boolean;
}

export interface Stats {
  total_cards: number;
  due_now: number;
  learning: number;
  review: number;
  suspended: number;
  total_lookups: number;
  repeat_lookup_ratio: number;
}

export interface Settings {
  api_key: string;
  base_url: string;
  model: string;
  /** 整次查词的总超时（秒）。后端会 clamp 到 5–300，默认 45。 */
  timeout_secs: number;
  daily_review_limit: number;
  reminder_time: string;
}

/** `test_llm` 的返回：连通性测试成功时才有。 */
export interface ConnectionTest {
  /** 模型回的话（正常是 pong）。 */
  reply: string;
  /** 服务端回报的真实模型名 —— 传错模型名时这里会露马脚。 */
  model: string;
  elapsed_ms: number;
}

/** 复习评分，和后端 review_card 的 1..4 对齐。 */
export type Rating = 1 | 2 | 3 | 4;

export const RATING_LABEL: Record<Rating, string> = {
  1: "忘了",
  2: "勉强",
  3: "记得",
  4: "秒答",
};

/** get_settings 用这个占位符代替明文 key，前端原样回传表示"不改"。 */
export const KEY_PLACEHOLDER = "***configured***";
