---
status: 已修
---

# 缺陷：工具在授权前被中断时卡片不上架，压缩 / 重开对话后卡片才冒出来

工具卡片由宿主在 `toolPermissionRequested` 里上架（`src/host/ui/toolHandler.ts` 的
`requestToolPermission` → `addMessage` 建 `toolcall` 节点）。中断发生在**授权之前**
（流式期间用户点终止：assistant 消息已带 `tool_use` 落盘，工具还没走到权限请求）时，
core 只为这些 `tool_use` 补了 `toolResult`，从未发过 `toolPermissionRequested`：

- 实时 UI 收到一条**找不到卡片**的 `updateToolStatus`——webview 的
  `handleToolUpdateToolStatus` 查不到同 `toolCallId` 的节点就把它塞进
  `bufferedToolStatusRef`（等待后续出现同名卡片时回放），于是这一轮**看不到任何工具卡片**；
- 下一次整批重放（压缩后的 `messagesReplaced`、重开对话的 `conversationLoaded`）走
  `build_replay_message_data`，从落盘的 `tool_use` + `is_canceled` 的 `tool_result`
  直接产出 `role: 'toolcall'` 项——**卡片这时才出现**。

用户看到的就是「中断后，压缩完工具调用又显示在 UI 中了」：卡片不是被压缩重新造出来
的，而是**首次出现**。压缩只是碰巧提供了那条重放路径。

## 现状

- `core-rs/src/engine.rs` 的「流式期间被中止」分支（`cancelled || tool_uses.is_empty()`
  内的 `if cancelled`）对每个 `tool_use` 只做两件事：`emit toolResult` + 补
  `tool_result` block 落盘。没有 `request_tool_permission`。
- 正常执行路径（`run_query_loop` 的工具循环）在执行前一律先发
  `toolPermissionRequested`（`Core::request_tool_permission`），UI 靠它上架卡片；
  「工具不存在」分支同样发一次（`permResult` 恒 `allow`，只为上架失败卡片）——
  中断分支漏了这一步。
- 重放路径（`core-rs/src/replay.rs` 的 `build_replay_message_data`）不看
  `toolPermissionRequested`，直接从落盘消息造卡片，因此两条路径的产物不一致：
  同一对被中断的工具，实时一条卡片都没有，重放有一条。
- 复现（Rust，修复前红）：
  `cargo test --manifest-path core-rs/Cargo.toml abort_with_pending_tool_uses_backfills`
  ——断言「中断也必须上架工具卡片」失败，实测 `toolPermissionRequested` 请求数为 0。
- 端到端可见形态（Electron 整应用实测）：中断那一刻时间线只有 `*User Interrupted*`，
  没有 Bash 卡片；压缩后（或重开对话后）同一段历史里出现
  `Bash / Sleep thirty / sleep 30 / (无输出) Command was interrupted` 卡片。

## 期望

- 中断发生时，每个未执行的 `tool_use` 都**当场**上架工具卡片：先
  `request_tool_permission`（`permResult` 恒 `allow`、`displayArgs` 与正常授权路径同一份
  展开实现），再 `emit toolResult`。
- 于是实时 UI 与重放产物一致：中断那一刻卡片就在，压缩 / 重开对话后卡片形状与状态不变
  （仍是失败态、仍带「Command was interrupted」说明）。
- 中断卡片**不弹确认框**：`permResult.behavior` 恒为 `allow`，与「工具不存在」的失败
  卡片同一口径（用户没有可做的选择）。

## 不变量

- `tool_result` block 的落盘形状不变：`content` = `Command was interrupted`、
  `exit_code` = -1、`is_canceled` = true。
- 中断后不再回到 LLM（不补发 `aiEnd` 之外的东西）、`*User Interrupted*` 仍是
  once 通知（只记 `meta.json` 的 `onceMessage`，不进 jsonl、不进上下文）。
- 工具确实不执行（`should-not-run` 这类副作用不发生）。
- 正常执行路径的 `toolPermissionRequested` 次数与时机不变（仍是执行前一次）。
- 重放路径（压缩 `messagesReplaced` / 重开 `conversationLoaded`）的产物形状不变。
- `permResult` 为 `allow` 时宿主不回传任何应答——中断的会话不需要等确认。

## 回归测试

- **RT-1**：Rust——流式期间中止后，`toolPermissionRequested` 恰好一条、`toolUseId` /
  `toolName` / 展开后的 `displayArgs.command` 对得上、`permResult.behavior == allow`，
  且该请求帧**先于** `toolResult` 帧；原有落盘 / once 通知 / 不执行断言全部保持
  （落点：`core-rs/src/engine_tests.rs` 的
  `abort_with_pending_tool_uses_backfills_tool_results_and_reports_interruption`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path core-rs/Cargo.toml abort_with_pending_tool_uses_backfills` | 红 | 失败断言「中断也必须上架工具卡片」：`requests_of("toolPermissionRequested")` 为空 |
| RT-1（修复后） | 同修复前命令 | 绿 | 一条 `toolPermissionRequested`（`call_1` / `Bash` / `displayArgs.command` 对得上 / `behavior=allow`），帧序先于 `toolResult`；原有断言全绿 |
| 既有中断回归 | `cargo test --manifest-path core-rs/Cargo.toml abort_` | 绿 | 同文件的 `abort_during_tool_execution_reports_interruption`、`abort_during_responses_stream_...`、`abort_marks_the_session_for_cancellation` 均绿 |
| 真实应用可见形态（修复前） | Electron 整应用：Bash `sleep 30` 执行中 → 终止 → 继续 4 轮 → 点用量条压缩 | 部分验证 | 中断那一刻**无** Bash 卡片；压缩后出现 `Command was interrupted` 卡片（卡片首次出现的时机就是缺陷）。探针里观测，未固化成 e2e 用例 |
| 中断窗口的 e2e 复现尝试 | 同整应用：mock 延迟 2500ms 才吐 tool_calls，终止落在 200ms | not-run | 该探针命中的是「tool_calls 还没到」的窗口（`tool_uses` 为空，本来就不该有卡片），打不到「tool_use 已解析、工具未执行」那段。该窗口在真实应用里只能靠时序撞，确定性复现放在 RT-1 的 `start_gated` 用例里 |
| 全量回归（core） | `cargo test --manifest-path core-rs/Cargo.toml` | 部分验证 | 1059 通过 / 5 失败，失败全部落在 `mcp::tests` 的 stdio 真子进程用例；已 `git stash` 掉本次改动在干净基线复跑 `stdio_handshake_paging_call_and_reverse_request` 同样失败——与本修复无关的本机环境问题（TODO.md 另有记录的工具类环境依赖） |
