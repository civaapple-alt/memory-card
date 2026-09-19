# 开发指南

改代码前读这份。命令、模块职责、**不能改坏的约定**、本机踩过的坑。

产品意图和设计取舍见 [PRD.md](PRD.md)；验证结论见 [VERIFICATION.md](VERIFICATION.md)。

## 环境

| 需要什么 | 本机实测 | 备注 |
|---|---|---|
| Rust toolchain | 1.96.0，`x86_64-pc-windows-msvc` | Tauri 2 后端 |
| Node | v24.18.0（≥ 20 即可） | 前端构建 |
| pnpm | 11.9.0 | 包管理；npm 也行但 lockfile 是 pnpm 的 |
| Visual Studio 2022 | Community，含 C++ 生成工具 | MSVC 链接器，Tauri 与 rusqlite 都要 |
| WebView2 Runtime | 153.0.4234.32 | Win11 自带；Tauri 前端渲染依赖 |
| Tauri CLI | **不需要全局安装** | 已作为 devDependency（`@tauri-apps/cli`），走 `pnpm tauri` |
| cmake / nasm | **没有装，也别装** | 见「坑 1」 |

## 常用命令

```powershell
pnpm install

pnpm tauri dev                            # 开发窗口，前端热更新
pnpm tauri build --debug --no-bundle      # 产出 target/debug/memory-card.exe，不打安装包
pnpm build                                # 只构建前端（vite build）
npx tsc --noEmit                          # 前端类型检查

cd src-tauri
cargo test                                # 单元测试（SM-2 + prompt 构造）
cargo test --test live_llm -- --nocapture # 联网集成测试，会真花 token
```

`live_llm` 在没配 key 时自动跳过，所以无脑跑 `cargo test` 是安全的。加 `--nocapture` 才看得到 `[live] handle -> ...` 那两行输出（含耗时和 token 数）。

## 配置优先级

**settings 表 > 环境变量**。首次启动由 `seed_settings_from_env` 把 env 写进表；之后一律以表为准 —— 所以在设置页改过 key 之后，再改 `.env` 是不生效的。

`.env` 放在仓库根，字段名沿用 OpenAI 风格：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。

## 模块职责

| 文件 | 管什么 |
|---|---|
| `src-tauri/src/lib.rs` | Tauri 命令层（16 条）、配置优先级、`def_cache` 读写、复习批次调度 |
| `src-tauri/src/db.rs` | schema、种子数据、迁移 |
| `src-tauri/src/llm.rs` | prompt 构造、前缀缓存键、`define()`（含空返回重试） |
| `src-tauri/src/srs.rs` | SM-2，纯函数、无 IO —— 所以能干净地单测 |
| `src-tauri/src/models.rs` | 前后端共用的序列化模型 |
| `src-tauri/src/error.rs` | `AppError`，前端拿到的是字符串 |
| `src/App.tsx` | 外壳：五个标签页 + 全局刷新 + 全局拖拽放置区 |
| `src/dragdrop.ts` | 拖入内容判断：纯函数 `classifyDrop` / `readDropText`，测试在 `scripts/check-dragdrop.ts` |
| `src/api.ts` | `invoke` 封装 —— **所有命令名只在这里出现** |
| `src/types.ts` | 与 `models.rs` 一一对应的类型 |
| `src/format.ts` | 时间 / 间隔 / 置信度的显示格式 |
| `src/ui.tsx` | `Panel` / `Field` / `Badge` / `Notice` 等零件 |
| `src/views/` | Lookup / Review / History / Decks / Settings 五个页面 |
| `src/actionbar.tsx` | 底部常驻动作栏的 context + `useActionBar`（主操作的唯一注入点） |
| `src/views/DefinitionBody.tsx` | 释义正文块，取词页与复习页共用，保证显示顺序一致 |

## 不能改坏的约定

### 改坏了会静默变慢或变脏

