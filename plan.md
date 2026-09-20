# 计划：把「词」和「句子」拆成两个输入框

用户报的两件事（2026-09-21，附截图：只查了 `presentation` 一个词，结果里却有一块「在这句话里」）：

1. 只查了一个词，释义里却出现「在这句话里」—— 看着像读了某句话，其实没有。
2. 输入一段话时，没法表达"我要问整段"还是"问段里那个词"。

## 现状（读代码得到的事实，不是猜测）

| 事实 | 位置 |
|---|---|
| 「在这句话里」只看 `in_context` 非空，不看有没有句子 | `src/views/DefinitionBody.tsx:26` |
| prompt 把 `in_context` 当必填：格式示例里直接写好了"在这句话里，handler 指…"；全文只有 `why_translation_fails` 写了"不构成误导就留空" | `src-tauri/src/llm.rs:82,88-99` |
| 无句子时后端是说实话的（`sentence: (无上下文，仅给出该词)`），但模型仍会拿领域知识把 `in_context` 填满 | `src-tauri/src/llm.rs:133` |
| 句子模式下 `term` 和 `sentence` 传的是**同一个字符串** | `src/views/LookupView.tsx:76-77` |
| 于是"查句中哪个词"完全由模型猜；缓存键、卡片键也都由这串文本决定 | `src-tauri/src/llm.rs:168-176`、`src-tauri/src/lib.rs:441,452` |
| 词还是句由**形状**决定（≤3 词且 ≤40 字 = term，否则 sentence），不是意图 | `src/dragdrop.ts:78-82` |
| 超 300 字、或非空行超 2 行就拒 —— "解释整段"这条路根本不存在 | `src/dragdrop.ts:41-52` |
| 拖进来的整句也被同时当 term 和 sentence 送出去 | `src/App.tsx:109-114` |
| 输入区标题写着"单词 / 句子自动识别"，这句话在哪个框上都不成立 | `src/views/LookupView.tsx:247` |

## 改什么

第一层 —— 显示说实话（`src/views/DefinitionBody.tsx`）：

* 「在这句话里」改成 `sentence && inContext` 才显示。没有句子就不显示 —— 那块内容和 hero 段讲的是同一件事，本来没有独立信息。
* 复习页共用同一组件（`src/views/ReviewView.tsx:205`），自动一致。
* 老卡片里存的 `in_context` 一个字节不动（`db.rs` / `lib.rs` 的读写也不动），只是不再显示。

第二层 —— 把词和句子拆成两个输入（`src/views/LookupView.tsx` + `src/dragdrop.ts`）：

* 输入区两个框：
  * 主框 = **要查的词 / 短语**，label 写明，上限收到 term 规则（≤3 词；多词短语再限 40 字，
    单个词不受这条长度限制 —— 标识符本来就可能很长）。
  * 「补充句子（可选）」**可展开**：默认收起，展开是一行 textarea（≤300 字、≤4 行）。旁边一句话说清它是干什么的 —— 贴上它出现的原句，释义按这句话解；留空就只按卡包领域解释这个词。
* **提交时 `term` = 主框，`sentence` = 句子框或 `null`。** 这是根因修复：后端 `build_body(term, sentence, keywords, …)` 本来就是两个参数（`llm.rs:125`），坏的是前端的传法。所以 **prompt 一个字不改、`PROMPT_VERSION` 不 bump、本地释义缓存不失效**。
* 整句贴进主框不再被静默当成 term：报错并把文本**挪进**「补充句子」（自动展开），提示上面只留要查的词。
* `classifyDrop` 拆成 `classifyTerm` / `classifyContext`（共用底层规则），`classifyDrop` 保留为"拖进来的东西该落到哪个框"的分派。`scripts/check-dragdrop.ts` 是现成的测试入口，跟着扩用例。
* 拖拽：短文本 → 主框；长文本 / 多行 → 句子框并自动展开，提示还需写上要查的词（这一条以前是模型替用户猜的，现在改成用户说清）。
* 历史回填：`LookupSeed.sentence` 非空 → 两框都填 + 自动展开（`src/views/LookupView.tsx:108-112`）。
* 输入区标题的"单词 / 句子自动识别"删掉，换成说清两个框各是什么。

### 一处和 PRD §4.2 的有意偏差

句子框**允许代码行**（`const x = 1;` 这类）：句子框存在的意义就是"我是在哪一行看到的"，
而那一行常常就是源码。词框仍然照旧拦代码 —— 那里的误判代价大得多（会变成卡片键）。

## 不做

* 不解释整段：段落不是一张卡，硬做出来的是不能复习的释义。只在被贴成长文本时给出明确引导。
* 不改 prompt、不 bump `PROMPT_VERSION`（理由见上）。
* 不清理存量数据：句子模式留下的旧缓存（norm = 整句）留着无害，新键会绕开；老卡片的 `in_context` 也不再显示。
* 后端一行不改 —— `lookup_term(request_id, deck_id, term, sentence)` 这个签名本来就是对的。

## 验收（能自己复现的证据）

1. `node --test scripts/check-dragdrop.ts`：新增用例 —— 整句进词框判 `asSentence`、句子框收单句与代码行、超 300 字 / 超 4 行 / 路径 / URL / base64 / 非拉丁各自拦掉。
2. `npx tsc --noEmit` + `pnpm build`。
3. 真实窗口三段（对本机假模型，不联网不花 token）：① 只填词 → 结果里**没有**「在这句话里」；② 词 + 展开补充句子 → 结果里有「在这句话里」，且「原文」就是补进去的那句；③ 把整句贴进主框 → 被拒 + 文本挪进补充句子。留截图。
4. 文档同步：README / PRD / DEVELOPMENT / VERIFICATION。
5. git 提交。
