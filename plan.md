# 计划：查词可中断 + 超时可配置 + 模型连接测试

用户报的三件事（2026-09-20，附了两张截图）：

1. 查词会卡住/超时，**没有手动停止的地方**（截图 1：`error decoding response body for url https://api.deepseek.com/chat/completions`）。
2. 设置页的模型配置**没有连接测试**（截图 2）。
3. 需要**防止请求拖太久**的东西 —— 也就是可配置的超时。

## 现状（读代码得到的事实，不是猜测）

| 事实 | 位置 |
|---|---|
| 超时是硬编码 45s，且是**客户端级**总超时 | `llm.rs::default_client()` |
| 传输层错误（`resp.send()` / `resp.text()` 失败）直接 `?` 上抛，**不重试** | `llm.rs::define()` |
| 前端只有"忽略过期结果"的 `abortRef`，请求在 Rust 侧照跑到底 | `LookupView.tsx` |
| 设置页只有 API Key / Base URL / 模型 / 复习三项，没有测试按钮 | `SettingsView.tsx` |
| PRD §9 里写了"设置页可编辑**并测试连通性**" —— 这一条当时没落地 | `docs/PRD.md` |

## 改什么

后端（`llm.rs`）：

* `Cancel`（`Arc<AtomicBool>` + `tokio::sync::Notify`）取消令牌；`define` / `ping` 用 `tokio::select!`
  同时等「取消」与「超时」。**future 被丢掉 = 连接被丢掉**，这是停止能真正生效的原因。
* 超时改成 `LlmConfig.timeout`（来自设置，5–300s，默认 45），作为**整次查词**的总预算，而不是每个 HTTP 请求一份。
* 传输层错误也进重试循环（原代码只对"空 content / 解析失败"重试），并且错误信息按 `is_connect` / `is_decode` / `is_timeout` 分类成中文。
* 新增 `ping()`：一次极短的 chat 请求，用来做设置页的连通性测试。

后端（`lib.rs` / `models.rs`）：

* `AppState.lookups: Mutex<HashMap<String, RunningLookup>>`，键是前端给的 `request_id`；
  `lookup_term` 带 `request_id`，新增命令 `cancel_lookup(request_id)` 与 `test_llm(settings)`。
* `Settings.timeout_secs`，读出来时 clamp，存进去时也 clamp。

前端：

* `LookupView`：查询中按钮变成 `查询中 2.0s`（带转圈），旁边出现「**停止**」+ 一句
  `最长等 45s，超了自动停 · 也可以按 Esc`；查询中按 `Esc` 等于点「停止」。
* `SettingsView`：超时输入 + 「测试连接」按钮，显示模型实际回的模型名、耗时与回复。
* `api.ts` / `types.ts`：新命令与类型；`newRequestId()`。

## 不做

* 不 bump 版本号、不重新打包 release（用户明确说不需要）。
* 不改 prompt、不改 `PROMPT_VERSION` —— 那会让本地释义缓存全部失效，和这次的事无关。

## 验收（能自己复现的证据）

1. `cargo test`：新增 4 个**本机假服务器**测试（不联网、不花 token）——
   卡住的请求能被取消且立刻返回、已经取消的令牌根本不碰网络、卡住的请求会超时并给出可读信息、
   被截断的响应会重试到 2/2 次、`ping` 能读出模型名与回复、`ping` 会如实报出 401；
   另加 1 个不联网的纯函数测试（超时值两端 clamp）。
2. `npx tsc --noEmit` + `pnpm build`。
3. 真实窗口：把 Base URL 指向一个本机"只接受不回复"的端口，点查询 → 界面停在"查询中"→ 点停止 → 立刻回到可输入状态；
   设置页点「测试连接」→ 能看到成功（模型名 / 毫秒 / 回复）或 401 的失败原因；把「请求超时」改成 5 秒保存后，
   同一个卡住的请求会在 5 秒时**自己**停下并给出提示。留截图。
4. 文档同步：README / PRD / DEVELOPMENT / VERIFICATION。
5. git 提交。

## 做完之后（2026-09-20，实际结果）

三条都落地并在真实窗口验过，证据在 [docs/VERIFICATION.md](docs/VERIFICATION.md) §8、截图在 `docs/evidence/`
（`cancel-01/02`、`timeout-01/02`、`settings-01/02/03`）。

和计划的两处偏差，按实际写：

1. **只写了 7 个新测试，不是 4 个**。除了计划里的 4 条，又补了两条防回归的：
   `already_cancelled_token_never_touches_the_network`（先停后查这条路真的不发请求）与
   `ping_surfaces_http_errors_instead_of_pretending_it_connected`（连通性测试失败必须报错，不能假装通）。
   `cargo test` 因此从 10 个变成 **17 个**，全绿。
2. **设置页的「请求超时」改完立刻生效，不用重启**：`App.tsx` 的 `onSaved` 回调会重新拉一次设置，
   `LookupView` 的提示当场从"最长等 45s"变成"最长等 5s"。这一点是验出来的，不是设计出来的。

另外记两个**取证环境**的坑（都不是产品问题，但会让人白跑一小时）：

* 本机有 `HTTP_PROXY=http://127.0.0.1:7890`（Clash）。`reqwest` 会读它，把发给 `127.0.0.1:8787` 的假服务器请求
  也转给代理，回一个 502 —— 表现成"假服务器坏了"。驱动应用时要么加 `NO_PROXY=127.0.0.1,localhost`，
  要么让假服务器自己 `.no_proxy()`（测试里就是这么做的，见 `llm.rs::test_client()`）。
* `ui-drive.ps1` 能把字弄进**已经聚焦**的 `input`（点它 + `^{a}` + `-Paste` 可行），但
  **`-Keys "{ENTER}"` 不会激活按钮**：给设置页的「保存设置」发回车，界面毫无反应，看着像"保存失败"。
  要点按钮就点它的坐标。另外设置页一出现提示条，下面所有控件会整体下移一行的高度 ——
  先截图再按坐标点，别照抄十分钟前的坐标。
