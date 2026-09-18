import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "../api";
import { confidenceTone, fmtDue, nowSec } from "../format";
import { Badge, ErrorBar, Field, Notice, Panel, Spinner } from "../ui";
import type { Card, Deck, LookupResult } from "../types";

export interface LookupSeed {
  deckId: number;
  term: string;
  sentence: string | null;
  /** 每次点击历史条目都要能重新触发，所以带一个自增序号。 */
  nonce: number;
}

type Mode = "word" | "sentence";

export function LookupView({
  decks,
  deckId,
  onDeckChange,
  seed,
  onSaved,
}: {
  decks: Deck[];
  deckId: number | null;
  onDeckChange: (id: number) => void;
  seed: LookupSeed | null;
  onSaved: () => void;
}) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("word");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef(0);

  const run = useCallback(
    async (term: string, useMode: Mode, useDeckId: number) => {
      const text = term.trim();
      if (!text) {
        setError("请输入要查询的词或短语");
        return;
      }
      const token = ++abortRef.current;
      setBusy(true);
      setError(null);
      setResult(null);
      setSaved(null);
      setElapsed(0);
      try {
        const r = await api.lookupTerm(
          useDeckId,
          text,
          useMode === "sentence" ? text : null,
        );
        if (token !== abortRef.current) return;
        setResult(r);
      } catch (e) {
        if (token !== abortRef.current) return;
        setError(errText(e));
      } finally {
        if (token === abortRef.current) setBusy(false);
      }
    },
    [],
  );

  // 历史里点一条 → 回填并直接查。
  useEffect(() => {
    if (!seed) return;
    setInput(seed.term);
    setMode(seed.sentence ? "sentence" : "word");
    void run(seed.term, seed.sentence ? "sentence" : "word", seed.deckId);
  }, [seed, run]);

  // 请求进行中让计时器自己跑，否则用户看不到"卡了多久"。
  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const id = window.setInterval(() => setElapsed(performance.now() - t0), 100);
    return () => window.clearInterval(id);
  }, [busy]);

  const submit = () => {
    if (deckId == null) {
      setError("先选一个卡包 —— 释义要靠卡包关键词限定领域");
      return;
    }
    void run(input, mode, deckId);
  };

  const save = async () => {
    if (!result || deckId == null) return;
    setSaving(true);
    setError(null);
    try {
      // 卡片用 lemma 而不是原始输入：handle/handles/handling 才能落成同一张卡。
      const termForCard = (result.definition.lemma || result.term).trim();
      const card = await api.saveLookup(
        deckId,
        termForCard,
        result.sentence,
        result.definition,
        "manual",
      );
      setSaved(card);
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const d = result?.definition;
  const termForCard = d ? (d.lemma || result!.term).trim() : "";
  const tone = confidenceTone(d?.confidence ?? "");

  return (
    <div className="view">
      {error && <ErrorBar text={error} onClose={() => setError(null)} />}

      <Panel
        title="取词"
        actions={
          <div className="seg">
            <button
              className={mode === "word" ? "seg-on" : ""}
              onClick={() => setMode("word")}
            >
              单词
            </button>
            <button
              className={mode === "sentence" ? "seg-on" : ""}
              onClick={() => setMode("sentence")}
            >
              句子
            </button>
          </div>
        }
      >
        <Field label="卡包" hint="决定释义的领域">
          <select
            value={deckId ?? ""}
            onChange={(e) => onDeckChange(Number(e.target.value))}
          >
            {decks.length === 0 && <option value="">（还没有卡包）</option>}
            {decks.map((dk) => (
              <option key={dk.id} value={dk.id}>
                {dk.name}
                {dk.keywords.length > 0 ? ` · ${dk.keywords.join("/")}` : ""}
              </option>
            ))}
          </select>
        </Field>

        <textarea
          className="input-term"
          rows={mode === "sentence" ? 3 : 1}
          placeholder={mode === "sentence" ? "贴一整句英文" : "handle / ship it / bounded"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.shiftKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="row">
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy ? `查询中 ${(elapsed / 1000).toFixed(1)}s` : "查询"}
          </button>
          <span className="hint">Ctrl+Enter</span>
        </div>
      </Panel>

      {d && result && (
        <>
          <Panel
            title={
              <span className="term-title">
                {termForCard || result.term}
                {d.pos && <em className="pos">{d.pos}</em>}
              </span>
            }
            actions={
              <>
                {d.confidence && <Badge tone={tone}>置信 {d.confidence}</Badge>}
                {result.from_cache && <Badge tone="ok">缓存</Badge>}
              </>
            }
          >
            <div className="meaning">{d.domain_meaning || "（模型没给出领域释义）"}</div>

            {d.in_context && (
              <div className="block">
                <div className="block-label">在这句话里</div>
                <div>{d.in_context}</div>
              </div>
            )}

            {result.sentence && (
              <div className="block">
                <div className="block-label">原文</div>
                <div className="quote">{result.sentence}</div>
              </div>
            )}

            {d.why_translation_fails && (
              <div className="block why">
                <div className="block-label">为什么通用翻译会错</div>
                <div>{d.why_translation_fails}</div>
              </div>
            )}

            {d.general_meaning && (
              <div className="block dim">
                <div className="block-label">通用义（对照）</div>
                <div>{d.general_meaning}</div>
              </div>
            )}

            {d.examples.length > 0 && (
              <div className="block">
                <div className="block-label">例句</div>
                <ul className="examples">
                  {d.examples.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}

            {d.collocations.length > 0 && (
              <div className="block">
                <div className="block-label">常见搭配</div>
                <div className="chips">
                  {d.collocations.map((c, i) => (
                    <span className="chip" key={i}>
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          <Panel title="入卡">
            {result.existing_in_deck && (
              <Notice tone="warn">
                当前卡包已有这个卡（复习 {result.existing_in_deck.reps} 次）。再次存入只更新释义，
                <b>复习进度保留</b>。
              </Notice>
            )}
            {result.existing_elsewhere.length > 0 && (
              <Notice>
                其他卡包也有：
                {result.existing_elsewhere
                  .map((c) => `${c.deck_name}（${c.reps} 次）`)
                  .join("、")}
                。同一个词在不同卡包是独立的两张卡，这是有意的。
              </Notice>
            )}
            {saved ? (
              <Notice tone="info">
                已存入 <b>{result.deck_name}</b>：{saved.display_term}
                {saved.due_at <= nowSec()
                  ? "（现在就可以复习）"
                  : `（${fmtDue(saved.due_at)}复习）`}
              </Notice>
            ) : (
              <div className="row">
                <button className="primary" onClick={save} disabled={saving}>
                  {saving ? <Spinner /> : null}
                  存入卡包「{result.deck_name}」
                </button>
                <span className="hint">卡片词形：{termForCard}</span>
              </div>
            )}
          </Panel>

          <div className="debug">
            {[
              result.from_cache ? "来源 缓存" : "来源 模型",
              `耗时 ${result.elapsed_ms}ms`,
              result.attempts > 1 ? `重试 ${result.attempts} 次` : null,
              result.completion_tokens > 0 ? `输出 ${result.completion_tokens} tokens` : null,
              result.cache_miss_tokens > 0 || result.cache_hit_tokens > 0
                ? `前缀缓存 ${result.cache_hit_tokens}/${result.cache_hit_tokens + result.cache_miss_tokens} tokens`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </>
      )}
    </div>
  );
}
