# memory-card — 产品需求文档 (PRD) v0.2

状态：草稿，待确认（v0.2 已并入技术栈、DeepSeek 核实结论、卡包模型、无热键交互）

## 0. 一句话定义

一个常驻桌面的**小窗**：复制或拖入一段英文，它给出**在指定卡包（领域）下**的释义，一键存入该卡包，并按间隔重复在同一个窗口里复习。

## 1. 问题陈述

我在 GitHub / X / 技术博客 / IDE 里读英文，英文水平约四级。痛点是两段式断裂的：

1. **查的时候不准。** Chrome 整页翻译或通用词典给的是通用义。`handle` 译成"把手"、`promise` 译成"承诺"、`ship it` 译成"把它运走"，在这个领域里都不成立。通用翻译解决的是"这个单词什么意思"，我需要的是"这句话里它是什么意思"。
2. **查完就忘。** 每次查完就关闭标签页，词义没有沉淀。几天后遇到同一个词，重查一遍。同一个词被查 5 次，就等于付了 5 次成本，收益为 0。

代价不是"麻烦"，而是**技术阅读速度被卡在一个上限上**：生词不认识 → 读得慢 → 读得少 → 生词更不认识。

不解决的话会一直依赖整页机翻。机翻能让我看懂个大概，但也替代了那个本该发生的"辨认"动作，导致我永远学不会自己看懂。

## 2. 目标与非目标

### 目标

- **G1**：从"看到一个不懂的词"到"看到领域释义" ≤ 3 秒，且**不需要记快捷键、不需要切换应用、不需要粘贴到别处**。
- **G2**：释义必须回答"在这个卡包的领域里、在这句话里，它是什么意思"，并在通用义会误导时明确指出误导在哪。
- **G3**：查过的词自动变成复习资产。30 天后，同一个词不应该还需要"重新查"。
- **G4**：复习能坚持下去。每日量有上限、有提醒、可在 2 分钟内清空。

### 非目标（v1 明确不做）

- **不做整页网页翻译**。那是 Chrome 的活。
- **不做全局热键取词**。用户明确排斥，尤其在 IDE 里。见 §4。
- **不做剪贴板监听**。用户明确不做（2026-09-18 决定）。取词因此收敛为**拖拽入窗 + 手动粘贴**两条路。
  附带效果值得记下来：不再读你复制过的每一个东西（密码、内网地址、私聊），代价是从"选中"到"看到释义"多了几步 —— 见 §4.2。
- **不做通用 SRS 平台**。不做卡片编辑器、牌组市场、社区卡组。
- **不做移动端、不做多端同步**。v1 单机。

## 3. 设计原则

**P1. 摩擦要低，但不要靠"自动化魔法"。**
打掉热键、也不监听剪贴板之后，取词靠的是用户本来就会做的动作 —— 拖拽、粘贴。不要发明新动作，要搭在旧动作上。

**P2. 复习量必须封顶，宁可少。**
Anki 类工具最大的失败模式是欠债：几天没复习攒了 400 张卡，然后直接弃用。每日队列有硬上限（默认 15 张），逾期太久的卡自动休眠而不是堆在前面。

**P3. 释义要分层，先回答"在这句话里它是什么意思"。**
阅读场景下的第一需求是看懂这句话，不是学一个词的全部义项。所以顺序固定为：① 场景概要（在这句话里的意思）→ ② 细节（语境说明、真实例句、常见搭配）→ ③ 通用义（弱化收尾，只作对照）。
`why_translation_fails`（"为什么直译会跑偏"）字段仍保留在库里（老数据与将来的手工修正可用），但**默认不再展示** —— 它对"看懂这句话"没有增量，只会把结果拉长一屏。

**P4. 词的记忆是资产，不是消耗品。**
每次查词写入本地库。同一个词第二次被查，第一反应应该是"你 3 周前查过，这是当时的释义和出处"，而不是再调一次模型。

