---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：会话运行时状态（Core 进程）

本文描述 `CoreEvent.sessionRuntimeChanged` 的生产者——Core 进程内的会话运行时状态表
（`core-rs/src/engine.rs` 的 `SessionState` 与 `emit_runtime`），它是会话运行时状态的
**唯一 owner**（as-built）。事件词汇表见
[events.md](../architecture/events.md)，架构原则见
[principles.md](../architecture/principles.md)。

`sessionRuntimeChanged` 是跨层最常用的一条流（Electron 侧栏流水灯、系统托盘状态点、
webview 对话树的运行标记、两端 abort 按钮）。

## 1. 来源与调用点

Core 的各模块在自己的事实变化点更新该会话的 `SessionState`（`emit_runtime` 内部按快照
diff，无变化不发事件）。内部按来源分列（多个来源会重叠，共用一个布尔位会互相清掉），
对外同时暴露根事实与由根事实合并出的 `idle`：

| 来源 | 事实 | 写入点 |
| --- | --- | --- |
| `queryRunning` | 会话自身有活跃查询 / 引擎在消费 | 消费循环（`run_consumer` / `run_query_loop`）的进入与收尾、子代理轮次 |
| `compacting` | 正在压缩上下文（会整体替换消息数组） | `compact.rs` 的 `mark_compacting` / `unmark_compacting`（`compact_conversation` 的进出） |
| `pendingCompact` | 手动压缩已登记、等待当前轮次结束、队列排空时执行（排队不是正在执行的工作，不参与 `idle`） | `Core::request_compact` 的 `mark_pending_compact`；`run_consumer` 队列排空时消费、中止 / `Core::drop_session` 清理时 `unmark_pending_compact` |
| `backgroundRunning` | 有运行中的后台 Bash 任务 | `bash_task.rs` 的任务注册 / 结束 / 中止（按剩余任务数同步） |
| `subAgentRunning` | 该会话已注册子代理（idle 递归看子代理当前是否非 idle，本标志只作变更信号；跨工作区子代理在 `crossWorkspaceAgentCompleted` 前恒算非 idle） | `subagent.rs` 的 `register` / `unregister` / `register_remote` / `unregister_remote` |
| `waiting` | 正在等待用户操作 | `Core::on_user_choice_pending`（宿主上报）；`waiting_request` 入队时提前标记 |

会话关闭 / 删除时 `Core::drop_session` 清理该会话的状态、注销它作为子代理的注册表
条目（只注销自身、不级联到存活的子孙），并清掉进程级待压缩注册表。

`waiting` 只表示**真的在等用户**：`waiting_request`（`request_user_choice`）的入队与
`userChoicePendingChanged`（webview 弹出 / 应答）。`CoreRequest.toolPermissionRequested`
的往返（上架工具卡片、回传权限结果）**不算**——宿主拿到 `permResult` 就返回，`ask` 也
直接返回（真确认框随后由 `userChoice` 弹），那段时间并没有在等用户；该往返由
`Engine::plain_request` 承担，只有 `waiting_request` 走标记 `waiting` 的路径。两个入口的
载荷类型不同：`plain_request` 只收 `HostRenderRequest`，`waiting_request` 只收
`UserBlockingRequest`（只能由 `user_choice` 构造），因此渲染往返在类型上就拿不到标记
`waiting` 的入口——「这次请求算不算在等用户」由载荷类型承载，不靠发起点记不记得换入口。

## 2. 对外快照

| 字段 | 取值 |
| --- | --- |
| `sessionId` | 会话 ID |
| `idle` | 派生字段：自身 `query` / `waiting` / `compacting` / `background` 全为假，且所有已登记子代理都空闲（`pendingCompact` 不参与） |
| `waiting` | `waiting` 来源（正在等待用户操作，流水灯显示黄色） |
| `queryRunning` | `query` 来源（前台查询 / 引擎在消费） |
| `compacting` | `compacting` 来源（正在压缩上下文） |
| `pendingCompact` | `pendingCompact` 来源（手动压缩已登记、等待当前轮次结束后执行；不参与 `idle`） |
| `backgroundRunning` | `background` 来源（有运行中的后台 Bash 任务） |
| `backgroundTasks` | 运行中的后台 Bash 任务清单（specs/019），按注册序逐项 `taskId` / `description` / `command`；空集为 `[]`。与 `backgroundRunning` 同源（同一注册表、同一次 `emit_runtime` 产出），abort 按钮黄色态的悬停明细据此列出任务（[docs/features/abort-button.md](../features/abort-button.md)） |
| `subAgentRunning` | 派生字段：存在非 idle 的已登记子代理（递归到子代理自身的查询 / 压缩 / 后台任务 / 下层子代理）；跨工作区子代理没有本地会话状态，登记期间恒算非 idle，结束事件到达后注销 |
| `subAgentDescription` | 子代理会话为创建时 Agent 工具调用的 description（specs/019）；普通会话与恢复路径取不到时为 `null`，UI 显示回退文案。悬停明细据此列出子代理 |
| `parentSessionId` | 父会话 ID（**本地**子代理会话才有；普通会话与跨工作区对话为 `null`）。登记于子代理创建时，随会话存续，不随注册表注销消失。它是**树事实**（本地嵌套在哪）；「谁创建的」归属语义读 `creator`，不得从本字段反推（specs/025 FR-002） |
| `creator` | 会话创建者（specs/025 FR-002）：`user` = 用户 prompt 发起；agent 形态携带创建方工作区身份（本地创建为 `null`）与创建方会话 id。完成提醒 / 未读绿灯的抑制、输入禁用、`Reply` 回传路由与跨工作区跳转都以此为判据（specs/025 FR-003 / FR-004 / FR-007） |

