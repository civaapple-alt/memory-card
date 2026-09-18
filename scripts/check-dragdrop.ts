/**
 * 拖入判断的测试。用 node 直接跑，不引入测试框架：
 *
 *   node --test scripts/check-dragdrop.ts
 *
 * 能这么省事是因为 Node 24 原生支持 type stripping。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classifyDrop } from "../src/dragdrop.ts";

function kindOf(s: string): string {
  return classifyDrop(s).kind;
}

function reasonOf(s: string): string {
  const c = classifyDrop(s);
  assert.equal(c.kind, "reject", `期望 reject，实际 ${c.kind}：${JSON.stringify(s)}`);
  return c.kind === "reject" ? c.reason : "";
}

test("词和短语判为 term", () => {
  for (const s of ["bounded", "  handle  ", "ship it", "returns a promise", "JoinHandle"]) {
    assert.equal(kindOf(s), "term", JSON.stringify(s));
  }
});

test("整句判为 sentence", () => {
  assert.equal(kindOf("the request handler returns a promise"), "sentence");
  assert.equal(kindOf("Use a bounded queue to avoid unbounded memory growth."), "sentence");
});

test("路径 / URL / 数字 / base64 拦掉", () => {
  assert.match(reasonOf("C:\\Users\\alwar\\dev\\memory-card"), /路径/);
  assert.match(reasonOf("\\\\server\\share\\x"), /路径/);
  assert.match(reasonOf("/usr/local/bin/node"), /路径/);
  assert.match(reasonOf("https://api.deepseek.com/v1"), /URL/);
  assert.match(reasonOf("12345"), /数字/);
  assert.match(reasonOf("aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Qgc3RyaW5n"), /base64/);
});

test("代码行拦掉 —— 哪怕很短", () => {
  assert.match(reasonOf("const x = 1;"), /代码/);
  assert.match(reasonOf("if err != nil { return }"), /代码/);
  assert.match(reasonOf("fn main() -> Result<(), E>"), /代码/);
});

test("太长 / 跨行太多 / 中文 拦掉", () => {
  assert.match(reasonOf("x".repeat(301)), /太长/);
  assert.match(reasonOf("first line\nsecond line\nthird line"), /跨了 3 行/);
  assert.match(reasonOf("这是一个中文句子不应该被查询"), /拉丁字母/);
});

test("空内容拦掉", () => {
  assert.match(reasonOf("   "), /没有文本/);
  assert.match(reasonOf(""), /没有文本/);
});

test("多行但只有两行有效内容是允许的", () => {
  // 从 PDF 里拖出来的常见形态：正文里夹着被折断的空行。
  assert.equal(kindOf("the request handler\n\nreturns a promise"), "sentence");
});
