# 实施方案：用户选择请求的作废与收回

技术路线一句话：**让作废成为 Core 发出的一个带标识的事件，宿主只做转发与幂等收敛**。
Core 在等待 `userChoice` 期间持有「本次请求标识」，放弃等待（超时 / abort）时把同一标识
随作废事件发出；宿主按标识精确拒答那一条 pending、投递收框消息、`waiting` 归零。
webview 另有一条**不依赖 Core 事件**的收框路径：选择框携带发起它的 `toolUseId`，该工具的
`toolResult` 到达即收框。两条路径汇到同一个收框函数，因此界面行为只有一份实现。

需求见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 请求标识：Core 生成，随请求下发，随作废回传

标识由 Core 在 `waiting_request` 入口生成（`util::unique_id("choice")`），三个位置同源：

| 位置 | 形态 |
| --- | --- |
| `CoreRequest.userChoice` 载荷 | 新增必选字段 `choiceRequestId: string` |
| `CoreEvent.userChoiceCanceled` 载荷 | 必选字段 `choiceRequestId: string`（+ `sessionId`） |
| `UserChoiceOptions` | 新增必选字段 `choiceRequestId: string`，由 `UserBlockingRequest` 注入 |

否决了另外两种标识（见「被否决的替代方案」）：宿主 `choiceId` 是投递时刻的展示句柄，
webview 重建会重新生成，跨重建不成立；wire 帧 `id` 是总线内部路由号，不进事件载荷。

`UserBlockingRequest::user_choice` 因此要带标识：签名从「session + options」变成
「session + options + choiceRequestId」，标识由 `waiting_request` 生成后注入载荷，
同时保留在 `request_user_choice` 的作废路径上使用。

### 2. Core 的作废点：两个来源，都靠主动推送

现状 `waiting_request`（`core-rs/src/engine.rs`）用 `await_response` 等写死的 3600s，
超时返回 `None`，宿主不知情。

**来源一：用户回复超时（可配置）。** 在途请求等待「发起时刻取到的超时值」，到期就地发作废：

```
fn waiting_request(&self, request: UserBlockingRequest) -> Option<Value> {
    let (id, receiver) = self.send_request(request.payload)?;   // payload 已含 choiceRequestId
    let timeout = config::user_choice_timeout();                 // 发起时取一次，本请求沿用
    ... waiting = true; emit_runtime();
    let response = self.await_response_with(id, receiver, timeout);
    if response.is_none() {
        self.cancel_user_choice(&request, UserChoiceEnd::TimedOut);
    }
    ... waiting = false; emit_runtime();
    response
}
```

超时值在**发起时刻**取一次：之后用户改设置不影响在途请求（AC-16）。`config::
user_choice_timeout()` 与 `default_agent_mode` 同型——读快照、缺失回落默认值，
默认值唯一来源在 `src/shared/settingsSnapshot.ts`，Core 不自己声明常量。

`await_response_with(id, receiver, timeout)` 只是把现有 `await_response` 的
`Duration::from_secs(3_600)` 参数化，超时后仍 `bus.cancel_request(id)` 摘表。

**来源二：abort——用通道断开打断等待，不轮询。**

`mpsc::Receiver::recv_timeout` 在对应 `Sender` 被 drop 时**立即**返回
`Err(Disconnected)`，这是标准库既有语义，因此 abort 不需要周期检查：

1. 总线新增 `CoreBus::abort_pending(filter) -> Vec<u64>`：遍历 `pending`，把命中的条目
   **移除并 drop 其 `Sender`**，返回被中止的请求 id。drop sender 本身就是中断信号。
2. `pending` 的 value 从 `(String, Sender<Value>)` 扩成
   `(PendingRequest, Sender<Value>)`，`PendingRequest { request_type, session_id,
   choice_request_id }`——`session_id` 取请求载荷的 `sessionId` 字段（`userChoice` /
   `crossWorkspaceAgentRequested` 都有），`choice_request_id` 只对 `userChoice` 有值。
