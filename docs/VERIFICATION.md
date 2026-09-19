# 验证记录

最后验证：2026-09-19（v0.1 骨架期；补记拖拽取词；补记 UI/交互改版；补记 release 打包）

**结论**：取词 → 域释义 → 入卡 → 复习 → 历史 全链路在**真实窗口**里跑通；后端 16 条命令逐条执行过；自动化测试全绿、0 warning。

**取词两条路径**：手动粘贴（已实现、已验证）与拖拽入窗（**已实现**，分类器有单元测试覆盖，用户已在真实窗口确认「放下即查」可用）。剪贴板监听仍按 PRD §2 非目标不做。

**重要限定**：

* **一键入库部分达成 PRD P0 #5。** `Enter 存入` / `Esc 丢弃` 已实现（输入框内 `Enter` 查询、`Shift+Enter` 换行；结果出来后、焦点不在输入框时 `Enter` 入库），主操作固定在底部常驻动作栏；`E 编辑后存入` **未实现**（没有释义手工编辑界面）。
* 别把下面的结论读成这个工具已经好用 —— 它只说明管道是通的。

## 1. 自动化测试

| 命令 | 结果 |
|---|---|
| `cargo test`（src-tauri） | **10 个单元测试通过**（SM-2 调度 + prompt 构造），0 failed，0 warning |
| `cargo test --test live_llm -- --nocapture` | **1 个联网集成测试通过**（3.44s） |
| `npx tsc --noEmit` | 通过 |
| `pnpm build`（vite） | 通过 |
| `pnpm tauri build --debug --no-bundle` | 通过，产出 `src-tauri/target/debug/memory-card.exe` |
| `pnpm tauri build`（release + 打包，先 `Remove-Item Env:CI`） | 通过，2m50s；产出独立 exe + `bundle/msi/*.msi` + `bundle/nsis/*-setup.exe` |
| `node --test scripts/check-dragdrop.ts` | **7 个分类器测试通过**（拖入内容过滤：词 / 句 / 路径 / URL / 数字 / base64 / 代码行 / 超长 / 中文） |

联网测试的原始输出（它断言 `handle` 在 rust 卡包下给的是句柄义，而不是通用词典的"把手"）：

```text
[live] handle -> 对某个异步任务、资源或运行时对象的引用/句柄，持有它就能查询状态、等待完成或对其进行操作 | 1895ms | 输出 249 tokens
[live] bounded -> cache_hit=256 cache_miss=162
```

第二行是**前缀缓存确实生效**的证据：`bounded` 这次请求有 256 个输入 token 命中缓存、162 个未命中 —— 命中的正是两个请求共享的固定前言 + 卡包作用域。缓存价是未命中价的 1/50，这是这个工具能便宜的前提。

没配 key 时 `live_llm` 自动跳过，所以无脑跑 `cargo test` 不会因为缺 key 而红。

**release 打包复验（同日）**：`Remove-Item Env:CI` 后 `pnpm tauri build` 成功（后端冷编译 `cargo build --release` 2m50s，随后 WiX 出 MSI、makensis 出 NSIS）。产物：

| 产物 | 字节 | SHA256 |
|---|---|---|
| `target/release/memory-card.exe` | 6,765,568 | `F666FDE4…E554FB99` |
| `bundle/msi/memory-card_0.1.0_x64_en-US.msi` | 3,375,104 | `00F6FE64…1E3057D9` |
| `bundle/nsis/memory-card_0.1.0_x64-setup.exe` | 2,444,622 | `1A9962E8…DFFF160F83` |

三个产物都是 PE32+ x64（NSIS 外壳是 32 位存根，属正常），`Get-AuthenticodeSignature` 均为 `NotSigned`。**只验证了独立 exe**：把 cwd 设成不含 `.env` 的临时目录再启动 `target/release/memory-card.exe`，进程存活、窗口标题 `memory-card`、`DwmGetWindowAttribute` 给出 664×977 物理 / 144 DPI(150%) = 440×620 逻辑（与 `tauri.conf.json` 一致），界面完整渲染（五页标签 + 底部状态栏 `23 张卡 · 18 待复习`，见 §4），未配 key 也不崩 —— 说明 `frontendDist` 已被打进二进制、配置确实从 SQLite 读。**MSI 与 NSIS 安装包没有真跑安装**（不在这台机器上装）。

**UI/交互改版后的复验（同日）**：改版只动前端（`src/App.tsx`、`src/views/*`、`src/styles.css`，以及 `src/dragdrop.ts` 的提示文案），后端与 prompt **未动**。重跑：`npx tsc --noEmit`（通过）、`pnpm build`（通过）、`node --test scripts/check-dragdrop.ts`（7/7 通过）。改版内容 —— 底部常驻动作栏（主操作不再随内容滚动）、取消"单词 / 句子"开关（改由分类器自动判断）、卡包下拉只显名称（领域关键词移到下方一行）、释义按"场景概要 → 细节 → 通用义"重排并默认隐藏 `why_translation_fails`、出结果后收起输入区。已在真实窗口里驱动验证并留下 §4 的四张新截图。

