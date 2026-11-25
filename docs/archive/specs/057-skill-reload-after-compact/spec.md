---
status: 已收敛
---

# 改动规格：压缩后重挂本会话已调用的技能正文

技能正文是一次性进上下文的：`Skill` 工具把 `SKILL.md` 渲染成一条 `isMeta` 的 user 消息落盘，
之后就是普通历史。压缩把较早的历史折进摘要，摘要里通常只剩「加载过某技能」这类痕迹，
红线规则与检查清单从模型可见层消失；模型也不知道自己已经忘了，不会自觉重调 `/name`。

本改动让「本会话真正调用过的技能」在压缩后按预算重挂：正文来源是**压缩那一刻从磁盘重渲染
的原版**，不是摘要、也不是调用时的旧副本。范围只覆盖 core 侧的压缩事实与落盘字段；
进度提示、摘要卡片的展示形态不在本规格内。

交叉引用：压缩流程与三段产物形态见
[compaction.md FR-003](../../docs/features/compaction.md#fr-003压缩流程与落盘)；技能注入路径见
[skills.md 3.4](../../docs/features/skills.md#34-注入路径)；两个调用开关的语义见
[skills.md FR-001](../../docs/features/skills.md#fr-001两个调用开关各管一侧)与
[ADR-0011](../../docs/adr/0011-agents-shared-skills-discovery.md)；「core 描述事实，UI 决定表现」见
[principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [1. 用户场景与验收标准](../../docs/features/compaction.md#1-用户场景与验收标准) | 修改 | 新增「场景 7：已调用技能跨压缩携带」及其验收标准 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | FR 章节（新增 `FR-007：已加载技能随压缩携带`） | 新增 | 记录字段、重挂章节形态、预算与截断、正文来源、跨代延续 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [3.1 数据流](../../docs/features/compaction.md#31-数据流) | 修改 | 压缩产物仍是三段形态，摘要正文多一个章节 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [4. 边界与错误路径](../../docs/features/compaction.md#4-边界与错误路径) | 修改 | 补技能已删除 / 读失败 / 预算溢出 / 保留区已含正文四类 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [7. 追溯矩阵](../../docs/features/compaction.md#7-追溯矩阵) | 修改 | 补 `FR-007` 行 |
| [docs/features/skills.md](../../docs/features/skills.md) | [3.4 注入路径](../../docs/features/skills.md#34-注入路径) | 修改 | 补「压缩后的重挂」这一条正文来源 |
| [docs/features/skills.md](../../docs/features/skills.md) | [4. 边界与错误路径](../../docs/features/skills.md#4-边界与错误路径) | 修改 | 补技能文件在压缩前被删除 / 改动的预期 |
| [docs/features/skills.md](../../docs/features/skills.md) | [5. 非目标](../../docs/features/skills.md#5-非目标) | 修改 | 移除「压缩后不重新挂载已加载的技能正文」；保留预算、去重两项 |
| [docs/features/skills.md](../../docs/features/skills.md) | [7. 追溯矩阵](../../docs/features/skills.md#7-追溯矩阵) | 修改 | 补重挂的测试落点 |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [US-27 斜杠命令与技能触发](../../docs/features/user-stories/tools.md#us-27-斜杠命令与技能触发) | 修改 | 验收标准新增第 5 条（压缩后已调用技能仍生效） |

`TODO.md` 的「技能名单的上下文经济」同步缩窄范围：其中「压缩后不重新挂载已加载的技能正文」
一项，本次落地后删去；名单预算与重复调用去重仍是未排期缺口。

## 用户场景与验收标准

- 场景 1：模型在压缩前调用过技能
  - **AC-1**（FR-001）：GIVEN 本会话调用过技能 `a` WHEN 压缩完成 THEN 摘要消息正文含 `a` 的重挂正文，且正文是该技能当前文件内容。
  - **AC-2**（FR-001）：GIVEN 本会话从未调用任何技能 WHEN 压缩完成 THEN 摘要正文与不含重挂章节的形态逐字节相同，落盘不出现技能字段。
- 场景 2：用户 `/name` 触发过的技能
  - **AC-3**（FR-001）：GIVEN 用户发送 `/a args` 触发技能 `a` WHEN 压缩完成 THEN `a` 以同样的 `args` 重挂，正文里的 `$ARGUMENTS` 替换结果与首次注入一致。
  - **AC-4**（FR-006）：GIVEN 技能 `b` 设 `user-invocable: false` 但模型调用过 WHEN 压缩完成 THEN `b` 重挂；其斜杠菜单可见性不变。
- 场景 3：正文来源
  - **AC-5**（FR-003）：GIVEN 技能 `a` 在首次调用后磁盘内容被改写 WHEN 压缩完成 THEN 重挂正文是改写后的内容，不是首次注入的副本。
  - **AC-6**（FR-003）：GIVEN 技能 `a` 在首次调用后被删除 WHEN 压缩完成 THEN 压缩照常完成，`a` 不出现在重挂正文里，摘要正文点名 `a` 未能重读，core 日志有 WARNING。
- 场景 4：预算
  - **AC-7**（FR-002）：GIVEN 单个技能正文超过单项上限 WHEN 重挂 THEN 只保留开头到上限，并带一行截断说明（含该技能名与「可重新调用取全文」的指引）。
  - **AC-8**（FR-002）：GIVEN 已调用技能的总量超过总预算 WHEN 重挂 THEN 按「最近调用优先」填充，被整项挤出的技能逐个点名在同一行说明里，不静默丢弃。
  - **AC-9**（FR-002）：GIVEN 重挂章节的估算 token 数 WHEN 与总预算比较 THEN 计算用 `util::estimate_text_tokens`，章节整体（含标题与说明行）不超总预算。
- 场景 5：跨多次压缩
  - **AC-10**（FR-004）：GIVEN 会话已经历一次压缩、其中的技能早已不在保留区 WHEN 再次压缩 THEN 该技能仍出现在新的重挂章节里。
  - **AC-11**（FR-004）：GIVEN 同一技能在本会话被调用两次且参数不同 WHEN 压缩完成 THEN 只重挂最近一次（参数取最近一次的），章节里该技能只出现一次。
  - **AC-12**（FR-004）：GIVEN 技能的最近一次注入正文仍完整落在保留区 WHEN 压缩完成 THEN 不重复重挂该技能，落盘字段仍记录它。
  - **AC-13**（FR-005）：GIVEN 上一次压缩的摘要消息落在本次归档区 WHEN 生成本次摘要 THEN 上一次的重挂章节不进摘要输入（正文其余部分照常进）。
- 场景 6：并发与失败
  - **AC-14**（FR-003）：GIVEN 重挂时技能文件读不出（权限 / 编码错误） WHEN 压缩完成 THEN 压缩仍以 `complete` 收尾，该技能不进正文并被点名，消息数组照常替换。
  - **AC-15**（FR-004）：GIVEN 摘要消息落盘 / 读取时技能字段缺失或形态非法 WHEN 再次压缩 THEN 按「无历史记录」处理并从本次归档区重新收集，不报错、不中断压缩。

## 功能需求

### FR-001：会话内已加载技能的事实

- 一条「已加载技能」记录 = 技能名 + 调用参数 + 最近一次调用的先后序。记录**不含正文**：
  正文是磁盘内容的投影，随文件变化，不作为事实留存。
- 收集范围是本会话的 `Skill` 工具调用：模型主动调用与用户 `/name` 派发都算（两条路径共用
  同一次工具执行）。**不**收集 `Agent` 子代理在它自己会话里的调用——技能记录按会话隔离。
- 记录带在压缩摘要消息上（字段 `compactLoadedSkills`），随会话 JSONL 落盘：它是跨多次压缩
  与 `--resume` 后仍能重挂的唯一载体，不依赖进程内状态。
- 两个调用开关（`user-invocable` / `disable-model-invocation`）不影响记录：被调用了就记。
- 本会话没有调用记录时不留字段、不出章节。

### FR-002：压缩后的重挂章节

- 压缩产物仍是 `[边界标记, 摘要, ...保留区]` 三段形态，重挂内容作为摘要消息正文里的一个
  章节，标题为 `### 已加载技能`，位置在「用户输入历史」「后台任务」之后、固定尾注之前。
- 章节开头一句时点与来源说明：这些技能是本会话较早时候加载的，不是当前轮次的要求，
  仅为保持规则可见而重述；其中的指令按既有优先级继续生效。
- 每个技能一段：先是 `#### <name>` 与一行来源（技能目录路径），然后是正文。
- **预算**：单项上限 5,000 token，总量上限 25,000 token，均按 `util::estimate_text_tokens`
  计算；预算与上限是可从常量读到的确定值，不按模型 / 配置浮动。
- **填充顺序**：按「最近调用优先」填充；单项超限时保留开头并追加一行截断说明（点名该技能、
  说明可重新调用取全文）。总量不足时**整项**放弃最旧的，把所有被放弃的技能名写进章节末尾
  一行说明，不静默丢弃。
- 章节整体（标题、来源行、说明行都算）不超总量上限：说明行本身超预算时才允许省略说明并
  改在 core 日志里点名。
- 子代理会话与主会话同口径：有调用记录就重挂，没有就不出章节。

### FR-003：正文来源是压缩那一刻的磁盘内容

- 每条记录在压缩时**重新渲染**：按名字在当前工作目录解析技能（与 `/name` 派发同一套发现与
  仲裁），用记录里的参数做变量替换（`$ARGUMENTS` / `${SKILL_DIR}` / `${SESSION_ID}`），
  与首次注入走同一份渲染逻辑。
- 因此重挂的是技能文件的**当前**内容与当前目录路径：文件改了就重挂新版，路径变了就写新路径。
  这与「已注入的旧副本」是有意区别——旧副本会把过期规则当成现行规则。
- 解析不到 / 读不出 / 渲染失败：该技能不进正文，摘要正文末尾的说明行点名它，core 日志打一条
  点名技能名与原因的 WARNING；压缩本身不因此失败。
- 重挂发生的读写都在压缩流程内，不经工具执行、不经模型调用，因此不受 `disable-model-invocation`
  限制，也不会产生新的消息、事件或 UI 卡片。

### FR-004：跨代延续与去重

- 组合事实源三处，按技能名合并、取「最近一次调用」：本次归档区里的 `Skill` 调用、
  保留区里的 `Skill` 调用、上一代摘要消息上的 `compactLoadedSkills`。
- 摘要消息上的字段是跨代载体：字段里的记录在本次压缩时已不在消息里，仍要被继承下来，
  否则每压一次就丢一代。
- 保留区里若仍完整含某技能的最近一次注入正文，则该技能不进重挂正文（不重复占预算），
  字段照常记录。「完整」以该 `isMeta` 注入消息是否仍在保留区为准，不做内容比对。
- 同一技能的多次调用只留最近一次（参数取最近一次）；按名字去重，不按参数。
- 读到旧版本落盘的摘要或字段形态非法（缺 `name`、类型不对）时，忽略该条并按「无历史记录」
  处理，从本次归档区重新收集。

### FR-005：二次压缩的摘要输入卫生

- 上一次的重挂章节在被喂进摘要模型之前剥掉，机制与「后台任务」章节的剥离同族：只对
  `isCompactSummary` 消息生效，剥掉的范围从章节标题到下一个章节边界或正文末尾，正文其余
  部分照常进摘要输入。
- 理由：章节里是旧版技能正文，原样进摘要会被压成一段似是而非的规则文本，与本次新算的章节
  自相矛盾，并且会让摘要模型的输出里混进技能指令。
- 剥掉之后仍要能继承记录——字段与正文分离，剥正文不影响 FR-004 的跨代继承。

### FR-006：重挂不改变技能的调用语义

- 重挂既不改斜杠菜单（`user-invocable`）、也不改模型名单与模型调用校验
  （`disable-model-invocation`）：它只是把已经加载过的正文重新放回上下文。
- 重挂不产生用户消息、不产生 `Skill` 卡片、不刷新 `meta.json` 的 `messageCount`：压缩的
  消息计数变化只来自三段产物本身。
- 重挂内容对用户可见（它在摘要消息正文里，与「用户输入历史」「后台任务」同口径）；展示形态
  （折叠 / 摘要卡片布局）由 UI 决定，不在本规格内。

## 边界与错误路径

- **一个技能都没调用过**：不留 `compactLoadedSkills` 字段、不出章节，摘要正文与改动前逐字节
  相同（AC-2）。
- **技能文件在压缩前被删除 / 改名**：从重挂正文里缺席，说明行点名，WARNING 落 core stderr
  并带原因；压缩仍 `complete`（AC-6、AC-14）。
- **同名技能被更高优先级的根遮蔽**：重挂按当前仲裁结果解析，因此出现的是胜出路径与它的
  正文；被遮蔽的那份不参与。
- **单项超限**：保留开头，追加截断说明行；不静默截断（AC-7）。
- **总量超限**：整项放弃最旧的，放弃名单写进说明行；说明行本身放不下时改记 core 日志
  （AC-8）。
- **`compactLoadedSkills` 字段损坏**：忽略损坏条目、按无记录继续，不中断压缩（AC-15）。
- **摘要生成失败**（既有的空摘要兜底）：重挂章节照常产出——它不依赖摘要模型的输出。
- **保留区已含最近一次正文**：不重复重挂（AC-12）。
- **压缩被中止 / 前台忙碌**：仍按 FR-002 的既有触发路径执行，重挂不引入新的中止点。
- **`--resume` 后首次压缩**：字段来自已落盘的摘要消息，正常继承；旧版本会话没有该字段时按
  「无历史记录」处理。

## 非目标

- 技能名单（`## Available Skills`）的字符预算与截断：名单仍无上限，留在
  [TODO.md](../../TODO.md) 的「技能名单的上下文经济」。
- 同一技能重复调用时省掉第二份正文、只加一句「已加载」：留在同一 TODO 条目。
- 让重挂正文跟着磁盘后续修改实时更新：重挂只保证「压缩那一刻读到的内容」，压缩之后文件再改
  不回溯。
- 技能管理面板、启用 / 停用开关、`/skills` 列表。
- 摘要卡片与 TUI 的展示形态（折叠、高亮、语法着色）。
- 归档展开（`compactArchiveRequested`）的语义与内容：展开仍只读重放各代归档 + 保留区，
  重挂章节随摘要一并出现，不额外构造。
- 新增总线事件、`UiEvent` / `UiRequest` 契约成员：本改动只多一个落盘字段与摘要正文的一段。

## 对需求基线的影响

修改 [US-27 斜杠命令与技能触发](../../docs/features/user-stories/tools.md#us-27-斜杠命令与技能触发)：
验收标准新增第 5 条「会话压缩后，本会话调用过的技能仍按当前文件内容对模型可见；技能文件已
删除时压缩照常完成并在摘要里点名」。不新增 US，因此 e2e 映射表与豁免段不动（US-27 既有的
`e2e/electron/desktopShell.spec.ts` 行不变）。

压缩侧落在 US-9（上下文用量与手动压缩）的既有验收表述内：压缩仍由用户点击或自动触发，
产物形态与刷新路径不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/compact.rs`（调用记录收集与 `compactLoadedSkills` 字段）、`core-rs/src/engine.rs`（`Skill` 工具调用与 `/name` 注入的既有路径） | `core-rs/src/compact_tests.rs`、`core-rs/src/compact_engine_tests.rs`、`core-rs/fixtures/compact.json` | 自动 |
| FR-002 | `core-rs/src/compact.rs` 的重挂章节组装与预算常量、`generate_compact_user_message` | `core-rs/src/compact_tests.rs`（章节形态 / 截断 / 溢出点名）、`core-rs/fixtures/compact.json` 的 `compactUserMessages` | 自动 |
| FR-003 | `core-rs/src/compact.rs` 的重渲染入口、`core-rs/src/skills.rs` 的 `find_skill` / `prompt_for_command` / `substitute_builtin_variables` | `core-rs/src/compact_tests.rs`（磁盘改动后取新版 / 删除后缺席 / 读失败）、`core-rs/src/compact_engine_tests.rs` | 自动 |
| FR-004 | `core-rs/src/compact.rs` 的跨代合并与去重 | `core-rs/src/compact_engine_tests.rs`（二次压缩仍重挂 / 同名取最近 / 保留区已含不重挂）、`core-rs/src/compact_tests.rs`（字段损坏） | 自动 |
| FR-005 | `core-rs/src/compact.rs` 的 `format_messages_for_compact` 与章节剥离 | `core-rs/src/compact_tests.rs`（剥离区段 / 尾注保留 / 缺章节原样返回） | 自动 |
| FR-006 | `core-rs/src/skills.rs`（两个开关不参与重挂）、`core-rs/src/replay.rs`（不进 UI 消息区的既有口径） | `core-rs/src/skills_tests.rs`、`core-rs/src/compact_tests.rs`（重挂不产生消息） | 自动 |

## 待澄清

无未决问题。

## 收敛记录

收敛时由 /implement 填写，结论只分三类。

- 已满足：
  - AC-1 / AC-3 / AC-4 → `compact_reloads_an_invoked_skill_from_disk`（引擎级：归档区里的
    `Skill` 调用在压缩后进摘要正文与 `compactLoadedSkills`）；用户 `/name` 与模型调用共用
    同一次 `tools::run_skill`，参数替换走同一份 `render_skill_body`。
  - AC-2 → `section_is_absent_without_reloadable_records`、`absent_field_reads_as_empty_history`、
    e2e「没有调用过技能时，压缩产物不带重挂章节」（摘要无章节、无字段）。
  - AC-5 → `section_renders_the_current_file_content`（改写后取新版）、e2e 重复压缩用例
    （第二代取 V2、请求体里没有 V1）。
  - AC-6 / AC-14 → `missing_skill_is_named_instead_of_silently_dropped`（解析不到点名）、
    `deleted_skill_is_named_and_compaction_still_completes`（引擎级：压缩仍 complete、点名、
    记录保留）、e2e「技能在压缩前被删除」。
  - AC-7 → `oversized_skill_is_truncated_with_a_note`（截断说明行 + 单项正文落在上限内）。
  - AC-8 → `budget_overflow_drops_the_oldest_and_names_them`（最近优先、最旧被点名）。
  - AC-9 → 两个预算常量各一处定义；`build_loaded_skills_section` 整章按
    `util::estimate_text_tokens` 累加，正文截断用同一系数口径的
    `util::take_prefix_within_tokens`。
  - AC-10 / AC-11 → `repeated_compact_keeps_reloading_the_skill`（第二代仍重挂、记录跨代）、
    `records_dedupe_by_name_keeping_the_latest`（同名取最近一次及其参数）、e2e 重复压缩用例。
  - AC-12 → `skill_still_in_the_keep_region_is_not_reloaded`（不重复重挂、记录照常写入）、
    `keep_region_names_come_from_the_injection_marker`。
  - AC-13 → `strips_the_whole_section_keeping_the_footer`（章节整段剥掉、尾注保留）、
    e2e 重复压缩用例断言第二次压缩的摘要请求体既无 `### 已加载技能` 也无 V1 正文。
  - AC-15 → `malformed_persisted_entries_are_ignored`（缺 name / 非字符串 / 空串 / 非对象
    逐条忽略）。
  - 其他：`records_are_collected_from_skill_tool_uses_in_order`、
    `section_lists_recent_skills_first_with_body_from_disk`（最近优先排序）、
    `inline_mention_is_not_treated_as_the_section`（正文里提到标题不算章节）、
    `absent_section_leaves_text_unchanged`、`tools_tests` 的 `skillName` 标记断言、
    对照表 `core-rs/fixtures/compact.json` 的「带已加载技能」用例。
- 偏差：
  - 影响基线里写的「新增 `FR-007：已加载技能随压缩携带`」是 as-built 侧的编号（压缩规格的
    需求条目），与 spec 自己的 FR-001～FR-006 是两套编号：spec 的 FR 描述本次改动的分解，
    as-built 的 FR-007 是落地后进入 docs 的需求条目。实现与测试注释按 as-built 的 FR-007 写，
    spec 侧编号保持不变，追溯矩阵两侧各自对齐。
  - `strip_loaded_skills_section` 初版只按标题定位，技能正文自带同名标题时会从章节内部开刀。
    收敛核对（反向枚举实现分支）时发现，改为「标题 + 前言整段定位，前言被预算挤掉才退回
    只认标题」，并补 `inline_mention_is_not_treated_as_the_section`。
  - 预算口径一处实现偏差：初版只把正文计入单项上限、截断说明行不计，加了说明行的条目会
    顶穿 5,000。改为「说明行先扣额度」；`oversized_skill_is_truncated_with_a_note` 的断言
    随之变严（断言整项 token）。
  - 「所有技能都因预算被放弃」原本返回 `None`（不出章节），与 AC-8 的「不静默丢弃」冲突；
    改为 `dropped` 非空也出章节。
- 未做：无。
