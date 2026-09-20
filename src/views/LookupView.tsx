import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText, newRequestId } from "../api";
import { useActionBar } from "../actionbar";
import { classifyContext, classifyTerm } from "../dragdrop";
import { confidenceTone, fmtDue, nowSec } from "../format";
import { Badge, ErrorBar, Field, Notice, Panel, Spinner } from "../ui";
import type { Card, Deck, LookupResult } from "../types";
import { DefinitionBody } from "./DefinitionBody";

export interface LookupSeed {
  deckId: number;
  /** 要查的词。拖进来的是一句话时这里是空的 —— 那时候只填句子框，不查。 */
  term: string;
  sentence: string | null;
  /** 每次点击历史条目都要能重新触发，所以带一个自增序号。 */
  nonce: number;
}

export function LookupView({
  active,
  decks,
  deckId,
  onDeckChange,
  seed,
  onSaved,
  timeoutSecs,
}: {
  /** 本页当前是否在前台。常驻挂载（切标签页不卸载）时，后台页要让出动作栏和全局键盘。 */
  active: boolean;
  decks: Deck[];
  deckId: number | null;
  onDeckChange: (id: number) => void;
  seed: LookupSeed | null;
  onSaved: () => void;
  /** 后端那次查词的最长等待（秒），只用来在界面上说实话。 */
  timeoutSecs: number;
}) {
  /** 要查的词 / 短语。 */
  const [termInput, setTermInput] = useState("");
  /** 它出现的那句话（可选）。 */
  const [ctxInput, setCtxInput] = useState("");
  /** 句子框默认收起：多数查词只需要上面一个框。 */
  const [ctxOpen, setCtxOpen] = useState(false);
  const termRef = useRef<HTMLTextAreaElement | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [saved, setSaved] = useState<Card | null>(null);
  const [saving, setSaving] = useState(false);
  /** 出结果后收起输入区，把屏幕让给释义；点"换个词"再展开。 */
  const [compose, setCompose] = useState(true);
  /** 正在跑的那次请求的 id：停止按钮靠它精确打中这一次。 */
  const [requestId, setRequestId] = useState<string | null>(null);
  /**
   * 要求把焦点交给词框的计数器。
   *
   * 不直接调 `termRef.current.focus()`：需要聚焦的时机（拖进来一句话、把整句挪走）
   * 都发生在"输入区刚从收起变展开"的同一次渲染里，那时 textarea 还没挂上。
   * 加一个自增的值，等它渲染完再聚焦。
   */
  const [focusTerm, setFocusTerm] = useState(0);
  const abortRef = useRef(0);

  const run = useCallback(
    async (term: string, sentence: string | null, useDeckId: number) => {
      const text = term.trim();
      if (!text) {
        setError("请输入要查询的词或短语");
        return;
      }
      // 两个身份各管一件事：requestId 给后端（停止按它命中那一次），
      // token 给这里（认领"过期结果"）。它们的失效时机必须一致 ——
      // 谁让 token 过期，谁就得负责把那一次后端请求停掉，否则会留下一个没人看的在飞请求。
      const id = newRequestId();
      const token = ++abortRef.current;
      setRequestId(id);
      setBusy(true);
      setStopped(false);
      setError(null);
      setResult(null);
      setSaved(null);
      setElapsed(0);
      try {
        const r = await api.lookupTerm(
          id,
          useDeckId,
          text,
          sentence && sentence.trim() ? sentence : null,
        );
        if (token !== abortRef.current) return;
        setResult(r);
        setCompose(false);
      } catch (e) {
        // 停止之后后端也会 reject 一次（"已停止"），但它同样是过期结果：
        // 界面在 stop() 里已经说清楚了，再弹一条红色错误条只是噪音。
        if (token !== abortRef.current) return;
        setError(errText(e));
      } finally {
        if (token === abortRef.current) {
          setBusy(false);
          setRequestId(null);
        }
      }
    },
    [],
  );

  /** 停止这次查词：先作废 token（迟到的响应不许再改界面），再通知后端别再等了。 */
  const stop = useCallback(() => {
    const id = requestId;
    abortRef.current += 1;
    setBusy(false);
    setRequestId(null);
    setStopped(true);
    if (id) void api.cancelLookup(id).catch(() => {});
  }, [requestId]);

  // 历史里点一条 / 拖进来一段文本 → 回填；词和句子两边都齐了才直接查。
  useEffect(() => {
    if (!seed) return;
    setTermInput(seed.term);
    setCtxInput(seed.sentence ?? "");
    setCompose(true);
    setError(null);
    if (seed.sentence) setCtxOpen(true);
    if (!seed.term.trim()) {
      // 拖进来的是一句话：要查的词还没说清，不查 —— 只摆好，等用户写词。
      setFocusTerm((n) => n + 1);
      return;
    }
    void run(seed.term, seed.sentence, seed.deckId);
  }, [seed, run]);

  // 等词框真的挂上再聚焦（见 focusTerm 的注释）。
  useEffect(() => {
    if (focusTerm > 0) termRef.current?.focus();
  }, [focusTerm]);

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
    // 词和句子各判各的 —— 这两样东西从此不再共用同一个字符串（见 dragdrop 顶部注释）。
    const cls = classifyTerm(termInput);
    if (cls.kind === "asSentence") {
      // 用户把一整句贴进了"要查的词"：把它挪到该在的框里。不丢内容，也不拿它当词去查。
      setCtxInput(termInput);
      setCtxOpen(true);
      setTermInput("");
      setError(cls.reason);
      setFocusTerm((n) => n + 1);
      return;
    }
    if (cls.kind === "reject") {
      setError(cls.reason);
      return;
    }
    // 句子是可选的；但既然填了，就得是一句像样的话 —— 否则宁可不查，
    // 免得把一段代码或一个路径当成"它出现的语境"塞给模型。
    let sentence: string | null = null;
    if (ctxInput.trim()) {
      const ctx = classifyContext(ctxInput);
      if (ctx.kind === "reject") {
        setCtxOpen(true);
        setError(ctx.reason);
        return;
      }
      sentence = ctx.text;
    }
    void run(cls.text, sentence, deckId);
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
  /** 收起输入区后，句子框里留着什么要能看见 —— 否则释义里的「原文」是凭空冒出来的。 */
  const ctxPreview = ctxInput.trim();
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
      if (e.key === "Escape" && busy) {
        // 查询中 Esc = 停止，和「停止」按钮走同一条路径。
        e.preventDefault();
        stop();
      } else if (e.key === "Enter" && result && !saved && !saving && !interactive) {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        setResult(null);
        setSaved(null);
        setError(null);
        setStopped(false);
        setCompose(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, busy, result, saved, saving, save, stop]);

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
      {stopped && (
        <Notice>
          已停止：不再等这次响应了。服务端可能还在算，但结果不会再进这里。
        </Notice>
      )}

      {composing ? (
        <Panel title="取词" actions={<span className="hint">一个词 + 可选的一句话</span>}>
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

          <Field label="要查的词 / 短语">
            <textarea
              className="input-term"
              rows={1}
              ref={termRef}
              placeholder="handle / ship it / bounded queue"
              value={termInput}
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>

          {/* 句子框默认收起：多数查词只要上面那个框，多一个框就多一份犹豫。
              但要查的词常常长在一句话里，那条路必须点得到，所以标题一直在。 */}
          <div className="ctx-head">
            <button type="button" className="ctx-toggle" onClick={() => setCtxOpen((v) => !v)}>
              {ctxOpen ? "▾" : "▸"} 补充句子（可选）
            </button>
            {!ctxOpen && ctxPreview !== "" && (
              <span className="hint">已填 {ctxPreview.length} 字</span>
            )}
          </div>

          {ctxOpen && (
            <>
              <textarea
                className="input-ctx"
                rows={2}
                placeholder="把这句话贴在这里：the request handler returns a promise"
                value={ctxInput}
                onChange={(e) => setCtxInput(e.target.value)}
              />
              <div className="hint ctx-hint">
                贴上它出现的那句话，释义就按这句话来解；留空则只按卡包领域解释这个词。
                要的是那一句（≤300 字），不是整段。
              </div>
            </>
          )}

          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? <Spinner /> : null}
              {busy ? `查询中 ${(elapsed / 1000).toFixed(1)}s` : "查询"}
            </button>
            {/* 卡住的时候，用户最想找的就是这个按钮 —— 它必须一直在，不用滚动、不用猜。 */}
            {busy && (
              <button className="danger" onClick={stop}>
                停止
              </button>
            )}
            <span className="hint">
              {busy
                ? `最长等 ${timeoutSecs}s，超了自动停 · 也可以按 Esc`
                : "Enter 查询 · Shift+Enter 换行"}
            </span>
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
          <div className="compact-term">{termInput.trim()}</div>
          {ctxPreview !== "" && (
            <div className="hint compact-ctx">
              附句子：{ctxPreview.length > 80 ? `${ctxPreview.slice(0, 80)}…` : ctxPreview}
            </div>
          )}
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
