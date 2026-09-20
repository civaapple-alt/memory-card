import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errText } from "./api";
import { ActionBarContext } from "./actionbar";
import { classifyDrop, dropHasFiles, readDropText } from "./dragdrop";
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
  /** 后端每次查词的最长等待（秒），只用于界面上如实显示。 */
  const [llmTimeout, setLlmTimeout] = useState(45);
  const [seed, setSeed] = useState<LookupSeed | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  /** 底部常驻动作栏的内容：由当前页通过 useActionBar 注入（计划 D4）。 */
  const [actionBar, setActionBar] = useState<ReactNode>(null);
  /** dragenter/dragleave 会为每个子元素各来一次，所以用计数器而不是布尔值。 */
  const dragDepth = useRef(0);

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
        setLlmTimeout(s.timeout_secs);
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
    // 历史条目带着它当时用的卡包，一起切过去：否则会出现"释义是在 A 卡包算的、
    // 状态栏和卡包下拉却写着 B"，存入也就落到 B 去了。
    pickDeck(item.deck_id);
    setSeed({
      deckId: item.deck_id,
      term: item.term,
      sentence: item.context_sentence,
      nonce: Date.now(),
    });
    setTab("lookup");
  };

  const handleDrop = useCallback(
    (raw: string) => {
      const cls = classifyDrop(raw);
      if (cls.kind === "reject") {
        // PRD §4.2：判断不过就只提示，不自动查 —— 免得拖错东西白烧一次请求。
        setDropNotice(cls.reason);
        return;
      }
      if (deckId == null) {
        setDropNotice("先选一个卡包 —— 释义要靠卡包关键词限定领域。");
        setTab("lookup");
        return;
      }
      setDropNotice(null);
      setSeed({
        deckId,
        term: cls.text,
        sentence: cls.kind === "sentence" ? cls.text : null,
        nonce: Date.now(),
      });
      setTab("lookup");
    },
    [deckId],
  );

  // 拖拽取词：不做剪贴板监听之后，这是唯一能降低摩擦的取词路径（PRD §4.2），
  // 所以整个窗口都是放置区。
  //
  // 必须 preventDefault：WebView2 对拖进来的文件默认行为是**直接导航过去**，
  // 那样整个 app 就没了。dragover 上不 preventDefault 则根本收不到 drop。
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    };
    const onOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      if (dropHasFiles(e.dataTransfer)) {
        setDropNotice("拖进来的是文件，不是文字。");
        return;
      }
      handleDrop(readDropText(e.dataTransfer));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleDrop]);

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

      {dropNotice && (
        <div className="dropbar">
          <span>{dropNotice}</span>
          <button className="icon-btn" onClick={() => setDropNotice(null)}>
            ×
          </button>
        </div>
      )}

      <ActionBarContext.Provider value={setActionBar}>
        <main className="content">
        {booting ? (
          <div className="view center">
            <span className="spinner" />
          </div>
        ) : (
          <>
            {/*
              取词页**常驻挂载**，切标签页只切 display、不卸载。
              它身上挂着一次已经付过钱的模型结果，卸载即丢失 —— "查完切去复习，回来全空了"
              就是这么来的。代价是它会在启动时就挂上（它自己不发任何请求），
              并且要靠 active 让出动作栏和全局键盘（见 useActionBar / 下面的 keydown）。

              其余页反过来：每次进入重新查库才是对的（历史要看到新记录、复习要看到刚到期的卡），
              所以照旧按需挂载。
            */}
            <div hidden={tab !== "lookup"}>
              <LookupView
                active={tab === "lookup"}
                decks={decks}
                deckId={deckId}
                onDeckChange={pickDeck}
                seed={seed}
                onSaved={safeRefresh}
                timeoutSecs={llmTimeout}
              />
            </div>
            {tab === "review" && <ReviewView limit={dailyLimit} onReviewed={safeRefresh} />}
            {tab === "history" && <HistoryView onPick={pickHistory} />}
            {tab === "decks" && <DecksView decks={decks} onChanged={safeRefresh} />}
            {tab === "settings" && (
              <SettingsView
                stats={stats}
                onSaved={() => {
                  safeRefresh();
                  void (async () => {
                    try {
                      const s = await api.getSettings();
                      setDailyLimit(s.daily_review_limit);
                      setLlmTimeout(s.timeout_secs);
                    } catch {
                      // 忽略：下次进设置页还会再读一次。
                    }
                  })();
                }}
              />
            )}
          </>
        )}
        </main>
      </ActionBarContext.Provider>

      {actionBar !== null && <div className="actionbar">{actionBar}</div>}

      <footer className="statusbar">
        <span>{decks.find((d) => d.id === deckId)?.name ?? "未选卡包"}</span>
        <span>{stats ? `${stats.total_cards} 张卡 · ${dueNow} 待复习` : "—"}</span>
      </footer>

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">松手即查</div>
        </div>
      )}
    </div>
  );
}
