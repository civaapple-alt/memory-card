# 开发指南

面向项目贡献者：环境、构建 / 测试命令、模块职责和容易破坏的约定。本地桌面构建已在 Windows 上验证；GitHub Actions 已配置 macOS universal 构建，需等首次 workflow 实跑后确认。

产品意图和设计取舍见 [PRD.md](PRD.md)；验证结论见 [VERIFICATION.md](VERIFICATION.md)。

## 环境

| 需要什么 | 已验证基线 | 备注 |
|---|---|---|
| Rust toolchain | 1.96.0，`x86_64-pc-windows-msvc` | Tauri 2 后端 |
| Node | v24.18.0（Vite 8 要求 `^20.19.0 || >=22.12.0`） | 前端构建 |
| pnpm | 11.9.0 | 包管理；npm 也行但 lockfile 是 pnpm 的 |
| Visual Studio 2022 | Community，含 C++ 生成工具 | MSVC 链接器，Tauri 与 rusqlite 都要 |
| WebView2 Runtime | 153.0.4234.32 | Win11 自带；Tauri 前端渲染依赖 |
| Tauri CLI | **不需要全局安装** | 已作为 devDependency（`@tauri-apps/cli`），走 `pnpm tauri` |

当前 `reqwest` 配置在 Windows 上使用系统 TLS（`native-tls`）；标准构建不需要额外安装 CMake 或 NASM。不要把维护者机器上的具体版本当作唯一可用版本。

## 常用命令

```powershell
pnpm install

pnpm tauri dev                            # 开发窗口，前端热更新
Remove-Item Env:CI -ErrorAction SilentlyContinue # 见「坑 3」；只影响当前会话
pnpm tauri build                          # release：独立 exe + msi + nsis 安装包
pnpm tauri build --debug --no-bundle      # 产出 target/debug/memory-card.exe，不打安装包
pnpm build                                # 只构建前端（vite build）
npx tsc --noEmit                          # 前端类型检查

Push-Location src-tauri
cargo test --lib                          # Rust 单元测试；不调用真实模型
cargo test --test live_llm -- --nocapture # 可选：真实联网集成测试
Pop-Location

# 在仓库根目录的另一个终端启动本机假模型（不联网、不花 token）
node scripts/fake-llm.mjs --port 8787 --mode hang
```

