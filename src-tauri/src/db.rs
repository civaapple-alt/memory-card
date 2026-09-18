use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS deck (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  keywords    TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup (
  id                INTEGER PRIMARY KEY,
  raw_selection     TEXT NOT NULL,
  norm_term         TEXT NOT NULL,
  lemma             TEXT,
  deck_id           INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL DEFAULT 'word',
  context_sentence  TEXT,
  source_hint       TEXT,
  engine            TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lookup_norm ON lookup(norm_term, deck_id);
CREATE INDEX IF NOT EXISTS idx_lookup_created ON lookup(created_at DESC);

CREATE TABLE IF NOT EXISTS definition (
  id                     INTEGER PRIMARY KEY,
  lookup_id              INTEGER NOT NULL REFERENCES lookup(id) ON DELETE CASCADE,
  pos                    TEXT,
  domain_meaning         TEXT NOT NULL,
  general_meaning        TEXT,
  why_translation_fails  TEXT,
  in_context             TEXT,
  examples_json          TEXT NOT NULL DEFAULT '[]',
  collocations_json      TEXT NOT NULL DEFAULT '[]',
  confidence             TEXT,
  is_user_edited         INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_definition_lookup ON definition(lookup_id);

CREATE TABLE IF NOT EXISTS card (
  id                    INTEGER PRIMARY KEY,
  term_key              TEXT NOT NULL UNIQUE,
  display_term          TEXT NOT NULL,
  deck_id               INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
  primary_definition_id INTEGER REFERENCES definition(id) ON DELETE SET NULL,
  state                 TEXT NOT NULL DEFAULT 'new',
  due_at                INTEGER NOT NULL,
  interval_days         REAL NOT NULL DEFAULT 0,
  ease                  REAL NOT NULL DEFAULT 2.5,
  reps                  INTEGER NOT NULL DEFAULT 0,
  lapses                INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at      INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_due ON card(due_at);
CREATE INDEX IF NOT EXISTS idx_card_deck ON card(deck_id);

CREATE TABLE IF NOT EXISTS review_log (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  rating        INTEGER NOT NULL,
  elapsed_ms    INTEGER,
  prev_interval REAL,
  next_interval REAL,
  reviewed_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
  id      INTEGER PRIMARY KEY,
  term    TEXT NOT NULL,
  deck_id INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
  meaning TEXT NOT NULL,
  note    TEXT,
  UNIQUE(term, deck_id)
);

CREATE TABLE IF NOT EXISTS def_cache (
  cache_key    TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 首次运行时预置的卡包。用户可随时改名/改关键词，6 个只是起点。
pub const DEFAULT_DECKS: &[(&str, &[&str])] = &[
    ("编程通用", &["programming", "software engineering", "api", "debug", "refactor"]),
    ("前端", &["javascript", "typescript", "react", "css", "browser"]),
    ("Rust 后端", &["rust", "tokio", "async", "ownership", "borrow"]),
    (
        "AI·LLM",
        &["llm", "transformer", "embedding", "inference", "prompt", "context window"],
    ),
    ("网络协议", &["http", "tcp", "tls", "dns", "latency"]),
    ("GitHub 协作黑话", &["git", "github", "pull request", "code review", "ci"]),
];

pub fn init(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    // journal_mode 会返回一行，所以不能用 execute_batch。
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;
    seed_default_decks(&conn)?;
    Ok(conn)
}

fn seed_default_decks(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM deck", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let now = crate::now_ts();
    for (name, keywords) in DEFAULT_DECKS {
        let kw = serde_json::to_string(keywords)?;
        conn.execute(
            "INSERT INTO deck (name, keywords, description, created_at) VALUES (?1, ?2, NULL, ?3)",
            rusqlite::params![name, kw, now],
        )?;
    }
    Ok(())
}