1. **prompt 前缀必须字节不变、且永远排在前面。** 前缀缓存按字节逐前缀匹配。固定前言 + 卡包作用域消息必须原样、有序、在最前，用户输入永远在最后。破坏它 → 缓存全失效，输入侧延迟和价格差 50 倍（缓存命中价是未命中的 1/50）。
2. **改了 prompt 文本就要 bump `llm.rs::PROMPT_VERSION`。** 它参与 `def_cache` 的键；不 bump 会让旧释义被当成新 prompt 的产物复用。
3. **`save_lookup` 必须保持 `ON CONFLICT(term_key) DO UPDATE` 只更新 `primary_definition_id` / `display_term`。** 绝不能顺手把 `due_at` / `reps` / `interval_days` 覆盖回去 —— 那等于"重复查一个词就清空它的复习进度"。

### UI 契约（小窗是硬约束）

* **主操作一律走底部常驻动作栏**（`src/actionbar.tsx` 的 `useActionBar`）。不要把"存入卡包""评分"这类主操作放回滚动区 —— 小窗只有 440×620，一滚动就得拖着找按钮，这正是这一版专门修掉的问题。
* **不做"单词 / 句子"模式开关**。是词还是句由 `classifyDrop`（和拖拽同一个分类器）判断；两处判断一旦分叉，就会出现"拖进来的能查、粘进来的不能查"这类怪事。
* **`why_translation_fails` 默认不展示**（PRD P3 修订）。字段与 prompt 都保留，别删；要重新展示先改 PRD。
* 键盘：输入框内 `Enter` = 查询、`Shift+Enter` = 换行；结果出来后、焦点不在输入框时 `Enter` = 主操作、`Esc` = 丢弃。

### 改坏了会直接报错

4. **命令参数名在 JS 侧是 camelCase。** Tauri 的 `tauri-macros` 默认 `ArgumentCase::Camel`，所以前端传 `deckId` / `cardId` / `elapsedMs` / `sourceHint`；但**结构体内部的字段名保持 snake_case**。两种风格混用是最常见的低级报错来源。
5. **`reqwest` 必须显式启用 `native-tls`。** 见「坑 1」，别为了"现代化"换回 rustls。
6. **`lookup_term` 里的 mutex 必须在 `await` 之前释放**，否则并发查询会退化成串行。
7. **`term_key = "{normalized_term}|{deck_id}"`。** 同一个词在两个卡包是两张独立的卡（有意为之）。改这个格式等于让所有老卡失联。

### 已经删掉的，别加回来

8. `srs::should_suspend` 已删除。逾期休眠由 `lib.rs` 里一条批量 UPDATE 统一执行，不要在单卡路径里重新加一份判断。

### 范围约束（别顺手加回来）

* **不做剪贴板监听**（PRD §2 非目标，2026-09-18 决定）。不要引入 `tauri-plugin-clipboard-manager`，也不要写轮询剪贴板变化的循环。产品取词只有两条路：拖拽入窗 + 手动粘贴。
* **不需要全局热键，也不需要模拟按键（SendInput）**。两条路都不模拟用户输入：一条靠拖拽事件，一条靠用户在输入框里自己粘。同样是刻意选的，不是还没做。
* 托盘：`Cargo.toml` 里开着 `tray-icon` feature 但没有代码。真要加，连着 PRD §6 的"托盘显示待复习数"一起做，别只开开关。
* **`tauri.conf.json` 的 `dragDropEnabled` 保持 `false`。** 拖拽取词依赖 WebView 的 HTML5 拖拽事件（`src/App.tsx` 挂在 window 上、`src/dragdrop.ts` 判内容）；改成 `true` 会让 Tauri 原生接管文件拖拽、文本拖拽事件收不到，功能**静默失效**。

## 这台机器上的坑