顺手改掉的两个真问题（都是"驱动真实窗口"才暴露的）：

* 出结果后 `Enter` 会抢走焦点所在控件（按钮 / 标签页）的按键 —— 键盘 Tab 到"复习"再按 Enter 变成了入库。已把 `Enter = 主操作` 限制为"焦点不在任何可交互控件上"时生效（`src/views/LookupView.tsx`）。实测：结果页 Tab 到"复习"再 Enter 会正常切页，不会入库。
* `scripts/shot-window.ps1` 在 150% 缩放下会截错区域/裁掉右下半张图（`GetWindowRect` 给的是 DPI 虚拟化后的坐标，`CopyFromScreen` 也照此裁）。本轮改为用 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 拿物理尺寸 + `PrintWindow(..., 2)` 截图。**脚本本身尚未修改**（见 §5）。

## 2. 端到端：16 条命令逐条执行

不是"能编过"，是每一条都在真实窗口里操作过一遍：

| 命令 | 观察到的结果 |
|---|---|
| `list_decks` | 启动即用，6 个种子卡包出现（编程通用 / 前端 / Rust 后端 / AI·LLM / 网络协议 / GitHub 协作黑话） |
| `create_deck` | 建包并要求填关键词；不填关键词时界面直接拦下 |
| `update_deck` | 改关键词生效，已有释义不自动重算 |
| `delete_deck` | 删包后卡包列表与队列计数同步更新 |
| `lookup_term` | `handle` 与 `bounded` 各查一次，**覆盖了模型请求与本地缓存命中两条路径** |
| `save_lookup` | 存入「编程通用」；重复存入一个已存在的词，`reps` / `due_at` 未被重置 |
| `list_cards` | 卡片列表出现 2 张 |
| `delete_card` | 删掉一张，列表与计数同步 |
| `list_history` | 刚才两次查询都在，可按词或按释文搜到 |
| `list_due_cards` | 新卡 `due_at = now`，立刻进队列，显示 `1/1` |
| `review_card` | 评分 3 → 间隔变为 1 天 → 标签栏的到期角标消失 |
| `reactivate_card` | 被休眠的逾期卡可手动恢复 |
| `get_stats` | 卡数 / 待复习数正确 |
| `get_settings` | API key 回显为 `***configured***`，不回传明文 |
| `save_settings` | 改 key 落库，后续请求用新值 |
| `db_location` | 返回 `%APPDATA%\memorycard\memory-card\data\memory-card.db` |

两处**领域义正确性**的实例（截图里可见）：

* `handle` 给的是"处理、应对（事件、请求、错误、数据等）"，上下文能点出通用义"触摸、拿、操作"在编程语境下不合用。（模型仍返回 `why_translation_fails`，但按 P3 修订已不再默认展示。）
* `bounded` 给的是"有明确上限、有界循环、有界延迟"，对照通用义"有边界的"。

## 3. 过程中发现并修掉的真 bug

对着截图逐张看才发现的三处，都是"看代码时觉得对、看画面时才发现不对"的类型：

| 现象 | 根因 | 修法 |
|---|---|---|
| 存卡提示写死"首次复习 10 分钟后"，但新卡其实立刻到期 | 文案是硬编码的，没跟 `due_at` 走 | 改为按真实到期时间显示，并补"（现在就可以复习）" |
| 新卡在复习页显示"上次间隔 0 分钟" | `interval_days` 对未复习过的卡是 0，被当成历史值渲染 | `reps === 0` 时显示"新卡" |
| 间隔显示成 `1.0 天` | 浮点直接格式化 | 整数不补小数位 |

## 4. 证据

截图来自真实窗口，由 `scripts/ui-drive.ps1` 驱动、`scripts/shot-window.ps1` 抓取（只截窗口，不截桌面）。

| 文件 | 说明 |
|---|---|
| ![查 handle](evidence/def-cache-hit.png) | 查 `handle`，置信度 high，右上角「缓存」标记说明这条释义来自本地 `def_cache` 而非重新请求模型 |
| ![存 bounded](evidence/save-card.png) | 存 `bounded` 入「编程通用」，入卡提示已按 bug 修复后的形式显示；底部来源行给出 `2017ms / 输出 252 tokens / 前缀缓存 256/424 tokens` |
| ![复习新卡](evidence/review-new-card.png) | 复习页对新卡显示"新卡"而非"上次间隔 0 分钟" |

UI 改版后的四张（同一轮 `pnpm tauri dev` 真实窗口，由 `scripts/ui-drive.ps1` 驱动）：

