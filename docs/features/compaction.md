---
owner: pzlvv
last_reviewed: 2026-11-10
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
  - **AC-3**（FR-002）：GIVEN 会话空闲 WHEN UI 发 `compactRequested` THEN 立即执行压缩
  - **AC-4**（FR-002）：GIVEN 会话非空闲 WHEN 手动请求压缩 THEN 登记「待压缩」，当前轮次结束、队列排空时执行
- 场景 3：压缩结果
  - **AC-5**（FR-003）：GIVEN 可压缩消息 WHEN 压缩完成 THEN 消息数组整体替换为 `[边界标记, 摘要, ...保留区]`，meta 标记 `isCompacted`，UI 收到 `messagesReplaced`
  - **AC-6**（FR-003）：GIVEN `tool_use` 被留在归档区而其 `tool_result` 落在保留区（或相反） WHEN 按条数截断保留区 THEN 向保留区补一条 `is_canceled` 的合成 `tool_result`
- 场景 4：跨压缩历史
  - **AC-7**（FR-004）：GIVEN 会话已经历多次压缩 WHEN 再次压缩 THEN 会话**最初**的 4 条真实用户输入仍出现在摘要的用户输入历史中
  - **AC-8**（FR-004）：GIVEN 保留区里的用户输入 WHEN 生成历史章节 THEN 不列入（避免与上下文重复）
- 场景 5：归档展开
  - **AC-9**（FR-005）：GIVEN 已压缩会话 WHEN 用户展开 THEN 只读重放「归档 + 保留区」给 webview，不改任何 core 状态，LLM 上下文不变
- 场景 6：运行中后台任务
  - **AC-10**（FR-006）：GIVEN 压缩开始时本会话有运行中的后台 Bash 任务 WHEN 生成摘要消息 THEN 正文含这些任务的 `taskId` 与描述，按注册序列出
  - **AC-11**（FR-006）：GIVEN 运行中任务数超过上限 WHEN 生成章节 THEN 只列出上限内的任务并报出剩余条数
  - **AC-12**（FR-006）：GIVEN 压缩开始时没有运行中的后台任务 WHEN 生成摘要消息 THEN 正文不含该章节
  - **AC-13**（FR-006）：GIVEN 章节已写入压缩产物 WHEN 其中某个任务随后完成或被杀 THEN 压缩产物不回写（章节是压缩那一刻的时点事实，后续由完成通知接续）

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

UI 发 `UiEvent.compactRequested` → Core 的手动压缩入口；
会话非空闲（`idle === false`）时登记「待压缩」，在当前轮次结束、消费队列排空时执行
（轮次末尾到压缩开始之间 `running` 保持为真，压缩完成后才进入 idle）。
排队事实经运行时快照的 `pendingCompact` 根事实推给 UI（见
[docs/core/session-runtime.md 第 2 节](../core/session-runtime.md#2-对外快照)）：
webview 与 TUI 在「`pendingCompact === true` 且 `compacting === false`」期间把上下文用量
文本显示为「准备压缩」（英文 `Preparing`），webview 同时取消该文本的点击入口；实际开始
压缩或标记清除后还原。不再发 `message`（`once: true`）通知，也不写 `meta.json` 的
`onceMessage`。

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
   `save_compact_archive`：归档区 + 摘要）在 `compact_conversation` 内完成；返回后整文件
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

- 展开（`expandCompact`）是**只读**操作：宿主读归档文件并把「归档 + 保留区」重放给
  webview，不改任何 core 状态；LLM 仍只看压缩后的消息（[principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)）。
- 归档读取经 `UiRequest.compactArchiveRequested`（[docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。

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

## 3. 行为规格

### 3.1 数据流

```
阈值判定 ──▶ compact_conversation ──compactBegin──▶ UI（压缩进度提示）
                    │
                    ├─ LLM 生成摘要
                    ├─ 组装 [边界, 摘要, ...保留区]
                    ├─ 重算压缩后占用（估算）
                    ├─ compactEnd ──▶ UI（进度提示 complete / error + 用量按新值刷新）
                    ├─ save_compact_archive（归档区 + 摘要）
                    ├─ 整文件重写 jsonl + meta 标记 + totalContextTokens 写回
                    └─ replay_messages_to_ui ──messagesReplaced──▶ UI（整批替换消息区）
```

## 4. 边界与错误路径

- **无可摘要内容**：边界之后消息数不严格大于 30 → 直接返回（AC-2）。
- **压缩失败**：`compactEnd` 以 `error` 收尾（压缩流程上报），
  进度提示转错误态；消息数组不被替换。
- **并发保护**：压缩进行中标记 `compacting`，新到用户消息只入队（压缩结束后排空）；
  周期性后台提醒压缩中不投递。
- **孤立工具调用**：截断导致的配对断裂由 `sanitize_tool_pairing` 修复（AC-6）。
- **运行中后台任务**：压缩开始时按任务登记表现算一次并进摘要消息（FR-006）；
  登记表为空时不出章节。章节不随后续完成 / 中止回写（AC-13）。

## 5. 非目标

- 进度条 / 按钮等 UI 表现不在本规格内（core 只发事实事件）。
- 归档文件的 UI 呈现样式不在本规格内（展开的只读语义见 FR-005）。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-9（上下文用量与手动压缩）/
US-17（压缩历史展开）；无新增 US。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/compact.rs` 的 `get_auto_compact_threshold` | `core-rs/src/compact_tests.rs`（阈值与触发判定） | 自动 |
| FR-002 | `core-rs/src/main.rs` 的 `compactRequested` 分发（空闲立即 / 非空闲延后） | `core-rs/src/compact_engine_tests.rs`（手动 / 自动触发、延后执行） | 自动 |
| FR-003 | `core-rs/src/compact.rs` 的 `compact_conversation` / `sanitize_tool_pairing` | `core-rs/src/compact_engine_tests.rs`；`core-rs/src/compact_tests.rs` | 自动 |
| FR-004 | `core-rs/src/compact.rs` 的 `select_user_input_history` | `core-rs/src/compact_engine_tests.rs` 的 `repeated_compact_keeps_the_global_user_input_head` | 自动 |
| FR-005 | 宿主 `expandCompact`（`src/host/ui/webviewMessageHandler.ts`）+ `UiRequest.compactArchiveRequested` 应答 | e2e `e2e/webview/messagePresentation.spec.ts`（展开） | 自动 |
| FR-006 | `core-rs/src/compact.rs` 的 `compact_conversation_inner` / `generate_compact_user_message` / `strip_running_tasks_section`；`core-rs/src/bash_task.rs` 的 `build_running_tasks_section` / `RUNNING_TASKS_HEADING`；`core-rs/src/engine.rs` 的 `enqueue_agent_message` 的 `compacting` 守卫 | `core-rs/src/bash_task_tests.rs` 的 `running_tasks_section_*` 五条；`core-rs/src/compact_tests.rs` 的 `strip_running_tasks_tests` 三条；`core-rs/src/compact_engine_tests.rs` 的 `compact_carries_the_running_background_tasks_into_the_summary_message` / `compact_without_running_tasks_adds_no_section`；`core-rs/src/engine_tests.rs` 的 `agent_message_during_compaction_is_queued_without_starting_the_consumer`；对照表 `core-rs/fixtures/compact.json` 的 `compactUserMessages` | 自动 |
