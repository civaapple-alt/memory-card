//! memory-card —— 取词 / 域释义 / 入卡 / 复习 的桌面小窗。
//!
//! 前端只需要认得这些命令。真实设计见 docs/PRD.md。

mod db;
// error / llm / models 对外暴露，是为了 tests/live_llm.rs 能直接打真实的
// llm::define —— 命令壳里那层没被验证过的接缝（reqwest + schannel）必须能测。
pub mod error;
pub mod llm;
pub mod models;
mod srs;

use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{Manager, State};

use error::{AppError, AppResult};
use models::*;

pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub http: reqwest::Client,
    /// 正在跑的查词请求。键是前端给的 `request_id` —— 「停止」靠它精确打中**那一次**，
    /// 而不是把所有在飞的请求一起掐掉（用户点了停止马上换个词再查，第二枪必须活下来）。
    lookups: Mutex<HashMap<String, RunningLookup>>,
}

struct RunningLookup {
    cancel: llm::Cancel,
    started: Instant,
}

/// 登记表里条目的寿命。
///
/// `cancel_lookup` 找不到对应请求时会先建一个"已取消"的条目，等那个请求起来自己退出。
/// 万一前端发了停止却再没有请求起来（或请求早就跑完了），这些条目得能自己烂掉，
/// 否则这张表会一直长。
const LOOKUP_REGISTRY_TTL: Duration = Duration::from_secs(300);

impl AppState {
    /// 这张表没有不变量，锁中毒了也只是"谁还在跑"的历史记录 —— 直接取回内容继续用，
    /// 不要为此让用户重启应用。
    fn lookups(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunningLookup>> {
        self.lookups.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn register_lookup(&self, request_id: &str) -> llm::Cancel {
        let mut map = self.lookups();
        map.retain(|_, r| r.started.elapsed() < LOOKUP_REGISTRY_TTL);
        // 用 or_insert 而不是 insert：停止可能比请求先到（两次 IPC 没有先后保证），
        // 那种情况下留下的是那个"已取消"的令牌，请求一起来就自己退出。
        let entry = map
            .entry(request_id.to_string())
            .or_insert_with(|| RunningLookup {
                cancel: llm::Cancel::new(),
                started: Instant::now(),
            });
        entry.started = Instant::now();
        entry.cancel.clone()
    }

    fn finish_lookup(&self, request_id: &str) {
        self.lookups().remove(request_id);
    }

    /// 返回值 = 是否打中了一个**已经在跑**的请求。
    /// 没打中就把这次取消记在表里（同上：停止可能比请求先到），所以调用方不需要重试。
    fn cancel_lookup(&self, request_id: &str) -> bool {
        let mut map = self.lookups();
        if let Some(entry) = map.get_mut(request_id) {
            entry.cancel.cancel();
            return true;
        }
        let cancel = llm::Cancel::new();
        cancel.cancel();
        map.insert(
            request_id.to_string(),
            RunningLookup {
                cancel,
                started: Instant::now(),
            },
        );
        false
    }
}

fn lock_err<E>(_: E) -> AppError {
    AppError::Other("数据库锁被污染，请重启应用".into())
}

fn normalize(term: &str) -> String {
    term.trim()
        .trim_matches(|c: char| c.is_ascii_punctuation() && c != '-')
        .to_lowercase()
}

fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("MEMORY_CARD_DB") {
        return PathBuf::from(p);
    }
    directories::ProjectDirs::from("com", "memorycard", "memory-card")
        .map(|d| d.data_dir().join("memory-card.db"))
        .unwrap_or_else(|| PathBuf::from("memory-card.db"))
}

// -------------------------------------------------------------------- settings

fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// 配置优先级：settings 表 > 环境变量。
///
/// 桌面应用从资源管理器双击启动时不继承 shell 的环境变量，所以 .env 只当开发便利，
/// 正式配置必须落在 settings 表里（PRD §9）。
fn llm_config(conn: &Connection) -> AppResult<llm::LlmConfig> {
    let pick = |key: &str, envs: &[&str]| -> Option<String> {
        get_setting(conn, key)
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                envs.iter()
                    .find_map(|e| std::env::var(e).ok())
                    .filter(|s| !s.trim().is_empty())
            })
    };

    let api_key = pick("api_key", &["DEEPSEEK_API_KEY", "OPENAI_API_KEY"])
        .ok_or_else(|| AppError::Config("还没有配置 API Key，请在设置里填写".into()))?;
    let base_url = pick("base_url", &["DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"])
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = pick("model", &["DEEPSEEK_MODEL", "OPENAI_MODEL"])
        .unwrap_or_else(|| "deepseek-flash".to_string());
    let timeout_secs = timeout_setting(conn);

    Ok(llm::LlmConfig {
        api_key,
        base_url,
        model,
        timeout: Duration::from_secs(timeout_secs),
    })
}

