# 实施方案：压缩后重挂本会话已调用的技能正文

技术路线一句话：技能调用记录只从会话消息里**派生**（`Skill` 的 `tool_use`），正文每次压缩从
磁盘**重渲染**，重挂形态是摘要消息正文的最后一个章节，跨代只继承一份无正文的记录字段。
需求见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 事实与派生（core-rs/src/compact.rs）

| 东西 | 来源 | 是否落盘 |
| --- | --- | --- |
| 调用记录 `{ name, args }` | 会话消息里 `assistant` 的 `tool_use`（`name == "Skill"`） | 是：摘要消息的 `compactLoadedSkills` |
| 记录先后序 | 记录数组的顺序（越靠后越近） | 同上 |
| 正文 | 压缩时 `skills::find_skill(cwd)` + 重渲染 | 否（投影） |
| 「正文仍在上下文」 | 保留区里带同名 `skillName` 的 `isMeta` 消息 | 否 |

`compactLoadedSkills` 的形态是 `[{ name, args }]`，数组顺序即调用先后（末尾最近）。合并按
「上一代摘要字段 → 本次归档区 → 本次保留区」三段顺序追加，同名先删旧再追加，因此**天然取最近
一次**且只有一条。旧会话没有该字段、字段形态非法、条目缺 `name` → 逐条忽略，等价于「无历史
记录」，不中断压缩。

### 2. 重挂章节（`build_loaded_skills_section`）

章节固定为摘要正文的**最后一个**章节，位于固定尾注之前：

```
### 已加载技能

以下技能是本会话较早时候加载的，不是当前轮次的要求；其中的指令按既有优先级继续生效。

#### <name>
技能目录：<dir>            ← 仅当 skill_root 存在

<从磁盘重渲染的正文>

（已截断：<name> 的正文超过单项上限 5000 token，仅保留开头；需要全文请重新调用 /<name>）

（以下技能因总量预算未重挂：a、b）
（以下技能无法重新读取，未重挂：c；请确认 SKILL.md 是否仍在）
```

- 填充顺序：**最近调用优先**，展示顺序与填充顺序一致（最近的在最上面）。
- 单项上限 `COMPACT_SKILL_MAX_TOKENS = 5000`、总量 `COMPACT_SKILL_TOTAL_TOKENS = 25000`，
  都按 `util::estimate_text_tokens` 计算，且**整章**（标题 / 前言 / 来源行 / 说明行）一起计入。
- 单项超限用新的 `util::take_prefix_within_tokens` 取开头（逐 UTF-16 code unit 按
  `estimate_text_tokens` 的同一套系数累加，与估算函数同口径），再追加截断说明行。
- 总量溢出：从最旧的那个开始整项放弃，剩余全部点名进同一行说明，不静默丢弃。
- 失败：`find_skill` 解析不到就进「无法重读」名单并 `eprintln!` WARNING；压缩本身不失败
  （摘要生成失败本来就有空摘要兜底，重挂不依赖摘要输出）。
- 说明行本身顶穿预算时才允许省略，改记 core 日志。
- 章节为空（没有记录，或所有记录都仍在保留区）→ 不产出章节、摘要正文逐字节不变。

### 3. 正文渲染只有一份（core-rs/src/skills.rs）

新增 `skills::render_skill_body(&SkillCommand, args, session_id) -> String`：
`prompt_for_command(args)` 取内容块 → 拼文本 → `substitute_builtin_variables(.., skill_root,
Some(session_id))`。`tools::run_skill`（模型调用与用户 `/name` 两条路径共用）改成调它，
压缩重挂也调它——满足 spec FR-003「与首次注入走同一份渲染逻辑」，不会出现两套口径。

### 4. 注入消息加一个名字标记（core-rs/src/tools.rs）

`run_skill` 产出的 `isMeta` user 消息上加 `"skillName": <name>`。没有它就无法结构化判断
「这个技能的正文是否仍在保留区」，只能做内容比对（spec 明确不做）。字段与正文一样只进落盘
消息、不进 LLM 载荷（`build_raw_api_messages` 只取 `role` / `content`）。

`replay.rs` 跳过 `isMeta` 消息，UI 与 TUI 都不受影响。

### 5. 摘要输入卫生（FR-005）

`format_messages_for_compact` 对 `isCompactSummary` 消息依次剥离「后台任务」与「已加载技能」
两个章节。剥离实现按**章节是最后一个**这一点走：从标题行首到固定尾注起点之间全部丢掉，尾注
保留。这样技能正文里自带的 Markdown 标题 / `---` 不会把剥离截断（后台任务章节用的是遇到标题
即止的通用逻辑，因为它后面还有章节）。

固定尾注提成常量 `COMPACT_FOOTER`，`generate_compact_user_message` 与剥离函数共用一份。

### 6. 签名变更