**P5. 卡包是"语义范围"，不只是文件夹。**
卡包的关键词会进入模型 prompt，决定"在这个范围里这个词是什么意思"。这既是分组，也是释义的约束条件。

## 4. 交互模型（核心改动：无热键的小窗）

### 4.1 窗口形态

- 一个**常驻小窗**，默认约 440 × 620，可缩放、可拖动、可记忆位置。
- 支持「置顶」开关（在 IDE / 浏览器旁边停靠时有用）和「收起为细条」。
- 托盘图标：显示待复习数、显示/隐藏窗口、退出。
- **不抢焦点**：窗口在后台更新内容时不夺走 IDE 的输入焦点。

### 4.2 取词的两条路径（都不需要热键）

**剪贴板监听不做**（见 §2）。取词只剩两条路：

| 路径 | 操作 | 说明 |
|---|---|---|
| **A. 拖拽入窗**（主） | 选中文字后直接拖到小窗上 | 完全跳过剪贴板。Chrome / VS Code / PDF 阅读器都支持拖拽选中文本 |
| **B. 输入 / 粘贴** | 在小窗输入框粘贴或输入，`Enter` | 兜底路径。已实现。**不再手选"单词 / 句子"**：与拖拽共用同一个分类器（`src/dragdrop.ts` 的 `classifyDrop`）自动判断 |

不监听剪贴板换来一个实在的好处：**不需要模拟按键（SendInput），也不读你复制的每一个东西**。实现更简单、更稳，权限和杀软误报的问题一起消失。

代价要说清楚：从"选中一个词"到"看到释义"的步数变多了。所以**路径 A 的体验就是 v1 的摩擦上限** —— 放下即查、命中区域够大、放下时窗口不抢焦点。这一条做砸，工具就会输给"干脆直接问 ChatGPT"。

拖入的内容仍需过滤，否则拖一段代码进来只是白烧一次请求。规则（任一条命中则只提示、不自动查）：长度 > 300 字符、换行超过 2 行、像文件路径 / URL / 纯数字 / base64、非拉丁字符占比过低。**输入框与拖拽共用这套判断**：不合格的输入同样只提示、不发请求。

关于 IDE 的已知问题（必须处理）：

- VS Code 多光标选中会带换行 → 先 trim 并折叠空白。
- 在终端里连命令带提示符一起选中 → 被上面的过滤器拦掉。

### 4.3 上下文句子的来源

用户双击选中的通常只是**一个词**，那就没有句子。不给句子，模型就只能猜领域。三个补法：

1. **卡包关键词兜底**（永远可用）：当前卡包的关键词本身就把语义范围收窄了，`handle` 在「Rust 后端」卡包里不会被解释成"把手"。
2. **句子**（P0）：把整句/整段直接粘进来或拖进来即可，**不需要先选模式** —— 分类器会把长内容判为句子。注意：PRD 原定的"自动切出难点词与搭配、逐条入卡"（见 §4.4 流程 B）**尚未实现**；当前句子与单词走同一个单次释义 prompt，整句作为上下文一起送。
3. **附带上下文**（P1）：若本窗口内上一次粘贴/拖入的文本较长（比如刚粘过的段落），可选地作为上下文一起送。**不读系统剪贴板历史。**

### 4.4 三个主要流程

**流程 A：查词入库**

```
在 Chrome 里选中 "handler" → 拖到小窗上（或 Ctrl+C 后在小窗里 Ctrl+V）
  ↓（放下 / 粘贴即查询）
小窗显示：
  卡包：[Rust 后端 ▾]                    ← 只在输入时出现；出结果后输入区收起
  handler  n.  [software]
  ── 领域义（在这句话里）─────
  处理请求/事件的代码单元，被调用去响应某个输入的函数或对象
  ── 在这句话里 ──────────────
  （若带了上下文句子）
  ── 例句 / 常见搭配 ─────────
  the request handler returns a promise
  request handler · error handler · event handler
  ── 通用义 ─────────────────  ← 弱化收尾，仅作对照
  把手；动词义「处理、应付」

  ┌────────────────────────────────┐
  │  [ 存入「Rust 后端」 ]          │  ← 底部常驻动作栏，永不随内容滚动
  └────────────────────────────────┘
  ↓ Enter = 主操作（此处＝存入）   Esc = 丢弃
```