`live_llm` 会读取仓库根目录的 `.env`。设置了 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY` 时，`cargo test`（不只是 `--test live_llm`）会执行真实模型请求并可能产生费用；没有 key 时该集成测试会跳过。日常离线验证用 `cargo test --lib`。只有确认愿意联网并承担费用时才运行 `live_llm`；加 `--nocapture` 可查看模型响应摘要、耗时和 token 数。

`llm.rs` 里的取消/超时/重试那几个测试**不需要网**：它们在 `127.0.0.1` 上起一个按剧本说话的假服务器（见 `llm.rs` 的 `fake_server`），所以"卡住 30 秒"这种用例也是毫秒级跑完的。

## 自动发布（Windows + macOS）

`.github/workflows/release.yml` 在推送 `vX.Y.Z` 格式的 tag 时运行。Windows job 构建免安装 exe、MSI 和 NSIS；macOS job 构建同时支持 Intel 与 Apple Silicon 的 universal DMG。两个 job 都先检查 tag 与 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本一致，再运行不需要 API Key 的测试。发布 job 汇总制品、附上该 tag 的 `LICENSE`、生成 `SHA256SUMS.txt` 并创建 GitHub Release。

发版前先在同一个提交中更新上述三个版本字段并推送分支，然后从该提交创建并推送新 tag：

```powershell
git tag v0.1.2
git push origin v0.1.2
```

将示例版本替换为实际版本。Workflow 使用仓库提供的 `GITHUB_TOKEN`，不需要个人 `gh` token 或模型 API Key。`v0.1.1` 是 workflow 加入前手动发布的版本，不会因新增 workflow 自动重建。发行包未签名；macOS DMG 也未 notarize，首次启动可能出现 Gatekeeper 警告。

## 配置优先级

**settings 表 > 环境变量**。首次启动由 `seed_settings_from_env` 把 env 写进表；之后一律以表为准，所以在设置页改过 key 之后，再改 `.env` 不会覆盖已保存值。

`.env` 放在仓库根。支持 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`，也兼容 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`；同一项同时设置时优先使用 `DEEPSEEK_*`。不要提交包含真实密钥的 `.env`。

## 模块职责

| 文件 | 管什么 |
|---|---|
| `src-tauri/src/lib.rs` | Tauri 命令层（18 条）、配置优先级、`def_cache` 读写、复习批次调度、在跑的查询登记与取消（`cancel_lookup`） |
| `src-tauri/src/db.rs` | schema、种子数据、迁移 |
| `src-tauri/src/llm.rs` | prompt 构造、前缀缓存键、`define()`（含重试 / 超时 / 取消）、`ping()`（连通性测试） |
| `src-tauri/src/srs.rs` | SM-2，纯函数、无 IO —— 所以能干净地单测 |
| `src-tauri/src/models.rs` | 前后端共用的序列化模型 |
| `src-tauri/src/error.rs` | `AppError`，前端拿到的是字符串 |
| `src/App.tsx` | 外壳：五个标签页 + 全局刷新 + 全局拖拽放置区 |
| `src/dragdrop.ts` | 输入判断：纯函数 `classifyTerm`（词框）/ `classifyContext`（句子框）/ `classifyDrop`（拖进来的东西该落哪个框）/ `readDropText`，测试在 `scripts/check-dragdrop.ts` |
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
4. **总超时只有一个来源：`LlmConfig.timeout`**（设置页可改，`define` / `ping` 里的 `select!` 负责执行）。别在 `reqwest::Client` 上再设一个 `ClientBuilder::timeout`：那会变成"设置页改了也不生效"的隐形天花板 —— 45 秒那条老 bug 就是这么来的。传输层错误要跟着重试（用户报的 `error decoding response body` 就是这一类）。

### UI 契约（小窗是硬约束）

* **主操作一律走底部常驻动作栏**（`src/actionbar.tsx` 的 `useActionBar`）。不要把"存入卡包""评分"这类主操作放回滚动区 —— 小窗只有 440×620，一滚动就得拖着找按钮，这正是这一版专门修掉的问题。
* **词和句子是两个输入框，不是一个框的两种模式**（2026-09-21）。上框的内容就是 `term`，下框（可空的「补充句子」）就是 `sentence`，**两者绝不能传成同一个字符串** —— 曾经就是那样：整句同时当 term 和 sentence 送出去，"句中哪个词"由模型猜，而 `cache_key` / `term_key` 都跟着这串文本走。判断规则按框分成 `classifyTerm` / `classifyContext`，拖拽走 `classifyDrop` 分派；三处共用底层规则（`sharedReject`），别各自另写一套。
* **「在这句话里」必须挂在 `sentence` 上**（`DefinitionBody`）。模型无论有没有上下文都会填 `in_context`；无句子时它填的是领域知识，显示出来就是在撒谎。同理，别为了"省 token"去改 prompt 让它留空 —— 那要 bump `PROMPT_VERSION`，见下面第 2 条。
* **整段文章不做释义**。段落不是一张卡。被贴成长文本时给明确引导（"只取要查的那个词，或它出现的那一句"），别悄悄拿它当句子或词去查。
* **`why_translation_fails` 默认不展示**（PRD P3 修订）。字段与 prompt 都保留，别删；要重新展示先改 PRD。
* 键盘：词框内 `Enter` = 查询、`Shift+Enter` = 换行；**句子框里 `Enter` 就是换行**（那里本来就可能有多行，不能抢）；结果出来后、焦点不在输入框时 `Enter` = 主操作、`Esc` = 丢弃。
* **取词页常驻挂载，切标签页只切 `display`、不卸载**（`App.tsx` 里那个 `hidden={tab !== "lookup"}`）。它身上挂着的是"已经付过钱的那次模型结果"，卸载就没了 —— 曾经的 bug 就是"查完切去复习，回来一片空白"。代价是它必须在后台让出**动作栏**和**全局键盘**：`useActionBar(node, deps, active)` 的第三个参数、以及 `LookupView` 里 keydown 开头的 `if (!active) return`，都是在干这个，删了就会出现"在复习页按 Esc 清掉了取词页的结果"。其余页照旧按需挂载（每次进入重新查库才是对的：历史要看到新记录、复习要看到刚到期的卡）。
* **主操作文案必须说真话。** 这个词在卡包里**已有卡**时，主操作是「更新「X」释义」而不是「存入」；存完的提示用**后端返回的 `saved.deck_name`**，不要用请求里的 `result.deck_name` —— 卡落在哪个卡包以数据库为准。
* **存入的目标是 `result.deck_id`，不是下拉框此刻选中的那个卡包。** 释义是用那个卡包的关键词限定算出来的，`term_key` 又带 `deck_id`，塞进别的卡包就同时犯了"串领域"和"另建一张卡"两个错。历史条目同理：点它会连卡包一起切过去。
* **查词必须随时能停。** 「停止」（以及查询中的 `Esc`）走 `api.cancelLookup(requestId)`，后端按 `request_id` 取消**那一次**请求。`requestId` 每次查词都要新生成（`newRequestId()`）：复用固定值会把"停止后马上换个词再查"的第二枪一起打死。停止时前端先作废自己的 token 再通知后端 —— 迟到的响应不许再改界面，后端那次 reject（`已停止`）也不该弹成红色错误条。
* **超时要说实话。** 界面上的"最长等 N 秒"来自 `getSettings().timeout_secs`（后端已 clamp 到 5–300），不要在前端另写一个数字：两处一旦分叉，用户看到的最长等待就成了假的。

### 改坏了会直接报错

5. **命令参数名在 JS 侧是 camelCase。** Tauri 的 `tauri-macros` 默认 `ArgumentCase::Camel`，所以前端传 `requestId` / `deckId` / `cardId` / `elapsedMs` / `sourceHint`；但**结构体内部的字段名保持 snake_case**。两种风格混用是最常见的低级报错来源。
6. **`reqwest` 必须显式启用 `native-tls`。** 见「坑 1」，别为了"现代化"换回 rustls。
7. **`lookup_term` 里的 mutex 必须在 `await` 之前释放**，否则并发查询会退化成串行。同理，查词登记表（`AppState::lookups`）也只做"取/存一个令牌"这种事，别在持锁时 `await`。
8. **`lookup_term` 要成对地用 `register_lookup` / `finish_lookup`。** 漏了注销只是让表里多一条（有 TTL 兜着），但漏了登记就等于「停止」按钮点了没反应 —— 而且不报错。
9. **`term_key = "{normalized_term}|{deck_id}"`。** 同一个词在两个卡包是两张独立的卡（有意为之）。改这个格式等于让所有老卡失联。

### 已经删掉的，别加回来

10. `srs::should_suspend` 已删除。逾期休眠由 `lib.rs` 里一条批量 UPDATE 统一执行，不要在单卡路径里重新加一份判断。

### 范围约束（别顺手加回来）

* **不做剪贴板监听**（PRD §2 非目标，2026-09-18 决定）。不要引入 `tauri-plugin-clipboard-manager`，也不要写轮询剪贴板变化的循环。产品取词只有两条路：拖拽入窗 + 手动粘贴。
* **不需要全局热键，也不需要模拟按键（SendInput）**。两条路都不模拟用户输入：一条靠拖拽事件，一条靠用户在输入框里自己粘。同样是刻意选的，不是还没做。
* 托盘：`Cargo.toml` 里开着 `tray-icon` feature 但没有代码。真要加，连着 PRD §6 的"托盘显示待复习数"一起做，别只开开关。
* **`tauri.conf.json` 的 `dragDropEnabled` 保持 `false`。** 拖拽取词依赖 WebView 的 HTML5 拖拽事件（`src/App.tsx` 挂在 window 上、`src/dragdrop.ts` 判内容）；改成 `true` 会让 Tauri 原生接管文件拖拽、文本拖拽事件收不到，功能**静默失效**。

## 维护者本机排障记录

以下经验来自维护者的一台 Windows 机器，不是项目的通用环境要求。DPI、输入法、代理和进程实例等行为会因系统配置不同而变化；遇到相似问题时先确认自己的环境，再套用对应排查步骤。

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
8. **150% 缩放下不要用 `GetWindowRect` + `CopyFromScreen` 截窗口。** pwsh 是 DPI-unaware 进程，`GetWindowRect` 返回的是**虚拟化过的**坐标（664×977 物理的窗口报成 455×657），拿它去 `CopyFromScreen` 就会截偏、裁掉右下角。截窗口一律走 `scripts/win-shot.ps1`：`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取物理框 + `PrintWindow(..., PW_RENDERFULLCONTENT=2)`（flag 必须带 2，否则 WebView2 是空白）。
   反过来，`ui-drive.ps1` 里的**点击**坐标是**故意**用虚拟化坐标算的：本进程同样 DPI-unaware，`SetCursorPos` 会被系统按同一比例放大回去，两边一致才对得上。别把点击一起"修"了。
