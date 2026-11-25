---
owner: pzlvv
last_reviewed: 2026-11-21
---

# 规格：对话压缩

本规格界定对话压缩（compact）的行为：触发条件、摘要生成、跨多次压缩保留的用户输入历史、
归档与展开。范围只覆盖 core 侧的压缩事实与落盘格式；进度条 / 按钮等表现由 UI 自行决定，
不在本规格内。

交叉引用：事件词汇表见 [events.md](../architecture/events.md)（`compactBegin` /
`compactEnd` / `messagesReplaced` / `compactRequested`）；`compacting` 来源见
[docs/core/session-runtime.md](../core/session-runtime.md)；「core 描述事实，UI 决定表现」见
[principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)；Core 的落盘格式与
行为对照见 [docs/core/standalone-core-boundaries.md 第 3 节](../core/standalone-core-boundaries.md#3-测试与覆盖率)。

## 1. 用户场景与验收标准

- 场景 1：自动压缩
  - **AC-1**（FR-001）：GIVEN 会话上下文超过自动压缩阈值 WHEN 下一轮 `aiBegin` 之前 THEN 自动触发压缩
  - **AC-2**（FR-001）：GIVEN 压缩边界之后的消息数不大于 `maxMessagesToKeep` WHEN 触发压缩 THEN 不做任何处理直接返回
- 场景 2：手动压缩
  - **AC-3**（FR-002）：GIVEN 会话前台空闲 WHEN UI 发 `compactRequested` THEN 立即执行压缩
  - **AC-4**（FR-002）：GIVEN 会话前台仍有工作 WHEN 手动请求压缩 THEN 登记「待压缩」，当前轮次结束、队列排空时执行
  - **AC-15**（FR-002）：GIVEN 前台已停下、只剩后台 Bash 任务或非 idle 子代理（abort 按钮为黄） WHEN UI 发 `compactRequested` THEN 立即执行压缩，不等这些后台工作结束
- 场景 3：压缩结果
  - **AC-5**（FR-003）：GIVEN 可压缩消息 WHEN 压缩完成 THEN 消息数组整体替换为 `[边界标记, 摘要, ...保留区]`，meta 标记 `isCompacted`，UI 收到 `messagesReplaced`
  - **AC-6**（FR-003）：GIVEN `tool_use` 被留在归档区而其 `tool_result` 落在保留区（或相反） WHEN 按条数截断保留区 THEN 向保留区补一条 `is_canceled` 的合成 `tool_result`
- 场景 4：跨压缩历史
  - **AC-7**（FR-004）：GIVEN 会话已经历多次压缩 WHEN 再次压缩 THEN 会话**最初**的 4 条真实用户输入仍出现在摘要的用户输入历史中
  - **AC-8**（FR-004）：GIVEN 保留区里的用户输入 WHEN 生成历史章节 THEN 不列入（避免与上下文重复）
- 场景 5：归档展开
  - **AC-9**（FR-005）：GIVEN 已压缩会话 WHEN 用户展开 THEN 只读重放「各代归档 + 保留区」给 webview，不改任何 core 状态，LLM 上下文不变
  - **AC-14**（FR-005）：GIVEN 会话已压缩 N 次 WHEN 用户第 k 次点击「展开压缩的对话历史」THEN 消息区显示第 N-k+1 到第 N 代 + 保留区，第 N 次点击后按钮消失
- 场景 6：运行中后台任务
  - **AC-10**（FR-006）：GIVEN 压缩开始时本会话有运行中的后台 Bash 任务 WHEN 生成摘要消息 THEN 正文含这些任务的 `taskId` 与描述，按注册序列出
  - **AC-11**（FR-006）：GIVEN 运行中任务数超过上限 WHEN 生成章节 THEN 只列出上限内的任务并报出剩余条数
  - **AC-12**（FR-006）：GIVEN 压缩开始时没有运行中的后台任务 WHEN 生成摘要消息 THEN 正文不含该章节
  - **AC-13**（FR-006）：GIVEN 章节已写入压缩产物 WHEN 其中某个任务随后完成或被杀 THEN 压缩产物不回写（章节是压缩那一刻的时点事实，后续由完成通知接续）
- 场景 7：已调用技能跨压缩携带
  - **AC-16**（FR-007）：GIVEN 本会话调用过技能 `a` WHEN 压缩完成 THEN 摘要正文含 `### 已加载技能` 章节与 `a` 的磁盘当前正文，摘要消息带 `compactLoadedSkills` 记录
  - **AC-17**（FR-007）：GIVEN 本会话从未调用任何技能 WHEN 压缩完成 THEN 摘要正文不含该章节，摘要消息不出现 `compactLoadedSkills` 字段
  - **AC-18**（FR-007）：GIVEN 技能文件在首次调用后被改写 WHEN 压缩完成 THEN 重挂正文是改写后的内容（不是调用时的副本）与当前技能目录
  - **AC-19**（FR-007）：GIVEN 技能文件在压缩前被删除或读不出 WHEN 压缩完成 THEN 压缩仍以 `complete` 收尾，该技能不进正文、在章节说明行里被点名，记录仍随摘要保留
  - **AC-20**（FR-007）：GIVEN 单个技能正文超过单项上限 WHEN 重挂 THEN 只保留开头并追加一行截断说明（点名技能与「可重新调用取全文」）
  - **AC-21**（FR-007）：GIVEN 已调用技能总量超过总预算 WHEN 重挂 THEN 按最近调用优先填充，被整项挤出的技能名逐个写进章节说明行
  - **AC-22**（FR-007）：GIVEN 会话已压缩一次、其中重挂的技能早已不在保留区 WHEN 再次压缩 THEN 该技能仍出现在新的重挂章节里（记录跨代继承）
  - **AC-23**（FR-007）：GIVEN 同一技能被调用两次且参数不同 WHEN 压缩完成 THEN 章节里该技能只出现一次且参数取最近一次
  - **AC-24**（FR-007）：GIVEN 某技能最近一次注入正文仍完整落在保留区 WHEN 压缩完成 THEN 该技能不进重挂正文，记录照常写入
  - **AC-25**（FR-007）：GIVEN 上一次压缩的重挂章节落在本次归档区 WHEN 生成本次摘要 THEN 该章节不进摘要输入（正文其余部分照常进）
  - **AC-26**（FR-007）：GIVEN 摘要消息上的 `compactLoadedSkills` 缺失或条目形态非法 WHEN 再次压缩 THEN 按「无历史记录」处理并从本次归档区重新收集，不中断压缩

## 2. 功能需求

### FR-001：触发与阈值

自动压缩阈值按 `contextWindow - min(50K, 0.3 * maxOutputTokens)` 计算
（`core-rs/src/compact.rs` 的 `get_auto_compact_threshold`），
为输出预留缓冲。前端进度条与本函数共用同一套规则，保证 UI 与触发条件一致。

触发判定的上下文占用按「存量 + 增量」计（`core-rs/src/engine.rs` 的
`estimate_next_context_tokens`，同一估算也用于本轮输出预留）：存量取最近一条带
`usage` 的 assistant 消息返回的真实用量（`input + output`，已含当轮 system prompt
与 tools），只对其后新增的消息做文本估算；没有 usage 锚点时（首轮、压缩后 usage
被清空）退回整体估算，并与 `meta.json` 的 `context.totalContextTokens` 取 max。

- **自动压缩**：在 `aiBegin` 之前判断，超过阈值即触发（`engine.rs` 的消费循环）。
- 压缩是否可行由 `has_compactable_messages` 判定：压缩边界之后的消息数必须**严格大于**
  `maxMessagesToKeep`（30），否则没有可摘要的内容，调用方直接返回、不做任何处理。

### FR-002：手动压缩与延后执行

UI 发 `UiEvent.compactRequested` → Core 的手动压缩入口（`Core::request_compact`），
受理判据是**前台是否仍在工作**（`Core::foreground_busy`：`running` / `compacting` /
排队待消费的用户消息，即 abort 按钮的红色档，见
[docs/features/abort-button.md](abort-button.md#fr-001三态判定)）：

- 前台仍有工作：登记「待压缩」，在当前轮次结束、消费队列排空时执行
  （轮次末尾到压缩开始之间 `running` 保持为真，压缩完成后才进入 idle）。
- 前台已停下（abort 按钮为黄或灰）：立即执行，**不等待**仍在运行的后台 Bash 任务与
  非 idle 子代理。后台工作不阻塞压缩——压缩期间它们的通知只入队（FR-003 的并发保护），
  收尾时再排空。

登记先写、前台判据后读，登记标记由 `compact::take_pending_compact` 原子取走：
`run_query_loop` 每轮 `aiBegin` 前、`run_consumer` 的队列排空分支、`Core::request_compact`
自己都会消费同一条登记，一步取走保证只压一次；反过来（先判前台再登记）会让登记与
循环收尾交错、挂到下一条用户消息。循环在排空分支看到这条登记时把 `running` 标回真并
回到顶部，由常规出队分支取走（同样一步原子取走）——轮次末尾到压缩开始之间仍属同一段
连续任务，不出现 `idle` 快照。
排队事实经运行时快照的 `pendingCompact` 根事实推给 UI（见
[docs/core/session-runtime.md 第 2 节](../core/session-runtime.md#2-对外快照)）：
webview 与 TUI 在「`pendingCompact === true` 且 `compacting === false`」期间把上下文用量
文本显示为「准备压缩」（英文 `Preparing`），webview 同时取消该文本的点击入口；实际开始
压缩或标记清除后还原。不再发 `message`（`once: true`）通知，也不写 `meta.json` 的
`onceMessage`。

中止（`abortRequested`）时清除待压缩：中止后不补跑压缩，用户需重新点用量条
（此时前台已停下，按上面的判据立即执行）。

### FR-003：压缩流程与落盘

压缩会**整体替换**会话消息数组，期间把会话标记为「正在压缩」
（`compact.rs` 的 `mark_compacting` + 运行时状态的 `compacting` 来源，
见 [docs/core/session-runtime.md](../core/session-runtime.md)），新到的用户消息只入队、压缩结束后排空。

1. 取最后一次压缩边界之后的消息（`messages_after_compact_boundary`）。
2. 保留最近 `maxMessagesToKeep`（30）条消息作为**保留区**，原样留在上下文里；
   其余为**归档区**，会被摘要掉。
3. 用归档区调 LLM 生成摘要（`COMPACT_SYSTEM_PROMPT` + `generate_compact_summary_prompt`）。
4. 新建边界标记（`system` / `compact_boundary`）与摘要消息（`user` / `isCompactSummary`）；
   摘要正文带用户输入历史章节（FR-004）与运行中后台任务章节（FR-006）。
5. 组装压缩后的消息：`[边界标记, 摘要消息, ...保留区]`（`build_post_compact_messages`）。
6. `compactEnd`（`complete`，带压缩后上下文占用的重算值）与归档写盘（`history.rs` 的
   `append_compact_archive`：本代归档区 + 摘要，追加在第 N 代之后）在 `compact_conversation`
   内完成；返回后整文件
   重写 jsonl、标记 `meta.json` 的 `context.isCompacted = true` / `isExpanded = false`，
   最后 `replay.rs` 的 `replay_messages_to_ui` 投递 `messagesReplaced` 整批替换 UI 消息区。

保留区按条数截断后必须修复 `tool_use` / `tool_result` 配对（`sanitize_tool_pairing`）：
某条 `tool_use` 被留在归档区、其 `tool_result` 落在保留区（或相反）时，会向保留区
补一条 `is_canceled` 的合成 `tool_result`，避免下一轮请求出现孤立工具调用。

`is_canceled` 的结果在重放里落成**失败态**：`build_replay_message_data` 把取消说明
作为卡片内容、`status` 取 `fail`，与 `conversationLoaded` 那条恢复路径
（webview 的 `restoreMessagesFromConversation`）同口径。落成 `running` 会让卡片时间线
画旋转风扇、自动滚动轮询按 `hasRunningTools` 一直空转——被中止的工具明明是过去时。

**压缩后上下文占用的重算与写回**：压缩清空了保留区消息的 `usage`
（`clear_message_usage`），真实锚点不复存在。压缩完成时 core 把压缩产物按运行时同款
口径（`util::estimate_request_tokens` 作用在压缩后消息上）重算占用，随
`compactEnd.postCompactTokenCount` 带给 UI、写回 `meta.json` 的
`context.totalContextTokens`——不写回的话，从 meta 恢复用量条的视图（webview / TUI
的 `conversationLoaded` 恢复路径）与 core 自己的估算兜底（第 1 节 FR-001 的 max 口径）
都会拿压缩前的旧值。下一轮真实 usage 落盘后照常覆盖该估算值。

### FR-004：用户输入历史（跨多次压缩）

摘要消息正文里带一个「用户输入历史」章节，保存用户真实输入（过滤掉系统自动产生的
`silent` / `origin` 为 `agent` / `bash` / `isMeta` / `isCompactSummary` / 带 `reminder`
字段 / 内容形如 `<reminder>` 的消息，见 `get_user_input_history`），避免压缩后丢失用户的
原始意图。

**全局口径**：历史不是只看本次归档区，而是把「上次摘要持久化的历史」与「本次归档区里的
真实用户输入」按时间顺序合并去重，再取**最早 4 条 + 最后 8 条**（不超过 12 条时全留）：

- 摘要消息上的 `compactUserInputHistory` 字段（`{ uuid, content }[]`）是跨多次压缩的
  持久化载体：`uuid` 用于合并去重，`content` 用于拼章节正文。
- 头部固定为会话**最初**的 4 条真实用户输入：即使它们在第一次压缩时已被摘要掉、
  不再作为消息存在，也能从 `compactUserInputHistory` 恢复，不会因为再次压缩而丢失。
- 尾部取本次归档区最近 8 条（不足则取全部）。**保留区里的用户输入不进这里**——
  它们仍原样留在上下文里，列进摘要就是重复。
- 两次压缩之间没有重叠：上次持久化的条目在上次压缩时已从消息里移除，不会出现在本次
  归档区；去重只是防御性兜底。

纯函数与落盘字段（`core-rs/src/compact.rs`）：

| 环节 | 函数 / 字段 |
| --- | --- |
| 提取条目 | `to_user_input_entries` |
| 跨压缩选择 | `select_user_input_history` |
| 读取持久化历史 | `read_compact_user_input_history` |
| 格式化章节 | `format_user_input_entries` |
| 字段名 | `compactUserInputHistory` |

### FR-005：归档与展开

归档文件（`compact archive`）只保存被摘要掉的归档区消息 + 本次摘要消息，**不含保留区**
（保留区仍可见，展开时与归档一起重放）。

**归档按代次累积、只增不改**：一次压缩对应一代，记录带 `compactGeneration`（1 起），
新的一代追加在文件末尾，既有代次的记录逐字节保留（`history.rs` 的
`append_compact_archive`）。代次序号 = 既有最大代次 + 1；读不到代次标识的记录属于
「按代次累积」之前的旧格式，按第 1 代处理，因此旧会话升级后第一次压缩就是第 2 代，
不需要迁移。

**展开是逐层的**：`UiRequest.compactArchiveRequested` 应答
`{ messages, generationStarts } | null`——`messages` 是「各代按代次升序拼接 + 当前保留区」
的完整序列（按 `uuid` 去重，上一代末尾的摘要同时是下一代归档区的第一条，只出现一次），
`generationStarts[i]` 是第 `i+1` 代第一条在该序列里的下标（升序、单调不减，重合表示该代
归档区只含已被去重的上代摘要）。webview 按展开层级 `depth`（已展开几代，0 = 压缩后形态）
取 `generationStarts[代次数 - depth]` 起的尾部：每点一次「展开压缩的对话历史」加深一层，
在已显示内容**之前**补入一代更早的内容，`depth === 代次数` 后按钮消失。
层级只存在 webview 内存，换会话 / 新建对话 / 又完成一次压缩都归零。

- 展开（`expandCompact`）是**只读**操作：宿主读归档文件并把合并后的完整序列交给
  webview，不改任何 core 状态；LLM 仍只看压缩后的消息（[principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)）。
- 宿主按 `generationStarts` **分段**调用 `buildReplayMessageData` 再累加下标：该转换会丢掉
  压缩边界、空消息与纯 `tool_result` 的 user 消息，整体转换后 Core 给的下标会错位。
- 归档读取经 `UiRequest.compactArchiveRequested`（[docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。
- 取不到归档（无文件 / 读失败 / 空结果）时 `expandCompactDone` 回空载荷：可见集合与展开
  层级都不动，按钮保留。

### FR-006：运行中后台任务随压缩携带

后台任务的工具结果里带有「完成会通知、不要轮询」的提示，这段提示寄生在 `tool_result`
正文中。压缩会销毁那处载体：归档区的 `tool_result` 被摊平成摘要输入
（`format_messages_for_compact` → `format_content_blocks` 的 `[Tool Result]: …` 转换），
保留区的可能因配对修复被换成合成的
`is_canceled` 结果（[第 1 节 AC-6](#1-用户场景与验收标准)），大输出还可能被裁剪。
任务仍在运行、任务表仍在册，而模型那一侧的事实已经消失。

压缩因此额外产出一段「运行中后台任务」章节，并进摘要消息正文：

- **来源**：压缩开始时按 `bash_task::running_tasks_for_session` 现算，不经由任何一条
  `tool_result`；注册表是唯一事实来源（[background-bash.md](background-bash.md)）。
  不进注册表的进程（`detach: true` 放行的自我脱离进程，见
  [bash-detach.md FR-002](bash-detach.md#fr-002detachtrue-的豁免语义)）不在清单内。
- **落点**：摘要消息 `content` 的正文段，位于「用户输入历史」之后、固定尾注
  （`---` + 「请基于以上摘要继续工作」）之前（`generate_compact_user_message` 的
  `running_tasks` 入参，纯函数 `bash_task::build_running_tasks_section` 生成），
  标题为 `### 后台任务`（与用户输入历史章节同级）。
  压缩产物仍是 `[边界标记, 摘要, ...保留区]` 三段形态，不新增消息。
- **内容**：每任务一行 `taskId` + 描述；`command` 与描述不同时补命令（与后台提醒文案
  同一口径）。超过上限（`COMPACT_TASKS_MAX`）只列前若干个并报剩余条数。
- **不含易变字段**：不写已运行时长、pid、输出尾部——这些每秒都变，会让摘要消息在
  归档重放与上下文估算里反复抖动，且对决策没有增量信息。
- **时点语义**：章节陈述「压缩开始时」的事实，不回写。之后完成的任务由完成通知
  按既有通道接续（[background-bash.md FR-003](background-bash.md#fr-003查询结束兜底提醒)）。
  压缩进行中到达的自动消息只入队、不另起消费循环（`enqueue_agent_message` 的
  `compacting` 守卫），因此通知不会被随后的整文件重写丢掉，压缩收尾时与摘要一并消费。
- **二次压缩**：上一次的摘要消息落在本次归档区，其中带的章节是**当时**的快照。
  它在进摘要输入前被剥掉（`format_messages_for_compact` 对 `isCompactSummary` 消息调
  `strip_running_tasks_section`），否则摘要模型会把陈旧 `taskId` 抄进「未完成事项」，
  与新算的章节自相矛盾。正文其余部分照常进摘要。

章节随摘要消息一并**展示给用户**（webview 的压缩摘要卡片原样渲染正文，与
「用户输入历史」同等处理）。这是有意的：压缩摘要对用户是可见的历史记录，清单属于
其中一段，不单独隐藏。

空集不产出章节，正文与不含该章节的形态逐字节相同。

**清单为空不等于没有任务**：`detach: true` 的进程不进注册表，Core 重启后进程内的
任务表也会清空——两种情况下清单为空但命令可能仍在跑。章节只陈述「本进程当前登记在册的
运行中任务」，不是全局事实。

### FR-007：已加载技能随压缩携带

技能正文是一次性进上下文的：`Skill` 工具把 `SKILL.md` 渲染成一条 `isMeta` 的 user 消息
落盘，之后就是普通历史（[skills.md 3.4](skills.md#34-注入路径)）。压缩把较早的历史折进摘要，
摘要里通常只剩「加载过某技能」这类痕迹，红线规则与检查清单从模型可见层消失——而模型不知道
自己已经忘了，不会自觉重调 `/name`。

压缩因此在摘要正文里额外产出一个「已加载技能」章节，并在摘要消息上留一份不含正文的调用记录。

**事实与投影**：

| 东西 | 来源 | 是否落盘 |
| --- | --- | --- |
| 调用记录 `{ name, args }` | 消息里 `assistant` 的 `tool_use`（`name == "Skill"`） | 是：摘要消息的 `compactLoadedSkills` |
| 记录先后序 | 记录数组顺序（末尾最近） | 同上 |
| 正文 | 压缩时 `skills::find_skill(cwd)` 解析 + `skills::render_skill_body` 重渲染 | 否（磁盘投影） |
| 「正文仍在上下文」 | 保留区里带同名 `skillName` 的 `isMeta` 消息 | 否 |

- **收集范围**：本会话的 `Skill` 工具调用，模型主动调用与用户 `/name` 派发都算（两条路径
  共用同一次工具执行）。子代理在自己会话里的调用不进本会话记录。调用时被记下就行——
  两个调用开关（`user-invocable` / `disable-model-invocation`）不参与记录判定。
- **跨代合并**：按「上一代摘要字段 → 本次归档区 → 本次保留区」顺序合并，同名先删旧再追加，
  因此同一技能只留**最近一次**的调用（参数取最近那次的），数组里每个名字一条。三段顺序就是
  时间顺序，`compactLoadedSkills` 是跨多次压缩与 `--resume` 的唯一载体。
- **正文来源是压缩那一刻的磁盘**：每条记录在压缩时重新解析并渲染（参数替换 → 内置变量替换
  与首次注入走同一份 `render_skill_body`），因此文件改了就重挂新版、路径变了就写新路径。
  这与「重放调用时的旧副本」是有意区别：旧副本会让过期规则继续按现行规则生效。
- **章节形态**：摘要正文的**最后一个**章节（位于「用户输入历史」「后台任务」之后、固定尾注
  之前），标题 `### 已加载技能`，前言点明「这些技能是本会话较早时候加载的，不是当前轮次的
  要求」。每个技能一段：`#### <name>` + 来源行（技能目录，`skill_root` 存在时）+ 正文。
- **预算**：单项 `COMPACT_SKILL_MAX_TOKENS`（5,000 token，含该技能的标题行 / 来源行 /
  截断说明行），整体 `COMPACT_SKILL_TOTAL_TOKENS`（25,000 token，含章节标题与说明行），
  都按 `util::estimate_text_tokens` 计算。填充顺序是**最近调用优先**。
- **截断与溢出都不静默**：单项超限时保留开头（`util::take_prefix_within_tokens`）并追加
  一行截断说明，点名技能与「需要全文请重新调用」；总量不足时**整项**放弃最旧的，被放弃的
  技能名逐个写进章节末尾的说明行。说明行本身顶穿预算时才省略它，被省略名单改记 core 日志。
- **读不出 / 解析不到**：该技能不进正文，在说明行里被点名（`无法重新读取`），core 日志打一条
  点名技能名与原因的 WARNING；压缩照常以 `complete` 收尾——重挂不依赖摘要模型的输出。
- **保留区已含正文**：保留区里仍有该技能的 `skillName` 注入消息时，不重复重挂（它还在上下文
  里，再挂一份只白花预算），但记录照常写入。判据只看标记、**不比对内容**：内容随文件改动
  立刻失效，拿它判断会得出「还在」的错误结论。
- **二次压缩的摘要输入卫生**：上一代的重挂章节落在本次归档区，它在进摘要输入前被剥掉
  （`format_messages_for_compact` 对 `isCompactSummary` 消息先剥「后台任务」再剥「已加载
  技能」）。剥离范围是「标题行首 → 固定尾注起点」，不走「遇到下一个 Markdown 标题即止」的
  通用逻辑——技能正文自带标题与 `---`，通用逻辑会在章节内部提前收手，把半段旧正文喂给摘要
  模型。`COMPACT_FOOTER` 是生成侧与剥离侧共用的唯一一份尾注常量。
- **不改调用语义**：重挂不过工具执行、不产生用户消息 / `Skill` 卡片、不刷 `meta.json` 的
  `messageCount`，也不受 `disable-model-invocation` 约束（[skills.md FR-001](skills.md#fr-001两个调用开关各管一侧)）。
- **可见性**：章节随摘要正文一并展示给用户（webview 的压缩摘要卡片原样渲染），与「用户输入
  历史」「后台任务」同口径；展示形态由 UI 决定，不在本规格内。
- **空集**：本会话没有调用记录，或所有记录都仍完整落在保留区 → 不产出章节、不写字段，
  摘要正文与不含该章节的形态逐字节相同。
- **字段形态非法**：条目缺 `name`、`name` 非字符串 / 全空白、`compactLoadedSkills` 不是数组
  → 逐条忽略并按「无历史记录」继续，不让整次压缩失败（外部工具可能改坏 JSONL）。

## 3. 行为规格

### 3.1 数据流

```
阈值判定 ──▶ compact_conversation ──compactBegin──▶ UI（压缩进度提示）
                    │
                    ├─ LLM 生成摘要
                    ├─ 组装 [边界, 摘要, ...保留区]
                    │    └─ 摘要正文：摘要 + 用户输入历史 + 后台任务 + 已加载技能（FR-007）
                    ├─ 重算压缩后占用（估算）
                    ├─ compactEnd ──▶ UI（进度提示 complete / error + 用量按新值刷新）
                    ├─ append_compact_archive（本代归档区 + 摘要，追加在第 N 代之后）
                    ├─ 整文件重写 jsonl + meta 标记 + totalContextTokens 写回
                    └─ replay_messages_to_ui ──messagesReplaced──▶ UI（整批替换消息区）
```

## 4. 边界与错误路径

- **无可摘要内容**：边界之后消息数不严格大于 30 → 直接返回（AC-2）。
- **压缩失败**：`compactEnd` 以 `error` 收尾（压缩流程上报），
  进度提示转错误态；消息数组不被替换。
- **并发保护**：压缩进行中标记 `compacting`，新到用户消息只入队（压缩结束后排空）；
  周期性后台提醒压缩中不投递。
- **仅剩后台工作时压缩**：前台已停下（abort 按钮为黄）时手动压缩立即执行，不等后台
  Bash 任务与子代理结束；压缩产物里的「后台任务」章节按压缩开始那一刻的注册表现算。
  子代理不进该章节——它的 `Reply` 压缩后按自动消息接续（同一「时点事实 + 通知接续」
  口径）。中止会清除待压缩，中止后不补跑。
- **孤立工具调用**：截断导致的配对断裂由 `sanitize_tool_pairing` 修复（AC-6）。
- **运行中后台任务**：压缩开始时按任务登记表现算一次并进摘要消息（FR-006）；
  登记表为空时不出章节。章节不随后续完成 / 中止回写（AC-13）。
- **归档写盘失败**：`compactEnd` 仍是 `complete`；展开取不到归档 → 展开回空载荷，
  可见集合与层级不变、按钮保留。
- **归档尾部半行**：进程写一半崩溃留下的坏行跳过，其余记录照常读出，下一次压缩照常追加新代。
- **归档被外部删除**：展开取不到归档 → 同上；`hasCompactArchive` 在下一次会话加载时变假。
- **展开中会话被其他实例持有**：归档读取是纯读，不受会话锁限制（与压缩写入口不同）。
- **代次分界重合**：某代归档区只含已被去重的上代摘要时，两代分界落在同一下标——该层
  可见集合不变，但层级计数照常推进，展开到最后仍会露出全部代次。
- **会话回退（`rewindConversation`）**：不回写也不回收归档，各代仍是压缩那一刻的事实。
- **已加载技能读不出**：`find_skill` 解析不到 / 渲染为空时该技能不进重挂正文，章节说明行点名
  （`无法重新读取`）并打 core WARNING；压缩仍 `complete`，记录留在 `compactLoadedSkills` 里
  等下次再试（AC-19）。
- **单项 / 总量超预算**：单项保留开头 + 截断说明行；总量按最近调用优先填充，被整项挤出的技能
  逐个点名。两者都不静默丢弃（AC-20、AC-21）。
- **保留区已含正文**：不重复重挂，记录照常写入（AC-24）。
- **技能记录字段损坏**：逐条忽略、按无历史记录继续（AC-26）。
- **第一代重挂章节进归档区**：进摘要输入前被剥掉；剥离不影响记录的跨代继承（二者分离）
  （AC-25）。

## 5. 非目标

- 进度条 / 按钮等 UI 表现不在本规格内（core 只发事实事件）。
- 归档文件的 UI 呈现样式不在本规格内（展开的只读语义见 FR-005）。
- 重挂正文不跟随压缩后的磁盘改动：它只保证「压缩那一刻读到的内容」（非目标登记于
  [skills.md 第 5 节](skills.md#5-非目标)）。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-9（上下文用量与手动压缩）/
US-17（压缩历史展开）/ [US-27 斜杠命令与技能触发](user-stories/tools.md#us-27-斜杠命令与技能触发)
（验收标准 5：会话压缩后本会话调用过的技能仍按当前文件内容对模型可见）。无新增 US。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/compact.rs` 的 `get_auto_compact_threshold` | `core-rs/src/compact_tests.rs`（阈值与触发判定） | 自动 |
| FR-002 | `core-rs/src/engine.rs` 的 `Core::request_compact`（判据 `Core::foreground_busy`）+ `compact.rs` 的 `take_pending_compact`；分发在 `core-rs/src/main.rs` 的 `compactRequested` | `core-rs/src/compact_engine_tests.rs`（手动 / 自动触发、延后执行、仅剩后台工作立即执行）、`core-rs/src/compact_tests.rs` 的 `compacting_registry_tracks_sessions`（原子取走） | 自动 |
| FR-003 | `core-rs/src/compact.rs` 的 `compact_conversation` / `sanitize_tool_pairing` | `core-rs/src/compact_engine_tests.rs`；`core-rs/src/compact_tests.rs` | 自动 |
| FR-004 | `core-rs/src/compact.rs` 的 `select_user_input_history` | `core-rs/src/compact_engine_tests.rs` 的 `repeated_compact_keeps_the_global_user_input_head` | 自动 |
| FR-005 | `core-rs/src/history.rs` 的 `append_compact_archive`（按代次追加）+ `core-rs/src/main.rs` 的 `compact_archive_display`（合并与每代起始下标）+ 宿主 `expandCompact`（`src/host/ui/webviewMessageHandler.ts`，分段转换）+ `src/webview/compactExpand.ts`（层级 → 可见集合 / 按钮显隐） | `core-rs/src/history_tests.rs`（追加不覆盖 / 旧格式 / 半行）、`core-rs/src/main_tests.rs` 的 `compact_archive_display_*`、`core-rs/src/compact_engine_tests.rs` 的 `repeated_compact_appends_a_second_archive_generation`、`src/test/compactExpand.test.ts`、e2e `e2e/webview/messagePresentation.spec.ts`（US-17 逐层展开） | 自动 |
| FR-006 | `core-rs/src/compact.rs` 的 `compact_conversation_inner` / `generate_compact_user_message` / `strip_running_tasks_section`；`core-rs/src/bash_task.rs` 的 `build_running_tasks_section` / `RUNNING_TASKS_HEADING`；`core-rs/src/engine.rs` 的 `enqueue_agent_message` 的 `compacting` 守卫 | `core-rs/src/bash_task_tests.rs` 的 `running_tasks_section_*` 五条；`core-rs/src/compact_tests.rs` 的 `strip_running_tasks_tests` 三条；`core-rs/src/compact_engine_tests.rs` 的 `compact_carries_the_running_background_tasks_into_the_summary_message` / `compact_without_running_tasks_adds_no_section`；`core-rs/src/engine_tests.rs` 的 `agent_message_during_compaction_is_queued_without_starting_the_consumer`；对照表 `core-rs/fixtures/compact.json` 的 `compactUserMessages` | 自动 |
| FR-007 | `core-rs/src/compact.rs` 的 `collect_loaded_skill_records` / `read_compact_loaded_skills` / `keep_region_skill_names` / `build_loaded_skills_section` / `strip_loaded_skills_section` / `COMPACT_SKILL_MAX_TOKENS` / `COMPACT_SKILL_TOTAL_TOKENS`；`core-rs/src/skills.rs` 的 `render_skill_body`；`core-rs/src/util.rs` 的 `take_prefix_within_tokens`；`core-rs/src/tools.rs` 的 `skillName` 标记 | `core-rs/src/compact_tests.rs` 的 `loaded_skills_tests` / `strip_loaded_skills_tests`（14 条）、`core-rs/src/compact_engine_tests.rs` 的 `compact_reloads_an_invoked_skill_from_disk` / `repeated_compact_keeps_reloading_the_skill` / `skill_still_in_the_keep_region_is_not_reloaded` / `deleted_skill_is_named_and_compaction_still_completes`、对照表 `core-rs/fixtures/compact.json` 的 `compactUserMessages`、e2e `e2e/electron/skillReloadAfterCompact.spec.ts`（含重复压缩） | 自动 |
