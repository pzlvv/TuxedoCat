# 实施方案：LLM 失败 once 通知的一键重试按钮

技术路线：失败 once 通知的载荷带 `noticeKind: 'llmError'`（随 `meta.json` 的
`onceMessage` 落盘），webview 的 `SystemMessage` 据此渲染「重试」按钮；点击经新 wire
消息 `retryQuery` → 新 `UiEvent.queryRetryRequested` 进 core，core 给会话登记一个
「重试批次」槽位并拉起既有消费循环，消费循环以 `run_turn(None)`（既有 Reminder 无用户
消息同款形态）重跑一轮——重试动作本身不产生任何输入消息（不追加用户消息、reminder、
Skill 注入），本轮产出的 assistant 回复照常落盘。全部展示与收尾信号
（queryBegin / queryEnd / busy / 流式 / 中止 / 失败 once）走既有管线。需求见同目录
`spec.md`。

## 技术方案

### 数据流

```
core engine.rs
  run_turn 失败 → emit_once_notice(..., kind = Some("llmError"))
    → meta.json onceMessage = { role:'system', content, noticeKind:'llmError' }（整份 JSON 落盘）
    → CoreEvent.message data（+ once:true）
  → 宿主 WebViewUI.onMessage（`...data` 透传，零映射改动）→ wire addMessage
  → webview toUiMessage（shared.ts 透传）→ Message.noticeKind
  → SystemMessage：once && noticeKind==='llmError' → 渲染「重试」按钮
  → 点击 → postMessage retryQuery → WebviewMessageHandler.entry('retryQuery')
  → UiEvent.queryRetryRequested → main.rs dispatch_ui_event 分支
  → Core::on_query_retry_requested：守卫 → pending_retry 槽位 + running=true + spawn
  → run_consumer 消费循环 take_queued_batch 弹出 QueuedBatch::Retry
  → run_turn(None, None, None)（既有「Reminder 轮次没有用户消息，只跑查询」形态）
  → 失败：emit_once_notice（带 kind）替换旧通知；成功：流式节点追加（stripOnce 剥除）
```

### 关键形态

- **`MessageData.noticeKind`**（`src/shared/types.ts`）：可选成员袋成员
  `noticeKind?: 'llmError'`，与 `once` 同模式；wire `addMessage` 载荷
  （`src/host/webviewMessages.ts`）与 webview `Message`（`src/webview/types.ts`）同步。
- **`UiEvent.queryRetryRequested`**（`src/shared/AssistantEventBus.ts`）：
  `{ type: 'queryRetryRequested'; sessionId: string }`——单向事件，无结果回传（与
  `compactRequested` 同形态）。
- **重试批次**（`core-rs/src/engine.rs`）：`SessionState` 增加 `pending_retry: bool`
  槽位（与 `pending_user_message` 同型的「槽」而非队列，`take_queued_batch` 消费）；
  `QueuedBatch::Retry` 变体 → `run_turn(&core, &session_id, &state, None, None, None)`。
  重试只在空闲时受理，槽位不可能与真实批次并存，消费优先级无歧义。
- **`emit_once_notice` 加 kind 参数**：`kind: Option<&str>`，写入消息 JSON 顶层
  （`save_once_message` 落的就是这份 JSON，meta 恢复天然带回）；LLM 失败调用点传
  `Some("llmError")`，中断 / 压缩排队调用点传 `None`。
- **重试守卫**（`on_query_retry_requested`，与 `on_user_message` 同口径）：
  spin 模式丢弃；子代理已收尾（`sub_agent_reply_called || sub_agent_driver_done`）丢弃；
  `running || compacting` 丢弃并记日志（幂等兜竞态，与 `bashBackgroundRequested`
  无匹配时同口径）。通过后 `ensure_loaded` + `pending_retry = true` + `running = true` +
  `cancel` / `silent_abort` / `pause_loop` 复位（与 `on_user_message` 启动分支逐字段
  对齐）+ `emit_runtime()` + spawn `run_consumer`。
- **i18n**：`src/webview/i18n/zh.ts` / `en.ts` 增加 `messagesView.retry`（重试 / Retry）。

### 测试方案

- **core-rs**（`engine_tests.rs`，EngineHarness + Sandbox + FakeLlm 口径）：
  - 既有 `run_consumer_reports_turn_failures_as_system_messages` 扩断言：载荷与
    `meta.json` 的 `onceMessage` 均带 `noticeKind: 'llmError'`。
  - 新增空闲重试用例（FakeLlm 可成功应答）：`on_query_retry_requested` → `queryBegin`
    到 `queryEnd`、LLM 收到请求、用户消息零新增（assistant 回复照常落盘）、
    `running` 归 false。
  - 新增忙碌丢弃用例：`running = true` 时请求 → 队列不被消费、无事件、`running` 不变。
  - 新增重试再败用例（LLM 不可达）：新 once 替换旧通知（`onceMessage` 覆盖）。
- **TS 单测**：`src/test/docsLint.test.ts` 自动对照（事件表载荷列 / UiEvent 名单 / 
  eventTypes 契合）；`core-rs/fixtures/eventTypes.json` 的 `uiEvents` 登记
  `queryRetryRequested`（main_tests 的双向锁定会红着催）。
