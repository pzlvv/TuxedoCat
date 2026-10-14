---
owner: pzlvv
last_reviewed: 2026-10-14
---

# 规格：宿主侧共享子模块与端口

本规格界定 `src/host/ui/*` 的三个宿主共享子模块与它们回推 webview 的窄端口：`UserChoiceManager`（第 1 节）、`ToolHandler`（第 2 节）、`WebviewMessageHandler`（第 3 节），以及 `WebViewUI` 实现并注入它们的 `WebViewUiPort`（第 4 节）。

交叉引用：`docs/architecture/contracts.md`（宿主契约 `UIHost` / `SpinDesign` / `ConversationManager` 的定义与宿主侧入口）、`docs/hosts/webview-ui.md`（`WebViewUI`——`WebViewUiPort` 的实现方）、`docs/architecture/events.md`（子模块翻译出的 `UiEvent` 与其触发点）、`docs/hosts/host-matrix.md`（两个宿主对契约的逐成员实现对照）。

---

位置：`src/host/ui/*`。

三个**宿主共享**子模块承载与宿主无关的三块 UI 逻辑：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| `UserChoiceManager` | `src/host/ui/userChoice.ts` | per-session 待答选择的投递与恢复（会话 open 即投递）、`waiting` 标记、diff 快照暂存 |
| `ToolHandler` | `src/host/ui/toolHandler.ts` | 工具卡片的展示与状态更新（**不含权限规则**） |
| `WebviewMessageHandler` | `src/host/ui/webviewMessageHandler.ts` | webview 协议消息的解析与分发（解析 + 翻译） |

**隔离规则**：子模块拿不到 `WebViewUI` 的事件处理方法（`onMessage` / `onQueryBegin` / …），
只能通过两类依赖访问外界：

| 依赖 | 内容 |
| --- | --- |
| `host: UIHost` | 宿主能力（投递消息、日志、打开文件…）；子模块不 import `vscode` / `electron`（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 3、4） |
| 回调 | 回推 webview 或通知 `WebViewUI`：`postToWebview` / `postConversationLoaded` / `setTitle` / `closePreview` … |

`WebviewMessageHandler` 另有一个**构造后回填**的窄端口 `uiPort`（只声明自己用到的 7 个成员）。
回填是因为 `WebViewUI` 只能在构造期间把自己交出去；端口内容是 `WebViewUiPort`（第 4 节）的子集。

子模块之间只有一条依赖：`ToolHandler` 与 `WebviewMessageHandler` 都持有**同一个**
`UserChoiceManager` 实例（共享 diff 快照与 pending 队列）。该实例由宿主工厂
（`WebViewUI.create` 的 `deps.createUserChoiceManager`）创建——它是唯一需要宿主差异的模块
（VS Code 注入 `OutputChannel`，Electron 注入 `console` 包装的日志出口）。

## 1. UserChoiceManager

共享模块本身不依赖任何宿主 API；需要宿主能力时用注入的回调。**diff 预览不在本模块内**：
权限确认的 diff 由 core 展开进 `displayArgs.diffHunks`，随工具卡片在 webview 里渲染
（第 2 节）；宿主侧的 diff 预览归 `UIHost.showDiff`。

构造依赖：

| 依赖 | 用途 |
| --- | --- |
| `outputChannel` | 日志（`LogChannel` 形状） |
| `postToWebview(sessionId, message)` | 回推 `requestUserChoice` / `showThinkingAnimation` |
| `closePreview()` | 用户响应后关闭宿主预览（`UIHost.closePreview`） |
| `isSessionOpenInternal(sessionId)` | 回答 core `UserChoiceQueue` 的「该会话是否 open」查询（多视图：有聊天视图；单视图：open == active） |
| `onChoiceShown?(sessionId)` | 选择框弹出后的可选回调（当前无人传入；waiting 由 core 的 `sessionRuntimeChanged` 推给侧栏与托盘） |

成员：