要点：

- 若该词已在**当前卡包**中 → 顶部提示 `已在库中（3 周前，复习 2 次）`，显示旧释义，可一键用新释义覆盖。
- 若该词在**别的卡包**中 → 提示 `已在「AI」卡包中`，给两个选项：复用那张卡 / 在当前卡包新建一张。
- 若已有**我手动改过**的释义 → 优先显示我的版本，不再调模型。
- 相同 `词 + 卡包 + 引擎版本` 命中缓存 → 秒出，不消耗 API。
- **查询进行中**（2026-09-20 补记）：按钮变成 `查询中 2.0s`，旁边出现「**停止**」与一句
  `最长等 Ns，超了自动停 · 也可以按 Esc`。点「停止」或按 `Esc` 立刻回到可输入状态，
  **结果不会再进来**（服务端可能还在算）；等满「请求超时」（默认 45s）则走同一条路自动停。

**流程 B：句子模式**

```
整句/整段拖进来或粘进来
  ↓
小窗显示：
  原句（可点回原文）
  整句意思（中文，技术语境下）
  难点列表：
    ▸ handler                n.    处理该请求的函数          [存入卡包]
    ▸ returns a promise      v.    返回一个 Promise 对象     [存入卡包]
    ▸ stale                  adj.  （缓存/数据）过期的        [存入卡包]
```

**流程 C：复习**

```
到点 → 托盘角标显示待复习数 / 弹一次通知
  ↓ 点托盘或窗口切到复习页
一次一张卡
  正面：原始句子，目标词加粗
        "the request handler returns a promise" → handler 是什么意思？
  ↓ 空格翻开
  背面：领域义 + 通用义对照 + 出处链接
  ↓ 1 忘记  2 模糊  3 记得  4 太简单
  队列清空 → 回到待命
```

卡片默认考"**在句子里认出它**"，不考孤立单词。阅读真正需要的能力就是在句子里辨认。

## 5. 卡包（Deck）模型

```rust
struct Deck {
    id: i64,
    name: String,              // "Rust 后端"
    keywords: Vec<String>,     // ["rust", "tokio", "async", "ownership", "borrow"]
    description: Option<String>,
    created_at: i64,
}
```

规则：

- 存在一个"**当前卡包**"，小窗顶部可切换。查词默认存入当前卡包。
- `keywords` 会以固定文本注入 prompt 前缀，声明语义范围。例：`handle` 在 `["rust","tokio","async"]` 下会被解释为 async 运行时里的任务句柄。
- **同一个词在不同卡包 = 两张不同的卡**（两套释义、两条复习曲线）。这是有意为之，因为 `token` 在「AI」和「前端鉴权」里确实是两个词。
- 复习默认**跨卡包混排**，也支持按单卡包复习。
- 卡包关键词建议 3–8 个。太少约束不住，太多会互相干扰。
- （P1）根据来源 URL 建议卡包，例如 github.com/tokio-rs → 建议「Rust 后端」。

## 6. 需求分层

### P0 — v1 不可缺

