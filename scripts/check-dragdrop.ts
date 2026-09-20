/**
 * 输入分类的测试。用 node 直接跑，不引入测试框架：
 *
 *   node --test scripts/check-dragdrop.ts
 *
 * 能这么省事是因为 Node 24 原生支持 type stripping。
 *
 * 重点在"落进哪个框"：词框和句子框的上限不同，判错的代价也不同 ——
 * 整句被当成词，会变成缓存键和卡片键；一段文章被当成句子，会白烧一次请求。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classifyContext, classifyDrop, classifyTerm } from "../src/dragdrop.ts";

function termKind(s: string): string {
  return classifyTerm(s).kind;
}

function ctxKind(s: string): string {
  return classifyContext(s).kind;
}

function dropKind(s: string): string {
  return classifyDrop(s).kind;
}

function termReason(s: string): string {
  const c = classifyTerm(s);
  assert.equal(c.kind, "reject", `期望词框 reject，实际 ${c.kind}：${JSON.stringify(s)}`);
  return c.kind === "reject" ? c.reason : "";
}

function ctxReason(s: string): string {
  const c = classifyContext(s);
  assert.equal(c.kind, "reject", `期望句子框 reject，实际 ${c.kind}：${JSON.stringify(s)}`);
  return c.kind === "reject" ? c.reason : "";
}

function dropReason(s: string): string {
  const c = classifyDrop(s);
  assert.equal(c.kind, "reject", `期望 reject，实际 ${c.kind}：${JSON.stringify(s)}`);
  return c.kind === "reject" ? c.reason : "";
}

test("词框只收词和短语", () => {
  for (const s of ["bounded", "  handle  ", "ship it", "returns a promise", "JoinHandle"]) {
    assert.equal(termKind(s), "term", JSON.stringify(s));
  }
});

test("单个词不受 40 字限制，多词短语才受", () => {
  // 长标识符是货真价实的词 —— 判成句子，拖进来的它就会落进句子框、白让用户重打一遍。
  assert.equal(termKind("JoinHandleOfABackgroundTask"), "term");
  assert.equal(termKind("build_the_request_handler_chain_for_the_client"), "term");
  // 3 个词、40 字以内才是短语
  assert.equal(termKind("bounded queue implementation"), "term");
  assert.equal(termKind("task-runner-with-a-very-long-name indeed"), "term");
  // 多词短语过 40 字、或者超过 3 个词，就该去句子框了。
  assert.equal(termKind("task-runner-with-a-very-long-name indeed-extra"), "asSentence");
  assert.equal(termKind("a b c d"), "asSentence");
});

test("整句贴进词框 -> asSentence（调用方该把它挪到句子框）", () => {
  assert.equal(termKind("the request handler returns a promise"), "asSentence");
  assert.equal(termKind("Use a bounded queue to avoid unbounded memory growth."), "asSentence");
  // 同一句话在句子框里是合法的 —— 两个框判的本来就不是一回事。
  assert.equal(ctxKind("the request handler returns a promise"), "context");
});

test("整段文本：词框说\"整段\"，句子框说\"太长\"", () => {
  const para = "x".repeat(301);
  assert.match(termReason(para), /整段/);
  assert.match(ctxReason(para), /太长/);
  // 拖拽报的是更像这个输入的那条 —— 别让人以为"再删两个字就行"。
  assert.match(dropReason(para), /整段/);
});

test("句子框收跨行，但不超过 4 行", () => {
  // 从 PDF / 浏览器里复制常见形态：正文里夹着被折断的空行。
  assert.equal(ctxKind("the request handler\n\nreturns a promise"), "context");
  assert.match(ctxReason("a\nb\nc\nd\ne"), /跨了 5 行/);
});

test("句子框收代码行（那一行常常就是源码），词框仍然拦代码", () => {
  assert.equal(ctxKind("const handler = createHandler(req);"), "context");
  assert.match(termReason("const x = 1;"), /代码/);
  assert.match(termReason("if err != nil { return }"), /代码/);
  assert.match(termReason("fn main() -> Result<(), E>"), /代码/);
  assert.equal(dropKind("const handler = createHandler(req);"), "context");
});

test("路径 / URL / 数字 / base64 两个框都拦", () => {
  for (const s of ["C:\\Users\\alwar\\dev\\memory-card", "\\\\server\\share\\x", "/usr/local/bin/node"]) {
    assert.match(termReason(s), /路径/, JSON.stringify(s));
    assert.match(ctxReason(s), /路径/, JSON.stringify(s));
  }
  assert.match(termReason("https://api.deepseek.com/v1"), /URL/);
  assert.match(ctxReason("https://api.deepseek.com/v1"), /URL/);
  assert.match(termReason("12345"), /数字/);
  assert.match(ctxReason("12345"), /数字/);
  const b64 = "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qgc3RyaW5n";
  assert.match(termReason(b64), /base64/);
  assert.match(ctxReason(b64), /base64/);
});

test("中文内容拦掉", () => {
  assert.match(termReason("这是一个中文句子不应该被查询"), /拉丁字母/);
  assert.match(ctxReason("这是一个中文句子不应该被查询"), /拉丁字母/);
});

test("空内容拦掉", () => {
  assert.match(termReason("   "), /没有文本|请输入/);
  assert.match(termReason(""), /请输入/);
  assert.match(ctxReason("   "), /没有文本/);
});

test("拖拽分派：词进词框、句子进句子框、判不过就只提示", () => {
  assert.equal(dropKind("handle"), "term");
  assert.equal(dropKind("the request handler returns a promise"), "context");
  assert.match(dropReason("C:\\Users\\alwar\\dev\\memory-card"), /路径/);
  assert.match(dropReason("   "), /没有文本/);
});