1. **`reqwest` 0.13 的 `default-tls` 是 rustls**（0.12 时代它才是 native-tls）→ 会拉 `aws-lc-sys` → 需要 cmake/nasm → 本机没有 → 编译直接失败。必须写 `default-features = false, features = ["native-tls", "json"]`，Windows 下走 schannel，零外部依赖。
2. **dev / build 之分是编译期的。** 跑过 `cargo test` 会把 `target/debug/memory-card.exe` 换成指向 `devUrl`(1420) 的版本，此时直接启动就是 `ERR_CONNECTION_REFUSED`。要跑独立 exe，先 `pnpm tauri build --debug --no-bundle`。
3. **`CI=1` 会让 tauri CLI 报 `invalid value '1' for '--ci'`。** 脚本里先 `Remove-Item Env:CI`。
4. **长任务不能用后台任务。** shell 命令一返回，子进程就被杀（rustc 报 `0xc000013a` STATUS_CONTROL_C_EXIT）。用 `Start-Process` + `Wait-Process -Timeout` 把输出重定向到日志，再轮询日志。**不要用 `Win32_Process.Create`** —— 它会弹出一个可见的控制台窗口。
5. **激活窗口后必须断言，不能盲发按键。** 前台锁会让 `SetForegroundWindow` 静默失败；`ui-drive.ps1` 的做法是激活后检查 `GetForegroundWindow`，不是目标窗口就直接抛错退出 —— 否则按键会落进用户正在用的编辑器里。
6. **SendKeys 往 WebView2 敲英文会被中文输入法吞进候选缓冲 —— 而且失败是静默的。** 本机活动输入语言是"中文(简体) - 美式键盘"（`GetKeyboardLayout` 返回 langId `0x0804`），逐字键入的 `handle` 会进输入法的候选缓冲、**不会落到输入框**，而脚本照样打印 `sent keys: handle`。上次这一步是靠**人工按 Shift 切到英文**才过去的。
   * 解法是**不要逐字键入**：用 `-Paste`（`Set-Clipboard` + `^{v}`）。`Ctrl+V` 不被输入法拦截，实测可靠。
   * 控制键（`{ENTER}` / `{TAB}` / `{DOWN}` / `^{v}`）不受影响，照用。
   * `ui-drive.ps1` 现在会在「要键入字面字符 + 目标窗口输入法是中文」时**直接报错**，而不是发出去再假装成功；确属必要用 `-AssumeEnglishInput` 硬发。
   * **脚本不替你切换输入法** —— 那是你机器的全局状态，不该被一个调试脚本改。要切就自己按 Shift。
   * 粘贴之后**截图确认文字真的进去了**再发查询。
   * **不要发 ESC** 去关候选框 —— ESC 会把已输入的内容清空。
7. **启动应用时要把仓库根作为 cwd**，否则 `dotenvy` 找不到 `.env`。

## scripts/

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `probe-deepseek.ps1` | 直连模型（不发 Tauri），打印耗时 / JSON 可解析性 / 缓存命中 token / confidence，并跑一次 thinking 开启做对照 | 排查"是网络和模型的问题，还是应用的问题"。`-DryRun` 只看请求体不发请求 |
| `cargo-run.ps1` | 后台跑一次 cargo 任务，全部输出落日志 | 首次编译远超 120s 的命令超时上限。`-Task test` / `-Task check`，之后 `Get-Content .cargo-out.log -Tail N` 轮询。`cargo-run.cmd` 是给 cmd 用的薄包装 |
| `ui-drive.ps1` | 驱动真实窗口：激活、粘贴、点击、发按键（发之前断言前台窗口） | 没有人手时跑端到端流程。`-ClickAt "200,213"` 坐标相对窗口左上角；`-Paste` 走剪贴板；`-Wait` 毫秒；`-Out` 顺带截图 |
| `shot-window.ps1` | 只截指定进程的顶层窗口，不截整个屏幕 | 需要视觉证据、又不想把用户桌面拍进去 |
| `check-dragdrop.ts` | 拖入分类器的单元测试，`node --test scripts/check-dragdrop.ts`（Node 24 原生跑 TS，不引测试框架） | 改了 `src/dragdrop.ts` 的规则之后 |