| # | 需求 | 验收标准 |
|---|---|---|
| 1 | 常驻小窗 | 可缩放/拖动/记忆位置/置顶开关/收起；更新内容时不抢焦点 |
| 2 | 拖拽取词 | 从 Chrome / IDE 选中文字拖到小窗即触发查询；拖入代码块、路径或 URL 时只提示不查询 |
| 3 | 卡包 | 可创建/编辑/切换卡包；关键词可编辑；查词默认存入当前卡包 |
| 4 | 领域感知释义 | 给定 `词 + 卡包关键词 +（可选）句子`，返回领域义、通用义、直译为何不成立、例句、搭配、词性、置信度 |
| 5 | 一键入库 | Enter 即保存，不弹表单；保存卡包、上下文句子、来源（若可获取）、时间 |
| 6 | 本地存储与去重 | SQLite 落盘；重复查词提示历史记录而非重新请求 |
| 7 | 复习调度 | SM-2；每日队列硬上限（默认 15）；托盘显示待复习数 |
| 8 | 定时提醒 | 可设每日提醒时间；Windows 通知 + 托盘角标；同一天最多提醒 2 次 |
| 9 | 释义缓存 | 相同 `词+卡包+引擎版本` 命中本地缓存直接返回；离线可看已缓存内容 |
| 10 | 手动修正 | 任何释义可编辑；此后该词优先用我的版本 |
| 11 | 句子模式 | 粘贴/拖入整句，得到整句释义 + 难点词列表，可逐条入卡 |
| 12 | 历史检索 | 可按词、句子片段、卡包、来源搜索全部历史 |

> 变更记录：**剪贴板取词**原为 P0 第 2 项，2026-09-18 用户决定不做，已移入 §2 非目标；原第 3 项「拖拽取词」升为 P0 第 2 项，其余序号顺移。引用旧序号处已一并更新。
>
> 实现状态（2026-09-18）：第 4 项现在**默认不展示**"直译为何不成立"（见 P3 修订）；第 5 项 `Enter 存入` / `Esc 丢弃` 已实现（主操作固定在底部动作栏），`E 编辑后存入` 未实现；第 11 项"整句释义 + 难点词列表、逐条入卡"（§4.4 流程 B）**未实现**，当前句子与单词共用同一个单次释义 prompt。

### P1 — 显著提升

| # | 需求 | 说明 |
|---|---|---|
| 14 | 按卡包复习 / 混合复习切换 | 学习期按卡包聚焦更有效 |
| 15 | 个人术语表 | 手动维护 `术语 → 卡包 → 释义`，优先级高于模型 |
| 16 | GitHub / X 黑话层 | LGTM、nit、PTAL、ship it、squash、cherry-pick、thread、OP 等内置解释 |
| 17 | 来源卡包建议 | 由 URL/标题推断该存哪个卡包 |
| 18 | 导出 Anki | apkg / CSV |
| 19 | 附带上下文 | 本窗口内上一段较长的粘贴/拖入文本作为上下文一起送 |
| 20 | 卡片方向切换 | 某张卡从"识别"改为"产出"（中 → 英） |

### P2 — 现在不做，但别把路堵死

- Chrome 扩展（用于抓更完整的上下文；没有它也能用，所以优先级低）
- 本地模型（Ollama）离线释义 —— 数据模型留 `engine` 字段即可
- 发音、词根词缀、配图
- 学习报告（新增 / 掌握 / 遗忘曲线）
- 从浏览历史自动发现反复出现的生词
- 多设备同步

## 7. 数据模型

核心：**查词（lookup）与学习单元（card）分离**。查 5 次会生成 5 条 lookup，但只对应 1 张 card。

