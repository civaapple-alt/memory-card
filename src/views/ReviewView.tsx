import { useCallback, useEffect, useState } from "react";
import { api, errText } from "../api";
import { useActionBar } from "../actionbar";
import { fmtInterval } from "../format";
import { Badge, Empty, ErrorBar, Panel, Spinner } from "../ui";
import type { Rating, ReviewCard } from "../types";
import { DefinitionBody } from "./DefinitionBody";

const RATINGS: { n: Rating; label: string; hint: string }[] = [
  { n: 1, label: "忘了", hint: "1" },
  { n: 2, label: "勉强", hint: "2" },
  { n: 3, label: "记得", hint: "3" },
  { n: 4, label: "秒答", hint: "4" },
];

export function ReviewView({
  limit,
  onReviewed,
}: {
  limit: number;
  onReviewed: () => void;
}) {
  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [flipAt, setFlipAt] = useState(0);
  const [doneCount, setDoneCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNote(null);
    setFlipped(false);
    setIdx(0);
    setDoneCount(0);
    try {
      const list = await api.listDueCards(limit > 0 ? limit : null);
      setCards(list);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = cards[idx];

  const reveal = useCallback(() => {
    setFlipped((f) => {
      if (!f) setFlipAt(performance.now());
      return true;
    });
  }, []);

  const rate = useCallback(
    async (rating: Rating) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        const spent = flipAt > 0 ? Math.round(performance.now() - flipAt) : 0;
        const updated = await api.reviewCard(current.card.id, rating, spent);
        setNote(
          `${updated.display_term} → ${fmtInterval(updated.interval_days)}后再见` +
            (updated.state === "suspended" ? "（已挂起）" : ""),
        );
        setDoneCount((n) => n + 1);
        setFlipped(false);
        setFlipAt(0);
        setIdx((i) => i + 1);
        onReviewed();
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, flipAt, onReviewed],
  );

  // 键盘是复习的全部效率来源：空格翻面，1-4 评分。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!flipped) reveal();
        return;
      }
      if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        void rate(Number(e.key) as Rating);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, reveal, rate]);

  // D4：翻面/评分同样常驻底部，拇指区就能点完一整轮。
  useActionBar(
    loading || !current ? null : flipped ? (
      <div className="rating-row">
        {RATINGS.map((r) => (
          <button
            key={r.n}
            className={`rate rate-${r.n}`}
            disabled={busy}
            onClick={() => void rate(r.n)}
          >
            <em>{r.hint}</em>
            {r.label}
          </button>
        ))}
      </div>
    ) : (
      <button className="primary action-primary" onClick={reveal}>
        翻面（空格 / Enter）
      </button>
    ),
    [loading, current, flipped, busy, rate, reveal],
  );

  if (loading) {
    return (
      <div className="view center">
        <Spinner />
        <span className="hint">正在取到期卡片…</span>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="view">
        {error && <ErrorBar text={error} onClose={() => setError(null)} />}
        <Empty>
          {doneCount > 0 ? (
            <>
              <div className="big-ok">本轮完成</div>
              <div>复习了 {doneCount} 张。剩下的到期卡会按 SM-2 排到后面几天。</div>
            </>
          ) : (
            <>
              <div className="big-ok">今天没有到期卡片</div>
              <div>去「取词」存几个词，或者稍后再来。</div>
            </>
          )}
        </Empty>
        <div className="row center-row">
          <button onClick={() => void load()}>重新检查</button>
        </div>
      </div>
    );
  }

  const total = cards.length;
  const pct = total > 0 ? Math.round((idx / total) * 100) : 0;

  return (
    <div className="view">
      {error && <ErrorBar text={error} onClose={() => setError(null)} />}

      <div className="review-top">
        <span className="hint">
          {idx + 1} / {total}
        </span>
        <div className="progress">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <Badge>{current.card.deck_name}</Badge>
      </div>

      <Panel
        title={
          <span className="term-title">
            {current.card.display_term}
            {current.pos && <em className="pos">{current.pos}</em>}
          </span>
        }
        actions={
          <span className="hint">
            {current.card.reps === 0
              ? "新卡"
              : `第 ${current.card.reps + 1} 次 · 上次间隔 ${fmtInterval(current.card.interval_days)}`}
          </span>
        }
      >
        {current.context_sentence && (
          <div className="block">
            <div className="block-label">上次的原文</div>
            <div className="quote">{current.context_sentence}</div>
          </div>
        )}

        {flipped ? (
          <DefinitionBody
            domainMeaning={current.domain_meaning}
            inContext={current.in_context}
            examples={current.examples}
            general={current.general_meaning}
          />
        ) : (
          <div className="recall-prompt">
            <div className="hint">先自己想一遍，再翻面（空格 / Enter）</div>
          </div>
        )}
      </Panel>

      {note && <div className="debug">{note}</div>}
      {busy && (
        <div className="row center-row">
          <Spinner />
        </div>
      )}
    </div>
  );
}
