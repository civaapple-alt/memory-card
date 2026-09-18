import { invoke } from "@tauri-apps/api/core";
import type {
  Card,
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

  lookupTerm: (deckId: number, term: string, sentence: string | null) =>
    invoke<LookupResult>("lookup_term", { deckId, term, sentence }),

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