3. `abort_session_scope`（`core-rs/src/engine.rs`）在置 `cancel` 之外，对每个被中止的
   会话调一次 `bus.abort_pending(该会话在途的 userChoice)`。
4. 等待线程的 `recv_timeout` 随即返回 `Disconnected` → `await_response` 返回 `None`
   → 与来源一同一条 `cancel_user_choice`。**不需要分辨「超时还是 abort」**：两个来源的
   收敛动作完全相同，且都是 Core 主动推送。

`cancel_user_choice` 是唯一作废出口，并带上**结束原因**（`reason`），让 webview 与工具结果
能区分「超时」与「被中止」：

```
enum UserChoiceEnd { TimedOut, Aborted }

fn cancel_user_choice(&self, request: &UserBlockingRequest, reason: UserChoiceEnd) {
    self.emit(json!({
        "type": "userChoiceCanceled",
        "sessionId": request.session_id,
        "choiceRequestId": request.choice_request_id,
        "reason": reason.as_wire(),          // "timedOut" | "aborted"
    }));
}
```

原因不改变宿主的收敛动作（都是拒答 + 收框 + `waiting` 归零），只影响文案与工具结果：
超时让 `AskUserQuestion` 收尾成「等待用户回复超时」，abort 仍是既有的中止语义
（`*User Interrupted*` 由既有中止路径产出，本函数不重复发）。

超时一支保留现有的 `bus.cancel_request(id)`（从 `pending` 表摘除，避免无界增长）；
abort 一支的条目已由 `abort_pending` 摘除，不重复。

`send_request` 返回 `None`（总线未接线 / 写帧失败）不发作废事件：没有待答的宿主侧状态
可收敛，`waiting` 由随后的 `false` 归零即可。

### 2.1 权限确认与 `AskUserQuestion` 的不同收尾

`waiting_request` 只返回 `Option<Value>`，两者共用一个返回值，但超时后的收敛口径不同
（FR-006）：`AskUserQuestion` 失败即止，权限确认「拒绝但不终止本轮」。因此
`waiting_request` 的返回值外面需要一层原因，把「没等到」与「等到了拒绝」区分开：

```
enum UserChoiceFailure { TimedOut, Aborted, Unavailable }

fn waiting_request(&self, request: UserBlockingRequest) -> Result<Value, UserChoiceFailure>
```

- `ask` 分支（`request_user_choice`）：收到 `Err(TimedOut)` → `PermissionOutcome::Denied
  { terminate: false }`；`Err(Aborted)` → 保持现有的终止语义。
- `run_ask_user_question`：`Err(TimedOut)` → `ToolOutcome::Error("AskUserQuestion timed
  out waiting for the user's reply")`；`Err(Aborted)` → 现有失败文案保持。

`ToolContext.user_choice` 的类型从 `Fn(&Value) -> Option<Value>` 改为
`Fn(&Value) -> Result<Value, UserChoiceFailure>`：让「为什么没等到」由类型承载，而不是
靠调用点记不记得区分——与 `HostRenderRequest` / `UserBlockingRequest` 的既有做法一致。

### 3. 宿主侧：按标识收敛

`UserChoiceQueue`（`src/shared/UserChoiceQueue.ts`）的 `PendingChoiceEntry` 增加
`choiceRequestId` 字段，并新增：

```
cancel(choiceRequestId: string, reason: unknown): boolean
```

按标识找到条目（不是按 `sessionId`——同会话可能已有新请求）、删除并以 `reason` reject。
找不到返回 `false`（幂等，第二次为 no-op）。

`UserChoiceManager`（`src/host/ui/userChoice.ts`）新增：

```
cancelUserChoice(sessionId: string, choiceRequestId: string): void
```

