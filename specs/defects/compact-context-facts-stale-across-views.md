---
status: 已修
---

# 缺陷：压缩后的上下文占用事实没有产出，三个视图消费方各拿旧值或归零

「模型 context 更新后所有视图立刻按新值显示」里最重的一条更新是压缩：压缩把上下文
整体替换为「边界 + 摘要 + 保留区」，占用从逼近阈值骤降到一个小的估算值。as-built
契约里这个事实的载体是 `compactEnd` 的 `postCompactTokenCount`（载荷语义：
[events.md 第 2.1 节](../../docs/architecture/events.md)「压缩后的 token 使用量」）与
`meta.json` 的 `context.totalContextTokens`（[Conversation.ts](../../src/shared/history/Conversation.ts)
「当前对话的上下文总 token 数」；[compaction.md FR-003](../../docs/features/compaction.md#fr-003压缩流程与落盘)
「compactEnd（complete，带压缩后 token 数）」）。现状是三处都没做到：

1. **core 没有产出压缩后占用**：`compactEnd.postCompactTokenCount` 填的是**摘要生成
   那次 LLM 调用的 output tokens**（`core-rs/src/compact.rs` 的 `generate_summary`
   返回值），不是压缩后上下文的占用；`meta.json` 的 `totalContextTokens` 在压缩流程里
   完全不写（只有每轮 usage 落盘时写，`engine.rs` 的消费循环）——压缩清空了保留区的
   usage（`clear_message_usage`），这个旧值就成了既无锚点可覆盖、又持续被读取的僵尸值。
2. **webview 把刚收到的值抹零**：`messagesReplaced` 的 handler（`conversationHandlers.ts`）
   无条件 `setContextLength(0)`。wire 顺序是 compactEnd 先到（把用量条设为
   postCompactTokenCount）、messagesReplaced 后到（归零）——US-9 验收 2「压缩完成后
   进度条按新值刷新」被第二步推翻，直到下一轮真实 usage 才恢复。展开归档（`expandCompact`，
   只读展示、LLM 上下文不变）复用同一条 wire 消息，同样被归零。
3. **TUI 不消费压缩完成**：`compactEnd` 在 TUI 只转成一条瞬时通知；状态栏的上下文
   tokens（`session.context_tokens`）停留压缩前旧值，直到下一轮 `streamEnd`。

僵尸 meta 值还有两处**非显示**的后果（同一根因）：

- webview / TUI 切回（或重开）该对话时用量条从 `conversationLoaded` 的
  `savedContext.totalContextTokens` 恢复——显示压缩前的旧用量（红色虚高）。
- core 自己的估算兜底 `estimate_next_context_tokens`（无 usage 锚点分支与 meta 取 max）
  拿旧值：手动压缩（空闲立即执行）后的下一轮估算 ≥ 阈值，`should_auto_compact` 再次
  为真 → 刚压完立即又被自动压缩一次（重复压缩）；同一估算也喂
  `available_output_tokens`，该轮输出预算被旧值挤占。

## 现状

- `core-rs/src/compact.rs` `compact_conversation_inner`：
  `compactEnd` 的 `postCompactTokenCount` = `summary_output_tokens`；压缩全程不写
  `totalContextTokens`。
- `core-rs/src/compact.rs` `compact_and_apply_messages`：只写 `isCompacted` / `isExpanded`。
- `src/webview/hooks/handlers/conversationHandlers.ts` `handleConversationMessagesReplaced`：
  `props.setContextLength(0)`。
- `tui-rs/src/host.rs` `handle_event` 的 `compactEnd` 分支：只发通知；`store.rs` 的
  `Action::MessagesReplaced` 只替换消息列表。

## 期望

- **core 是压缩后占用的事实产出点**：压缩完成时用与运行时估算同一套口径
  （`util::estimate_request_tokens` 作用在压缩后消息上；保留区 usage 已清空，没有
  真实锚点可用，估算值是此刻能给出的最好事实；下一轮真实 usage 落盘后照常覆盖）
  重算占用，`compactEnd.postCompactTokenCount` 带该值、`meta.json` 的
  `totalContextTokens` 写回该值。一个字段一个写入点不变：`totalContextTokens` 的
  写入方仍是 core，压缩只是新增一个写入时机。
- **webview**：`messagesReplaced` 不再触碰用量——压缩场景 `compressProgress(complete)`
  已把用量设为 core 给的新值；展开归档场景上下文未变、用量本就不该动。
- **TUI**：`compactEnd(complete)` 把该会话状态栏的上下文 tokens 更新为
  `postCompactTokenCount`（通知保留）；`messagesReplaced` 维持只换消息列表。

## 不变量

- 压缩流程的既有序与事件不变：compactBegin → 摘要 → compactEnd(complete) → 归档写盘 →
  整文件重写 jsonl + meta 压缩标记 → messagesReplaced（[compaction.md 第 3.1 节](../../docs/features/compaction.md#31-数据流)）。
- 每轮 usage 落盘路径（`engine.rs` 消费循环的 `update_context(totalContextTokens)`）
  不变：只在 `> 0` 时写，压缩后首轮真实 usage 照常覆盖估算值。
- `expandCompact` 只读语义不变（不改 core 状态；归档读取仍走 `compactArchiveRequested`）。
- 用量条分母（`contextLimitUpdated` 的 `maxContextTokens`）与「准备压缩」投影
  （`pendingCompact`）不受影响。
- `messagesReplaced` 的 wire 载荷不变（不加字段）。

## 回归测试

- **RT-1**（core 产出）：手动压缩后 `meta.json` 的 `context.totalContextTokens` 等于
  `compactEnd.postCompactTokenCount` 且 > 0（压缩前先造一个大占用，断言不再停留旧值）
  （落点：`core-rs/src/compact_engine_tests.rs` 的
  `manual_compact_writes_post_compact_context_tokens`）。
- **RT-2**（webview 不归零）：e2e 注入 `compressProgress(complete, postCompactTokenCount)`
  后紧接 `messagesReplaced`，用量文本保持压缩后值、不回落 0（落点：
  `e2e/webview/inputMenu.spec.ts` US-9 用例扩展）。
- **RT-3**（TUI 消费）：`compactEnd(complete)` 产生更新 `context_tokens` 的动作且
  reducer 写入该会话（落点：`tui-rs/src/host.rs` 内嵌测试 + `store.rs` reducer 测试）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（core 产出，修复后） | `cargo test --bin standalone-core manual_compact -- --test-threads=1` | 绿 | `manual_compact_writes_post_compact_context_tokens`：压缩前先写 999_999，压缩后 `compactEnd.postCompactTokenCount` 与 `meta.json` 的 `totalContextTokens` 同值且不为旧值 |
| RT-1（core 产出，修复前） | 同上（stash 修复后回放） | 红 | 压缩后 meta 停留 999_999（压缩流程不写该键）、`postCompactTokenCount` 取摘要调用的 output tokens |
| RT-2（webview 不归零，修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "US-9"` | 绿 | 3 用例全过，含新增「压缩完成后用量条按新值刷新，不被随后的整批替换归零」（`compressProgress(complete, 30720)` → `messagesReplaced` → 用量文本保持 `30/125`） |
| RT-2（webview 不归零，修复前） | 同上（仅 stash `conversationHandlers.ts` 后回放） | 红 | messagesReplaced 把用量归零，`30/125` 断言超时 |
| RT-3（TUI 消费，修复后） | `cargo test --manifest-path tui-rs/Cargo.toml` | 绿 | 81/81：`host::tests::compact_end_updates_context_tokens`（compactEnd → SetContextTokens + 通知保留）、`store::tests::session_config_and_context_tokens_updates`（reducer 写入） |
| 既有回归（rust 全套） | `cargo test --bin standalone-core -- --test-threads=1` | 部分验证 | 1040 过 / 1 失败；唯一失败 `abort_clears_pending_compact` 在基线（stash 对照）即失败，与本缺陷无关（先例：specs/defects/manual-compact-lock-guard.md 验证记录，CI Linux 为准） |
| 既有回归（单测全套） | `npm run test:unit` | 绿 | 87 过 / 1 skip（sidebarFiles 环境前置，与本缺陷无关） |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 验证记录落笔后复跑通过 |
| check-types / lint | `npm run check-types && npm run lint` | 绿 | 含 webview / electron / e2e 三份 tsconfig |