```sql
CREATE TABLE deck (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  keywords    TEXT NOT NULL,        -- JSON 数组字符串
  description TEXT,
  created_at  INTEGER
);

CREATE TABLE lookup (
  id                INTEGER PRIMARY KEY,
  raw_selection     TEXT NOT NULL,  -- 实际选中的文本
  norm_term         TEXT NOT NULL,  -- 归一化检索键，如 'handle|rust-backend'
  lemma             TEXT,
  deck_id           INTEGER REFERENCES deck(id),
  mode              TEXT,           -- 'word' | 'sentence'
  context_sentence  TEXT,
  context_before    TEXT,
  context_after     TEXT,
  source_hint       TEXT,           -- 来源线索（拖拽来源/标题，尽力而为）
  engine            TEXT,           -- 'deepseek:deepseek-flash' | 'glossary:xx' | 'user'
  created_at        INTEGER
);

CREATE TABLE definition (
  id                     INTEGER PRIMARY KEY,
  lookup_id              INTEGER REFERENCES lookup(id),
  pos                    TEXT,
  domain_meaning         TEXT,
  general_meaning        TEXT,
  why_translation_fails  TEXT,      -- 关键差异点
  in_context             TEXT,
  examples_json          TEXT,
  collocations_json      TEXT,
  confidence             TEXT,      -- high / medium / low
  is_user_edited         INTEGER DEFAULT 0,
  created_at             INTEGER
);

CREATE TABLE card (
  id                    INTEGER PRIMARY KEY,
  term_key              TEXT NOT NULL UNIQUE, -- 'handle|rust-backend'，卡包已并入 key
  display_term          TEXT NOT NULL,
  deck_id               INTEGER NOT NULL REFERENCES deck(id),
  primary_definition_id INTEGER REFERENCES definition(id),
  state                 TEXT,       -- new / learning / review / suspended
  due_at                INTEGER,
  interval_days         REAL,
  ease                  REAL DEFAULT 2.5,
  reps                  INTEGER DEFAULT 0,
  lapses                INTEGER DEFAULT 0,
  last_reviewed_at      INTEGER,
  created_at            INTEGER
);

CREATE TABLE review_log (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER REFERENCES card(id),
  rating        INTEGER,            -- 1 again / 2 hard / 3 good / 4 easy
  elapsed_ms    INTEGER,
  prev_interval REAL,
  next_interval REAL,
  reviewed_at   INTEGER
);

CREATE TABLE glossary (            -- 个人术语表，优先级高于模型
  id      INTEGER PRIMARY KEY,
  term    TEXT NOT NULL,
  deck_id INTEGER NOT NULL REFERENCES deck(id),
  meaning TEXT NOT NULL,
  note    TEXT,
  UNIQUE(term, deck_id)
);

CREATE TABLE def_cache (
  cache_key    TEXT PRIMARY KEY,   -- hash(norm_term|deck_keywords|context|engine|prompt_ver)
  payload_json TEXT NOT NULL,
  created_at   INTEGER
);

CREATE TABLE sentence_result (     -- 句子模式的整句结果
  id           INTEGER PRIMARY KEY,
  lookup_id    INTEGER REFERENCES lookup(id),
  source_text  TEXT NOT NULL,
  translation  TEXT,
  terms_json   TEXT,               -- 难点词数组
  created_at   INTEGER
);
```

## 8. 释义生成的输出契约

模型必须返回结构化字段，否则前端无法对照展示、无法入库、无法复习。

```json
{
  "lemma": "handler",
  "pos": "n.",
  "domain_meaning": "处理请求/事件的代码单元，即被调用去响应某个输入的函数或对象",
  "general_meaning": "把手；动词义为「处理、应付」",
  "why_translation_fails": "通用词典给出「把手」，但此处 handler 指的是一个可被调用的实体，不是实物",
  "in_context": "在「the request handler returns a promise」中，handler = 处理该请求的那个函数",
  "examples": ["the request handler returns a promise"],
  "collocations": ["request handler", "error handler", "event handler"],
  "confidence": "high"
}
```

Prompt 结构（顺序固定，见 §9 的缓存要点）：

```
[system]  <固定角色说明 + JSON 输出格式说明 + 示例>      ← 稳定前缀，可被缓存
[system]  <卡包范围声明>                                   ← 同一卡包内稳定，可被缓存
          当前领域范围关键词：rust, tokio, async, ownership
          在这些领域内解释下面的词。
[user]    term: handler
          sentence: the request handler returns a promise
          请输出 json。
```

原则：**只发选中的词 + 一句话（可选前后一句），不发整页。** 省 token，也降低隐私暴露面。

## 9. DeepSeek 接入要点（已从官方文档核实）

以下事实于实现前从 api-docs.deepseek.com 实时抓取核对，不是记忆推断。你配置的三项都成立：

| 项 | 你的值 | 核实结果 |
|---|---|---|
| `OPENAI_BASE_URL` | `https://api.deepseek.com` | 与文档一致（OpenAI 格式） |
| `OPENAI_MODEL` | `deepseek-flash` | 有效，且是文档**推荐**写法；对应 DeepSeek-V4.1-Flash。旧名 `deepseek-v4-flash` 仍接受但模型已退役 |
| `OPENAI_API_KEY` | `sk-xxx` | 你贴的是占位符，无法验证真实可用性 |

