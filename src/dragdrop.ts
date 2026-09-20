/**
 * 输入分类：用户给的这段文字里，哪个是"要查的词"，哪个是"它出现的句子"。
 *
 * 单独成模块是因为它是纯函数、能单独验证 —— 而"拖进一大段代码就白烧一次请求"
 * 这种事，盯着界面是看不出来的。
 *
 * 规则来自 PRD §4.2（长度、行数、像路径/URL/纯数字/base64、拉丁字符占比）。
 * 和当时不同的是：现在输入区有两个框，落进哪个框决定了 term 和 sentence 各是什么，
 * 所以"是词还是句"不再由长度替用户决定 —— 词框只收词，句子一律进句子框。
 */

export type TextClass =
  | { kind: "term"; text: string }
  | { kind: "context"; text: string }
  | { kind: "reject"; reason: string };

export type TermClass =
  | { kind: "term"; text: string }
  /** 看着像句子：调用方该把它挪进「补充句子」，而不是拿它当词查。 */
  | { kind: "asSentence"; reason: string }
  | { kind: "reject"; reason: string };

export type ContextClass =
  | { kind: "context"; text: string }
  | { kind: "reject"; reason: string };

/** 超过这个长度基本是整段文字或代码，不是要查的词。 */
const TERM_MAX_WORDS = 3;
const TERM_MAX_CHARS = 40;

/** 句子框的上限：一整段源码或整篇文章不是"它出现的那一句"。 */
const CONTEXT_MAX_CHARS = 300;
const CONTEXT_MAX_LINES = 4;

function collapse(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function countLines(raw: string): number {
  return raw.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0).length;
}

/** 拉丁字母占所有字母的比例。中文内容会被判掉。 */
function latinRatio(text: string): number {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (!letters) return 0;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, "");
  return latin.length / letters.length;
}

/** 两个框都适用的拦截：这些东西不管放在哪个框里都不是"要查的英文"。 */
function sharedReject(text: string): string | null {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])/.test(text)) {
    return "看着像文件路径。";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return "看着像 URL。";
  }
  if (/^[\d\s.,:%+\-/]+$/.test(text)) {
    return "全是数字和符号，没有可查的词。";
  }
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(text)) {
    return "看着像 base64 或哈希值。";
  }
  if (latinRatio(text) < 0.5) {
    return "大部分不是拉丁字母 —— 这个工具是查英文技术词汇的。";
  }
  return null;
}

/**
 * 词框：只有词和短语能过。
 *
 * 判不出词时返回 `asSentence` 而不是 reject —— 一整句贴进来是最常见的误操作，
 * 调用方可以把它挪到该在的框里，而不是让用户重打一遍。
 */
export function classifyTerm(raw: string): TermClass {
  if (!raw.trim()) return { kind: "reject", reason: "请输入要查询的词或短语。" };

  const text = collapse(raw);
  if (text.length > CONTEXT_MAX_CHARS || countLines(raw) > CONTEXT_MAX_LINES) {
    return {
      kind: "reject",
      reason: `这是 ${text.length} 字的整段文本 —— 这个工具查词，不解释整段。只取要查的那个词，或它出现的那一句。`,
    };
  }
  const shared = sharedReject(text);
  if (shared) return { kind: "reject", reason: shared };
  // 分号/大括号/箭头出现在要查的英文词或句里几乎没有正当理由，所以不设长度门槛 ——
  // `const x = 1;` 这种短代码行也必须拦住，否则它会被当成"词"送去查。
  // 故意不拦 `()`：`handle()` 这种带括号的写法是真会想去查的。
  if (/[{};]|=>|->|::/.test(text)) {
    return { kind: "reject", reason: "看着像代码（有分号、大括号或箭头）—— 只取要查的词或句子。" };
  }

  // 单个词不受 40 字限制：`JoinHandle` 之外的标识符也很长，但它是货真价实的词。
  // 长度门槛是给"多词短语"的 —— 4 个词往后基本就是一句话了。
  const words = text.split(" ").filter(Boolean);
  const singleToken = words.length === 1;
  if (words.length <= TERM_MAX_WORDS && (singleToken || text.length <= TERM_MAX_CHARS)) {
    return { kind: "term", text };
  }
  return {
    kind: "asSentence",
    reason: "这看着是一句话 —— 它该在「补充句子」里，上面只留要查的那个词。",
  };
}

/**
 * 句子框：装的是"这个词出现在哪"。
 *
 * 故意**不拦代码行** —— 读者常常是在源码里遇到的这个词，
 * 那一行长这样：`const handler = createHandler(req);`。
 */
export function classifyContext(raw: string): ContextClass {
  if (!raw.trim()) return { kind: "reject", reason: "这段里没有文本。" };

  const text = collapse(raw);
  if (text.length > CONTEXT_MAX_CHARS) {
    return {
      kind: "reject",
      reason: `太长了（${text.length} 字，上限 ${CONTEXT_MAX_CHARS}）—— 只取它出现的那一句。`,
    };
  }
  const lines = countLines(raw);
  if (lines > CONTEXT_MAX_LINES) {
    return {
      kind: "reject",
      reason: `跨了 ${lines} 行，看着像整段文本 —— 只取它出现的那一句（最多 ${CONTEXT_MAX_LINES} 行）。`,
    };
  }
  const shared = sharedReject(text);
  if (shared) return { kind: "reject", reason: shared };
  return { kind: "context", text };
}

/**
 * 拖进来的东西该落到哪个框。
 *
 * 词框优先：能从词框过就绝不塞进句子框。两个都装不下时，
 * 报"更像整段文本"的那条 —— 它对这种输入更贴切。
 */
export function classifyDrop(raw: string): TextClass {
  // 拖拽路径有它自己的措辞：用户没打字，"请输入…"没有意义。
  if (!raw.trim()) return { kind: "reject", reason: "拖进来的东西里没有文本。" };
  const term = classifyTerm(raw);
  if (term.kind === "term") return { kind: "term", text: term.text };
  const ctx = classifyContext(raw);
  if (ctx.kind === "context") return { kind: "context", text: ctx.text };
  return { kind: "reject", reason: term.kind === "reject" ? term.reason : ctx.reason };
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
