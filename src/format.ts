/** 后端一律用 unix 秒，别把 Date.now() / 1000 忘了。 */

export const nowSec = () => Math.floor(Date.now() / 1000);

export function fmtDateTime(sec: number | null | undefined): string {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间，人话优先。"3 天前" 比时间戳有信息量。 */
export function fmtRelative(sec: number | null | undefined): string {
  if (!sec) return "—";
  const diff = nowSec() - sec;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtDateTime(sec).slice(0, 10);
}

/** 距下次复习还有多久。负数表示已到期。 */
export function fmtDue(dueAt: number): string {
  const diff = dueAt - nowSec();
  if (diff <= 0) return "现在";
  if (diff < 3600) return `${Math.ceil(diff / 60)} 分钟后`;
  if (diff < 86400) return `${Math.ceil(diff / 3600)} 小时后`;
  return `${Math.round(diff / 86400)} 天后`;
}

export function fmtInterval(days: number): string {
  if (days < 1 / 24) return `${Math.round(days * 1440)} 分钟`;
  if (days < 1) return `${Math.round(days * 24)} 小时`;
  if (days < 30) {
    // "1.0 天" 读起来像机器说话；整数就别带小数点。
    const n = Math.round(days * 10) / 10;
    return `${Number.isInteger(n) ? n : n.toFixed(1)} 天`;
  }
  if (days < 365) return `${(days / 30).toFixed(1)} 个月`;
  return `${(days / 365).toFixed(1)} 年`;
}

export function confidenceTone(c: string): "high" | "mid" | "low" | "none" {
  const t = (c || "").toLowerCase();
  if (t.includes("high")) return "high";
  if (t.includes("low")) return "low";
  if (t.includes("med") || t.includes("mid")) return "mid";
  return "none";
}