`compact_conversation` / `compact_conversation_inner` 增加 `cwd: &str`（重渲染要按会话工作目录
解析技能）。唯一调用点 `compact_and_apply_messages` 传 `project`。`generate_compact_user_message`
增加 `loaded_skills: Option<&str>` 入参。

### 7. 测试面

| 层 | 落点 | 覆盖 |
| --- | --- | --- |
| 纯函数对照表 | `core-rs/fixtures/compact.json` 的 `compactUserMessages` / 新增 `loadedSkills` 段 | 章节形态、截断、溢出点名、失败点名、空集不出章节 |
| 纯函数单测 | `core-rs/src/compact_tests.rs` | 记录合并 / 去重 / 保留区判定 / 字段损坏 / 剥离边界 |
| 引擎级 | `core-rs/src/compact_engine_tests.rs` | 一次压缩重挂、二次压缩仍重挂、保留区已含不重复 |
| e2e（electron 车道） | 新增 `e2e/electron/skillReloadAfterCompact.spec.ts` | 真实 Core + mock LLM：压缩后下一轮请求含正文；**重复压缩**下第二代仍重挂、第一代章节不进摘要输入、磁盘改动取新版 |

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/compact.rs` | 新增常量 / 记录派生 / 章节组装 / 剥离 / `cwd` 入参 | 无事件、无契约成员；摘要消息多一个落盘字段 `compactLoadedSkills` |
| `core-rs/src/skills.rs` | 新增 `render_skill_body` | 无 |
| `core-rs/src/tools.rs` | `run_skill` 复用 `render_skill_body`，注入消息加 `skillName` | 无（消息级内部字段） |
| `core-rs/src/util.rs` | 新增 `take_prefix_within_tokens` | 无 |
| `core-rs/src/format_messages_for_compact`（compact.rs） | 剥离新章节 | 无 |
| `core-rs/fixtures/compact.json` | 新增对照用例 | 无 |
| `core-rs/src/compact_tests.rs` / `compact_engine_tests.rs` | 新增用例 | 无 |
| `e2e/electron/skillReloadAfterCompact.spec.ts` | 新增 | 无 |
| `docs/features/compaction.md` / `skills.md` / `user-stories/tools.md` / `TODO.md` | 同步 as-built | 无 |

`UiEvent` / `UiRequest` / `CoreEvent` / `CoreRequest` 一律不动：重挂是压缩流程内部的产物，
不新增总线消息。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 `core-rs/`（Core 进程内），不碰 `src/host/`、
      不 import 宿主 API、不做宿主嗅探；`src/shared/` 不动。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback——技能解析不到就点名 + WARNING 而不是
      静默吞；契约成员全必选——不动契约；一份事实一个写入点——调用记录只由压缩按消息派生、
      只写进摘要消息一个字段，正文是磁盘投影（不在落盘里留第二份）；默认值单源——两个预算
      常量各只有一处定义。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：落点全在 `core-rs/`，摘要消息新增字段
      由 `compact_tests.rs` 与引擎级用例锁定；`src/shared/history/` 只有元数据类型与只读视图，
      不解析消息体，无需两侧同步（确认：`src/shared/` 里没有对 `compactUserInputHistory`
      等同级字段的解析）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`docs/features/compaction.md`（新 FR-007 + 场景 7 +
      边界 + 追溯矩阵）、`docs/features/skills.md`（3.4 注入路径、边界、非目标删一条、追溯
      矩阵）、`docs/features/user-stories/tools.md`（US-27 第 5 条）、`TODO.md`（缩窄条目）。
      时机：收敛核对通过后与代码同一提交。

## 被否决的替代方案

1. **重挂调用那一刻的正文副本**（Claude Code 现行口径）。否决：副本会把过期规则当成现行
   规则继续生效，而且要在订阅记录里多存一份正文（与「一份事实一个写入点」冲突）。用户已选
   「现读磁盘重渲染」。
2. **在进程内维护 per-session 已加载技能表**。否决：`--resume`、Core 重启、多视图都会丢；
   落盘字段才是跨代载体。
3. **用 `Base directory for this skill:` 前缀或正文内容比对来判定「正文是否仍在保留区」**。
   否决：捆绑技能没有 base dir，内容比对随文件改动立刻失效（spec 明确不做内容比对）。
4. **重挂走一次 `Skill` 工具调用**（模型 / 用户路径复用）。否决：会产生 `Skill` 卡片、落三条
   消息、刷 `messageCount`，且会撞 `disable-model-invocation` 的模型侧校验；FR-006 明确不要。
5. **把重挂做成独立消息插在摘要之后**。否决：破坏 `[边界标记, 摘要, ...保留区]` 三段形态，
   展开与代次下标都要跟着改；章节留在摘要正文里，归档与展开零改动。
6. **总量溢出时静默截断**（Claude Code #96168 的现行行为）。否决：模型与用户都不知道技能
   丢了；改为点名说明，放不下才降级到日志。