**必须处理的一点：`deepseek-flash` 默认开启 thinking 模式，且默认 effort 为 `high`。**
这会让每次查词变成数秒级思考 + 大量 `reasoning_content` 输出，直接违背 G1（≤3 秒）。查词不需要推理，要显式关掉：

- REST：请求体加 `{"thinking": {"type": "disabled"}}`（等价的还有 `{"reasoning": {"effort": "none"}}`）。
- OpenAI SDK（Python）：`thinking` 必须放进 `extra_body`，否则不生效。

其他已核实的行为差异：

- **thinking 模式下 `temperature` / `presence_penalty` / `frequency_penalty` 被静默忽略**（不报错但无效）。我们依赖低 temperature 求稳定，所以只有在**非 thinking 模式**下 `temperature` 才生效。
- `top_p` 在 thinking 模式下有 0.95 下界；非 thinking 模式固定 1.0 且忽略你传的值。别靠 `top_p` 控稳定性。
- **JSON Output**：`response_format={"type":"json_object"}`，且 **prompt 里必须出现 "json" 字样并给出格式示例**。文档明确说明"可能偶发返回空 content"，所以**必须有重试与兜底**：解析失败 → 重试一次 → 仍失败则降级为自由文本展示并提示。
- **上下文缓存（省钱关键）**：命中缓存的输入价格是未命中的 **1/50**（off-peak $0.003 vs $0.15 / 1M tokens）。缓存按**前缀完全匹配**，所以 §8 里那两段固定 system prompt 放在最前面、逐字不变，就能稳定命中。响应里的 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 可用来验证是否命中。
- **价格与时区**：peak 为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余时段半价。换算成北京时间约 09:00–12:00 与 14:00–18:00 是 peak。**傍晚和晚上学习是半价。** 单次查词量级约 $0.0003，实际成本可忽略，但值得心里有数。
- 并发上限 2500，个人使用无压力。上下文 1M，最大输出 384K，我们只用得上极小一部分。

**配置写入方式的建议**：不要把 key 放在系统环境变量里指望应用去读。桌面应用从资源管理器双击启动时**不继承你在 shell 里的环境变量**，典型症状是"命令行跑得通、双击打不开"。正确做法是写进应用自己的配置文件（或 Windows 凭据管理器），设置页可编辑并测试连通性。

**落地情况（2026-09-20 补记）**：上面这条已实现 —— 设置页可编辑 `API Key` / `Base URL` / `模型` / `请求超时`，
并有「**测试连接**」按钮：它用表单里**此刻**的值（改完不必先保存）发一次极短的 chat 请求，
成功时显示服务端实际使用并回显的模型名、往返毫秒数与回复内容，失败时把 HTTP 状态与响应体原文摆出来。

同一条里"必然会有超时"的推论也补上了两件配套能力（此前都没有）：

* **请求超时可配**：`请求超时` 5–300 秒，默认 45，落库时 clamp。它是**整次查词**的总预算（不是每个 HTTP 请求各算一份），
  超了就放弃这次查询并给出可读提示 —— 这也是 §13"模型不响应 / 响应被截断"那一行的缓解手段。
* **查询可以中途停止**：查询进行中界面给出「停止」按钮（此时 `Esc` 等价于它），按下立刻回到可输入状态，
  不再等这次响应。机制见 VERIFICATION §8。

## 10. 复习算法

v1 用 **SM-2**（规则简单、可解释、实现量小）：

- rating ≥ 3（记得）：interval 依次 1 天、6 天，之后 `interval × ease`；ease 按评级微调。
- rating < 3（忘记）：`reps` 归零，interval 回到 1 天，`lapses +1`。
- 每日队列上限默认 15，可调。
- **债务保护**：`due_at` 逾期超过 14 天的卡不进当日队列，标记 `suspended` 并提示"要重新激活吗"，避免队列雪崩。

