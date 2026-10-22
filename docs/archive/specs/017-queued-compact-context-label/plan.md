# 实施方案：排队压缩的上下文用量文本

技术路线：core 在 `SessionRuntimeState` 快照里暴露 `pendingCompact` 根事实（数据源仍是
`compact.rs` 的 `PENDING_COMPACT` 注册表，不新增第二份记账），并删掉登记待压缩时的
once 通知；webview 与 TUI 读该事实，在「已排队且未开始压缩」时把上下文用量文本换成
`准备压缩` / `Preparing`，webview 同时取消该文本的点击入口。指向同目录 `spec.md`。

## 技术方案

### 1. core：快照新增 `pendingCompact`

- `core-rs/src/engine.rs` 的 `runtime_state_json` 增加 `pending_compact: bool` 参数，
  输出 `"pendingCompact": pending_compact`。
- `emit_runtime` 在取完 `SessionState` 快照后读 `compact::is_pending_compact(session_id)`
  传入。`PENDING_COMPACT` 是既有唯一写入点（`compact.rs` 的 `mark_pending_compact` /
  `unmark_pending_compact`），快照只做投影，不在 `SessionState` 里再存一份。
- `request_compact` 的非空闲分支：`mark_pending_compact` 后调用 `self.emit_runtime()`，
  删除 `emit_once_notice` 调用；不再产生 `message` 事件、不再写 `meta.json.onceMessage`。
- 待压缩清除后的推送：
  - `request_compact` 立即压缩分支：`unmark_pending_compact` 后若 `project_of` 失败或
    `compact_and_apply_messages` 返回 false（无可压缩内容），补一次 `emit_runtime()`；
    实际压缩时由 `compact_conversation` 的 `mark_compacting` 前后两次 `emit_runtime`
    覆盖。
  - `run_query_loop` 消费待压缩：`unmark_pending_compact` 后若
    `compact_and_apply_messages` 返回 false，补一次 `emit_runtime()`；返回 true 时压缩
    流程已推送。
  - 这样避免「pending=false、compacting=false」的中间快照让文本提前一帧还原。
- `drop_session` 调 `compact::unmark_pending_compact(session_id)`，避免会话删除后
  进程级注册表残留；会话已从快照移除，不需要额外事件。
- `pendingCompact` 不参与 `idle` 派生：`emit_runtime` 的 `idle` 计算不变。

### 2. 契约与投影

- `src/shared/AssistantEventBus.ts` 的 `SessionRuntimeState` 增加必选成员
  `pendingCompact: boolean`，注释注明「已登记手动压缩、等待下一轮开始；不参与 idle」。
- `src/host/webviewMessages.ts` 的 `sessionRuntimeStates.states` 内联类型同步。
- `src/webview/types.ts` 的 webview 投影同步。
- `src/webview/hooks/handlers/conversationHandlers.ts` 映射 `pendingCompact:
  !!s.pendingCompact`（与既有 `compacting` 同口径）。
- `src/host/bootstrapCore.ts` 的 Core 失联归零路径补 `pendingCompact: false`。
- `tui-rs/src/store.rs` 的 `RuntimeState` 增加 `pending_compact`，`from_value` 读
  `"pendingCompact"`（沿用现有 `flag()` 解析）。

### 3. webview：文本替换与取消点击

- `src/webview/App.tsx` 用 `useMemo` 计算当前会话的 `compactPending =
  pendingCompact && !compacting`，依赖 `currentSessionId` / `sessionIdleVersion`（与
  `abortButtonState` 同一重渲染信号），作为必选 prop 传给 `InputArea`。
- `src/webview/InputArea.tsx`：
  - `InputAreaProps` 增加 `compactPending: boolean`。
  - `ContextProgressBar` 增加 `compactPending`：为真时 `displayText` 取
    `t('inputArea.compactPending')`，不渲染内层 `<button>`，改为纯文本 `<span>`；
    外层 `title` 用同一文案，去掉「点击压缩」提示与 hover 下划线。
  - 进度条本身不变：仍按 `totalContextTokens / maxContextTokens` 计算宽度与颜色。
  - `compacting` 变真或 `pendingCompact` 清除后 `compactPending` 为假，自动回到原按钮。
- `src/webview/i18n/zh.ts` / `en.ts` 新增 `inputArea.compactPending`：
  `准备压缩` / `Preparing`。

### 4. TUI：状态栏文本

- `tui-rs/src/app.rs` 状态栏：`runtime.pending_compact && !runtime.compacting` 时，
  上下文 tokens 位置改渲染 `i18n::tt("准备压缩", "Preparing")`；否则保持
  `{used}{/max} tok`。
- `tui-rs/src/store_tests.rs` 的 `RuntimeState` 字面量补 `pending_compact: false`，
  并新增 `from_value` 解析用例。

### 5. 测试与闸门

- core：
  - `core-rs/src/engine_tests.rs`：把 `compact_requested_while_busy_emits_once_notice`
    改为断言「无 `message` 事件、`sessionRuntimeChanged` 中 `pendingCompact=true`」；
    重复请求不重复置真；`emit_runtime_reports_idle_and_waiting_flags` /
    `emit_runtime_reports_root_facts_and_busy_subagents` 补 `pendingCompact=false` 断言。
  - `core-rs/src/compact_engine_tests.rs`：`manual_compact_is_deferred_while_the_session_is_busy`
    改为断言无排队 `message`、快照 `pendingCompact=true`、消费后快照 `pendingCompact=false`；
    新增「待压缩被消费但无可压缩内容 → 清除并推送 `pendingCompact=false`」用例。
  - `core-rs/src/main_tests.rs` 的 `runtime_state_json` 调用补参数；
    `core-rs/fixtures/runtimeState.json` 的 `fields` 增加 `pendingCompact`。
