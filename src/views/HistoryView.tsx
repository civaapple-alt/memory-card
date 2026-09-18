import { useCallback, useEffect, useState } from "react";
import { api, errText } from "../api";
import { fmtRelative } from "../format";
import { Badge, Empty, ErrorBar, Panel, Spinner } from "../ui";
import type { HistoryItem } from "../types";

export function HistoryView({
  onPick,
}: {
  onPick: (item: HistoryItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listHistory(q.trim() ? q.trim() : null, 200));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 输入防抖，避免每敲一个字母就打一次数据库。
  useEffect(() => {
    const id = window.setTimeout(() => void load(query), 250);
    return () => window.clearTimeout(id);
  }, [query, load]);

  return (
    <div className="view">
      {error && <ErrorBar text={error} onClose={() => setError(null)} />}

      <Panel title="历史">
        <input
          className="input-search"
          placeholder="搜词 / 搜释义里的字"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && (
          <div className="row center-row">
            <Spinner />
          </div>
        )}
        {!loading && items.length === 0 && (
          <Empty>{query ? `没有匹配「${query}」的记录` : "还没有查过任何词"}</Empty>
        )}
        <ul className="history">
          {items.map((it) => (
            <li key={it.lookup_id} onClick={() => onPick(it)} title="点击重新查询">
              <div className="history-head">
                <span className="history-term">{it.term}</span>
                <span className="history-meta">
                  {it.has_card ? <Badge tone="ok">有卡</Badge> : <Badge>未入卡</Badge>}
                  <span className="hint">{fmtRelative(it.created_at)}</span>
                </span>
              </div>
              <div className="history-sub">
                <span className="hint">{it.deck_name}</span>
                <span className="history-def">{it.domain_meaning}</span>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
