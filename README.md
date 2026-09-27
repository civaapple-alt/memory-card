# memory-card

读英文技术资料时用的取词 / 记忆小窗。Rust + Tauri 2 + React。

## 它解决什么

两个具体的失败，不是笼统的"学英语很难"：

1. **通用翻译在技术语境下给错义。** `handle` 被翻成"把手"，`promise` 被翻成"承诺"，`ship it` 被翻成"把它运走"。Chrome 的翻译不知道你正在读 tokio 的文档。
2. **查过的词几天就忘。** 下次遇到同一个词再查一遍，循环往复 —— 查词的成本低到不值得记，遗忘的成本高到每次都要付。

所以它做三件事，都在同一个 440×620 的小窗里：取词 → 在**卡包关键词限定的领域**里给出释义 → 存成卡片按 SM-2 复习。

卡包不只是分类目录，它是**语义作用域**：卡包上的关键词（如 `rust, tokio, async`）会被塞进 prompt，让同一个 `handle` 在 Rust 后端卡包里是"句柄"，在前端卡包里是"事件处理函数"。

## 它长什么样

| 取词结果 | 复习评分 |
|---|---|
| ![取词结果](docs/evidence/ui-02-lookup-result.png) | ![复习评分](docs/evidence/ui-04-review-rating.png) |

释义结果按"先看懂这句话"排：**领域义** → 在这句话里 / 原文 → 例句 / 常见搭配 → **通用义（对照，弱化收尾）**。中间那两块**只有你填了「补充句子」才出现** —— 模型不管有没有上下文都会返回"在这句话里"那一段，没有句子时它填的是领域知识，挂这个标签等于撒谎，所以干脆不显示。模型也会返回"为什么通用翻译会错"，但默认不展示。主操作（存入卡包 / 翻面评分）固定在窗口底部的常驻动作栏，不用滚动去找。

取词页**切到别的标签页再回来，结果还在**（只切显示、不卸载）；如果这个词在当前卡包里已经有卡，底下的主操作会写「更新「卡包」释义」而不是「存入」。两处的现场截图在 [docs/VERIFICATION.md](docs/VERIFICATION.md) §7。

查询期间按钮变成 `查询中 2.0s`，旁边出现「**停止**」（`Esc` 等价）：按下立刻回到可输入状态，**这次响应不会再进来**。等满设置里的「请求超时」（默认 45 秒，5–300 可调）会走同一条路自己停下 —— 模型卡住或响应被截断时不用再重启应用。现场截图在 [docs/VERIFICATION.md](docs/VERIFICATION.md) §8。

## 快速开始

前置：Rust 1.96+（MSVC toolchain）、Node 20.19+ 或 22.12+、pnpm、Visual Studio 2022（C++ 生成工具）、WebView2 Runtime。

```powershell
pnpm install
pnpm tauri dev
```

首次启动会在 `%APPDATA%\memorycard\memory-card\data\memory-card.db` 建库，并种入 6 个卡包（编程通用 / 前端 / Rust 后端 / AI·LLM / 网络协议 / GitHub 协作黑话）。

**API Key 有两种给法**，优先级是 settings 表 > 环境变量：

