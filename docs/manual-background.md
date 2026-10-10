# 规格：手工转后台

本规格界定 Bash 卡片「转后台」按钮：用户把**正在前台运行**的命令转入后台继续执行时，
工具结果如何进入上下文、本轮 agent 循环如何暂停、暂停后由谁接续。范围只覆盖
「按钮 → 转换 → 暂停 → 接续」这条链路；后台任务的注册 / 完成通知 / 中止，以及提醒的
调度与文案不在本规格内（见 `DEVELOPMENT.md 第 4.5 节（sessionRuntimeChanged 的生产者：sessionRuntime）`
与 `docs/background-reminder.md`）。

相关规格与章节：

- `DEVELOPMENT.md 第 4.3 节（UiEvent（UI → core，单向））`
- `DEVELOPMENT.md 第 12.6 节（core 描述事实，UI 决定表现）`
- `DEVELOPMENT.md 第 12.7 节（一份事实只有一个写入点）`
- `DEVELOPMENT.md 第 13.3.18 节（子代理、后台 Bash 与其余已迁入能力）`
- `docs/background-reminder.md`（兜底提醒与周期性提醒）
- `docs/abort-button.md`（转换后按钮转黄）
- `docs/user-message-pipeline.md` 第 4 节（引擎消费循环）
- `docs/user-stories.md` 的 US-45

## 1. 能力

### 1.1 入口

Bash 卡片在 `status === 'running'`（前台执行中）时，于「复制命令」按钮**左侧**渲染
「转后台」按钮（时钟图标，`title` 取 i18n 的 `tool.bash.moveBackground`）。卡片进入任何
完成态后按钮消失——执行状态是卡片自己的事实，按钮只是它的投影。

点击后 webview 发 `backgroundBashTool` 消息（`sessionId` + `toolUseId`），宿主翻译为
`UiEvent.bashBackgroundRequested`（`DEVELOPMENT.md 第 4.3 节`）。重复点击不产生额外效果。

### 1.2 转换

core 按 `toolUseId` 查「前台执行注册表」（`tools/bash/ManualBackground.ts` 的
`requestManualBackground`）：

- 命中 → 触发该次前台执行的转换，与自动转后台（前台超时 / 通知驱动）走同一条
  `autoBackgroundCommand` 路径：子进程 detach、输出改由 file mode 继续收集、任务以
  `bg-auto-` 前缀注册；
- 未命中（命令已收尾 / 从未登记）→ 什么都不做。按钮与实际状态之间的竞态由注册表兜住，
  调用方不补兜底（`DEVELOPMENT.md 第 12.1 节`）。

转换的结果**照常作为 tool_result 进入上下文**：状态成功、`assistantAutoBackgrounded`
为真、`backgroundTaskId` 为 `bg-auto-*`，输出文案为「Command moved to the background
after <已运行时长> (task ID: …) …」（`tools/bash/Result.ts`）。转换失败（打不开输出文件等）
不置暂停标记，按前台结果收尾。

注册表生命周期归 `Exec.execForeground`：spawn 后登记触发器，全部收尾路径（完成 / 中止 /
已转后台 / 出错）注销。

### 1.3 循环暂停

转换成功时回写引擎的循环暂停标记（Embedded `QueryEngine.requestLoopPause` / Standalone
`SessionState.pause_loop`）。消费出口在查询循环的工具批收尾、下一轮 LLM 请求发起之前：
本批工具结果已进上下文，但**不再发起下一轮 LLM 请求**（`aiEnd` 已发）。消费循环随后按
队列状态收尾：

- 队列为空 → 结束本次消费，会话回到「等待用户输入」；abort 按钮因仍有后台任务而为黄
  （`docs/abort-button.md` 第 1.1 节）；
- 队列有消息（用户消息 / 后台任务完成通知 / reminder）→ 由既有入队路径立刻拉起新一轮，
  性质与用户触发的查询一致——**接续由队列消息触发，与转后台结果无关**。

暂停标记一次性（取走即清除）。新用户消息（`submitMessage` / `submit_message`）与中止
（`abortForegroundQuery` / `abort_foreground`）都清掉残留标记——暂停只对「当时那轮查询」
有意义。

### 1.4 与兜底提醒的边界

触发暂停的后台任务在转换成功时才注册，距上次访问不足最小间隔，因此查询收尾的兜底提醒
（`docs/background-reminder.md` 第 1.0 节）不会为它补一条 reminder 并拉起新查询——否则
转后台结果自己就触发了接续循环，违背 1.3 的暂停语义。周期性提醒不受影响。

## 2. 实现

| 环节 | Embedded（TS） | Standalone（Rust） |
| --- | --- | --- |
| 按钮 | `src/webview/tools/Bash.tsx` | 同左（webview 两宿主共用） |
| 协议消息 | `backgroundBashTool`（`src/host/webviewMessages.ts`） | 同左 |
| UiEvent | `bashBackgroundRequested`（`src/core/AssistantEventBus.ts`） | 同左 |
| core 订阅 | `initializeCoreEvents.ts` → `QueryEngine.requestBashBackground` | `main.rs` 的 `dispatch_ui_event` → `Core::on_bash_background_requested` |
| 注册表 | `tools/bash/ManualBackground.ts`（`toolUseId → 触发器`） | `tools.rs` 的 `MANUAL_BG`（`tool_use_id → 请求标记`） |
| 暂停信号 | `QueryEngine.loopPauseRequested` + `requestLoopPause` / `consumeLoopPauseRequest` | `tools::LoopPauseSignal`（`paused`）挂在 `SessionState.pause_loop` |
| 消费点 | `src/core/Query.ts` 的 `queryLoop`（工具批收尾、下一轮请求前） | `core-rs/src/engine.rs` 的 `run_query_loop`（同一位置） |

两侧实现按同一份契约对齐：事件名、暂停语义、兜底提醒门槛的生效时机一致，差异只在
注册表的载体（闭包 / 请求标记）。

## 3. 测试

- 注册表与暂停标记：`src/test/manualBackground.test.ts`；Standalone 对应
  `core-rs/src/tools_tests.rs::bash_manual_background_converts_and_requests_loop_pause`。
- 消费循环语义（暂停 + 队列接续）：
  `core-rs/src/engine_tests.rs::manual_background_pauses_the_loop_until_a_queued_message_arrives`。
- 事件词汇表对等：`src/test/fixtures/eventTypesParity.json` +
  `src/test/eventTypeParity.test.ts`（两侧同名 `bashBackgroundRequested`）。
- webview UI 级 e2e：`e2e/webview/bashBackgroundButton.spec.ts`（按钮位置 / 点击上报 /
  完成后隐藏）。
- 整应用 e2e：`e2e/electron/backgroundBash.spec.ts`（真实 Standalone Core + mock LLM：
  暂停后新用户消息接续、转后台前已排队的用户消息在暂停点接续、后台完成通知接续）。
