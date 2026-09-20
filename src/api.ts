import { invoke } from "@tauri-apps/api/core";
import type {
  Card,
  ConnectionTest,
  Deck,
  HistoryItem,
  LlmDefinition,
  LookupResult,
  ReviewCard,
  Settings,
  Stats,
} from "./types";

/**
 * 命令失败时 Tauri reject 的是 AppError 序列化后的**字符串**（见 error.rs），
 * 不是 Error 对象。不处理的话界面上只会看到 [object Object]。
 */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export const emptyDefinition = (): LlmDefinition => ({
  lemma: "",
  pos: "",
  domain_meaning: "",
  general_meaning: "",
  why_translation_fails: "",
  in_context: "",
  examples: [],
  collocations: [],
  confidence: "",
});

/**
 * 每次查词都要一个新的 requestId：后端的「停止」按它精确命中那一次请求。
 *
 * 不能复用固定值 —— 用户点停止后马上换个词再查，第二枪必须活着；
 * 用同一个 id 会把新请求也一起取消掉。
 */
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 顶层参数名一律 camelCase —— tauri-macros 默认 ArgumentCase::Camel，
 * 会把 Rust 侧的 snake_case 参数名转成 camelCase 再去 JSON 里取。
 */
export const api = {
  listDecks: () => invoke<Deck[]>("list_decks"),

  createDeck: (name: string, keywords: string[], description: string | null) =>
    invoke<Deck>("create_deck", { name, keywords, description }),

  updateDeck: (id: number, name: string, keywords: string[], description: string | null) =>
    invoke<Deck>("update_deck", { id, name, keywords, description }),

  deleteDeck: (id: number) => invoke<void>("delete_deck", { id }),

  lookupTerm: (requestId: string, deckId: number, term: string, sentence: string | null) =>
    invoke<LookupResult>("lookup_term", { requestId, deckId, term, sentence }),

  /**
   * 停止一次正在跑的查词。返回值是"有没有命中一个正在跑的请求"，界面不关心：
   * 没命中也不代表没生效（停止可能比请求先到，后端会记账）。
   */
  cancelLookup: (requestId: string) => invoke<boolean>("cancel_lookup", { requestId }),

  /** 用**表单里此刻的值**试一次请求，不看已保存的设置 —— 否则"改了再试"试不出东西。 */
  testConnection: (settings: Settings) => invoke<ConnectionTest>("test_llm", { settings }),

  saveLookup: (
    deckId: number,
    term: string,
    sentence: string | null,
    definition: LlmDefinition,
    sourceHint: string | null,
  ) => invoke<Card>("save_lookup", { deckId, term, sentence, definition, sourceHint }),

  listCards: (deckId: number | null) => invoke<Card[]>("list_cards", { deckId }),

  deleteCard: (cardId: number) => invoke<void>("delete_card", { cardId }),

  listHistory: (query: string | null, limit?: number) =>
    invoke<HistoryItem[]>("list_history", { query, limit: limit ?? null }),

  listDueCards: (limit: number | null) => invoke<ReviewCard[]>("list_due_cards", { limit }),

  reviewCard: (cardId: number, rating: number, elapsedMs?: number) =>
    invoke<Card>("review_card", { cardId, rating, elapsedMs: elapsedMs ?? null }),

  reactivateCard: (cardId: number) => invoke<Card>("reactivate_card", { cardId }),

  getStats: () => invoke<Stats>("get_stats"),

  getSettings: () => invoke<Settings>("get_settings"),

  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),

  dbLocation: () => invoke<string>("db_location"),
};
