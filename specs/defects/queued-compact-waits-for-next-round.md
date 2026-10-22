---
status: 已修
---

# 缺陷：排队压缩等到下一轮才执行，轮次结束后 UI 一直停在「准备压缩」

会话运行中请求压缩会登记 `pendingCompact`。当前实现只在 `run_query_loop` 的每轮
LLM 请求前消费该标记；如果请求发生在当前轮次的最后一次 LLM 往返之后（没有工具批次
触发下一轮），`run_consumer` 队列排空后直接退出，压缩不会执行，UI 一直显示「准备压缩」，
直到用户再发一条消息开启新的 consumer。

## 现状

- `Core::request_compact`（`core-rs/src/engine.rs`）在会话非空闲时只做
  `compact::mark_pending_compact`，不启动压缩。
- 唯一消费点在 `run_query_loop` 每轮 `aiBegin` 之前：
  `let pending_compact = compact::is_pending_compact(session_id);`，随后清除并
  `compact_and_apply_messages`。
- 当前轮次最后一次 LLM 往返结束后，`run_query_loop` 返回；`run_consumer_with_ui`
  的队列排空分支只把 `state.running = false` 并 `break`，没有检查 `pendingCompact`。
- 复现：会话运行中点击上下文用量条 → 当前回复结束 → 用量文本停在「准备压缩」，
  没有 `compactBegin` / `compactEnd` / `messagesReplaced`；再发一条消息后压缩才在
  下一轮开头执行。
- 文档侧：`docs/features/compaction.md` FR-002 与
  `docs/core/session-runtime.md` 的 `pendingCompact` 描述写成「下一轮对话开始时执行」，
  把上述等待行为写成了规格；原 as-built 文案与用户预期都是「当前轮次结束后执行」。

## 期望

1. 用户在当前轮次运行中请求压缩 → 登记待压缩；当前轮次最后一次 LLM 往返结束、
   队列排空时立即执行压缩（`compactBegin` / `compactEnd` / `messagesReplaced`），
   不要求用户再发一条消息。
2. 压缩完成后 `pendingCompact` 清除，UI 从「准备压缩」还原为上下文用量文本。
3. 压缩期间到达的用户消息仍然只入队，压缩结束后继续消费（既有并发保护不变）。
4. 会话空闲时请求压缩仍然立即执行；无可压缩内容时清除待压缩并还原文本。
5. 中止（abort）时清除待压缩，不在中止后执行压缩。
6. 文档恢复为「当前轮次结束后执行」：`docs/features/compaction.md` FR-002、
   `docs/core/session-runtime.md` 的 `pendingCompact` 来源 / 快照说明。

## 不变量

- 压缩结果、归档与落盘格式不变（`[边界标记, 摘要, ...保留区]`、`meta.json` 标记、
  整文件重写）。
- `pendingCompact` 仍是根事实、仍不参与派生 `idle`；`SessionRuntimeState` 字段集合不变。
- 压缩期间新到用户消息只入队、压缩结束后排空的并发保护不变。
- 空闲立即压缩路径与「无可压缩内容直接返回」路径不变。
- 排队提示不再走 once 消息的行为不变。

## 回归测试

- **RT-1**：当前轮次最后一次 LLM 往返期间请求压缩，轮次结束后自动执行压缩并清除
  `pendingCompact`；压缩开始前不出现 `idle` 快照，`queryEnd` 在压缩完成之后（落点：
  `core-rs/src/compact_engine_tests.rs` 的
  `pending_compact_runs_when_the_current_turn_ends`）。
- **RT-2**：会话中止时清除待压缩，不产生 `compactBegin`（落点：
  `core-rs/src/compact_engine_tests.rs` 的 `abort_clears_pending_compact`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `CC_aarch64_pc_windows_msvc="zig cc" CFLAGS_aarch64_pc_windows_msvc="--target=aarch64-windows-msvc" cargo test --manifest-path core-rs/Cargo.toml pending_compact_runs_when_the_current_turn_ends` | 红 | `messagesReplaced` 未出现：`queryEnd` 后事件止于 query 生命周期（`sessionRuntimeChanged` / `queryBegin` / `aiBegin` / `streamEnd` / `aiEnd` / `queryEnd`），16.87s 超时 |
| 回归用例（修复后） | 同上 | 绿 | 1 passed；新增断言：压缩开始前无 `idle` 快照、`queryEnd` 在 `messagesReplaced` 之后 |
| 回归用例 RT-2（修复前） | `CC_aarch64_pc_windows_msvc="zig cc" CFLAGS_aarch64_pc_windows_msvc="--target=aarch64-windows-msvc" cargo test --manifest-path core-rs/Cargo.toml abort_clears_pending_compact` | 红 | `中止后应当清除待压缩` 断言失败 |
| 回归用例 RT-2（修复后） | 同上 | 绿 | 1 passed |
| 既有回归 | `CC_aarch64_pc_windows_msvc="zig cc" CFLAGS_aarch64_pc_windows_msvc="--target=aarch64-windows-msvc" cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 898 passed；含既有的延后压缩、压缩期间排队、自动压缩用例 |
| 既有 TS / standalone 回归 | `npm run test:all` | 绿 | 63 通过 / 0 失败（含 docs-lint 46 组；standalone* 驱动新 Core 二进制） |
| TS 类型 / lint | `npm run check-types && npm run lint` | 绿 | 无 TS diff，复跑确认 |