| 文件 | 说明 |
|---|---|
| ![取词首屏](evidence/ui-01-lookup-empty.png) | 取词首屏：卡包下拉**只显名称**，领域关键词另起一行；**没有"单词 / 句子"开关**，标题栏写明"单词 / 句子自动识别"；无结果时底部无动作栏 |
| ![取词结果](evidence/ui-02-lookup-result.png) | 出结果后：输入区**收成一行**；释义顺序＝领域义（hero）→ 在这句话里 → 例句 → 常见搭配 → **通用含义（弱化收尾）**；**没有"为什么通用翻译会错"**；底部常驻动作栏「存入「编程通用」」**不滚动即可点**（其上方内容已溢出，正说明动作栏确实固定） |
| ![复习正面](evidence/ui-03-review-front.png) | 复习正面：`翻面（空格 / Enter）`固定在底部动作栏；此处也是"结果页 Tab 到别的标签页再按 Enter 会切页而不是入库"的现场 |
| ![复习评分](evidence/ui-04-review-rating.png) | 复习背面：`1–4 忘了/勉强/记得/秒答`评分行整体移入底部动作栏；正文同样是"领域义 → 细节 → 通用含义"且无 `why` |

release 打包产物的一张（`pnpm tauri dev` 之外的独立进程，cwd 不含 `.env`）：

| 文件 | 说明 |
|---|---|
| ![release 启动](evidence/release-01-launch.png) | `target/release/memory-card.exe` 独立启动：界面完整（不是白窗）、底部状态栏 `23 张卡 · 18 待复习` 说明 SQLite 正常打开、卡包/领域行正常 |

这张**不是** `shot-window.ps1` 抓的 —— 该脚本的 DPI 缺陷见 §5，这里用的内联做法是 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 取物理框 + `PrintWindow(hwnd, hdc, 2)`（`PW_RENDERFULLCONTENT`，否则 WebView2 会截出空白）。

## 5. 仍未验证 / 仍未实现

**仍未验证**：

* **拖拽取词的端到端驱动**：分类器过滤规则有 `node --test scripts/check-dragdrop.ts` 覆盖，用户也已在真实窗口确认「拖一下即出释义」可用；但尚未用 `scripts/ui-drive.ps1` 留证据截图（§4 的三张截图不含拖拽）。
* **`shot-window.ps1` 的 DPI 缺陷**：150% 缩放下会截错/裁图（见上）。本轮改用 `DwmGetWindowAttribute` + `PrintWindow` 的内联做法取证，脚本本身**没改**；要长期用应当修脚本。
* **句子流程 B**：UI 已去掉"单词 / 句子"开关（改由分类器自动判断），但"整句大意 + 难点词列表、逐条入卡"**未实现** —— 句子与单词仍共用同一个单次释义 prompt。抽词质量**没实测**。
* **几十张卡规模下的复习性能与滚动体验**没压测。
* **费用**：只在单次查询尺度上看过 token 数，没有按天累计的账。
* 未做同类工具对照（EasyDict / Bob / GoldenDict / Anki / 沉浸式翻译）。

**仍未实现**：

* **一键入库的 `E 编辑后存入`**（P0 第 5 项）：`Enter 存入` / `Esc 丢弃` 已实现；`E 编辑后存入` 未实现 —— 缺释义手工编辑界面（P1 第 10 项）。
* **托盘图标与到期通知**：`Cargo.toml` 里开了 `tauri` 的 `tray-icon` feature，但没有任何托盘代码 —— 目前只是把编译开关打开了，功能不存在。
* 剪贴板监听**已移出范围**（PRD §2 非目标），不再列为待办。原先"按下 Ctrl+C 就出释义"的那套体验设计与成功指标随之作废。

## 6. 自己复现

```powershell
# 1. 只验模型侧（不发 Tauri，最省事）
pwsh scripts/probe-deepseek.ps1 -DryRun      # 先看请求体，不发请求
pwsh scripts/probe-deepseek.ps1              # 真发一次，打印耗时 / 缓存 / confidence

# 2. 自动化测试（前端分类器在仓库根跑）
node --test scripts/check-dragdrop.ts

cd src-tauri
cargo test
cargo test --test live_llm -- --nocapture

# 3. 出独立 exe 再看真实窗口
cd ..
pnpm tauri build --debug --no-bundle
# 注意：必须传仓库根作 cwd，否则 dotenvy 找不到 .env
$exe = "$PWD\src-tauri\target\debug\memory-card.exe"
([wmiclass]'Win32_Process').Create($exe, $PWD.Path, $null)
```

一个会让上面第 3 步白费的坑：**跑过 `cargo test` 之后必须先重新 `pnpm tauri build`**，否则 exe 是编译期指向 `devUrl`(1420) 的那个版本，窗口会直接报 `ERR_CONNECTION_REFUSED`。详见 [DEVELOPMENT.md](DEVELOPMENT.md)。