三步且只做三步：`userChoiceQueue.cancel(...)` 拒答队列；遍历 `pendingUserChoices`
删掉 `choiceRequestId` 匹配的条目并对其 Promise 以「请求已作废」reject；投递 wire
`userChoiceCanceled` 让 webview 收框。`waiting` 由 Core 自己在作废后置 false 并
`emit_runtime()`，宿主侧不再补发 `userChoicePendingChanged`（避免第二个写入点）。

`showUserChoice` 生成的 `pendingUserChoices` 条目要带上 `choiceRequestId`，
`restoreUserChoiceIfPending` 重投时保持同一个（标识属于请求，不属于展示）。

### 4. webview 的收框与取消

wire 变更（`src/host/webviewMessages.ts`）：

- `requestUserChoice` 增加 `toolUseId: string | undefined` 与 `choiceRequestId: string`；
  `toolUseId` 为 `undefined` 时表示该请求不由某个工具发起（当前无此场景，留给权限确认
  的 pre-tool 阶段显式表达）。
- 新增下行 `userChoiceCanceled { sessionId, choiceRequestId, reason: 'coreCanceled' | 'userCanceled' }`。
- `respondUserChoice` 增加 `canceled: boolean`（用户点取消时 `canceled: true`，
  `index` / `answers` 缺省），宿主据此以「用户取消」reject 而非当作正常应答。

webview 两处改动：

- `toolHandlers.ts` 的 `handleToolRequestUserChoice` 把 `toolUseId` / `choiceRequestId`
  存进 `UserChoiceRequest`（`src/webview/types.ts`）；`updateToolStatus` 收到该
  `toolUseId` 的 success / fail 时，若当前 `userChoiceRequest.toolUseId` 与之相等，
  调 `setUserChoiceRequest(null)` 并清 `sessionStates` 里的同名字段。
- `useMessageHandler` 新增 `userChoiceCanceled` 分支，按 `choiceRequestId` 匹配当前选择框
  后收框。

取消入口：`UserChoiceOverlay` 与 `QuestionOverlay` 各加一个取消按钮 / Esc 键，
回调统一到 `useAppHandlers` 的 `handleUserChoiceCancel`：投递
`respondUserChoice { canceled: true, choiceId }`、清状态、恢复主输入框。

### 5. 配置：用户回复超时

字段 `llm.userChoiceTimeoutSeconds`（`settings.json`），默认值 **1800 秒**，唯一来源在
`src/shared/settingsSnapshot.ts` 的默认值区（与 `DEFAULT_AGENT_MODE` 同处），
Core 侧读快照、不声明常量：

| 层 | 落点 | 行为 |
| --- | --- | --- |
| 规范化 | `src/shared/settingsSnapshot.ts` | `SettingsSnapshot.llm.userChoiceTimeoutSeconds: number`；正整数才接受，非数值 / ≤ 0 / 缺失取默认值 1800 |
| 下发 | `CoreEvent.hostEnvironmentProvided.settings` | 随快照整份下发，无需新事件 |
| 读取 | `core-rs/src/settings.rs` 的 `SettingsSnapshot.llm`、`core-rs/src/config.rs` 的 `user_choice_timeout()` | 与 `default_web_search()` 同型；快照未就绪时回落默认值 |
| 消费 | `core-rs/src/engine.rs` 的 `waiting_request` | 发起时取一次，本请求沿用 |

不做设置面板控件（非目标）：本 spec 只要求该项可从 `settings.json` 配置并生效，
UI 编辑入口另行排期。这与「同一字段默认值只有一处」不冲突——默认值仍在
`settingsSnapshot.ts`。

### 6. 四个宿主