FSRS 更准但需要参数与数据积累。v1 不做；`review_log` 的完整记录足以支撑以后平滑迁移。

## 11. 技术选型与环境（已实测）

| 层 | 选择 |
|---|---|
| 外壳 | Tauri 2（Rust），已落地 |
| 前端 | React 19 + TypeScript + Vite，已落地 |
| 存储 | SQLite（`rusqlite`，bundled），已落地 |
| 取词 | 拖拽入窗 + 手动粘贴（无需模拟按键、不读剪贴板）；两条路均已落地 |
| 释义 | DeepSeek `deepseek-flash`（显式关 thinking）+ 本地缓存 + 个人术语表，已落地（术语表界面未做） |

本机环境实测结果、构建与运行命令见 [DEVELOPMENT.md](DEVELOPMENT.md)。这台机器的具体版本号会随工具链升级而变 —— 放进产品文档只会腐坏。PRD 只记"为什么选它"，环境与构建细节归开发文档。

## 12. 成功指标（个人工具，自己就是用户）

领先指标（1–2 周可看）：

- 每日入库词数 ≥ 5（低于此说明取词摩擦仍太大）
- 复习队列当天完成率 ≥ 70%
- 从"决定要查"到看到释义的中位耗时 ≤ 5 秒。**不做剪贴板监听后这条从 2 秒放宽了** —— 换来的好处见 §2
- 拖入/粘贴了不该查的东西（一大段代码、路径、URL）每日 ≤ 3 次

滞后指标（1–3 个月）：

- 30 天后仍在使用 —— 唯一的生死线
- **重复查询率下降**：同一个词两次查询的间隔在变长，说明真记住了
- 自评：同一篇技术文章比一个月前读得快

## 13. 风险与失败模式

| 风险 | 后果 | 缓解 |
|---|---|---|
| 取词步数太多（选中 → 拖/复制 → 粘 → Enter） | 嫌麻烦 → 懒得用 → 只查不记 → 弃用 | 拖拽尽量做到"放下即查"；粘贴后 Enter 直接查；不要求每次选卡包 |
| 小窗挡住 IDE / 浏览器 | 烦 → 关掉 → 弃用 | 可收起为细条、置顶开关、记忆位置、不抢焦点 |
| 复习队列积压 | 欠债后直接弃用（Anki 经典死法） | 每日硬上限 + 逾期卡休眠 |
| 模型释义错误 | 学到错的东西，比不知道更糟 | 领域义与通用义对照、附真实例句、标 confidence、支持一键改成自己的版本并永久优先 |
| thinking 模式默认开启 | 每次等好几秒，体验崩 | 显式 `thinking: disabled`，设置页可验证 |
| JSON 偶发返回空 | 查询失败 | 重试一次 + 降级展示 + 错误提示 |
| 模型不响应 / 响应被截断（实测见过 `error decoding response body`） | 界面永远停在"查询中"，用户只能重启应用 | 整次查词有可配总超时（默认 45s）；传输层错误也进重试（2 次）；查询中随时可点「停止」立刻脱身 |
| 只"查"不"记" | 退化成又一个划词翻译 | card 与 lookup 强绑定，入库即建卡 |
| 卡包关键词定得太宽/太窄 | 释义跑偏 | 关键词可随时改；已有释义不自动重算，提示可手动刷新 |

## 14. v1 最小可用范围与建议顺序

最小可用 = P0 的 1、3、4、5、6、7（常驻小窗 / 卡包 / 领域感知释义 / 一键入库 / 本地存储与去重 / 复习调度）。**先把手动路径跑通。**

1. **骨架**：Tauri 2 项目 + SQLite schema + 小窗布局（卡包选择器 / 输入框 / 结果区 / 复习页）
2. **打通释义**：接 DeepSeek，`thinking: disabled` + JSON 输出，返回 §8 的字段，落库
3. **卡包**：CRUD + 关键词注入 prompt
4. **复习**：SM-2 + 复习页 + 托盘待复习数
5. **拖拽取词**：命中区域 + 放下即查 + 拖入内容过滤
6. **提醒与历史检索**
7. **打磨**：缓存、手动修正、句子模式