/// 超时是用户可填的数字（也可能是脏数据），读出来一律过一遍 clamp。
fn timeout_setting(conn: &Connection) -> u64 {
    let raw = get_setting(conn, "timeout_secs")
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(llm::DEFAULT_TIMEOUT_SECS as i64);
    llm::clamp_timeout_secs(raw)
}

/// 设置页「测试连接」用的是**表单里此刻的值**，不是已保存的值 —— 否则"改了再试"就试不出东西。
/// key 为空或还是占位符时，回落到已保存的那把。
fn llm_config_from_form(state: &AppState, form: &Settings) -> AppResult<llm::LlmConfig> {
    let conn = state.db.lock().map_err(lock_err)?;
    let pick = |form_value: &str, key: &str, fallback: &str| -> String {
        let v = form_value.trim();
        if !v.is_empty() && v != KEY_PLACEHOLDER {
            v.to_string()
        } else {
            get_setting(&conn, key)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| fallback.to_string())
        }
    };

    let api_key = pick(&form.api_key, "api_key", "");
    if api_key.is_empty() {
        return Err(AppError::Config("还没有配置 API Key，请在设置里填写".into()));
    }
    Ok(llm::LlmConfig {
        api_key,
        base_url: pick(&form.base_url, "base_url", "https://api.deepseek.com"),
        model: pick(&form.model, "model", "deepseek-flash"),
        timeout: Duration::from_secs(llm::clamp_timeout_secs(form.timeout_secs)),
    })
}

fn seed_settings_from_env(conn: &Connection) {
    let pairs: &[(&str, &[&str])] = &[
        ("api_key", &["DEEPSEEK_API_KEY", "OPENAI_API_KEY"]),
        ("base_url", &["DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"]),
        ("model", &["DEEPSEEK_MODEL", "OPENAI_MODEL"]),
    ];
    for (key, envs) in pairs {
        if get_setting(conn, key).map(|v| !v.trim().is_empty()).unwrap_or(false) {
            continue;
        }
        if let Some(v) = envs
            .iter()
            .find_map(|e| std::env::var(e).ok())
            .filter(|s| !s.trim().is_empty())
        {
            let _ = put_setting(conn, key, &v);
        }
    }
    if get_setting(conn, "daily_review_limit").is_none() {
        let _ = put_setting(conn, "daily_review_limit", "15");
    }
    if get_setting(conn, "reminder_time").is_none() {
        let _ = put_setting(conn, "reminder_time", "20:00");
    }
    if get_setting(conn, "timeout_secs").is_none() {
        let _ = put_setting(conn, "timeout_secs", &llm::DEFAULT_TIMEOUT_SECS.to_string());
    }
}

// ------------------------------------------------------------------ row mappers

fn deck_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Deck> {
    let keywords_json: String = row.get(2)?;
    Ok(Deck {
        id: row.get(0)?,
        name: row.get(1)?,
        keywords: serde_json::from_str(&keywords_json).unwrap_or_default(),
        description: row.get(3)?,
        card_count: row.get(5)?,
        due_count: row.get(6)?,
        created_at: row.get(4)?,
    })
}

fn card_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: row.get(0)?,
        term_key: row.get(1)?,
        display_term: row.get(2)?,
        deck_id: row.get(3)?,
        deck_name: row.get(4)?,
        primary_definition_id: row.get(5)?,
        state: row.get(6)?,
        due_at: row.get(7)?,
        interval_days: row.get(8)?,
        ease: row.get(9)?,
        reps: row.get(10)?,
        lapses: row.get(11)?,
        last_reviewed_at: row.get(12)?,
        created_at: row.get(13)?,
    })
}

const CARD_SELECT: &str = "SELECT c.id, c.term_key, c.display_term, c.deck_id, d.name,
       c.primary_definition_id, c.state, c.due_at, c.interval_days, c.ease,
       c.reps, c.lapses, c.last_reviewed_at, c.created_at
