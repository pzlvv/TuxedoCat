---
owner: pzlvv
last_reviewed: 2026-10-26
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
4. 新建边界标记（`system` / `compact_boundary`）与摘要消息（`user` / `isCompactSummary`）。
5. 组装压缩后的消息：`[边界标记, 摘要消息, ...保留区]`（`build_post_compact_messages`）。
6. `compactEnd`（`complete`，带压缩后上下文占用的重算值）与归档写盘（`history.rs` 的
   `save_compact_archive`：归档区 + 摘要）在 `compact_conversation` 内完成；返回后整文件
   重写 jsonl、标记 `meta.json` 的 `context.isCompacted = true` / `isExpanded = false`，
   最后 `replay.rs` 的 `replay_messages_to_ui` 投递 `messagesReplaced` 整批替换 UI 消息区。

保留区按条数截断后必须修复 `tool_use` / `tool_result` 配对（`sanitize_tool_pairing`）：
某条 `tool_use` 被留在归档区、其 `tool_result` 落在保留区（或相反）时，会向保留区
补一条 `is_canceled` 的合成 `tool_result`，避免下一轮请求出现孤立工具调用。

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