- webview：e2e `e2e/webview/inputMenu.spec.ts` 扩展 US-9——推送
  `pendingCompact=true` 快照后断言文本为「准备压缩」、点击不新增 `requestCompress`；
  再推送 `compacting=true` 快照断言还原 `(K)`。`e2e/helpers/fakeHost.ts` 的
  `runningState` / `idleState` 及 `conversation.spec.ts` / `sendModes.spec.ts` 的
  状态字面量补 `pendingCompact: false`。
- 闸门：`npm run check-types && npm run lint`；`npm run build:core:host` 后
  `npm run test:all`（含 docs-lint）；`npm run test:e2e:webview -- inputMenu`；
  TUI 侧 `cargo test --manifest-path tui-rs/Cargo.toml`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/engine.rs` | 修改：`runtime_state_json` 加 `pendingCompact`；`request_compact` / `run_query_loop` / `drop_session` 维护推送与清理 | 快照新增根事实 `pendingCompact` |
| `core-rs/fixtures/runtimeState.json` | 修改：`fields` 增加 `pendingCompact` | 快照字段集合 |
| `core-rs/src/engine_tests.rs`、`compact_engine_tests.rs`、`main_tests.rs` | 修改：断言与调用参数 | 无 |
| `src/shared/AssistantEventBus.ts` | 修改：`SessionRuntimeState.pendingCompact: boolean` | 契约成员新增（必选） |
| `src/host/webviewMessages.ts` | 修改：`sessionRuntimeStates.states` 内联类型加字段 | wire 载荷字段新增 |
| `src/host/bootstrapCore.ts` | 修改：Core 失联归零时 `pendingCompact: false` | 无 |
| `src/webview/types.ts`、`hooks/handlers/conversationHandlers.ts` | 修改：投影与映射 | 无 |
| `src/webview/App.tsx`、`InputArea.tsx` | 修改：计算 `compactPending`、文本替换、取消点击 | 无 |
| `src/webview/i18n/zh.ts`、`en.ts` | 新增：`inputArea.compactPending` | 无 |
| `tui-rs/src/store.rs`、`app.rs`、`store_tests.rs` | 修改：解析与状态栏文本 | 无 |
| `e2e/helpers/fakeHost.ts`、`e2e/webview/inputMenu.spec.ts`、`conversation.spec.ts`、`sendModes.spec.ts` | 修改：快照字面量与 US-9 用例 | 无 |
| `docs/core/session-runtime.md`、`docs/architecture/events.md`、`docs/features/compaction.md`、`docs/hosts/webview-ui.md`、`docs/hosts/tui.md`、`docs/features/user-stories.md` | 文档同步（同 spec 影响基线表） | docsLint 对照项同步 |

不涉及：`AssistantEventBus` 的可选成员冻结清单（新增的是必选成员）；会话落盘格式
（`<sid>.jsonl` / `meta.json` 结构不变，只是不再写压缩排队 once）；`once` 机制本身与
其它写入点。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：core 只在
      快照里加事实，不 import host / 不感知 UI；`pendingCompact` 定义在 `src/shared/`
      的 `SessionRuntimeState`；webview 只读宿主推来的快照，TUI 只解析 wire；无
      `host.kind` 式嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      `pendingCompact` 是必选成员（不用 `?`）；唯一写入点是 `PENDING_COMPACT` 注册表，
      快照是只读投影；UI 不在点击时自建排队标记；无快照时不显示「准备压缩」而不是猜值；
      文案只有 i18n 一处。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：core
      行为改动落 `core-rs/src/engine.rs` + 两侧测试；`core-rs/fixtures/runtimeState.json`
      与 `main_tests` 的字段集合双向锁定同步；落盘格式不变。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec 影响基线
      同提交修订 session-runtime、events、compaction、webview-ui、tui、US-9；
      `npm run test:all -- docs-lint` 必绿。

## 被否决的替代方案

- **UI 点击后自建 pending 标记**：core 可能在「无可压缩消息 / 已在压缩中」时忽略请求，
  UI 会残留「准备压缩」；刷新 / 重开也会丢状态；且与 core 的待压缩事实形成两个写入点。
  否决。
- **新增独立 CoreEvent（`compactQueued` / `compactPendingChanged`）**：`sessionRuntimeChanged`
  已是逐会话运行时事实的既有通道，新增事件要平行维护状态表与订阅；`compacting` 就在
  快照里，排队事实放同一处最一致。否决。
- **在 `SessionState` 再存一份 `pending_compact`**：与 `PENDING_COMPACT` 注册表双记账，
  两处更新时点稍有偏差就会漂移；快照直接读注册表即可。否决。
- **保留 once 通知、额外加文本**：同一事实两套提示，且用户明确要求去掉 once。否决。
- **用 CSS `pointer-events: none` 让文本不可点**：键盘 / 辅助技术仍可触发 `onClick`，
  不是真正的不可点击；直接不渲染 `<button>` 才满足 AC-4。否决。
