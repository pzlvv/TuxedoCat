---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：sessionRuntime（会话运行时状态）

本文描述 `CoreEvent.sessionRuntimeChanged` 的生产者 `src/core/sessionRuntime.ts`——会话
运行时状态的**唯一 owner**（as-built）。事件词汇表见
[events.md](../architecture/events.md)，架构原则见
[principles.md](../architecture/principles.md)。

`sessionRuntimeChanged` 是跨层最常用的一条流（Electron 侧栏流水灯、系统托盘状态点、
webview 对话树的运行标记、两端 abort 按钮）。

## 1. 来源与调用点

各 core 模块在自己的事实变化点调用（幂等，内部 diff 后才发事件，无变化不发）。
内部按来源分列（多个来源会重叠，共用一个布尔位会互相清掉），对外同时暴露根事实与由根事实
合并出的 `idle`：

| 函数 | 来源 | 事实 | 调用点 |
| --- | --- | --- | --- |
| `markQueryRunning(sessionId, running)` | `query` | 会话自身有活跃查询 / 引擎在消费 | `QueryEngine`（queryBegin / queryEnd、beginConsumer、submitMessage 消费恢复） |
| `markSessionCompacting(sessionId, compacting)` | `compacting` | 正在压缩上下文（会整体替换消息数组） | `compact/compact.ts`（`compactConversation` 的进出） |
| `markSessionBackground(sessionId, background)` | `background` | 有运行中的后台 Bash 任务 | `tools/bash/LocalShellTask`（注册 / 结束 / 中止后按剩余任务数同步） |
| `markSessionSubAgent(sessionId, subagent)` | `subagent` | 该会话已注册子代理（idle 递归看子代理当前是否非 idle，本标志只作变更信号） | `tools/agent/SubAgentRegistry`（register / unregister） |
| `markSessionWaiting(sessionId, waiting)` | `waiting` | 正在等待用户操作 | `Integration`（入队时标记）；`initializeCoreEvents` 的 `userChoicePendingChanged` 订阅（webview 弹出 / 应答时标记） |
| `dropSessionRuntime(sessionId)` | — | 会话关闭 / 删除时清理该会话的状态 | `sessionResources.releaseSessionResources`、`history.deleteConversation` |

## 2. 对外快照

| 字段 | 取值 |
| --- | --- |
| `sessionId` | 会话 ID |
| `idle` | 派生字段：自身 `query` / `waiting` / `compacting` / `background` 全为假，且所有已登记子代理都空闲 |
| `waiting` | `waiting` 来源（正在等待用户操作，流水灯显示黄色） |
| `queryRunning` | `query` 来源（前台查询 / 引擎在消费） |
| `compacting` | `compacting` 来源（正在压缩上下文） |
| `backgroundRunning` | `background` 来源（有运行中的后台 Bash 任务） |
| `subAgentRunning` | 派生字段：存在非 idle 的已登记子代理（递归到子代理自身的查询 / 压缩 / 后台任务 / 下层子代理） |
| `parentSessionId` | 父会话 ID（子代理会话才有；普通会话为 `null`）。登记于子代理创建时，随会话存续，不随注册表注销消失——消费者据此区分「子对话完成」与「主对话完成」（如托盘完成提醒只对后者闪烁） |

`idle === false`（会话非空闲）当且仅当 `queryRunning` / `waiting` / `compacting` /
`backgroundRunning` / `subAgentRunning` 任一为真；即 `idle` 是其余字段的合取，消费者
按需读根字段自行推导表现（abort 按钮三态见 [docs/features/abort-button.md](../features/abort-button.md)，
推导原则见 [principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。

对外快照里每个会话都递归计算派生值，因此子代理的 `query` / `waiting` / `compacting` / `background`
变化会连带刷新其创建者的 `idle` / `subAgentRunning`。

`background` 来源还驱动后台任务的两类提醒：查询结束时的兜底提醒（`QueryEngine` /
`engine.rs` 的消费循环收尾；距上次访问满 3min，或命令含 `sleep` 且还没兜底过才投递；由 reminder
拉起的那一轮收尾直接跳过）与周期性进度提醒（`tools/bash/BackgroundReminder`，Standalone 为
`engine.rs` 的调度线程）。周期提醒只在该会话 `queryRunning` / `compacting` 均为假（abort 按钮为黄）时
推进每个运行中任务的时钟——只看引擎状态，不看查询由什么触发——按 5 / 10 / 20 / 30min
（此后 30min）向 LLM 投递 reminder，投递时刷新该任务的「上次访问时刻」
（规格见 [docs/features/background-bash.md](../features/background-bash.md)）。

## 3. 分发与读取

- `waiting` 的取值由 `markSessionWaiting` 直接驱动：入队时由 `Integration.requestUserChoice`
  标记，webview 弹出 / 应答时由 `UiEvent.userChoicePendingChanged` 标记。
  `sessionResources.isSessionIdle` 经 `isSessionWaiting(sessionId)` 读同一份事实。
- 读全量：`getSessionRuntimeStates()`；读单会话：`getSessionRuntimeState(sessionId)`。
- 分发有**推**和**拉**两条：推是常态（变化时经 `CoreEvent.sessionRuntimeChanged` 全量推给已存在的视图）；
  视图创建 / 激活时可能错过推送（当时视图还不存在），因此 webview 启动、或对话列表渲染方切到
  `webview`（Electron 悬浮窗：视图此前可能长期不是活动视图）时发
  `requestSessionRuntimeStates` 主动拉一次快照——`WebviewMessageHandler.pushSessionRuntimeStates`
  调 `getSessionRuntimeStates()` 并按**来源视图**回包（多视图宿主下请求方不一定是活动视图）。
  否则新视图的对话树流水灯 / abort 按钮 / 历史提醒会"失明"到下一次状态变化。
- **「是否空闲」的唯一判定入口是 `sessionResources.isSessionIdle(sessionId)`**（异步只读查询，
  覆盖来源表全部来源 + 子代理递归）。宿主空闲回收与「手动压缩是否延后」都调它。

## 4. 与 SessionUiState 的分工（避免双记账漂移）

- core 的 `sessionRuntime` 是**唯一事实 owner**，`SessionRuntimeState` 进 `CoreEvent`，
  是跨层的公共词汇。
- `SessionUiState`（host 侧）是**渲染投影**：webview 每会话的 thinking / text / tool
  渲染阶段（`getActivityPhase`）只有 UI 能算（它看到消息流）。**对话树流水灯与 abort 按钮
  都不属于它**——那是 `sessionRuntime` 的事实，webview 只读宿主推来的
  `sessionRuntimeStates`（[contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)）。
- **禁止从 `SessionUiState` 反推 `SessionRuntimeState`**：两者数据源不同
  （一个看 wire 消息，一个看 core 内部状态），互为对账可以，互相写值不行。
  `WebViewUI.onSessionRuntimeChanged` 只读（转发给 `ConversationManager.updateSessionStates`），
  不写回。
