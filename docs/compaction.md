# 规格：对话压缩

本规格界定对话压缩（compact）的行为：触发条件、摘要生成、跨多次压缩保留的用户输入历史、
归档与展开。范围只覆盖 core 侧的压缩事实与落盘格式；进度条 / 按钮等表现由 UI 自行决定，
不在本规格内。

相关规格与章节：

- [DEVELOPMENT.md 第 4.1 节](../DEVELOPMENT.md#41-coreeventcore--ui单向)（CoreEvent）：`compactBegin` / `compactEnd` / `messagesReplaced`
- [DEVELOPMENT.md 第 4.3 节](../DEVELOPMENT.md#43-uieventui--core单向)（UiEvent）：`compactRequested`
- [DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)（sessionRuntimeChanged 的生产者：sessionRuntime）：`compacting` 来源
- [DEVELOPMENT.md 第 5.6 节](../DEVELOPMENT.md#56-core-描述事实ui-决定表现)（core 描述事实，UI 决定表现）
- [DEVELOPMENT.md 第 5.8 节](../DEVELOPMENT.md#58-契约只写现状派生字段从根字段推导)（契约只写现状，派生字段从根字段推导）
- [docs/standalone-core.md 第 9 节](standalone-core.md#9-与-embedded-core-的对等)（与 Embedded Core 的对等）
- `docs/user-stories.md` 的 US-9 / US-17

## 1. 能力

### 1.1 触发与阈值

自动压缩阈值按 `contextWindow - min(50K, 0.3 * maxOutputTokens)` 计算
（`getAutoCompactThreshold`，`src/core/compact/types.ts` ↔ `core-rs/src/compact.rs`），
为输出预留缓冲。前端进度条与本函数共用同一套规则，保证 UI 与触发条件一致。

- **自动压缩**：在 `aiBegin` 之前判断，超过阈值即触发（`Query` / `engine.rs`）。
- **手动压缩**：UI 发 `UiEvent.compactRequested` → `Integration.requestCompact`；
  会话非空闲（`idle === false`）时登记「待压缩」，在当前轮次结束后执行。

压缩是否可行由 `hasCompactableMessages` 判定：压缩边界之后的消息数必须**严格大于**
`maxMessagesToKeep`（30），否则没有可摘要的内容，调用方直接返回、不做任何处理。

### 1.2 压缩流程

压缩会**整体替换**会话消息数组，期间把会话标记为「正在压缩」
（`compact/state.ts` 的 `markCompacting` + `sessionRuntime` 的 `compacting` 来源，
见 [DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)），新到的用户消息只入队、由 `resumeAfterCompact` 排空。

1. 取最后一次压缩边界之后的消息（`getMessagesAfterCompactBoundary`）。
2. 保留最近 `maxMessagesToKeep`（30）条消息作为**保留区**，原样留在上下文里；
   其余为**归档区**，会被摘要掉。
3. 用归档区调 LLM 生成摘要（`COMPACT_SYSTEM_PROMPT` + `generateCompactSummaryPrompt`）。
4. 新建边界标记（`system` / `compact_boundary`）与摘要消息（`user` / `isCompactSummary`）。
5. 组装压缩后的消息：`[边界标记, 摘要消息, ...保留区]`（`buildPostCompactMessages`）。
6. `compactEnd`（`complete`，带压缩后 token 数）与归档写盘（`saveCompactArchive`：归档区 + 摘要）
   在 `compactConversation` 内完成；返回后整文件重写 jsonl（`replaceConversationMessages`）、
   标记 `meta.json` 的 `context.isCompacted = true` / `isExpanded = false`，最后
   `replayMessagesToUI` 投递 `messagesReplaced` 整批替换 UI 消息区。

保留区按条数截断后必须修复 `tool_use` / `tool_result` 配对（`sanitizeToolPairing`）：
某条 `tool_use` 被留在归档区、其 `tool_result` 落在保留区（或相反）时，会向保留区
补一条 `is_canceled` 的合成 `tool_result`，避免下一轮请求出现孤立工具调用。

### 1.3 用户输入历史（跨多次压缩）

摘要消息正文里带一个「用户输入历史」章节，保存用户真实输入（过滤掉系统自动产生的
`silent` / `origin` 为 `agent` / `bash` / `isMeta` / `isCompactSummary` / 带 `reminder`
字段 / 内容形如 `<reminder>` 的消息，见 `getUserInputHistory`），避免压缩后丢失用户的
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

纯函数与落盘字段：

| 环节 | Embedded（TS） | Standalone（Rust） |
| --- | --- | --- |
| 提取条目 | `toUserInputEntries`（`compact/prompt.ts`） | `to_user_input_entries`（`compact.rs`） |
| 跨压缩选择 | `selectUserInputHistory` | `select_user_input_history` |
| 读取持久化历史 | `readCompactUserInputHistory` | `read_compact_user_input_history` |
| 格式化章节 | `formatUserInputEntries` | `format_user_input_entries` |
| 字段名 | `compactUserInputHistory` | `compactUserInputHistory` |

### 1.4 归档与展开

归档文件（`compact archive`）只保存被摘要掉的归档区消息 + 本次摘要消息，**不含保留区**
（保留区仍可见，展开时与归档一起重放）。

- 展开（`expandCompact`）是**只读**操作：宿主读归档文件并把「归档 + 保留区」重放给
  webview，不改任何 core 状态；LLM 仍只看压缩后的消息（[DEVELOPMENT.md 第 5.6 节](../DEVELOPMENT.md#56-core-描述事实ui-决定表现)）。
- Standalone 下归档读取经 `UiRequest.compactArchiveRequested`（[docs/standalone-core.md 第 10 节](standalone-core.md#10-宿主侧的-core-事实读取)）。

## 2. 数据流

```
阈值判定 ──▶ compactConversation ──compactBegin──▶ UI（压缩进度提示）
                    │
                    ├─ LLM 生成摘要
                    ├─ 组装 [边界, 摘要, ...保留区]
                    ├─ compactEnd ──▶ UI（进度提示 complete / error）
                    ├─ saveCompactArchive（归档区 + 摘要）
                    ├─ replaceConversationMessages（整文件重写 jsonl + meta 标记）
                    └─ replayMessagesToUI ──messagesReplaced──▶ UI（整批替换消息区）
```

## 3. 测试

- 纯函数对等：`src/test/compactParity.test.ts` ↔ `core-rs/src/compact_tests.rs`，
  共用 `src/test/fixtures/compactParity.json`（由 `scripts/gen-compact-parity.mjs` 生成）。
  覆盖条目提取 / 格式化 / 跨多次压缩的全局选择 / 读取持久化历史。
- 端到端（假 LLM）：`core-rs/src/compact_engine_tests.rs` 覆盖手动 / 自动触发、延后执行、
  并发保护、运行时状态上报，以及**多次压缩时全局头部不丢失**
  （`repeated_compact_keeps_the_global_user_input_head`）。
- 单测：`src/test/compactAgentMode.test.ts` 覆盖 `selectUserInputHistory` 等纯函数。