| 成员 | 语义 |
| --- | --- |
| `initUserChoiceQueue()` | 把 core `UserChoiceQueue` 的 3 个回调接到本类：`onShowUserChoice` / `onSessionLoaded` → 恢复该会话的待答选择；`isSessionOpen` → 上面注入的读取器。**不注册会话切换**：会话已 open 时请求直接投递到该会话自己的视图（多视图下未选中的视图也会显示，切过去即可看到）；未 open 的请求保留 pending，由 UI 提醒用户 |
| `requestUserChoice(sessionId, options)` | `CoreRequest.userChoice` 的入口：按会话入 `UserChoiceQueue`（不直接弹框），由 `isSessionOpen` 决定立即投递还是保留 pending；队列回调未注册（宿主未接线）时退化为直接 `showUserChoice` |
| `showUserChoice(sessionId, options)` | 弹出选择框并等待应答（队列投递与未接线兜底的共同落点）：① 保存 diff 快照（`beforeContent` / `afterContent` / 上下文 / 起止行）② 投递 `requestUserChoice` ③ 发 `UiEvent.userChoicePendingChanged(pending: true)`（`idle` / `waiting` 归 core，见[docs/core/session-runtime.md](../core/session-runtime.md)；Embedded 入队时 `Integration.requestUserChoice` 已提前标记、Standalone 由 Core 的 `waiting_request` 标记，此处幂等）④ 返回 Promise，`resolve` 时 `closePreview()` + 发 `userChoicePendingChanged(pending: false)` |
| `hasPendingChoice(sessionId)` | 该会话是否有待答选择：`pendingUserChoices`（已弹出）或 `userChoiceQueue`（已入队未投递，会话尚未 open）任一命中即为真。供 core `isSessionIdle` 判定「非空闲，不回收」 |
| `saveDiffSnapshot(sessionId, snapshot)` | 写入 diff 快照（`beforeContent` / `afterContent` / 上下文 / 起止行）并登记归属会话。`ToolHandler.requestToolPermission` 调用（`showUserChoice` 也直接写同一份快照） |
| `dropSession(sessionId)` | 会话 UI 侧状态释放：拒绝该会话在 `UserChoiceQueue` 里尚未投递的请求（Standalone 的 Core 进程不持有宿主队列，Embedded 由 core 的 `releaseSessionResources` 负责，此处幂等），清掉该会话的 `pendingUserChoices` 回调，并在 diff 快照归属该会话时清空快照。由 `WebViewUI.dropSession` fan-out 调用（[docs/hosts/webview-ui.md 第 9 节](../hosts/webview-ui.md#9-生命周期dropsession)） |
| `pendingUserChoices: Map<choiceId, {sessionId, resolve}>` | 待答选择表；`WebviewMessageHandler.handleRespondUserChoice` 按 `choiceId` 取出并 resolve |
| `currentBeforeContent` / `currentAfterContent` / `currentContextBefore` / `currentContextAfter` / `currentStartLine` / `currentEndLine` | 当前 diff 快照，**与 `ToolHandler` 共享**（`ToolHandler` 经 `saveDiffSnapshot` 写入，两边都读）；`diffSnapshotSessionId` 记录归属会话，供 `dropSession` 精确清理 |

调用方：`WebViewUI.requestUserChoice`（`CoreRequest.userChoice` 的处理方）与
`WebviewMessageHandler.handleRespondUserChoice`（响应回填）。

## 2. ToolHandler

构造依赖：`{ host, postToWebview, userChoiceManager }`。`userChoiceManager` 只用于共享
diff 快照——**确认框不在这里弹**（见下）。

| 成员 | 语义 |
| --- | --- |
| `requestToolPermission(sessionId, toolUseId, toolName, permResult, displayArgs, agentMode)` | `CoreRequest.toolPermissionRequested` 的处理方。① 仅当 `permResult` 真的带 `beforeContent`（Edit / Write）时经 `userChoiceManager.saveDiffSnapshot` 写入 diff 快照（同时登记归属会话）——否则会把上一次 Edit 的 diff 挂到本次失败卡片上 ② 投递工具卡片（`addMessage`，`status: 'normal'`）③ 带 diff 且 `agentMode === 'manual'` 时调 `host.showDiff`（见下）④ 追加写 `_meta`（`updateToolUseMeta`，append-only）⑤ 原样返回 `permResult` |
| `onToolCall(sessionId, toolUseId, toolName)` | 投递 `updateToolStatus: 'running'` |
| `onToolResult(sessionId, toolUseId, toolName, output, status)` | Edit 失败时清空卡片上的 diff；成功时补 `contextBefore` / `contextAfter` / 起止行；最后投递 `updateToolStatus`（`success` / `fail` + `output`） |

**不做权限判断**：`permResult` 已由 core 按 agentMode 规则加工完（`allow` / `deny` / `ask`，
见[docs/architecture/events.md 第 2.2 节](events.md#22-corerequestcore--ui请求-响应)）。`ask` 的确认框由 core 侧发起（Embedded：`RunTools` → `Integration.requestUserChoice`；
Standalone：Core 发 `CoreRequest.userChoice`），宿主统一经 `UserChoiceManager.requestUserChoice`
入 `UserChoiceQueue`（会话已 open 即投递到该会话自己的视图，未 open 保留 pending，不自动切换会话），
UI 侧提前弹框会造成双重确认。

**diff 的显示规则**（Edit / Write 的改动）

| 时机 | webview | VS Code |
| --- | --- | --- |
| 权限确认前 | 工具卡片（`addMessage` + `toolArgs.diffHunks`）已上架 | 仅 manual 模式：`host.showDiff` 打开 before/after 的 diff 标签 |
| 权限确认中 | 确认框替换底部输入区（`UserChoiceOverlay`），**不遮挡**消息区，diff 仍可见 | diff 标签保持打开（仅 manual） |
| 权限确认后 | 卡片保留 diff 渲染（失败时清空，见 `onToolResult`） | 标签保持打开（仅 manual） |
| 无授权流程（`allow`，即 auto / risk 自动放行） | 同上，只是没有等待 | 不打开宿主 diff（`agentMode !== 'manual'`） |

两个渲染的数据源是同一份：core 的 `PermissionPolicy` 把改动展开进
`CoreRequest.toolPermissionRequested.displayArgs`（`diffHunks` 供卡片）与 `permResult`
（`beforeContent` / `afterContent` 供宿主 diff），`ToolHandler` 一次读取后分别投给两处。

**改动内容与权限决策解耦**：`PermissionPolicy` 先从工具自己的 `checkPermissions` 结果里取出
改动内容（`PermissionDiffPayload`），再按 agentMode 加工决策；auto / risk 把 `ask` 自动放行为
`allow` 时会把这份内容一并带过去（`{ behavior: 'allow', ...diffPayload }`）。否则「无授权流程」
就会退化成「没有 diff」——用户看不到自动应用了什么改动。Electron 的 `host.showDiff` 是空实现
（没有原生 diff 界面），因此桌面端只有卡片这一处渲染。

## 3. WebviewMessageHandler

构造依赖：`{ host, postToWebview, postConversationLoaded, setTitle, userChoiceManager }`
（外加可选的 `onUserChoiceResponded`），构造完成后由 `WebViewUI` 回填 `uiPort`。

| 成员 | 语义 |
| --- | --- |
| `handleWebviewMessage(message, ctx?)` | 唯一入口（宿主 webview 的 `onDidReceiveMessage`）；按 `message.type` 查表分发，未知类型只记日志；异常兜底成一条日志，不冒泡成未处理的 rejection。`ctx.sender` 标识消息来源视图（`WebviewRequestContext`）：多视图宿主传入句柄，单视图宿主 / 宿主主动推送省略（缺省 `{ sender: null }`）；需要按来源回包的消息依赖它定向投递 |
| `getActiveSessionId()` | UI 自己维护的「当前前台会话」（core 不感知） |
| `setActiveSessionId(sessionId)` | 宿主切换前台会话时同步「当前活跃会话」。多视图宿主（Electron）切到**已打开**的视图不会再走 `loadConversation` / `startNewConversation`，必须由宿主在活动视图变化时显式同步（`ChatViewManager.show` → `onActiveSessionChanged` → `WebViewUI.setActiveSessionId`）；否则 `trackedActiveSessionId` 停在旧视图，按会话解析的数据（project skills / MCP 启用列表）会取到别的标签页的工作目录 |
| `dropTrackedSession(sessionId)` | 会话关闭 / 删除时清掉 `trackedActiveSessionId`（若指向该会话） |
| `emitUiEvent(event)` | `requireEventBus().emitToCore(event)`——**改 core 状态的唯一出口** |
| `buildMessageHandlers()` | 42 个消息类型 → 处理器（见下）；其中 `sendMessage` 是用户消息的唯一入口（`handleUserMessage`），wire 类型不区分「新消息 / 排队消息」：是否登记排队项由宿主按 core 的会话运行时快照决定（第 4 节 `onQueuedMessage`） |

**消息分发表**（`buildMessageHandlers`，按代码注释分区）：

| 分区 | 内容 |
| --- | --- |
| 纯宿主操作 | `openFile` / `requestToolMeta` / `showVirtualDocument` / `openMermaidPreview` / `openSpinDesign` / `openUrl` / `debugLog` |
| 无副作用查询 | `requestModels` / `fetchProviderModels` / `detectProviderModelApiTypes` / `requestLLMConfig` / `requestSettingsDefaults` / `requestSkills` / `requestConversationSpaces` / `requestMcpServers` / `requestSessionRuntimeStates` / `getConversations` |
| 环境查询 | `requestTheme`（→ `host.onThemeChanged(ctx.sender)`）/ `requestContextLimit`（→ `pushContextLimit(ctx.sender, modelRefOf(msg.provider, msg.model))`：读该模型身份（provider + model）的上下文配置，经 `sendToWebviewView` / `sendToWebview` 回包 `contextLimitUpdated`；`ref` 为 `undefined` 时按 active provider 的默认模型算，视图加载初始化推送即走这条）；`pushContextLimit` 也是 `WebViewUI` 的对外方法，供宿主在视图加载时主动推同一份内容 |
| 请求响应 / 显示 | `respondUserChoice` / `expandCompact` / `rollbackEdit`（→ `UiEvent`） |
| 消息 / 压缩 / 中止 | `sendMessage`（→ `handleUserMessage`：登记排队项 / 乐观回显后发 `UiEvent.userMessageSubmitted`）/ `abort` / `backgroundBashTool`（Bash 卡片「转后台」，→ `UiEvent.bashBackgroundRequested`）/ `discardQueuedMessage` / `requestCompress`（除 `sendMessage` 外均 → `UiEvent`） |
| 会话生命周期 | `loadConversation` / `startNewConversation` / `deleteConversation` / `renameConversation` / `updateConversationContext` / `clearConversationSpace`（`deleteConversation` / `renameConversation` / `updateConversationContext` / `clearConversationSpace` → `UiEvent`；多视图宿主的 `deleteConversation` 由宿主消息入口先接管，见 [docs/architecture/contracts.md 第 5 节](contracts.md#5-宿主侧入口动作翻译为-uievent)「载体 / 视图层动作」） |
| 会话配置 | `setModel` / `setThinkingMode` / `setPromptMode` / `setAgentMode` / `setWebSearch` / `setMcpEnabled` / `setMcpEnabledList`（全部 → `UiEvent`，core 处理后广播 `sessionConfigChanged` 回推多端）。`setModel` 的 wire 载荷是扁平的 `model` + `provider`，在 handler 入口组装成 `ModelRef`（provider 空串非法：记录日志并忽略，不回退到其它 provider） |
| 其它 | `saveLLMConfig` / `requestSmartNaming` |

前两个分区留在本模块内（只操作宿主或只读 core）；其余要么发 `UiEvent`，要么是**显示类**动作。
完整映射见[docs/architecture/events.md 第 2.3 节](events.md#23-uieventui--core单向)的「UI 侧触发点」列。

**LLM 配置面板**：`requestLLMConfig`（用户点设置按钮）与 `startNewConversation` 的配置引导都委托
`WebViewUI.showLLMConfigPanel(trigger, sessionId)`；视图加载补弹由两个 bootstrap 用同一方法触发
（`trigger='startup'`）。core 只提供配置事实（`getLLMConfigPanelPayload` /
`hasActiveProviderSetting` / `readMcpServersForDefaults`），wire message 的组装与投递在 UI 层
（[第 1 节](#1-userchoicemanager)）。三条触发路径共用同一份面板载荷（含 MCP 默认启用列表），差异只在守卫。

**留在模块内的两处例外**：

- `handleExpandCompact`：只读归档文件并把消息重放给 webview，不改 core 状态（纯显示）。
- `handleSaveLLMConfig`：`settings.json` 的写经 `host.updateSettingsJson`（core 只读不写，
  见 [docs/architecture/contracts.md 第 1 节](contracts.md#1-uihost对话-webview-的宿主能力)），其余仍是「组装 mutator + 回推协议消息」。

**并发防护**：`loadConversationSeq` 单调递增，`loadConversation` 的每个 `await` 之后都校验
序号，丢弃过期结果（用户快速连点两个对话时，后发的请求可能先完成）。

## 4. 端口：WebViewUiPort

位置：`src/host/ui/ports.ts`。由 `WebViewUI` 实现，子模块用它回推 webview 或读取 UI 侧状态，
**拿不到事件处理方法**。

| 成员 | 语义 |
| --- | --- |
| `postToWebview(sessionId, message)` | 补 `sessionId` 后投递到宿主 webview |
| `postConversationLoaded(sessionId, conversation, extra)` | 推送 `conversationLoaded`（含 `activityPhase`，见[docs/hosts/webview-ui.md 第 2 节](../hosts/webview-ui.md#2-内部流程约定)） |
| `onTitleChanged(sessionId, title)` | 会话标题变化（`WebviewMessageHandler` 的 `setTitle` 回调走它） |
| `dropSession(sessionId)` | 该会话的 UI 侧状态已释放 |
| `onQueuedMessage(sessionId, queued)` | 登记 / 清除该会话的排队项（`queued` 为 `null` 表示清除，载荷类型 `QueuedMessageState`）。登记调用点：`WebviewMessageHandler.handleUserMessage`（会话运行时快照 `idle === false` 时，见 [docs/features/user-message-pipeline.md 第 2 节](../features/user-message-pipeline.md#2-功能需求)）；清除调用点：内置命令就地执行（`onCommandSend`）、会话释放（`dropSession`）、进入上下文的用户消息由补发的 `addMessage`（带 `messageUuid`）清除 |
| `getActiveSessionId()` | 当前前台会话 |
| `openSpinDesign()` | 打开 Spin 设计器（子模块不直接持有 `SpinDesign`，见 [docs/architecture/contracts.md 第 2 节](contracts.md#2-spin-设计器契约spindesign)） |
| `refreshConversations()` | 重新读取并分发对话列表 |
| `getSessionRuntimeStatesSnapshot()` | 最近一次会话运行时状态快照（`ConversationManager` 缓存）；Standalone 下进程内 `sessionRuntime` 不被写入，拉取必须走这份缓存 |
| `isQueryActive(sessionId)` | 该会话**自己的**查询是否在跑（`SessionUiState.isQueryActive`）；`conversationLoaded.hasActiveQuery` 的来源，**不用** `sessionRuntime.idle`（后者含后台子代理 / 后台 Bash / 压缩，见`docs/hosts/webview-ui.md`） |
| `isSessionOpen(sessionId)` | 该会话的聊天视图是否 open（多视图：有聊天视图；单视图：open == active）；经 `bootstrapCore` 注入给 `UserChoiceManager` 的 `isSessionOpenInternal`，core `UserChoiceQueue` 借它决定立即投递还是保留 pending（[第 1 节](#1-userchoicemanager)） |
| `noteSessionActivity(sessionId)` | 记录会话活动（重置空闲计时；空闲回收只在 VS Code 生效，见 [docs/architecture/contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)） |
| `showLLMConfigPanel(trigger, sessionId)` | 打开 LLM 配置面板：core 给配置事实，`WebViewUI` 组装 `showLLMConfig` 并投递（`trigger` 见下） |

配套类型：

| 类型 | 语义 |
| --- | --- |
| `LLMConfigPanelTrigger` | `'startup'` / `'new-conversation'` / `'request'`：决定是否弹（补弹 / 引导 / 无条件） |
| `WebviewPoster` | `(sessionId, 消息体) => void`：补全后投递的投递器，`WebViewUI` 内部统一用它 |
| `ConversationLoadedExtra` | `conversationLoaded` 的附加信息（`pendingToolUseIds` / `savedContext` / `parentSessionId` / `agentMode` / `hasActiveQuery` / `hasCompactArchive` / `model`），由 `WebviewMessageHandler` 提供，`WebViewUI` 再补 `activityPhase`。`hasActiveQuery` 只表示本会话自己的查询在跑（`isQueryActive`），不是 `sessionRuntime` 的「会话非空闲」 |