`idle === false`（会话非空闲）当且仅当 `queryRunning` / `waiting` / `compacting` /
`backgroundRunning` / `subAgentRunning` 任一为真；即 `idle` 是其余字段的合取，消费者
按需读根字段自行推导表现（abort 按钮三态见 [docs/features/abort-button.md](../features/abort-button.md)，
推导原则见 [principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。
`pendingCompact` 不在这个合取里：排队不是正在执行的工作，会话空闲时它也可以为真。

明细成员（`backgroundTasks` / `subAgentDescription`）与布尔位同源同发，并参与快照
diff：清单增减、子代理 description 出现即使布尔位不变也触发推送——abort 悬停明细
（specs/019）据此保持与注册表一致。

对外快照里每个会话都递归计算派生值（`is_idle_deep`），因此子代理的 `query` / `waiting` /
`compacting` / `background` 变化会连带刷新其创建者的 `idle` / `subAgentRunning`。

spin 模式下父会话的消费循环被 SpinLoop 占用：`queryRunning` 为真，但跑的**不是** query
engine。按钮表现按工作模式归入黄色档（`workMode` 单独注入推导，见
[docs/features/abort-button.md](../features/abort-button.md) FR-001）。

`backgroundRunning` 来源还驱动后台任务的两类提醒：查询结束时的兜底提醒（`engine.rs`
消费循环收尾的 `background_reminder`；距上次访问满 3min，或命令含 `sleep` 且还没兜底过
才投递；由 reminder 拉起的那一轮收尾直接跳过）与周期性进度提醒（`engine.rs` 的
`tick_background_reminders` 调度线程）。周期提醒只在该会话 `queryRunning` / `compacting`
均为假（abort 按钮为黄）时推进每个运行中任务的时钟——只看引擎状态，不看查询由什么
触发——按 5 / 10 / 20 / 30min（此后 30min）向 LLM 投递 reminder，投递时刷新该任务的
「上次访问时刻」（规格见 [docs/features/background-bash.md](../features/background-bash.md)）。

## 3. 分发与读取

- 运行时事实的 owner 是 Core 进程；宿主进程内**没有**引擎 / 后台任务 / 子代理登记表，
  一律消费 Core 推送的快照。宿主侧 `src/shared/sessionRuntime.ts` 只剩单一派生
  `sessionBusyLevel`（`waiting` > `running` > `idle`），流水灯、托盘状态点与关闭前的
  二次确认都消费这一个函数。
- 分发有**推**和**拉**两条：推是常态（变化时经 `CoreEvent.sessionRuntimeChanged` 全量推给
  已存在的视图）；视图创建 / 激活时可能错过推送（当时视图还不存在），因此 webview 启动、
  或对话列表渲染方切到 `webview`（Electron 悬浮窗：视图此前可能长期不是活动视图）时发
  `requestSessionRuntimeStates` 主动拉一次快照——`WebviewMessageHandler.pushSessionRuntimeStates`
  读 `ConversationManager.getSessionStatesSnapshot()`（最近一次推送的缓存）并按**来源视图**
  回包（多视图宿主下请求方不一定是活动视图）。否则新视图的对话树流水灯 / abort 按钮 /
  历史提醒会"失明"到下一次状态变化。
- **「会话是否忙」的宿主侧判定入口是这份快照缓存**：VS Code 空闲回收（`isBusy`）、
  Electron 托盘与关闭确认都读 `getSessionStatesSnapshot()` 里该会话的 `idle`，不在宿主
  进程内重建状态表。

## 4. 与 SessionUiState 的分工（避免双记账漂移）

- Core 进程的运行时状态表是**唯一事实 owner**，`SessionRuntimeState` 进 `CoreEvent`，
  是跨层的公共词汇。
- `SessionUiState`（host 侧）是**渲染投影**：webview 每会话的 thinking / text / tool
  渲染阶段（`getActivityPhase`）只有 UI 能算（它看到消息流）。**对话树流水灯与 abort 按钮
  都不属于它**——那是 Core 的运行时事实，webview 只读宿主推来的
  `sessionRuntimeStates`（[contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)）。
- **禁止从 `SessionUiState` 反推 `SessionRuntimeState`**：两者数据源不同
  （一个看 wire 消息，一个看 Core 进程内状态），互为对账可以，互相写值不行。
  `WebViewUI.onSessionRuntimeChanged` 只读（转发给 `ConversationManager.updateSessionStates`），
  不写回。
