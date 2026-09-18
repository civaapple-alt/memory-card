import { useEffect, useState } from "react";
import { api, errText } from "../api";
import { fmtInterval, fmtRelative } from "../format";
import { Badge, Empty, ErrorBar, Field, Panel, Spinner } from "../ui";
import type { Card, Deck } from "../types";

/** "rust, tokio async" 和 "rust、tokio" 都当成三个关键词。 */
function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function DecksView({
  decks,
  onChanged,
}: {
  decks: Deck[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(decks[0]?.id ?? null);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);

  const current = creating ? null : decks.find((d) => d.id === selected) ?? null;

  useEffect(() => {
    if (creating) return;
    if (current) {
      setName(current.name);
      setKeywords(current.keywords.join(", "));
      setDescription(current.description ?? "");
    }
  }, [creating, current]);

  useEffect(() => {
    if (!current) {
      setCards([]);
      return;
    }
    let alive = true;
    setLoadingCards(true);
    api
      .listCards(current.id)
      .then((c) => {
        if (alive) setCards(c);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoadingCards(false);
      });
    return () => {
      alive = false;
    };
  }, [current]);

  const reset = () => {
    setError(null);
    setOk(null);
  };

  const startCreate = () => {
    reset();
    setCreating(true);
    setName("");
    setKeywords("");
    setDescription("");
  };

  const submit = async () => {
    reset();
    const kws = parseKeywords(keywords);
    if (!name.trim()) {
      setError("卡包名不能为空");
      return;
    }
    if (kws.length === 0) {
      setError("至少给一个关键词，否则释义会退回通用词典，等于白用");
      return;
    }
    setBusy(true);
    try {
      const desc = description.trim() ? description.trim() : null;
      if (creating) {
        const d = await api.createDeck(name.trim(), kws, desc);
        setCreating(false);
        setSelected(d.id);
        setOk("卡包已创建");
      } else if (current) {
        await api.updateDeck(current.id, name.trim(), kws, desc);
        setOk("已保存。改关键词会换掉 def_cache 的键，下次查词会重新问模型。");
      }
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    const n = current.card_count;
    if (!window.confirm(`删除卡包「${current.name}」？${n > 0 ? `里面 ${n} 张卡和查词记录会一起删掉。` : ""}`)) {
      return;
    }
    reset();
    setBusy(true);
    try {
      await api.deleteDeck(current.id);
      setSelected(null);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const removeCard = async (cardId: number) => {
    reset();
    try {
      await api.deleteCard(cardId);
      setCards((cs) => cs.filter((c) => c.id !== cardId));
      onChanged();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="view">
      {error && <ErrorBar text={error} onClose={() => setError(null)} />}
      {ok && <div className="notice notice-info">{ok}</div>}

      <Panel
        title="卡包"
        actions={
          <button onClick={startCreate} className={creating ? "seg-on" : ""}>
            + 新建
          </button>
        }
      >
        <ul className="deck-list">
          {decks.map((d) => (
            <li
              key={d.id}
              className={!creating && d.id === selected ? "on" : ""}
              onClick={() => {
                reset();
                setCreating(false);
                setSelected(d.id);
              }}
            >
              <div className="deck-name">{d.name}</div>
              <div className="deck-sub">
                <span className="hint">
                  {d.card_count} 张
                  {d.due_count > 0 ? ` · ${d.due_count} 待复习` : ""}
                </span>
                <span className="chips">
                  {d.keywords.slice(0, 4).map((k) => (
                    <span className="chip" key={k}>
                      {k}
                    </span>
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {decks.length === 0 && !creating && <Empty>还没有卡包，点「新建」</Empty>}
      </Panel>

      {(creating || current) && (
        <Panel title={creating ? "新建卡包" : `编辑：${current?.name ?? ""}`}>
          <Field label="名称">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rust 后端" />
          </Field>
          <Field label="关键词" hint="逗号分隔，会塞进 prompt 限定领域">
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="rust, tokio, async, sqlx"
            />
          </Field>
          <Field label="说明" hint="可选">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="看 Rust 源码和 issue 时存下来的词"
            />
          </Field>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>
              {busy ? <Spinner /> : null}
              {creating ? "创建" : "保存"}
            </button>
            {!creating && <button onClick={() => setCreating(true)}>另建一个</button>}
            {!creating && (
              <button className="danger" onClick={remove} disabled={busy}>
                删除
              </button>
            )}
          </div>
        </Panel>
      )}

      {current && (
        <Panel title={`卡片（${cards.length}）`}>
          {loadingCards && (
            <div className="row center-row">
              <Spinner />
            </div>
          )}
          {!loadingCards && cards.length === 0 && <Empty>这个卡包还没有卡片</Empty>}
          <ul className="card-list">
            {cards.map((c) => (
              <li key={c.id}>
                <div className="card-row">
                  <span className="card-term">{c.display_term}</span>
                  <span className="card-meta">
                    <Badge tone={c.state === "suspended" ? "warn" : "none"}>{c.state}</Badge>
                    <span className="hint">
                      {c.reps} 次 · 间隔 {fmtInterval(c.interval_days)}
                    </span>
                    <span className="hint">
                      {c.last_reviewed_at ? `上次 ${fmtRelative(c.last_reviewed_at)}` : "未复习"}
                    </span>
                  </span>
                  <button className="icon-btn" onClick={() => void removeCard(c.id)} title="删除卡片">
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