9. **验证时不要和用户正开着的实例共用同一个数据库。** 所有实例都读 `%APPDATA%\memorycard\memory-card\data\memory-card.db`，你起的那个会往里面写历史记录和释义缓存 —— 用户下次刷新就会看到一堆自己没查过的词。更糟的是分不清"用户那边为什么退了"这类问题（有一次把打包出来的 MSI 生成完，用户的实例恰好不在进程表里，无法归因）。要跑真实流程，先把 `data\` 整个复制出来、让它用那份库；或者干脆等人不在了再跑。另外**别用 `memory-card.exe` 这个名字起新实例** —— 和用户手上那个的进程名一模一样，`-ProcessName` 会挑错窗口、`Stop-Process` 也可能误伤。改名成 `mc-xxx.exe` 再跑（`target/release/memory-card.exe` 的 PE 资源不受改名影响）。
10. **这台机器有 `HTTP_PROXY=http://127.0.0.1:7890`（Clash），`reqwest` 会照用 —— 它读环境变量，Windows 的 IE 代理设置也就算了，环境变量它认。**
    * 从终端启动的实例会走代理，从资源管理器双击启动的不走（桌面应用不继承 shell 环境变量，和「坑 2」是同一件事的两面）。所以会出现"命令行里跑得好好的、双击就换一种坏法"。
    * 代理改写或掐断响应时，用户看到的是 `error decoding response body` 这类**解码**错误。第一次跑本机假服务器测试时就是这样：假服务器收下连接不说话，Clash 替它回了 `HTTP 502`，看起来像我们自己的 bug。**先确认是不是代理干的**，别一头扎进重试逻辑。排除办法：`$env:NO_PROXY='127.0.0.1,localhost'`。
    * `llm.rs` 的单元测试用 `.no_proxy()` 建客户端就是这个原因（否则测的是代理）。但**生产代码要保留代理支持** —— 用户可能真需要它，只让测试绕开。