`CoreEvent.userChoiceCanceled` 进 `WebViewUI.buildCoreEventHandlers`（VS Code 与 Electron
共用）、PyCharm 的 `HostUi.onCoreEvent`、TUI 的 `host.rs` 分发。PyCharm 与 TUI 的
`UserChoiceManager` 各自补一个与 TS 同语义的取消方法（TUI 已有 `frame_id` 跟踪，
可复用其「按 frame 错误应答」的既有能力）。三处都要把该事件列入 docsLint 的
`onCoreEvents` 名单对照。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `CoreEvent.userChoiceCanceled { sessionId, choiceRequestId, reason }`；`CoreRequest.userChoice` 载荷加 `choiceRequestId` |
| `src/shared/settingsSnapshot.ts` | 修改 | `SettingsSnapshot.llm.userChoiceTimeoutSeconds` + 默认值（默认值唯一来源）；正整数规范化 |
| `src/shared/UserChoiceQueue.ts` | 修改 | `UserChoiceOptions` 加 `choiceRequestId`；`PendingChoiceEntry` 加字段；新增 `cancel(choiceRequestId, reason)` |
| `src/host/ui/userChoice.ts` | 修改 | 新增 `cancelUserChoice(sessionId, choiceRequestId)`；`pendingUserChoices` 条目带标识 |
| `src/host/ui/webviewMessageHandler.ts` | 修改 | `handleRespondUserChoice` 分取消 / 应答两支；登记 `userChoiceCanceled` 下行 |
| `src/host/webviewMessages.ts` | 修改 | `requestUserChoice` 加 `toolUseId` / `choiceRequestId`；新增 `userChoiceCanceled`；`respondUserChoice` 加 `canceled` |
| `src/host/WebViewUI.ts` | 修改 | `onCoreEvents` 映射表加 `userChoiceCanceled` |
| `src/webview/types.ts` | 修改 | `UserChoiceRequest` 加 `toolUseId?` / `choiceRequestId` |
| `src/webview/hooks/handlers/toolHandlers.ts` | 修改 | 存标识；`updateToolStatus` 触发收框 |
| `src/webview/hooks/useMessageHandler.ts` | 修改 | 新增 `userChoiceCanceled` 分支 |
| `src/webview/hooks/useAppHandlers.ts` | 修改 | 新增取消提交路径 |
| `src/webview/UserChoiceOverlay.tsx` / `QuestionOverlay.tsx` | 修改 | 取消按钮 + Esc |
| `src/webview/i18n/{zh,en}.ts` | 修改 | 取消按钮文案 |
| `core-rs/src/bus.rs` | 修改 | `pending` value 改 `PendingRequest` 结构（含 `session_id` / `choice_request_id`）；新增 `abort_pending(filter)`——移除并 drop sender 以打断等待 |
| `core-rs/src/engine.rs` | 修改 | `waiting_request` 生成标识、按 `config::user_choice_timeout()` 等待、统一走 `cancel_user_choice(reason)`，返回 `Result<Value, UserChoiceFailure>`；`abort_session_scope` 调 `abort_pending` 打断在途等待；`UserBlockingRequest` 带标识；`request_user_choice` 按原因收敛 |
| `core-rs/src/settings.rs` | 修改 | `SettingsSnapshot.llm.userChoiceTimeoutSeconds` 反序列化字段 |
| `core-rs/src/config.rs` | 修改 | 新增 `user_choice_timeout()`（与 `default_web_search()` 同型） |
| `core-rs/src/tools.rs` | 修改 | `UserChoiceFn` 改 `Result` 型；`run_ask_user_question` 区分超时与中止文案 |
| `pycharm-plugin/.../HostUi.kt` | 修改 | 分发 `userChoiceCanceled` |
| `pycharm-plugin/.../UserChoiceManager.kt` | 修改 | 按标识取消 |
| `tui-rs/src/host.rs` / `choices.rs` | 修改 | 分发 `userChoiceCanceled`；按 frame 取消 |
| `docs/architecture/events.md` | 修改 | 2.1 新行、2.2 载荷列、6 超时约定、聚合数字 |
| `docs/core/session-runtime.md` | 修改 | 第 1 节 `waiting` 解除来源 |
| `docs/features/ask-user-question.md` | 修改 | 边界表、FR-003 取消入口 |
| `docs/hosts/{webview-ui,pycharm-plugin,tui}.md` | 修改 | `onCoreEvents` 名单与宿主落地 |
| `docs/architecture/host-ui-modules.md` | 修改 | UserChoiceManager 新方法 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：作废事件在 `src/shared/AssistantEventBus.ts` 定义，
      Core 只发数据；`src/host/ui/userChoice.ts` 不 import 宿主 API，收框经注入的
      `postToWebview`。不做 `host.kind` 嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：无 fallback——宿主不自行计时、不推测作废；
      也**不做轮询**：abort 靠 drop sender 让 `recv_timeout` 立即返回 `Disconnected`，
      是中断而不是周期检查；
      `CoreRequest.userChoice` 与 `CoreEvent.userChoiceCanceled` 的新字段全必选（`choiceRequestId`
      / `reason`）；
      「这次请求是否已作废」的唯一写入点是 Core，宿主只按标识收敛；
      `waiting` 的写入点仍是 Core（作废后自行置 false），宿主不补发
      `userChoicePendingChanged` 以免双记账；
      **默认值单源**：回复超时的默认值只在 `src/shared/settingsSnapshot.ts` 声明，Core 经
      `config::user_choice_timeout()` 读快照，不复制常量。
