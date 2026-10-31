# 任务分解：LLM 失败 once 通知的一键重试按钮

执行顺序：先 core 契约与行为（T001–T003，Rust 侧自锁），再 TS 契约与宿主翻译
（T004–T006），再 webview 渲染与 i18n（T007–T008），然后文档同步（T009）、e2e
（T010）、全量回归（T011）。需求见 `spec.md`，技术方案见 `plan.md`。

## 任务清单

- [x] **T001**（FR-001）：core-rs 失败通知带 `noticeKind`——`emit_once_notice` 加
  `kind: Option<&str>` 参数，`llm_error_message` 调用点传 `Some("llmError")`（中断 /
  压缩排队传 `None`）；依赖：—；完成判据：`engine_tests.rs` 的
  `run_consumer_reports_turn_failures_as_system_messages` 扩断言载荷与
  `onceMessage` 均带 `noticeKind: 'llmError'`，`npm run test:core` 绿。
- [x] **T002**（FR-003）：core-rs 重试请求——`SessionState.pending_retry` 槽位、
  `QueuedBatch::Retry`、`take_queued_batch` 消费、`on_query_retry_requested`（守卫与
  启动分支照 plan）、`main.rs` `dispatch_ui_event` 分支、`fixtures/eventTypes.json`
  的 `uiEvents` 登记；依赖：T001；完成判据：`engine_tests.rs` 新增空闲重试（FakeLlm
  应答、jsonl 零新增）/ 忙碌丢弃 / 重试再败新 once 替换三用例 +
  `dispatch_ui_event_covers_every_ui_event_type` 绿，`npm run test:core` 绿。
  （空闲重试用例的判据口径：用户消息零新增、assistant 回复照常落盘。）
- [x] **T003**（FR-001、FR-003）：TS 契约——`AssistantEventBus.ts` 的
  `UiEvent` +`queryRetryRequested`；`shared/types.ts` 的 `MessageData`
  +`noticeKind?: 'llmError'`；`shared/history/Conversation.ts` 的 `onceMessage`
  类型同步；依赖：T002；完成判据：`npm run check-types` 绿。
- [x] **T004**（FR-003）：wire 与宿主翻译——`webviewMessages.ts`
  `WebviewToHostMessage` +`retryQuery`、`addMessage` 载荷 +`noticeKind?`、会话列表
  载荷 `onceMessage` 类型同步；`webviewMessageHandler.ts`
  `entry('retryQuery', ...)` → `emitUiEvent`（含 `noteSessionActivity`）；依赖：T003；
  完成判据：`npm run check-types && npm run lint` 绿。
- [x] **T005**（FR-002、FR-004）：webview 渲染——`webview/types.ts` `Message`
  +`noticeKind?`；`shared.ts` `toUiMessage` 与 `onceMessage` 恢复透传；
  `MessagesView.tsx` `SystemMessage` 渲染「重试」按钮（once + noticeKind 判定，点击
  postMessage `retryQuery` 并本地剥除 once 节点）；i18n zh / en `messagesView.retry`；
  依赖：T004；完成判据：`npm run check-types && npm run lint` 绿。
- [x] **T006**（FR-001、FR-002、FR-003、FR-004）：文档同步——events.md 2.1 载荷列 /
  2.3 新行、[webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)、user-stories 新增 US-73 + 索引与 e2e 表登记；
  依赖：T005；完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T007**（FR-002、FR-003、FR-004）：e2e——`messagePresentation.spec.ts` 新增
  重试按钮用例（渲染 / 点击上报 retryQuery / 本地剥除 / 无 noticeKind 无按钮）；
  依赖：T005；完成判据：`npm run test:e2e -- --project=webview` 绿（本机至少手动跑
  messagePresentation 一个文件）。
- [x] **T008**（FR-001、FR-002、FR-003、FR-004）：全量回归——`npm run
  build:core:host` 后 `npm run test:all`（含 docs-lint 与 standalone 真实二进制
  系列）；依赖：T006、T007；完成判据：`npm run test:all` 全绿。
