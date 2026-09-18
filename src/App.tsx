import { useCallback, useEffect, useState } from "react";
import { api, errText } from "./api";
import type { Deck, HistoryItem, Stats } from "./types";
import { DecksView } from "./views/DecksView";
import { HistoryView } from "./views/HistoryView";
import { LookupView, type LookupSeed } from "./views/LookupView";
import { ReviewView } from "./views/ReviewView";
import { SettingsView } from "./views/SettingsView";

type Tab = "lookup" | "review" | "history" | "decks" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "lookup", label: "取词" },
  { id: "review", label: "复习" },
  { id: "history", label: "历史" },
  { id: "decks", label: "卡包" },
  { id: "settings", label: "设置" },
];

/** 上次用的卡包存本地：小窗工具，每次开都要重选卡包就等于不用了。 */
const LAST_DECK_KEY = "mc.lastDeckId";

export default function App() {
  const [tab, setTab] = useState<Tab>("lookup");
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [dailyLimit, setDailyLimit] = useState(15);
  const [seed, setSeed] = useState<LookupSeed | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  const refresh = useCallback(async () => {
    const [ds, st] = await Promise.all([api.listDecks(), api.getStats()]);
    setDecks(ds);
    setStats(st);
    setDeckId((cur) => {
      if (cur != null && ds.some((d) => d.id === cur)) return cur;
      const saved = Number(window.localStorage.getItem(LAST_DECK_KEY) ?? "");
      if (saved && ds.some((d) => d.id === saved)) return saved;
      return ds[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (e) {
        setBootError(errText(e));
      }
      try {
        const s = await api.getSettings();
        setDailyLimit(s.daily_review_limit);
      } catch {
        // 设置读不到不致命，用默认值继续。
      }
      setBooting(false);
    })();
  }, [refresh]);

  const safeRefresh = useCallback(() => {
    void refresh().catch((e) => setBootError(errText(e)));
  }, [refresh]);

  const pickDeck = (id: number) => {
    setDeckId(id);
    window.localStorage.setItem(LAST_DECK_KEY, String(id));
  };

  const pickHistory = (item: HistoryItem) => {
    setSeed({
      deckId: item.deck_id,
      term: item.term,
      sentence: item.context_sentence,
      nonce: Date.now(),
    });
    setTab("lookup");
  };

  const dueNow = stats?.due_now ?? 0;

  return (
    <div className="app">
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab tab-on" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "review" && dueNow > 0 && <span className="pill">{dueNow}</span>}
          </button>
        ))}
      </nav>

      {bootError && (
        <div className="errorbar">
          <span>{bootError}</span>
          <button className="icon-btn" onClick={() => setBootError(null)}>
            ×
          </button>
        </div>
      )}

      <main className="content">
        {booting ? (
          <div className="view center">
            <span className="spinner" />
          </div>
        ) : tab === "lookup" ? (
          <LookupView
            decks={decks}
            deckId={deckId}
            onDeckChange={pickDeck}
            seed={seed}
            onSaved={safeRefresh}
          />
        ) : tab === "review" ? (
          <ReviewView limit={dailyLimit} onReviewed={safeRefresh} />
        ) : tab === "history" ? (
          <HistoryView onPick={pickHistory} />
        ) : tab === "decks" ? (
          <DecksView decks={decks} onChanged={safeRefresh} />
        ) : (
          <SettingsView
            stats={stats}
            onSaved={() => {
              safeRefresh();
              void (async () => {
                try {
                  setDailyLimit((await api.getSettings()).daily_review_limit);
                } catch {
                  // 忽略：下次进设置页还会再读一次。
                }
              })();
            }}
          />
        )}
      </main>

      <footer className="statusbar">
        <span>{decks.find((d) => d.id === deckId)?.name ?? "未选卡包"}</span>
        <span>{stats ? `${stats.total_cards} 张卡 · ${dueNow} 待复习` : "—"}</span>
      </footer>
    </div>
  );
}
