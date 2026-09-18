# memory-card

读英文技术资料时用的取词 / 记忆小窗。Rust + Tauri 2 + React。

## 它解决什么

两个具体的失败，不是笼统的"学英语很难"：

1. **通用翻译在技术语境下给错义。** `handle` 被翻成"把手"，`promise` 被翻成"承诺"，`ship it` 被翻成"把它运走"。Chrome 的翻译不知道你正在读 tokio 的文档。
2. **查过的词几天就忘。** 下次遇到同一个词再查一遍，循环往复 —— 查词的成本低到不值得记，遗忘的成本高到每次都要付。

所以它做三件事，都在同一个 440×620 的小窗里：取词 → 在**卡包关键词限定的领域**里给出释义 → 存成卡片按 SM-2 复习。

卡包不只是分类目录，它是**语义作用域**：卡包上的关键词（如 `rust, tokio, async`）会被塞进 prompt，让同一个 `handle` 在 Rust 后端卡包里是"句柄"，在前端卡包里是"事件处理函数"。

## 它长什么样

| 存卡 | 复习 |
|---|---|
| ![存卡](docs/evidence/save-card.png) | ![复习](docs/evidence/review-new-card.png) |

释义结果里固定给这几块：**领域义** / 在这句话里 / **为什么通用翻译会错** / 通用义（对照）/ 例句 / 常见搭配。

## 快速开始

前置：Rust 1.96+（MSVC toolchain）、Node 20+、pnpm、Visual Studio 2022（C++ 生成工具）、WebView2 Runtime。

```powershell
pnpm install
pnpm tauri dev
```

首次启动会在 `%APPDATA%\memorycard\memory-card\data\memory-card.db` 建库，并种入 6 个卡包（编程通用 / 前端 / Rust 后端 / AI·LLM / 网络协议 / GitHub 协作黑话）。

**API Key 有两种给法**，优先级是 settings 表 > 环境变量：

* 开发：仓库根放 `.env`（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`），首次启动自动写进数据库。
* 正式：启动后在「设置」页填。

`.env` 已 gitignore。注意从资源管理器双击启动的应用**不继承 shell 环境变量** —— 这也是配置必须落库的原因。

## 怎么用

* **取词**：选卡包 → 粘贴词或整句 → `Ctrl+Enter`。切到"句子"模式会连上下文一起送进去。
* **入卡**：卡片词形取模型返回的 lemma，所以 `handle` / `handles` / `handling` 会落成同一张卡；重复入库只更新释义，**复习进度保留**。
* **复习**：`空格`翻面，`1`–`4` 评分（忘了 / 勉强 / 记得 / 秒答）。忘了的卡 10 分钟后会再来一次。
* **历史**：搜词或搜释文，点一条即可重新查询。
* **卡包**：建包时要给关键词 —— 没有关键词的卡包等于退回通用词典，界面上会直接拦你。

## 目录结构

```text
memory-card/
├─ src/                      前端（React 19 + TS）
│  ├─ App.tsx                外壳：五个标签页 + 全局刷新
│  ├─ api.ts                 invoke 封装 —— 所有命令名只在这里出现
│  ├─ types.ts               与 models.rs 一一对应的类型（字段名必须 snake_case）
│  ├─ format.ts              时间 / 间隔 / 置信度的显示格式
│  ├─ ui.tsx                 Panel / Field / Badge / Notice 等零件
│  └─ views/                 Lookup / Review / History / Decks / Settings
├─ src-tauri/
│  ├─ src/lib.rs             Tauri 命令层（16 条），配置优先级也在这
│  ├─ src/db.rs              schema + 6 个种子卡包
│  ├─ src/llm.rs             prompt 构造 / 前缀缓存键 / define()（带重试）
│  ├─ src/srs.rs             SM-2 调度
│  ├─ src/models.rs          序列化模型
│  ├─ src/error.rs           AppError（序列化成字符串给前端）
│  └─ tests/live_llm.rs      联网集成测试（没配 key 自动跳过）
├─ docs/                     见下方索引
└─ scripts/                  探针 / 构建 / 端到端驱动脚本
```

## 文档

* [docs/PRD.md](docs/PRD.md) —— 产品需求与设计。为什么不做全局热键、卡包为什么是语义作用域、数据模型、释义输出契约、DeepSeek 接入要点、成功指标。
* [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) —— 环境、构建 / 运行 / 测试命令、模块职责、**不能改坏的几条约定**、这台机器上踩过的坑。
* [docs/VERIFICATION.md](docs/VERIFICATION.md) —— 已经验证到哪一步、怎么自己复现、哪些还没验证。

## 状态

**已完成并验证**：后端 16 条命令 + 前端五页 + SM-2 全链路。`cargo test` 11 个单元测试 + 1 个联网集成测试全绿，0 warning。详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

**还没做**：剪贴板监听、拖拽取词、托盘图标、到期通知、释义手工编辑、个人术语表界面。**目前取词靠手动粘贴。**

**明确不做**（v1）：整页翻译、通用 SRS 平台、移动端与同步、账号体系。