- [x] Core 行为同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：改动落在 `core-rs/`，同步
      `core-rs/src/engine_tests.rs`（作废事件发送、abort 打断等待、标识注入三组用例）与
      `core-rs/src/bus_tests.rs`（`abort_pending` 的移除 + sender drop 语义）；
      不涉及落盘格式（`history.rs` / `session_meta` 无变化），因此无对照表义务。
      但**有 TUI 侧 parity 义务**：`tui-rs` 的 `UserChoiceManager` 与 TS 同语义，
      改动须两侧同步并用 `tui-rs` 内联单测覆盖。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按「影响基线」表逐项同步，`docs-lint` 必须绿；
      新事件要过 2.1 触发点列与 `onCoreEvents` 名单对照。

## 被否决的替代方案

1. **用宿主 `choiceId` 作标识**：`choiceId` 在投递时刻生成（`src/host/ui/userChoice.ts`
   的 `showUserChoice`），webview 重建后 `restoreUserChoiceIfPending` 会重新生成——同一
   请求在作废宣告到达时可能已换过 id。否决。
2. **用 CoreRequest 的 wire 帧 id**：总线内部路由号，不进 `CoreEvent` 载荷；且
   `handleCoreRequest(id, request)` 没有把它交给 handler，要暴露就得改总线契约的面。
   否决。
3. **宿主侧超时清扫（兜底）**：与「不过度 fallback」铁律直接冲突，且超时上限是 Core 的
   实现细节（且已按 FR-006 可配置），宿主复制一份必然漂移。否决。
4. **只做 webview 收框（FR-003），不做作废宣告**：工具 `toolResult` 到达确实能收框，
   但队列 pending 仍挂着、`onSessionLoaded` 仍会重投、`waiting` 仍要等下一次应答才归零。
   治标不治本。否决。
5. **作废时复用 `userChoicePendingChanged(false)`**：语义是「选择框是否在等待」，无法
   携带标识，会误清同会话随后新发的请求。否决。
6. **走 `UiEvent` 让宿主回报、Core 再收敛**：方向相反（UI → core），本就是 Core 发起
   的事件，多绕一跳。否决。
7. **切片轮询会话 `cancel` 标记（即复用 `cancellable_request` 的 50ms 骨架）**：能工作，
   但它是「定期去问」而不是「作废时打断」——abort 到收框之间最多多出一个切片的延迟，
   且每 50ms 唤醒一次等待线程，长等待（超时可配置，可能等很久）白白耗 CPU。
   `mpsc` 的 sender drop 本就能立即唤醒接收方，用既有语义即可，不需要自己造轮询。
   否决。`cancellable_request`（Transfer）保持现状，本次不顺手改它——它有自己的取消语义
   与既有测试，混进这次改动会扩大回归面。