- **e2e**（`e2e/webview/messagePresentation.spec.ts`，fakeHost 口径，与既有 once 用例
  同文件）：`addMessage { role:'system', once:true, noticeKind:'llmError' }` → 按钮可见
  → 点击 → `host.waitForSent('retryQuery')` + once 节点消失；不带 `noticeKind` 的 once
  无按钮。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/engine.rs` | `llm_error_message` 调用点带 kind；`emit_once_notice` 加参数；`SessionState.pending_retry`；`QueuedBatch::Retry`；`take_queued_batch` 消费；新增 `on_query_retry_requested` | `message` 事件载荷 +`noticeKind`；新 UiEvent `queryRetryRequested` |
| `core-rs/src/main.rs` | `dispatch_ui_event` 增加 `queryRetryRequested` 分支 | 同上（词汇表分支） |
| `core-rs/fixtures/eventTypes.json` | `uiEvents` 登记 `queryRetryRequested` | 词汇表双向锁定 fixture |
| `src/shared/AssistantEventBus.ts` | `UiEvent` 联合新增成员 | 新 UiEvent 成员 |
| `src/shared/types.ts` | `MessageData` +`noticeKind` | `message` 事件载荷列 |
| `src/shared/history/Conversation.ts` | `onceMessage` 类型 +`noticeKind?` | meta.json 落盘格式（宿主侧类型，Rust 侧整份 JSON 透传） |
| `src/host/webviewMessages.ts` | `WebviewToHostMessage` +`retryQuery`；`addMessage` 载荷 +`noticeKind?`；会话列表载荷的 `onceMessage` 类型同步 | wire 消息 +1 |
| `src/host/ui/webviewMessageHandler.ts` | `entry('retryQuery', ...)` → `emitUiEvent`（`noteSessionActivity` 照 `sendMessage` 口径） | 翻译表 +1 |
| `src/webview/types.ts` | `Message` +`noticeKind?` | webview 视图模型 |
| `src/webview/hooks/handlers/shared.ts` | `toUiMessage` 与 `onceMessage` 恢复两处透传 `noticeKind` | 无（视图模型透传） |
| `src/webview/MessagesView.tsx` | `SystemMessage` 渲染重试按钮（once + noticeKind 判定） | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | `messagesView.retry` | 用户可见文案 |
| `docs/architecture/events.md` | 2.1 `message` 载荷列补 `noticeKind`；2.3 新增 `queryRetryRequested` 行 | 文档同步 |
| `docs/hosts/webview-ui.md` | [第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)「一次性通知」行补重试按钮渲染规则 | 文档同步 |
| `docs/features/user-stories/dialog-core.md` + `docs/features/user-stories.md` | 新增 US-73 + 索引 / e2e 用例表登记 | 需求基线 |
| `e2e/webview/messagePresentation.spec.ts` | 重试按钮用例 | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动集中在 core-rs、`src/shared/`、`src/host/`、
      `src/webview/` 各自边界内——core 不知 UI 表现（按钮），webview 不持事实默认值；
      wire 与 UiEvent 翻译收在 `WebviewMessageHandler`，无宿主 API import、无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback（忙碌丢弃有注释理由且是设计允许
      的竞态兜底）；`noticeKind` 走 `MessageData` 既有可选成员袋（该类型不在可选成员
      冻结范围，联合本体零改动，specs/014 同款先例）；失败通知事实单点写入
      （`emit_once_notice`），按钮只是只读投影；无新默认值。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：`onceMessage` 落的是整份消息
      JSON，Rust 侧无结构化读取（原样透传），宿主侧 `src/shared/history/Conversation.ts`
      类型同步并补注释；重试行为改动在 `core-rs/src/engine.rs` + `engine_tests.rs` 同步
      锁定；`npm run test:core` + `npm run build:core:host` 后跑 standalone 系列。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：events.md（2.1 载荷列 / 2.3 新行）、
      [webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)、user-stories（US-73 + 索引 + e2e 表）随实施同一提交更新，
      `npm run test:unit -- docs-lint` 必须绿。

## 被否决的替代方案

- **重试走既有 `sendMessage` 重发上一条用户消息**：用户消息已落盘，重发产生重复节点与
  重复上下文，还会触发命令解析 / Skill 注入等与「重试」无关的路径。否决，新 UiEvent
  直达「重跑本轮」语义。
- **新增 `CoreRequest`（请求-响应）承载重试**：重试是长耗时动作，结果经既有事件流回达
  （queryBegin / 流式 / 失败 once），即时响应没有信息量；`compactRequested` /
  `abortRequested` 均为单向事件。否决。
- **webview 按内容前缀（`❌ **LLM API Error**`）识别可重试通知**：文案是 core 的展示
  细节，内容匹配把契约建立在文案上，改文案即静默失灵。否决，载荷显式带
  `noticeKind`。
- **core 在重试受理时主动发「剥除通知」事件**：剥除是视图表现（铁律 3），once 本就是
  视图态（specs/014「多视图各自维护」）；core 发事件还要给 wire / 处理表加成员，只为
  一件 webview 本地一行代码能做的事。否决，点击本地剥除。
- **`pending_retry` 换成往队列塞一个空批次**：`take_queued_batch` 的批次都携带落盘
  语义（reminder / auto / user message），空批次要为它绕过三处 persist 分支；槽位 +
  `Retry` 变体把「无消息轮次」收敛到 `run_turn(None)` 的既有形态。否决塞队列。
