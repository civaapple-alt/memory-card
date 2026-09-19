import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "../api";
import { useActionBar } from "../actionbar";
import { classifyDrop } from "../dragdrop";
import { confidenceTone, fmtDue, nowSec } from "../format";
import { Badge, ErrorBar, Field, Notice, Panel, Spinner } from "../ui";
import type { Card, Deck, LookupResult } from "../types";
import { DefinitionBody } from "./DefinitionBody";

export interface LookupSeed {
  deckId: number;
  term: string;
  sentence: string | null;
  /** 每次点击历史条目都要能重新触发，所以带一个自增序号。 */
  nonce: number;
}

type Mode = "word" | "sentence";

export function LookupView({
  active,
  decks,
  deckId,
  onDeckChange,
  seed,
  onSaved,
}: {
  /** 本页当前是否在前台。常驻挂载（切标签页不卸载）时，后台页要让出动作栏和全局键盘。 */
  active: boolean;
  decks: Deck[];
  deckId: number | null;
  onDeckChange: (id: number) => void;
  seed: LookupSeed | null;
  onSaved: () => void;
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);
  /** 出结果后收起输入区，把屏幕让给释义；点"换个词"再展开。 */
  const [compose, setCompose] = useState(true);
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
        setCompose(false);
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
    const text = input.trim();
    if (!text) {
      setError("请输入要查询的词或句子");
      return;
    }
    // D1：不再让用户自己选单词/句子，交给 dragdrop 里同一个分类器判断。
    const cls = classifyDrop(text);
    if (cls.kind === "reject") {
      setError(cls.reason);
      return;
    }
    void run(text, cls.kind === "sentence" ? "sentence" : "word", deckId);
  };

  const save = useCallback(async () => {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      // 卡片用 lemma 而不是原始输入：handle/handles/handling 才能落成同一张卡。
      const termForCard = (result.definition.lemma || result.term).trim();
      // 存进**这条释义所属的卡包**（result.deck_id），不是下拉框此刻选中的那个：
      // 释义是用那个卡包的关键词限定算出来的，塞进别的卡包就串领域了
      // （term_key 带 deck_id，那会变成另一张新卡）。动作栏上的文案也用的是 result.deck_name，
      // 两者同源才对得上。
      const card = await api.saveLookup(
        result.deck_id,
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
  }, [result, onSaved]);

  const d = result?.definition;
  const termForCard = d ? (d.lemma || result!.term).trim() : "";
  const tone = confidenceTone(d?.confidence ?? "");
  const curDeck = decks.find((dk) => dk.id === deckId) ?? null;
  const composing = !result || compose;
  /** 这个词在 result 所属卡包里已经有卡了 —— 主操作是"更新释义"而不是"存入新卡"。 */
  const existing = result?.existing_in_deck ?? null;

  // D4：出结果后 Enter 直接入库、Esc 丢弃；焦点在输入框里时不拦。
  useEffect(() => {
    // 后台（被藏起来的）页面不响应键盘 —— 否则在复习页按 Esc 会把取词页的结果清掉。
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 焦点在任何可交互控件上时，Enter 交还给该控件（按钮激活、Tab 导航都要它），
      // 只有焦点落在"空白处"才升级成主操作。
      const interactive =
        !!t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "Enter" && result && !saved && !saving && !interactive) {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        setResult(null);
        setSaved(null);
        setError(null);
        setCompose(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, result, saved, saving, save]);

  // D4：主操作进底部常驻动作栏，永远不用滚动去找它。
  useActionBar(
    result ? (
      saved ? (
        <span className="hint action-done">
          {/* 落在哪个卡包以后端返回的卡为准（saved.deck_name），不是请求里那个：
              这句话是在陈述"刚才发生了什么"，万一两者不一致，它必须说实话。 */}
          {existing ? "已更新" : "已存入"}「{saved.deck_name}」· {saved.display_term}
        </span>
      ) : (
        <>
          {/* 卡已经存在时，光写"存入"是在骗人 —— 写清楚这一步实际发生了什么。 */}
          {existing && (
            <span className="hint action-note">
              已有卡 · 复习 {existing.reps} 次
            </span>
          )}
          <button className="primary action-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : null}
            {saving
              ? "入库中…"
              : existing
                ? `更新「${result.deck_name}」释义`
                : `存入「${result.deck_name}」`}
          </button>
        </>
      )
    ) : null,
    [result, saved, saving, save, existing],
    active,
  );

  return (
    <div className="view">
      {error && <ErrorBar text={error} onClose={() => setError(null)} />}

      {composing ? (
        <Panel title="取词" actions={<span className="hint">单词 / 句子自动识别</span>}>
          <Field label="卡包">
            <select
              value={deckId ?? ""}
              onChange={(e) => onDeckChange(Number(e.target.value))}
            >
              {decks.length === 0 && <option value="">（还没有卡包）</option>}
              {decks.map((dk) => (
                <option key={dk.id} value={dk.id}>
                  {dk.name}
                </option>
              ))}
            </select>
            {curDeck && curDeck.keywords.length > 0 && (
              <div className="hint deck-hint">领域：{curDeck.keywords.join(" / ")}</div>
            )}
          </Field>

          <textarea
            className="input-term"
            rows={input.trim().length > 40 ? 3 : 1}
            placeholder="handle / ship it / 直接贴一整句英文"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
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
            <span className="hint">Enter 查询 · Shift+Enter 换行</span>
          </div>
        </Panel>
      ) : (
        <Panel
          title="取词"
          actions={
            <button className="icon-btn" onClick={() => setCompose(true)}>
              换个词
            </button>
          }
        >
          <div className="compact-term">{input.trim()}</div>
        </Panel>
      )}

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
            <DefinitionBody
              domainMeaning={d.domain_meaning}
              inContext={d.in_context}
              sentence={result.sentence}
              examples={d.examples}
              collocations={d.collocations}
              general={d.general_meaning}
            />
          </Panel>

          {(result.existing_in_deck ||
            result.existing_elsewhere.length > 0 ||
            saved) && (
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
              {saved && (
                <Notice tone="info">
                  {existing ? "已更新" : "已存入"} <b>{saved.deck_name}</b>：{saved.display_term}
                  {saved.due_at <= nowSec()
                    ? "（现在就可以复习）"
                    : `（${fmtDue(saved.due_at)}复习）`}
                </Notice>
              )}
            </Panel>
          )}

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