第 1–4 步走完这个工具就已经有用了 —— 此时它还只是个"粘贴查词"的小窗。拖拽取词（第 5 步）不该和它挤在一起做：先用手动路径跑够几十个词，你才知道自己真实的取词习惯，拖拽的过滤规则和默认行为才定得准。

## 15. 开放问题

已确定：

- ~~Q1 技术栈~~ → **Rust + Tauri**
- ~~Q2 释义引擎~~ → **DeepSeek，`deepseek-flash`，非 thinking 模式**
- ~~Q4 剪贴板触发方式~~ → **不做剪贴板监听**（2026-09-18 用户决定，见 §2 非目标）。取词收敛为拖拽入窗 + 手动粘贴

待确认：

- **Q3 平台范围**：只做 Windows，还是要兼顾 macOS？（本机是 Windows，默认只做 Windows）
- **Q5 复习目标**：只练"看到英文认出意思"（识别），还是也要练"想到中文写出英文"（产出）？后者卡片量与难度明显上升。
- **Q6 是否接 Anki**：若你已用/打算用 Anki，本工具就退化为"高质量取词入库前端"，复习交给 Anki；不想再装软件的话，复习自己实现（v1 默认按后者）。
- **Q7 卡包怎么分**：现在有几个？建议初始划分：`编程通用 / 前端 / Rust后端 / AI·LLM / 网络协议 / GitHub协作黑话`。按实际阅读内容调整。
- **Q8 来源信息**：不做浏览器扩展的话，来源 URL 基本拿不到（拖拽能拿到标题，粘贴拿不到）。可接受吗？影响的是复习卡上"回原文"这个功能。

---

## 附：事实 / 推断 / 假设

**事实（你的输入）**：熟悉 Rust + Tauri；有 DeepSeek API 可用（env 命名沿用 OpenAI 风格）；希望卡包用关键词定义翻译范围；不要全局热键（尤其 IDE 场景）；只要一个小桌面窗口。

**事实（本次核实，来自 DeepSeek 官方文档实时抓取）**：§9 全表 —— base URL、`deepseek-flash` 有效性、thinking 默认开启且 effort 默认 high、关闭参数形式、thinking 模式忽略 temperature、JSON Output 用法与偶发空返回、前缀缓存 1/50 价差及校验字段、峰谷时段、并发与上下文上限。

**事实（本机实测）**：见 [DEVELOPMENT.md](DEVELOPMENT.md) 的环境表 —— Rust 1.96 MSVC、Node 24、VS 2022、WebView2 已装；Tauri CLI 不需要全局安装（走 npm devDependency）。

**推断（可推翻）**：阅读主要在浏览器但 IDE 场景占比不低；每天生词个位数到几十；一人使用，无需账号与协作；真正风险是"两周后弃用"而非功能不够。~~剪贴板误触发会比预期更早成为痛点~~ —— **已作废**（剪贴板监听不做），代之以：取词摩擦（多出的那几步操作）成为主要流失点。

**实现与验证状态**：见 [VERIFICATION.md](VERIFICATION.md) —— 已逐条走过的 16 条命令、自动化测试结果、证据截图、修掉的真 bug，以及"句子流程 B 未实现"这类未做项。

**构建期踩过的坑**：见 [DEVELOPMENT.md](DEVELOPMENT.md) 的「这台机器上的坑」。其中"reqwest 必须显式 `native-tls`"同时是硬约束（本机没有 cmake / nasm），不是临时 workaround。

**仍未做**：一键入库的 `E 编辑后存入`（`Enter 存入` / `Esc 丢弃` 已实现，主操作已固定在底部动作栏）、句子流程 B（整句大意 + 难词清单、逐条入卡）、托盘图标、到期通知、释义手工编辑、个人术语表界面。
