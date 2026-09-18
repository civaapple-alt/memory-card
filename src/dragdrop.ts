/**
 * 拖入内容的判断。
 *
 * 单独成模块是因为它是纯函数、能单独验证 —— 而"拖进一大段代码就白烧一次请求"
 * 这种事，盯着界面是看不出来的。
 *
 * 规则来自 PRD §4.2：长度、行数、像路径/URL/纯数字/base64、拉丁字符占比。
 */

export type DropClass =
  | { kind: "term"; text: string }
  | { kind: "sentence"; text: string }
  | { kind: "reject"; reason: string };

/** 超过这个长度基本是整段文字或代码，不是要查的词。 */
const MAX_CHARS = 300;
/** 多光标选中带出来的换行，超过两行就不是"一个词或一句话"了。 */
const MAX_LINES = 2;
/** 词与句子的分界。 */
const TERM_MAX_WORDS = 3;
const TERM_MAX_CHARS = 40;

function collapse(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 拉丁字母占所有字母的比例。中文内容会被判掉。 */
function latinRatio(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters) return 0;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, "");
  return latin.length / letters.length;
}

export function classifyDrop(raw: string): DropClass {
  if (!raw.trim()) return { kind: "reject", reason: "拖进来的东西里没有文本。" };

  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const text = collapse(raw);

  if (text.length > MAX_CHARS) {
    return {
      kind: "reject",
      reason: `太长了（${text.length} 字，上限 ${MAX_CHARS}）—— 拖一个词或一句话进来；整段文字请切到「句子」模式粘贴。`,
    };
  }
  if (lines.length > MAX_LINES) {
    return {
      kind: "reject",
      reason: `跨了 ${lines.length} 行，看着像代码块或整段文本 —— 只拖一个词，或切到「句子」模式粘贴。`,
    };
  }
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])/.test(text)) {
    return { kind: "reject", reason: "看着像文件路径。" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { kind: "reject", reason: "看着像 URL。" };
  }
  if (/^[\d\s.,:%+\-/]+$/.test(text)) {
    return { kind: "reject", reason: "全是数字和符号，没有可查的词。" };
  }
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(text)) {
    return { kind: "reject", reason: "看着像 base64 或哈希值。" };
  }
  // 括号/分号/箭头出现在要查的英文词或句里几乎没有正当理由，所以不设长度门槛 ——
  // `const x = 1;` 这种短代码行也必须拦住，否则它会被当成"句子"送去查。
  // 故意不拦 `()`：`handle()` 这种带括号的写法是真会想去查的。
  if (/[{};]|=>|->|::/.test(text)) {
    return {
      kind: "reject",
      reason: "看着像代码（有括号、分号或箭头）—— 只拖要查的词，或切到「句子」模式粘贴。",
    };
  }
  if (latinRatio(text) < 0.5) {
    return { kind: "reject", reason: "大部分不是拉丁字母 —— 这个工具是查英文技术词汇的。" };
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length <= TERM_MAX_WORDS && text.length <= TERM_MAX_CHARS) {
    return { kind: "term", text };
  }
  return { kind: "sentence", text };
}

/** 从 DataTransfer 里取纯文本。文件拖拽没有文本，返回空串。 */
export function readDropText(dt: DataTransfer | null): string {
  if (!dt) return "";
  const plain = dt.getData("text/plain");
  if (plain) return plain;
  try {
    return dt.getData("text/uri-list") || "";
  } catch {
    // 某些来源在 dragover 阶段读 getData 会抛，忽略。
    return "";
  }
}

export function dropHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}
