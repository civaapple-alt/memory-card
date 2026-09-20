import { useEffect, useState } from "react";
import { api, errText } from "../api";
import { Field, Notice, Panel, Spinner } from "../ui";
import { KEY_PLACEHOLDER, type ConnectionTest, type Settings, type Stats } from "../types";

export function SettingsView({
  stats,
  onSaved,
}: {
  stats: Stats | null;
  onSaved?: () => void;
}) {
  const [form, setForm] = useState<Settings | null>(null);
  const [dbPath, setDbPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setForm(await api.getSettings());
        setDbPath(await api.dbLocation());
      } catch (e) {
        setError(errText(e));
      }
    })();
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    // 这一条测试结论是旧配置的，改完设置就不能再挂在界面上了。
    setTestResult(null);
    try {
      await api.saveSettings(form);
      setMsg("已保存。API Key 明文存在本机数据库里（本地应用，没有别的选择）。");
      setForm(await api.getSettings());
      onSaved?.();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 用表单里**此刻**的值试一次请求 —— 先填 key 再点这一下，通了再保存。
   * 失败时走错误条：它是"这次没通"，不是"设置坏了"。
   */
  const test = async () => {
    if (!form) return;
    setTesting(true);
    setError(null);
    setMsg(null);
    setTestResult(null);
    try {
      setTestResult(await api.testConnection(form));
    } catch (e) {
      setError(`测试连接失败：${errText(e)}`);
    } finally {
      setTesting(false);
    }
  };

  if (!form) {
    return (
      <div className="view center">
        <Spinner />
      </div>
    );
  }

  const keyIsSet = form.api_key === KEY_PLACEHOLDER;

  return (
    <div className="view">
      {error && <div className="errorbar">{error}</div>}
      {msg && <div className="notice notice-info">{msg}</div>}

      <Panel title="模型">
        <Field
          label="API Key"
          hint={keyIsSet ? "已配置（留空不改）" : "必填"}
        >
          <input
            type="password"
            value={form.api_key}
            placeholder="sk-..."
            onChange={(e) => set("api_key", e.target.value)}
            onFocus={(e) => {
              if (keyIsSet) e.target.select();
            }}
          />
        </Field>
        <Field label="Base URL">
          <input value={form.base_url} onChange={(e) => set("base_url", e.target.value)} />
        </Field>
        <Field label="模型" hint="deepseek-flash">
          <input value={form.model} onChange={(e) => set("model", e.target.value)} />
        </Field>
        <Field label="请求超时" hint="秒（5–300）；超过就放弃这次查询，不用一直等">
          <input
            type="number"
            min={5}
            max={300}
            value={form.timeout_secs}
            onChange={(e) => set("timeout_secs", Number(e.target.value) || 0)}
          />
        </Field>
        {testResult && (
          <Notice>
            连接正常 · {testResult.model} · {testResult.elapsed_ms}ms
            {testResult.reply ? ` · 模型回「${testResult.reply}」` : ""}
          </Notice>
        )}
      </Panel>

      <Panel title="复习">
        <Field label="每日复习上限" hint="0 表示不限">
          <input
            type="number"
            min={0}
            value={form.daily_review_limit}
            onChange={(e) => set("daily_review_limit", Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="提醒时间" hint="HH:MM，通知功能还没接">
          <input
            type="time"
            value={form.reminder_time}
            onChange={(e) => set("reminder_time", e.target.value)}
          />
        </Field>
      </Panel>

      <div className="row">
        <button className="primary" onClick={save} disabled={busy}>
          {busy ? <Spinner /> : null}
          保存设置
        </button>
        {/* 先试再存：key/地址写错了不用等到下次查词才发现。 */}
        <button onClick={test} disabled={busy || testing}>
          {testing ? <Spinner /> : null}
          {testing ? "测试中…" : "测试连接"}
        </button>
        <span className="hint">测试用表单里此刻的值</span>
      </div>

      <Panel title="数据">
        {stats && (
          <dl className="stat-grid">
            <div>
              <dt>卡片</dt>
              <dd>{stats.total_cards}</dd>
            </div>
            <div>
              <dt>待复习</dt>
              <dd>{stats.due_now}</dd>
            </div>
            <div>
              <dt>学习中</dt>
              <dd>{stats.learning}</dd>
            </div>
            <div>
              <dt>复习中</dt>
              <dd>{stats.review}</dd>
            </div>
            <div>
              <dt>挂起</dt>
              <dd>{stats.suspended}</dd>
            </div>
            <div>
              <dt>查词总数</dt>
              <dd>{stats.total_lookups}</dd>
            </div>
            <div>
              <dt>重复查询率</dt>
              <dd>{(stats.repeat_lookup_ratio * 100).toFixed(0)}%</dd>
            </div>
          </dl>
        )}
        <Field label="数据库位置" hint="换机器时复制这个文件">
          <input
            readOnly
            value={dbPath}
            onFocus={(e) => e.target.select()}
          />
        </Field>
      </Panel>

      <div className="debug">
        还没接的功能：剪贴板监听、托盘图标、到期通知、释义手工编辑、个人术语表界面。
      </div>
    </div>
  );
}
