---
status: 已修
---

# 缺陷：子代理起跑时未推送 sessionRuntimeChanged，流水灯与父会话 subAgentRunning 滞后

`/spin` 的节点子代理（以及任何 `Agent` 工具起的子代理）在跑第一轮时，对话树里它的流水灯不亮，
父会话的 `subAgentRunning` / 托盘状态点 / abort 按钮后台态也停在旧值；只有显式打开该子会话
（触发 `conversationOpened` → `emit_runtime`）才显示。根因是创建时的快照在 `running` 置位之前
推送（子会话首次出现是 idle），而起跑后没有补推；消费者只能读到 idle 快照。

## 现状

- `core-rs/src/engine.rs` 的 `run_sub_agent` 在起跑时先发 `queryBegin`，再给首条任务消息
  入队并置 `running = true`（Reminder 重入同样置位），但**没有调用 `emit_runtime()`**。
- 同一文件的 `create_sub_agent` 先 `self.session(&sub_session_id)` 登记子会话，随后
  `emit_runtime()`，**然后**才 `thread::spawn(run_sub_agent)`。因此消费者拿到的最后一份快照
  是「子会话 `idle: true`、父会话 `subAgentRunning: false`」。
- `run_consumer_with_ui` 对子代理传 `emit_ui = false`：进入时不发 runtime；退出处的
  `emit_runtime()` 在 `if emit_ui` 分支内，子代理不发；只有每轮结束后的 `emit_runtime()`
  会推一次。子代理通常一轮就 `Reply`，所以「running」快照要么来不及发，要么只在收尾瞬间出现。
- 消费者只读快照：webview 对话树流水灯由 `src/webview/hooks/handlers/conversationHandlers.ts`
  的 `handleConversationSessionRuntimeStates` 写入 `sessionRuntimeStatesRef`，
  `src/webview/App.tsx` 的 `getSessionIdleState` 与 `src/webview/ConversationTreeItem.tsx`
  只读这份 Map；`src/webview/hooks/handlers/streamHandlers.ts` 明确写了
  「对话树流水灯不在这里刷新：它只读 core 推送的 `sessionRuntimeStates`」，
  `queryBegin` / `queryEnd` 不驱动灯。
- 打开子会话会补一次快照：`src/host/ui/webviewMessageHandler.ts` 的 `loadConversation`
  发 `conversationOpened`，`core-rs/src/engine.rs` 的 `on_conversation_opened` 无条件
  `emit_runtime()`——这就是「打开后才亮」的直接原因。
- spin 与普通子代理走同一条路径：`core-rs/src/spin_host.rs` 的 `CoreSpinHost::run_sub_agent`
  调 `submit_tool_use("Agent")`，最终进 `create_sub_agent` → `run_sub_agent`。spin 更明显是因为
  `/spin` 在父会话消费循环里同步执行（`core-rs/src/engine.rs` 的 `resolve_pending_command`
  调 `spin_host::run_spin_command`），整个 spin 期间父会话没有轮次收尾的 `emit_runtime()`；
  普通对话里父轮次收尾的那次全量快照会把子会话的 `queryRunning` 一起刷新，所以通常只是晚几秒。
- 与规格冲突：[docs/core/session-runtime.md 第 1 节](../../docs/core/session-runtime.md#1-来源与调用点)
  把 `queryRunning` 的写入点写成「消费循环（`run_consumer` / `run_query_loop`）的进入与收尾、
  子代理轮次」，[第 2 节](../../docs/core/session-runtime.md#2-对外快照) 规定 `idle` 由根事实
  递归推导、消费者读快照；子代理起跑的事实变化没有进入快照。
- 复现路径：准备一个 `ready` 的 `spin.json`，执行 `/spin`；在某个节点的子代理运行期间观察对话树，
  该子会话行没有流水灯；点击该子会话打开它，流水灯出现。普通长任务子代理在该窗口内若没有
  其它 `emit_runtime()`（例如父轮次已结束、其它会话空闲）同样复现。
- 现有用例覆盖不到：`core-rs/src/engine_tests.rs` 的
  `emit_runtime_reports_root_facts_and_busy_subagents` 是手动改 `running` 后再调
  `emit_runtime()`，没有断言「子代理起跑本身会推快照」。

## 期望

- 子代理创建即 running：`create_sub_agent` 在登记子会话后、调用 `emit_runtime()` **之前**
  把 `running = true`；该子会话首次出现在快照里就是 `queryRunning: true`，父会话
  `subAgentRunning: true`、`idle: false`。不存在「先推 idle 再补 running」的中间态。
- `run_sub_agent` 仍负责把首条任务消息入队；它不改变运行时事实（`running` 已为 true），
  因此不需要额外推送一次快照。
- Reminder 重入同样不产生 idle 中间态：子代理消费循环的退出不发 runtime（`emit_ui = false`），
  最后一次 running 快照延续到下一轮；`emit_runtime` 的 diff 仍抑制无变化。
- 子代理收尾仍推 idle 快照（现状已满足，不得回退）。
- `queryBegin` / `queryEnd` 仍由 `run_sub_agent` 管一对，不因创建时的快照而重复；消费者仍只读
  `sessionRuntimeChanged`，不从 `queryBegin` / `queryEnd` 推导流水灯。

## 不变量

- `sessionRuntimeChanged` 仍是全量快照，状态没变时不重发（`emit_runtime` 内部 diff）。
- `run_sub_agent` 对 `run_consumer_with_ui(..., false)` 的调用不变，`queryBegin` / `queryEnd`
  仍只发一对。
- `is_idle_deep` 的递归判定与 `subAgentRunning` 的语义不变。
- 快照字段集合不变（`core-rs/fixtures/runtimeState.json` 与两侧测试双向锁定）。
- 子代理并发槽位的 acquire / release 配对不变。
- 会话落盘格式（`meta.json` / 对话 JSONL）不变。

## 回归测试

- **RT-1**：子代理首次出现在 `sessionRuntimeChanged` 中时就是 `queryRunning: true`
  （创建即 running，不允许 idle 中间态），父会话 `subAgentRunning: true` 且 `idle: false`。
  （落点：`core-rs/src/engine_tests.rs::sub_agent_start_emits_running_runtime_snapshot`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc sub_agent_start_emits_running_runtime_snapshot -- --nocapture` | 红 | 断言「子代理首次进入快照就应是 running（创建即 running，不允许 idle 中间态）」失败：`left: Bool(false) / right: true`——第一条包含子会话的 `sessionRuntimeChanged` 里 `queryRunning` 为 `false`。本机 rustc host 为 `aarch64-pc-windows-msvc`，默认 `cargo test` 在 `ring` 的 build script 上因缺 `clang` 构建失败（与本次改动无关），故显式指定产物已缓存的 `x86_64-pc-windows-msvc` |
| 回归用例（修复后） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc sub_agent_start_emits_running_runtime_snapshot -- --nocapture` | 绿 | 1 passed / 0 failed。修复方式：`create_sub_agent` 在登记子会话后、`emit_runtime()` 之前置 `running = true`，子代理首次进入快照即 `queryRunning: true`，不再有 idle 中间态；`run_sub_agent` 的消费循环与收尾推送不变 |
| 既有回归 | `cd core-rs && cargo test --target x86_64-pc-windows-msvc -- --test-threads=1` | 绿 | 881 passed / 0 failed（含 RT-1），在最终代码上跑完 |
| 文档守卫 | `npm run test:all -- docs-lint` | 绿 | 46 通过 / 0 失败 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 本次改动只在 Rust 侧与缺陷规格，TS 检查与改动前同状态 |