* 开发：仓库根放 `.env`（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`），首次启动自动写进数据库。
* 正式：启动后在「设置」页填。

`.env` 已 gitignore。注意从资源管理器双击启动的应用**不继承 shell 环境变量** —— 这也是配置必须落库的原因。

## 打包（Windows）

```powershell
Remove-Item Env:CI      # 本机 CI=1 会让 tauri CLI 报 invalid value '1' for '--ci'
pnpm tauri build
```

`bundle.targets` 是 `"all"`，所以一次出三个产物：

| 产物 | 用途 | 体积 |
|---|---|---|
| `src-tauri/target/release/memory-card.exe` | 免安装，双击即跑（仍需 WebView2 Runtime） | 6.5 MB |
| `src-tauri/target/release/bundle/nsis/memory-card_0.1.1_x64-setup.exe` | 安装包，最小 | 2.3 MB |
| `src-tauri/target/release/bundle/msi/memory-card_0.1.1_x64_en-US.msi` | MSI，走组策略 / 批量部署 | 3.2 MB |

发行包**未做代码签名**，Windows 会弹 SmartScreen 警告 —— 本地自用点"仍要运行"即可。Key 在「设置」页填（双击启动不继承 shell 环境变量，见上）。

打包后把三个产物 + `SHA256SUMS.txt` 复制一份到 `release/<版本>/`（已 gitignore）—— `target/` 会被 `cargo clean` 清掉，那份是拿来直接发给别人 / 自己双击的。当前是 `release/0.1.1/`。

## GitHub Release（Windows / macOS）

推送 `vX.Y.Z` tag 会触发 GitHub Actions：自动构建 Windows exe / MSI / NSIS，以及同时支持 Intel 和 Apple Silicon 的 macOS universal DMG；Release 同时附带 MIT 许可证和 SHA-256 清单。具体发版步骤见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#自动发布windows--macos)。

发行包尚未做代码签名；macOS DMG 也未 notarize，首次打开时 Windows SmartScreen 或 macOS Gatekeeper 可能提示安全警告。

## 怎么用

* **取词**：上框写**要查的词 / 短语**，按 `Enter`（`Shift+Enter` 换行）。如果这个词是在一句话里遇到的，展开下面的「**补充句子（可选）**」把那一句贴上 —— 释义就会按那句话说，结果里多出「在这句话里」和「原文」两块；不填就只按卡包领域解释这个词（**这时候不会有「在这句话里」**）。也可以直接把选中的文字**拖进窗口**：一个词就进上框，一整句就进句子框并提示你补上要查的词。过滤（路径 / URL / 纯数字 / base64 / 代码行 / 超长 / 中文）两框各有一套：词框严到会拦代码行，句子框允许代码行（你就是在源码里遇到的它）。**整段文章不解释** —— 那是不能复习的东西，工具会直接说清。剪贴板监听**不做** —— 见下方"明确不做"。
* **入卡**：出结果后按 `Enter`（或点底部动作栏的「存入」），`Esc` 丢弃。卡片词形取模型返回的 lemma，所以 `handle` / `handles` / `handling` 会落成同一张卡；重复入库只更新释义，**复习进度保留**。（`E` 编辑后存入尚未实现 —— 见下方"还没做"。）
* **复习**：`空格`翻面，`1`–`4` 评分（忘了 / 勉强 / 记得 / 秒答）。忘了的卡 10 分钟后会再来一次。
* **历史**：搜词或搜释文，点一条即可重新查询 —— 卡包会跟着切成那条记录当时的卡包。
* **卡包**：建包时要给关键词 —— 没有关键词的卡包等于退回通用词典，界面上会直接拦你。
* **查不动了**：查询中点「停止」或按 `Esc` 立刻脱身。另外每次查询有总预算（设置里的「请求超时」，默认 45 秒，5–300 可调），超了自动停并给出原因，不用重启。
* **设置**：改 `API Key` / `Base URL` / `模型` / `请求超时` 之后，先点「**测试连接**」再点「保存设置」—— 测试用表单里**此刻**的值（不必先存）发一次极短的请求，成功会显示服务端回的模型名、往返毫秒和回复内容，失败会把 HTTP 状态和响应体原文摆出来。

## 目录结构

```text
memory-card/
├─ src/                      前端（React 19 + TS）
│  ├─ App.tsx                外壳：五个标签页 + 全局刷新 + 全局拖拽放置区
│  ├─ dragdrop.ts           拖入内容判断（纯函数，测试在 scripts/check-dragdrop.ts）
│  ├─ api.ts                 invoke 封装 —— 所有命令名只在这里出现
│  ├─ types.ts               与 models.rs 一一对应的类型（字段名必须 snake_case）
│  ├─ format.ts              时间 / 间隔 / 置信度的显示格式
│  ├─ ui.tsx                 Panel / Field / Badge / Notice 等零件
│  └─ views/                 Lookup / Review / History / Decks / Settings
├─ src-tauri/
│  ├─ src/lib.rs             Tauri 命令层（18 条），配置优先级也在这
│  ├─ src/db.rs              schema + 6 个种子卡包
│  ├─ src/llm.rs             prompt 构造 / 前缀缓存键 / define()（带重试、总超时、取消）/ ping()（连通性测试）
│  ├─ src/srs.rs             SM-2 调度
│  ├─ src/models.rs          序列化模型
│  ├─ src/error.rs           AppError（序列化成字符串给前端）
│  └─ tests/live_llm.rs      联网集成测试（没配 key 自动跳过）
├─ docs/                     见下方索引
└─ scripts/                  探针 / 构建 / 端到端驱动脚本 + fake-llm.mjs（本机假模型，离线复现卡住 / 截断 / 401）
```

## 文档

* [docs/PRD.md](docs/PRD.md) —— 产品需求与设计。为什么不做全局热键、卡包为什么是语义作用域、数据模型、释义输出契约、DeepSeek 接入要点、成功指标。
* [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) —— 开发环境、构建 / 测试命令、模块职责、**不能改坏的约定**和维护者本机排障记录。
* [docs/VERIFICATION.md](docs/VERIFICATION.md) —— 已经验证到哪一步、怎么自己复现、哪些还没验证。

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。

## 状态

**已完成并验证**：后端 18 条命令 + 前端五页 + SM-2 全链路 + 拖拽取词（真实窗口确认可用）+ **查询可停止 / 超时可配 / 设置页连通性测试**（三样都在真实窗口里驱动验过，见 [docs/VERIFICATION.md](docs/VERIFICATION.md) §8）+ **词与句子拆成两个输入框**（释义里的「在这句话里」只在真给了句子时出现，见 §9）。`cargo test` **17 个单元测试**全绿 + 1 个联网集成测试通过，`node --test scripts/check-dragdrop.ts` **10 个分类器测试**通过，`npx tsc --noEmit` / `pnpm build` / `pnpm tauri build --debug --no-bundle` 通过，0 warning。

**还没做**：一键入库的 `E 编辑后存入`（回车即存 / Esc 丢弃 已实现，主操作固定在底部动作栏）、句子流程 B（整句大意 + 难词清单、逐条入卡 —— 现在句子仍走单次释义）、托盘图标、到期通知、释义手工编辑、个人术语表界面。

**明确不做**（v1）：**剪贴板监听**、整页翻译、通用 SRS 平台、移动端与同步、账号体系。不监听剪贴板 = 不读你复制的每一个东西（密码、内网地址、私聊），代价是取词手感不如划词工具 —— 这个取舍是刻意选的。