FROM card c JOIN deck d ON d.id = c.deck_id";

fn fetch_card(conn: &Connection, card_id: i64) -> AppResult<Card> {
    let sql = format!("{CARD_SELECT} WHERE c.id = ?1");
    conn.query_row(&sql, [card_id], card_from_row)
        .map_err(AppError::from)
}

fn deck_keywords(conn: &Connection, deck_id: i64) -> AppResult<(String, Vec<String>)> {
    let (name, keywords_json): (String, String) = conn.query_row(
        "SELECT name, keywords FROM deck WHERE id = ?1",
        [deck_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok((name, serde_json::from_str(&keywords_json).unwrap_or_default()))
}

/// 查这个词在哪些卡包里已经有卡了（PRD §4.4：当前卡包提示覆盖，其他卡包提示复用或新建）。
fn find_existing(
    conn: &Connection,
    norm: &str,
    deck_id: i64,
) -> AppResult<(Option<ExistingCard>, Vec<ExistingCard>)> {
    // 显式 ESCAPE，避免 norm 里的 % 或 _ 被当成通配符。
    let pattern = format!(
        "{}|%",
        norm.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let mut stmt = conn.prepare(
        "SELECT c.id, c.deck_id, d.name, c.term_key, c.last_reviewed_at, c.reps, c.created_at
         FROM card c JOIN deck d ON d.id = c.deck_id
         WHERE c.term_key LIKE ?1 ESCAPE '\\'",
    )?;
    let all = stmt
        .query_map([&pattern], |row| {
            Ok(ExistingCard {
                card_id: row.get(0)?,
                deck_id: row.get(1)?,
                deck_name: row.get(2)?,
                term_key: row.get(3)?,
                last_reviewed_at: row.get(4)?,
                reps: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut in_deck = None;
    let mut elsewhere = Vec::new();
    for card in all {
        if card.deck_id == deck_id {
            in_deck = Some(card);
        } else {
            elsewhere.push(card);
        }
    }
    Ok((in_deck, elsewhere))
}

// -------------------------------------------------------------------- 卡包命令

#[tauri::command]
fn list_decks(state: State<'_, AppState>) -> AppResult<Vec<Deck>> {
    let conn = state.db.lock().map_err(lock_err)?;
    let now = now_ts();
    let mut stmt = conn.prepare(
        "SELECT d.id, d.name, d.keywords, d.description, d.created_at,
                (SELECT COUNT(*) FROM card c WHERE c.deck_id = d.id),
                (SELECT COUNT(*) FROM card c WHERE c.deck_id = d.id
                   AND c.due_at <= ?1 AND c.state != 'suspended')
         FROM deck d ORDER BY d.id",
    )?;
    let rows = stmt
        .query_map([now], deck_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn deck_by_id(conn: &Connection, id: i64) -> AppResult<Deck> {
    let now = now_ts();
    conn.query_row(
        "SELECT d.id, d.name, d.keywords, d.description, d.created_at,
                (SELECT COUNT(*) FROM card c WHERE c.deck_id = d.id),
                (SELECT COUNT(*) FROM card c WHERE c.deck_id = d.id
                   AND c.due_at <= ?2 AND c.state != 'suspended')
         FROM deck d WHERE d.id = ?1",
        params![id, now],
        deck_from_row,
    )
    .map_err(AppError::from)
}

#[tauri::command]
fn create_deck(
    state: State<'_, AppState>,
    name: String,
    keywords: Vec<String>,
    description: Option<String>,
) -> AppResult<Deck> {
    let conn = state.db.lock().map_err(lock_err)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("卡包名不能为空".into()));
    }
    conn.execute(
        "INSERT INTO deck (name, keywords, description, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            name,
            serde_json::to_string(&keywords).unwrap_or_else(|_| "[]".into()),
            description,
            now_ts()
        ],
    )?;
    deck_by_id(&conn, conn.last_insert_rowid())
}

#[tauri::command]
fn update_deck(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    keywords: Vec<String>,
    description: Option<String>,
) -> AppResult<Deck> {
    let conn = state.db.lock().map_err(lock_err)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("卡包名不能为空".into()));
    }
    conn.execute(
        "UPDATE deck SET name = ?2, keywords = ?3, description = ?4 WHERE id = ?1",
        params![
            id,
            name,
            serde_json::to_string(&keywords).unwrap_or_else(|_| "[]".into()),
            description
        ],
    )?;
    deck_by_id(&conn, id)
}

#[tauri::command]
fn delete_deck(state: State<'_, AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.lock().map_err(lock_err)?;
    // deck 上的外键是 ON DELETE CASCADE，卡片和查词记录会一起走。
    conn.execute("DELETE FROM deck WHERE id = ?1", [id])?;
    Ok(())
}

// -------------------------------------------------------------------- 查词命令

#[tauri::command]
async fn lookup_term(
    state: State<'_, AppState>,
    request_id: String,
    deck_id: i64,
    term: String,
    sentence: Option<String>,
) -> AppResult<LookupResult> {
    // 登记一张"这次请求的取消票"，无论成功、失败还是被取消都要注销，
    // 所以真正的活放在内层函数里，外面包一层收尾。
    let cancel = state.register_lookup(&request_id);
    let outcome = lookup_term_inner(state.inner(), &cancel, deck_id, term, sentence).await;
    state.finish_lookup(&request_id);
    outcome
}

async fn lookup_term_inner(
    state: &AppState,
    cancel: &llm::Cancel,
    deck_id: i64,
    term: String,
    sentence: Option<String>,
) -> AppResult<LookupResult> {
    let norm = normalize(&term);
    if norm.is_empty() {
        return Err(AppError::Other("请输入要查询的词或短语".into()));
    }
    let sentence = sentence.filter(|s| !s.trim().is_empty());

    // 短锁：只取需要的东西，绝不把 MutexGuard 带过 await。
    let (deck_name, keywords, cfg, cached, existing_in_deck, existing_elsewhere) = {
        let conn = state.db.lock().map_err(lock_err)?;
        let (deck_name, keywords) = deck_keywords(&conn, deck_id)?;
        let cfg = llm_config(&conn)?;
        let key = llm::cache_key(&norm, deck_id, &keywords, sentence.as_deref());
        let cached: Option<LlmDefinition> = conn
            .query_row(
                "SELECT payload_json FROM def_cache WHERE cache_key = ?1",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|s| serde_json::from_str(&s).ok());
        let (in_deck, elsewhere) = find_existing(&conn, &norm, deck_id)?;
        (deck_name, keywords, cfg, cached, in_deck, elsewhere)
    };

    let (definition, from_cache, elapsed_ms, attempts, usage) = match cached {
        Some(def) => (def, true, 0u64, 0u32, llm::LlmUsage::default()),
        None => {
            let outcome = llm::define(
                &state.http,
                &cfg,
                &term,
                sentence.as_deref(),
                &keywords,
                cancel,
            )
            .await?;
            // 写缓存：下次同样输入秒出，且离线也能看。
            if let Ok(conn) = state.db.lock() {
                let key = llm::cache_key(&norm, deck_id, &keywords, sentence.as_deref());
                if let Ok(payload) = serde_json::to_string(&outcome.definition) {
                    let _ = conn.execute(
                        "INSERT INTO def_cache (cache_key, payload_json, created_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json",
                        params![key, payload, now_ts()],
                    );
                }
            }
            (
                outcome.definition,
                false,
                outcome.elapsed_ms,
                outcome.attempts,
                outcome.usage,
            )
        }
    };

    Ok(LookupResult {
        term,
        norm_term: norm,
        deck_id,
        deck_name,
        sentence,
        definition,
        from_cache,
        elapsed_ms,
        attempts,
        cache_hit_tokens: usage.cache_hit_tokens,
        cache_miss_tokens: usage.cache_miss_tokens,
        completion_tokens: usage.completion_tokens,
        existing_in_deck,
        existing_elsewhere,
    })
}

#[tauri::command]
fn save_lookup(
    state: State<'_, AppState>,
    deck_id: i64,
    term: String,
    sentence: Option<String>,
    definition: LlmDefinition,
    source_hint: Option<String>,
) -> AppResult<Card> {
    let conn = state.db.lock().map_err(lock_err)?;
    let now = now_ts();
    let norm = normalize(&term);
    if norm.is_empty() {
        return Err(AppError::Other("词不能为空".into()));
    }
    let term_key = format!("{norm}|{deck_id}");

    // 个人术语表优先级高于模型：用户手动写过的释义直接覆盖。
    let definition = match conn
        .query_row(
            "SELECT meaning FROM glossary WHERE term = ?1 AND deck_id = ?2",
            params![norm, deck_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        Some(user_meaning) => LlmDefinition {
            domain_meaning: user_meaning,
            ..definition
        },
        None => definition,
    };

    conn.execute(
        "INSERT INTO lookup (raw_selection, norm_term, lemma, deck_id, mode, context_sentence,
                             source_hint, engine, created_at)
         VALUES (?1, ?2, ?3, ?4, 'word', ?5, ?6, ?7, ?8)",
        params![
            term,
            norm,
            definition.lemma,
            deck_id,
            sentence,
            source_hint,
            llm::PROMPT_VERSION,
            now
        ],
    )?;
    let lookup_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO definition (lookup_id, pos, domain_meaning, general_meaning,
                                 why_translation_fails, in_context, examples_json,
                                 collocations_json, confidence, is_user_edited, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
        params![
            lookup_id,
            definition.pos,
            definition.domain_meaning,
            definition.general_meaning,
            definition.why_translation_fails,
            definition.in_context,
            serde_json::to_string(&definition.examples).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&definition.collocations).unwrap_or_else(|_| "[]".into()),
            definition.confidence,
            now
        ],
    )?;
    let definition_id = conn.last_insert_rowid();

    // 重复入库不重置复习进度，只把释义更新成最新那版。
    conn.execute(
        "INSERT INTO card (term_key, display_term, deck_id, primary_definition_id, state,
                           due_at, interval_days, ease, reps, lapses, created_at)
         VALUES (?1, ?2, ?3, ?4, 'new', ?5, 0, 2.5, 0, 0, ?6)
         ON CONFLICT(term_key) DO UPDATE SET
             primary_definition_id = excluded.primary_definition_id,
             display_term = excluded.display_term",
        params![term_key, term, deck_id, definition_id, now, now],
    )?;

    let card_id: i64 =
        conn.query_row("SELECT id FROM card WHERE term_key = ?1", [&term_key], |r| r.get(0))?;
    fetch_card(&conn, card_id)
}

#[tauri::command]
fn list_cards(state: State<'_, AppState>, deck_id: Option<i64>) -> AppResult<Vec<Card>> {
    let conn = state.db.lock().map_err(lock_err)?;
    let (sql, ids): (String, Vec<i64>) = match deck_id {
        Some(id) => (format!("{CARD_SELECT} WHERE c.deck_id = ?1 ORDER BY c.created_at DESC"), vec![id]),
        None => (format!("{CARD_SELECT} ORDER BY c.created_at DESC"), vec![]),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids), card_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
fn delete_card(state: State<'_, AppState>, card_id: i64) -> AppResult<()> {
    let conn = state.db.lock().map_err(lock_err)?;
    conn.execute("DELETE FROM card WHERE id = ?1", [card_id])?;
    Ok(())
}

#[tauri::command]
fn list_history(
    state: State<'_, AppState>,
    query: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<HistoryItem>> {
    let conn = state.db.lock().map_err(lock_err)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let q = query.unwrap_or_default();
    let like = format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );

    let mut stmt = conn.prepare(
        "SELECT l.id, l.raw_selection, l.deck_id, d.name, l.context_sentence,
                def.domain_meaning, l.created_at,
                EXISTS(SELECT 1 FROM card c
                        WHERE c.term_key = l.norm_term || '|' || CAST(l.deck_id AS TEXT))
         FROM lookup l
         JOIN deck d ON d.id = l.deck_id
         LEFT JOIN definition def ON def.id = (
             SELECT id FROM definition WHERE lookup_id = l.id ORDER BY id DESC LIMIT 1
         )
         WHERE l.raw_selection LIKE ?1 ESCAPE '\\'
            OR l.context_sentence LIKE ?1 ESCAPE '\\'
            OR def.domain_meaning LIKE ?1 ESCAPE '\\'
         ORDER BY l.created_at DESC
         LIMIT ?2",
    )?;

    let rows = stmt
        .query_map(params![like, limit], |row| {
            Ok(HistoryItem {
                lookup_id: row.get(0)?,
                term: row.get(1)?,
                deck_id: row.get(2)?,
                deck_name: row.get(3)?,
                context_sentence: row.get(4)?,
                domain_meaning: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                created_at: row.get(6)?,
                has_card: row.get::<_, i64>(7)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// -------------------------------------------------------------------- 复习命令

#[tauri::command]
fn list_due_cards(state: State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<ReviewCard>> {
    let conn = state.db.lock().map_err(lock_err)?;
    let now = now_ts();
    let limit = limit.unwrap_or(15).clamp(1, 200);

    // 债务保护（PRD §10）：逾期太久的卡不进当日队列，改为休眠，避免队列雪崩。
    let cutoff = now - (srs::SUSPEND_AFTER_OVERDUE_DAYS * 86_400.0) as i64;
    conn.execute(
        "UPDATE card SET state = 'suspended' WHERE state != 'suspended' AND due_at < ?1",
        [cutoff],
    )?;

    let mut stmt = conn.prepare(
        "SELECT c.id, c.term_key, c.display_term, c.deck_id, d.name,
                c.primary_definition_id, c.state, c.due_at, c.interval_days, c.ease,
                c.reps, c.lapses, c.last_reviewed_at, c.created_at,
                l.context_sentence, def.pos, def.domain_meaning, def.general_meaning,
                def.why_translation_fails, def.in_context, def.examples_json
         FROM card c
         JOIN deck d ON d.id = c.deck_id
         LEFT JOIN definition def ON def.id = c.primary_definition_id
         LEFT JOIN lookup l ON l.id = def.lookup_id
         WHERE c.state != 'suspended' AND c.due_at <= ?1
         ORDER BY c.due_at ASC
         LIMIT ?2",
    )?;

    let rows = stmt
        .query_map(params![now, limit], |row| {
            let examples_json: Option<String> = row.get(20)?;
            Ok(ReviewCard {
                card: card_from_row(row)?,
                context_sentence: row.get(14)?,
                pos: row.get(15)?,
                domain_meaning: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
                general_meaning: row.get(17)?,
                why_translation_fails: row.get(18)?,
                in_context: row.get(19)?,
                examples: examples_json
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
fn review_card(
    state: State<'_, AppState>,
    card_id: i64,
    rating: i64,
    elapsed_ms: Option<i64>,
) -> AppResult<Card> {
    if !(1..=4).contains(&rating) {
        return Err(AppError::Other("rating 必须是 1..4".into()));
    }
    let conn = state.db.lock().map_err(lock_err)?;
    let now = now_ts();

    let (interval_days, ease, reps, lapses) = conn.query_row(
        "SELECT interval_days, ease, reps, lapses FROM card WHERE id = ?1",
        [card_id],
        |r| {
            Ok((
                r.get::<_, f64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        },
    )?;

    let out = srs::schedule(srs::ScheduleInput { interval_days, ease, reps, lapses }, rating);
    let due_at = srs::interval_to_due_at(out.interval_days, now);

    conn.execute(
        "UPDATE card SET interval_days = ?2, ease = ?3, reps = ?4, lapses = ?5,
                         state = ?6, due_at = ?7, last_reviewed_at = ?8
         WHERE id = ?1",
        params![card_id, out.interval_days, out.ease, out.reps, out.lapses, out.state, due_at, now],
    )?;
    conn.execute(
        "INSERT INTO review_log (card_id, rating, elapsed_ms, prev_interval, next_interval, reviewed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![card_id, rating, elapsed_ms, interval_days, out.interval_days, now],
    )?;

    fetch_card(&conn, card_id)
}

#[tauri::command]
fn reactivate_card(state: State<'_, AppState>, card_id: i64) -> AppResult<Card> {
    let conn = state.db.lock().map_err(lock_err)?;
    conn.execute(
        "UPDATE card SET state = 'new', reps = 0, interval_days = 0, due_at = ?2 WHERE id = ?1",
        params![card_id, now_ts()],
    )?;
    fetch_card(&conn, card_id)
}

// -------------------------------------------------------------------- 杂项命令

#[tauri::command]
fn get_stats(state: State<'_, AppState>) -> AppResult<Stats> {
    let conn = state.db.lock().map_err(lock_err)?;
    let now = now_ts();
    let one = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<i64> {
        conn.query_row(sql, p, |r| r.get(0))
    };

    let total_cards = one("SELECT COUNT(*) FROM card", &[])?;
    let due_now = one(
        "SELECT COUNT(*) FROM card WHERE state != 'suspended' AND due_at <= ?1",
        &[&now],
    )?;
    let learning = one("SELECT COUNT(*) FROM card WHERE state = 'learning'", &[])?;
    let review = one("SELECT COUNT(*) FROM card WHERE state = 'review'", &[])?;
    let suspended = one("SELECT COUNT(*) FROM card WHERE state = 'suspended'", &[])?;
    let total_lookups = one("SELECT COUNT(*) FROM lookup", &[])?;

    // 重复查询率 = 被查过 2 次以上的 (词, 卡包) / 全部去重后的 (词, 卡包)
    let distinct: i64 = one(
        "SELECT COUNT(DISTINCT norm_term || '|' || CAST(deck_id AS TEXT)) FROM lookup",
        &[],
    )?;
    let repeated: i64 = one(
        "SELECT COUNT(*) FROM (SELECT 1 FROM lookup GROUP BY norm_term, deck_id HAVING COUNT(*) >= 2)",
        &[],
    )?;
    let repeat_lookup_ratio = if distinct > 0 { repeated as f64 / distinct as f64 } else { 0.0 };

    Ok(Stats {
        total_cards,
        due_now,
        learning,
        review,
        suspended,
        total_lookups,
        repeat_lookup_ratio,
    })
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    let conn = state.db.lock().map_err(lock_err)?;
    let val = |k: &str, d: &str| get_setting(&conn, k).unwrap_or_else(|| d.to_string());
    let has_key = !val("api_key", "").trim().is_empty();
    Ok(Settings {
        // 不回传明文 key，避免它出现在渲染进程里。
        api_key: if has_key { KEY_PLACEHOLDER.into() } else { String::new() },
        base_url: val("base_url", "https://api.deepseek.com"),
        model: val("model", "deepseek-flash"),
        timeout_secs: timeout_setting(&conn) as i64,
        daily_review_limit: val("daily_review_limit", "15").parse().unwrap_or(15),
        reminder_time: val("reminder_time", "20:00"),
    })
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    let conn = state.db.lock().map_err(lock_err)?;
    // 前端回传 ***configured*** 表示"不改 key"，别把占位符写进去。
    if !settings.api_key.trim().is_empty() && settings.api_key != KEY_PLACEHOLDER {
        put_setting(&conn, "api_key", settings.api_key.trim())?;
    }
    put_setting(&conn, "base_url", settings.base_url.trim())?;
    put_setting(&conn, "model", settings.model.trim())?;
    // 存之前 clamp：脏输入（负数、9999999）不许落库，否则下次读出来还得再修一遍。
    put_setting(
        &conn,
        "timeout_secs",
        &llm::clamp_timeout_secs(settings.timeout_secs).to_string(),
    )?;
    put_setting(&conn, "daily_review_limit", &settings.daily_review_limit.to_string())?;
    put_setting(&conn, "reminder_time", settings.reminder_time.trim())?;
    Ok(())
}

#[tauri::command]
fn cancel_lookup(state: State<'_, AppState>, request_id: String) -> AppResult<bool> {
    Ok(state.cancel_lookup(&request_id))
}

#[tauri::command]
async fn test_llm(state: State<'_, AppState>, settings: Settings) -> AppResult<llm::PingOutcome> {
    let cfg = llm_config_from_form(state.inner(), &settings)?;
    // 连通性测试不挂界面上的「停止」：它自己带超时，而且用户点一次就想看结果。
    llm::ping(&state.http, &cfg, &llm::Cancel::new()).await
}

#[tauri::command]
fn db_location() -> AppResult<String> {
    Ok(db_path().to_string_lossy().to_string())
}

// -------------------------------------------------------------------- 入口

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // .env 只是开发便利；正式配置存 settings 表（PRD §9）。
    let _ = dotenvy::dotenv();

    let path = db_path();
    let conn = db::init(&path).expect("初始化数据库失败");
    seed_settings_from_env(&conn);
    let http = llm::default_client().expect("创建 HTTP 客户端失败");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: Mutex::new(conn),
            http,
            lookups: Mutex::new(HashMap::new()),
        })
        .setup(move |app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title("memory-card");
            }
            println!("[memory-card] 数据库: {}", path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_decks,
            create_deck,
            update_deck,
            delete_deck,
            lookup_term,
            cancel_lookup,
            save_lookup,
            list_cards,
            delete_card,
            list_history,
            list_due_cards,
            review_card,
            reactivate_card,
            get_stats,
            test_llm,
            get_settings,
            save_settings,
            db_location,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