## scripts/

| 脚本 | 干什么 | 什么时候用 |
|---|---|---|
| `probe-deepseek.ps1` | 直连模型（不发 Tauri），打印耗时 / JSON 可解析性 / 缓存命中 token / confidence，并跑一次 thinking 开启做对照 | 排查"是网络和模型的问题，还是应用的问题"。`-DryRun` 只看请求体不发请求 |
| `cargo-run.ps1` | 后台跑一次 cargo 任务，全部输出落日志 | 首次编译远超 120s 的命令超时上限。`-Task test` / `-Task check`，之后 `Get-Content .cargo-out.log -Tail N` 轮询。`cargo-run.cmd` 是给 cmd 用的薄包装 |
| `ui-drive.ps1` | 驱动真实窗口：激活、粘贴、点击、发按键（发之前断言前台窗口） | 没有人手时跑端到端流程。`-ClickAt "200,213"` 坐标相对窗口左上角；`-Paste` 走剪贴板；`-Wait` 毫秒；`-Out` 顺带截图。两个实测坑：**点按钮可靠、点文本框不可靠**（坐标点击不会把焦点给 textarea，之后的 `-Paste` 静默不落），**`-Keys` 里连发一长串 `{TAB}` 会掉键**（发 10 个只落 2 个）—— 所以优先"点按钮"而不是"数 TAB"，非要 TAB 就一次只发一个。**想让它查出东西，点一条历史记录比想办法把字弄进输入框省事**（历史点击本身就会触发查询） |
| `shot-window.ps1` | 只截指定进程的顶层窗口，不截整个屏幕 | 需要视觉证据、又不想把用户桌面拍进去 |
| `win-shot.ps1` | 截窗口的公共实现（DWM 物理框 + `PrintWindow`），给上面两个脚本 dot-source | 不要在别处另写一份截窗口代码：见「坑 8」，写错的那个版本会静默截偏 |
| `check-dragdrop.ts` | 输入分类的单元测试（词框 / 句子框 / 拖拽分派各一组），`node --test scripts/check-dragdrop.ts`（Node 24 原生跑 TS，不引测试框架） | 改了 `src/dragdrop.ts` 的规则之后 |
| `fake-llm.mjs` | 本机假模型：`--mode hang`（收下连接永不回话）/ `truncate`（声明 200 字节只给 20 字节）/ `unauthorized` / `ok` / `definition`（回一条完整的释义 JSON，并把请求体里的 `term:` / `sentence:` 打进日志） | 复现"卡住、被截断、401"这类故障，以及验证「停止」「超时」「测试连接」和**界面到底把两个框传成了什么**。真 API 平时是好的，复现不出来也不该为它花钱 |
