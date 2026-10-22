---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：WebViewUI 实现与会话 UI 状态

本规格界定唯一的 UI 实现 `WebViewUI`（第 1–4 节）与会话级 UI 状态 `SessionUiState`（第 5–10 节）。`WebViewUI` 不实现任何事件契约，只经 `AssistantEventBus` 订阅与发送；`SessionUiState` 是 host 侧渲染投影，与 core 的 `sessionRuntime` 分工明确。

交叉引用：[docs/architecture/events.md 第 1 节](../architecture/events.md#1-总线契约)（总线契约）与[第 2 节](../architecture/events.md#2-事件词汇表)（事件列表）、`docs/architecture/contracts.md`（宿主契约与端口）、`docs/hosts/webview-facts.md`（webview 的事实与等待态）、`docs/features/abort-button.md`（abort 按钮三态）。

---

位置：`src/host/WebViewUI.ts`。

`WebViewUI` 是唯一的 UI 实现，宿主无关（不 import `vscode` / `electron`）。它**不 implements
任何事件契约**：构造时把 `CoreEventHandlers` / `CoreRequestHandlers` 两张映射表一次性注册到
总线（穷尽性由映射类型保证），需要通知 core 时 `bus.emitToCore(...)`。

渲染与控制 handler 同处一个类，按注释分区（不拆 `WebViewNotifier` / `WebViewController`）；
事件路由由总线承担，两者之间不需要「事件 → 方法」的适配层（不设 `WebViewEventBus`）。
理由见[docs/architecture/events.md 第 1 节](../architecture/events.md#1-总线契约)。

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [类定义与接线](#1-类定义与接线) |
| 2. | [内部流程约定](#2-内部流程约定) |
| 3. | [总线注册](#3-总线注册) |
| 4. | [对外方法](#4-对外方法) |
| 5. | [三张表](#5-三张表) |
| 6. | [活动阶段：谁在什么时候写](#6-活动阶段谁在什么时候写) |
| 7. | [查询计数：`queryBegin` / `queryEnd` 去重](#7-查询计数querybegin--queryend-去重) |
| 8. | [abort 按钮：读 core 的 `sessionRuntime`，不由这里判定](#8-abort-按钮读-core-的-sessionruntime不由这里判定) |
| 9. | [生命周期：dropSession](#9-生命周期dropsession) |
| 10. | [与 core 的 `SessionRuntimeState` 的边界](#10-与-core-的-sessionruntimestate-的边界) |
| 11. | [消息区视图行为：跳到底部与发送模式](#11-消息区视图行为跳到底部发送模式与一次性通知) |

---

## 1. 类定义与接线

**单例**：`static create(...)` 创建全局唯一实例，重复调用抛错；`static getInstance()` 未创建时
抛错。两者都把接线错误暴露在启动期，不用 `undefined` 静默降级。

**构造依赖**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `host` | `UIHost` | 宿主能力（[docs/architecture/contracts.md 第 1 节](../architecture/contracts.md#1-uihost对话-webview-的宿主能力)）；`public readonly`，子模块直接引用 |
| `bus` | `AssistantEventBus` | 只用于注册两张映射表；向 core 发消息走 `emitToCore` |
| `spinDesign` | `SpinDesign` | Spin 设计器（[docs/architecture/contracts.md 第 2 节](../architecture/contracts.md#2-spin-设计器契约spindesign)） |
| `conversations` | `ConversationManager` | 对话列表 / 会话状态（空闲回收是 VS Code 实现的事，[docs/architecture/contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)） |
| `deps.createUserChoiceManager` | 工厂 | 宿主专属：VS Code 传 `OutputChannel`，Electron 传 `console` 包装的日志出口（不传 `onChoiceShown`；waiting 由 core 的 `sessionRuntimeChanged` 推给侧栏与托盘） |
| `deps.log` | `(...args: unknown[]) => void` | 日志出口（VS Code 写 `OutputChannel`，Electron 写 `console`） |

`createUserChoiceManager` 是唯一用工厂而非实例注入的依赖：`UserChoiceManager` 需要
`WebviewPoster` 与 `WebViewUiPort`（即 `this`），这两者在构造期间才存在。

**bootstrap 调用**（两个宿主各一次，均在共享骨架 `bootstrapCore` 内）：

```ts
// src/host/bootstrapCore.ts（骨架内部，两个宿主共用）
const ui = WebViewUI.create(host, bus, spinDesign, conversations, { log, createUserChoiceManager });
```

`host` / `spinDesign` / `conversations` 三者平行注入（契约按 UI surface 划分，[docs/architecture/layering.md 第 2 节](../architecture/layering.md#2-规则清单)规则 7）；
`createUserChoiceManager` 由骨架构造（日志出口取自宿主的 `log` 参数），宿主不再各自实现。

**类内分区**（同一个类内按注释分区，不拆类）：

| 区 | 内容 |
| --- | --- |
| `WebViewUiPort` 实现 | 子模块回推 webview 的窄端口（`docs/architecture/contracts.md`） |
| 渲染 handler | 消息 / 流式 / 工具 / AI 阶段的投影与推送 |
| 控制面 handler | 查询生命周期 / 工具权限 / 用户选择 / 压缩 / 命令 |
| 事实通知 handler | `onConversationListChanged` / `onSessionRuntimeChanged` / `onSpinDesignDataChanged` |
| 公开方法 | 供宿主接线调用（第 4 节） |

**持有物**：

| 成员 | 用途 |
| --- | --- |
| `sessionUi: SessionUiState`（`public readonly`） | 渲染 handler 记活动阶段；控制面 handler 记查询计数（第 5 节） |
| `toolHandler: ToolHandler` | 工具卡片状态 + 权限弹框（`docs/architecture/contracts.md`） |
| `userChoiceManager: UserChoiceManager` | ask user / 权限确认队列（`docs/architecture/contracts.md`） |
| `webviewMessageHandler: WebviewMessageHandler` | webview 协议消息入口（`docs/architecture/contracts.md`） |
| `post: WebviewPoster` | `(sessionId, 消息体) => void`：补 `sessionId` 后交宿主，全类统一用它投递 |

子模块的接线：`UserChoiceManager` 由宿主工厂创建（收 `WebviewPoster` + `closePreview` +
`WebViewUiPort`）；`ToolHandler` 收 `{ host, postToWebview, userChoiceManager }`；
`WebviewMessageHandler` 收 `{ host, postToWebview, postConversationLoaded, setTitle,
userChoiceManager }`，构造完成后回填 `uiPort = this`。

**会话关闭 / 内存释放**：拆成两个方法（`closeConversation` = `releaseConversation` + 销毁宿主视图）：

```ts src=src/host/WebViewUI.ts
/** 只卸内存，不销毁宿主视图 */
releaseConversation(sessionId: string): void {
  // 临时 `new-` key 尚未对应正式会话（core 侧 releaseSessionResources 对它本就是
  // no-op），不发 conversationClosed：会话从未登记归属，多连接下 Client 按会话
  // 路由查不到归属会直接抛错（`docs/core/client-connection.md` 第 1 节）。
  if (!isTemporarySessionId(sessionId)) {
    requireEventBus().emitToCore({ type: 'conversationClosed', sessionId }); // core 卸内存
  }
  this.dropSession(sessionId);                                            // UI 侧 per-session 状态 fan-out
}

/** 会话的 UI 侧状态已释放：fan-out 给所有持有 per-session 状态的子模块 */
dropSession(sessionId: string): void {
  this.sessionUi.dropSession(sessionId);                    // 阶段 / 工具计数 / 查询计数
  this.userChoiceManager.dropSession(sessionId);            // 挂起的选择回调 + diff 快照
  this.webviewMessageHandler.dropTrackedSession(sessionId); // tracked active session
  this.onQueuedMessage(sessionId, null);                    // 会话释放 → 清排队项
}

/** 卸内存 + 销毁宿主视图；两件事归属不同，这里只做分发 */
closeConversation(sessionId: string): void {
  this.releaseConversation(sessionId);
  void this.host.closeConversationView(sessionId);                         // VS Code 为空实现
}
```

拆开的原因：Electron 的视图销毁序列（`ChatViewManager.closeView` / LRU trim / `disposeAll`）
只需要「卸内存」，若它回调 `closeConversation`，就会再触发 `host.closeConversationView` →
`ChatViewManager.destroyViewEntry` → 视图销毁 → 又回到卸内存，形成环。

| 调用方 | 用哪个 |
| --- | --- |
| Electron 视图销毁序列（`ChatViewManager.closeConversation`） | `releaseConversation` |
| Electron 关闭按钮 / 侧栏「关闭」、删除对话流程、VS Code 空闲回收 | `closeConversation` |

Electron 的侧栏「关闭」/ 聊天视图顶栏关闭经 `electron/main.ts` 的 `closeConversationWithConfirm`
（非 idle 先二次确认）。该会话没有打开的视图（`ChatViewManager.isViewAlive` 为假）时它直接
空操作：没有可卸的运行时资源，而 `conversationClosed` 按会话路由到归属 Connection，本进程
没打开过的会话在 Client 侧没有归属
（[docs/core/client-connection.md 第 6 节](../core/client-connection.md#6-会话路由)）。

## 2. 内部流程约定

**渲染 handler**：

| 方法 | 行为 |
| --- | --- |
| `onMessage` | `postToWebview(addMessage)`；`role === 'user'` 时额外调 `onConversationListChanged()`（消息已进入持久化流程，刷新 `messageCount`）。载荷的 `once` 标记（一次性通知，渲染规则见第 11 节）随 addMessage 透传，时间线的「末位显示、新节点先删」在 webview handler 层执行 |
| `onStreamMessage` | `role === 'assistant'` 且 `accumulated` 全为空白时直接丢弃；否则 `sessionUi.markText` / `markThinking` → 投递 `streamMessage` |
| `onStreamEnd` | 投递 `streamEnd`（含 `usage` / `streamId`） |
| `onToolCall` | `sessionUi.markToolPhase` → `toolHandler.onToolCall` |
| `onToolResult` | `sessionUi.endToolPhase` → `toolHandler.onToolResult` |
| `onToolArgsUpdated` | 投递 `updateToolArgs` |
| `onToolProgress` | `pushToolProgress`（`queryActivity`；推送内容已由工具层按统一上限 4K（前 2K + 后 2K）裁剪，宿主原样转发，不再二次截断） |
| `onAIBegin` | `markThinking` + `setThinkingAnimation(true)` → 投递 `aiBegin` |
| `onAIEnd` | `markIdle` + `setThinkingAnimation(false)` → 投递 `aiEnd` → `fetchAndSendBalance`（每轮 LLM 调用后刷新余额） |
| `onMessagesReplaced` | 投递 `messagesReplaced`（整批替换 webview 消息区）；触发方是 `compact` 的归档重放（`replayMessagesToUI`），宿主侧的 `expandCompact` 直接投递同一条 wire message、不经过本 handler |

**控制面 handler**：

| 方法 | 行为 |
| --- | --- |
| `requestToolPermission` | `sessionUi.beginToolPhase`（thinking 让位于工具卡片）→ `toolHandler.requestToolPermission`（上架工具卡片；Edit / Write 带 diff 且 `agentMode === 'manual'` 时调 `host.showDiff` 打开宿主侧 diff，见[docs/architecture/host-ui-modules.md 第 2 节](../architecture/host-ui-modules.md#2-toolhandler)） |
| `requestUserChoice` | `userChoiceManager.requestUserChoice` |
| `onQueryBegin` | `sessionUi.beginQuery()` 计数去重（嵌套调用直接忽略）→ `markThinking` → `setThinkingAnimation(true)` → 投递 `queryBegin` |
| `onQueryEnd` | `sessionUi.endQuery()` 去重 → `markIdle` → **显式 `setThinkingAnimation(false)`**（中断路径可能没有 `onAIEnd`，只发 `queryEnd` 会让 thinking 动画残留）→ 投递 `queryEnd` → `onConversationListChanged()` |
| `onTitleChanged` | 投递 `setTitle` |
| `onSessionCreated` | 投递 `initSessionState` |
| `onCompactBegin` / `onCompactEnd` | 投递 `compressProgress`（`start` / `complete` / `error`，含 `postCompactTokenCount`） |
| `onCommandSend` | 只处理 `spin`：`/spin:design` 直接开设计器；`/spin:` 在 `shouldOpenSpinDesign(ws)` 为真时开（core 只读函数，动态 import） |
| `onSessionConfigChanged` | 按 `change.key` 投递对应 wire message（多端同步）；`mcpEnabled` 只投 `setMcpServers` 让面板重读，不改 core |

**事实通知 handler**：

| 方法 | 行为 |
| --- | --- |
| `onConversationListChanged` | `conversations.refresh()`；「立即还是节流、推给哪些界面」由 `ConversationManager` 决定，core 不参与 |
| `onSessionRuntimeChanged` | `conversations.updateSessionStates(states)`；**只读**，不写回 `sessionUi`（[docs/core/session-runtime.md](../core/session-runtime.md)） |
| `onSpinDesignDataChanged` | `spinDesign.refresh()`（设计器不在 `UIHost` 上） |
| `onHighlightLanguagesUsed` | `host.updateSettingsJson(highlightLanguagesMutator(languages))`——core 只报告事实（不去重，同一种语言会重复上报），去重 / 上限 / 字段名在宿主的 `highlightLanguagesMutator`，写盘也在宿主 |

**投递路径**：所有出站消息都经 `postToWebview(sessionId, message)` 补 `sessionId` 后交
`host.sendToWebview`。`postConversationLoaded` 例外——它经 `buildConversationLoadedPayload`
组装，并注入 `activityPhase: this.getActivityPhase(sessionId)`（webview 靠它恢复
thinking / text / tool 动画）。`ConversationLoadedExtra.hasActiveQuery` 由
`WebviewMessageHandler.handleLoadConversation` 用 `WebViewUiPort.isQueryActive(sessionId)`
（`SessionUiState` 的本会话查询计数）填，**不读 `sessionRuntime.idle`**：后者是「会话非空闲」
口径，含后台子代理 / 后台 Bash / 压缩，会把「父会话空闲、后台子代理在等用户」误判成
父会话有活跃查询，重新加载父会话时误恢复 thinking 动画（第 5 节）。

## 3. 总线注册

构造期间一次性注册两张映射表，键与事件 `type` 一一对应：

| 表 | 数量 | 内容 |
| --- | --- | --- |
| `onCoreEvents` | 28 | 10 个渲染（`message` / `streamMessage` / `streamEnd` / `toolCall` / `toolResult` / `toolArgsUpdated` / `toolProgress` / `aiBegin` / `aiEnd` / `messagesReplaced`）+ 18 个控制面与事实通知（`coreReady` / `queryBegin` / `queryEnd` / `titleChanged` / `sessionCreated` / `conversationListChanged` / `conversationSpaceCleared` / `sessionRuntimeChanged` / `workspaceFileChanged` / `spinDesignDataChanged` / `workModeChanged` / `highlightLanguagesUsed` / `compactBegin` / `compactEnd` / `commandDispatched` / `sessionConfigChanged` / `log` / `notice`） |
| `onCoreRequests` | 2 | `toolPermissionRequested` → `requestToolPermission`；`userChoice` → `requestUserChoice` |

映射表把 `CoreEvent` 的 `e` 拆成位置参数后转调同名 handler，handler 自身保持
「一个方法一组参数」的形式（便于单测与复用），签名细节见 [docs/architecture/events.md 第 2.1 节](../architecture/events.md#21-coreeventcore--ui单向) / [第 2.2 节](../architecture/events.md#22-corerequestcore--ui请求-响应)。

## 4. 对外方法

`WebViewUI` 除了实现 `WebViewUiPort`（`docs/architecture/contracts.md`）外，还向宿主暴露以下入口：

| 方法 | 消费者 |
| --- | --- |
| `handleWebviewMessage(message, ctx?)` | 宿主 webview 的 `onDidReceiveMessage`（`extension.ts` / `electron/main.ts`）。`ctx.sender` 为来源视图句柄：Electron 用 `webviewHandleFor(sender)` 传入；单视图宿主 / 宿主主动推送省略（见[docs/architecture/host-ui-modules.md 第 3 节](../architecture/host-ui-modules.md#3-webviewmessagehandler)） |
| `getActiveSessionId()` | `host.getActiveSessionId` 接线（VS Code 空闲巡检的 `activeSessionProvider`、MCP 面板取当前会话）、`extension.ts` 的 `persistCurrentFileContext` |
| `getActivityPhase(sessionId)` | `postConversationLoaded` 内部；`conversationLoaded` 的 `activityPhase` 字段来源 |
| `isQueryActive(sessionId)` | `WebviewMessageHandler.handleLoadConversation` 内部；`conversationLoaded` 的 `hasActiveQuery` 字段来源（只认本会话自己的查询计数，见第 5 节） |
| `closeConversation(sessionId)` | VS Code 空闲回收的 `idleCloseHandler`；Electron 关闭按钮 / 侧栏「关闭」、删除对话流程 |
| `releaseConversation(sessionId)` | `ChatViewManager.closeConversation`（视图销毁序列） |
| `onTitleChanged(sessionId, title)` | 子模块注入的 `setTitle` 回调 |
| `showLLMConfigPanel(trigger, sessionId)` | `extension.ts` / `electron/main.ts` 的视图加载补弹（`startup`）；`WebviewMessageHandler` 的新对话引导（`new-conversation`）与 `requestLLMConfig` 回包（`request`） |
| `pushContextLimit(sender)` | `extension.ts` / `electron/main.ts` 的视图加载初始化推送（`sender` 为 `null` 走默认路由）；与 webview 的 `requestContextLimit` 共用 `WebviewMessageHandler` 的同一份实现 |
| `setActiveSessionId(sessionId)` | Electron 宿主在活动视图切换时回填（`electron/main.ts` 接线）：`WebviewMessageHandler` 的按会话解析（技能 / MCP 列表等）依赖它指向真实活动视图 |
| `setOpenSessions(sessionIds)` | Electron 宿主在打开集合变化时回填（`electron/main.ts` 接线） |

---

位置：`src/host/SessionUiState.ts`（host 层，宿主无关，两端共用）。
持有者：`WebViewUI` 的 `public readonly sessionUi`（第 1 节）。

`SessionUiState` 是 host 侧「按会话」的 UI 运行时状态容器：只保存三张 `Map` 与纯逻辑，
不触碰任何宿主 API（推送通道与视图生命周期由宿主负责，见类头注释）。它回答一个 UI 问题：

**该会话现在该显示什么动画**（`getActivityPhase`）——webview 重新打开会话时据此恢复
thinking / text / tool 动画（`conversationLoaded.activityPhase`，第 2 节）。

abort 按钮的可用性**不在这里**：它是「会话非空闲」，读 core 的 `sessionRuntime`
（`sessionRuntimeStates`），webview 自己推导。

```ts src=src/host/SessionUiState.ts
export type SessionActivityPhase = 'idle' | 'thinking' | 'text' | 'tool';

export class SessionUiState {
  // ===== 活动阶段 =====
  getActivityPhase(sessionId: string): SessionActivityPhase;
  markThinking(sessionId: string): void;
  markText(sessionId: string): void;
  markIdle(sessionId: string): void;

  /** 工具开始：递增并发计数并进入 tool 阶段 */
  beginToolPhase(sessionId: string): void;
  /** 工具阶段中（不改变并发计数） */
  markToolPhase(sessionId: string): void;
  /** 工具结束：递减并发计数，全部结束后回到 idle */
  endToolPhase(sessionId: string): void;

  // ===== 查询计数 =====
  /** 返回 true 表示这是该会话本轮的第一次 begin */
  beginQuery(sessionId: string): boolean;
  /** 返回 true 表示这是该会话本轮的最后一个 end */
  endQuery(sessionId: string): boolean;
  /** 该会话自己的查询是否在跑（收到 queryBegin、尚未收到 queryEnd；跨轮次恒为 true） */
  isQueryActive(sessionId: string): boolean;

  // ===== 生命周期 =====
  /** 会话关闭 / 删除：移除该会话的全部 per-session 状态（防长期运行累积） */
  dropSession(sessionId: string): void;
}
```

## 5. 三张表

| 表 | 键 → 值 | 写入方 | 读取方 | 作用 |
| --- | --- | --- | --- | --- |
| `activityPhases` | sessionId → `SessionActivityPhase` | `markThinking` / `markText` / `markIdle` / `beginToolPhase` / `markToolPhase` / `endToolPhase` | `getActivityPhase` | 渲染阶段，跨会话切换恢复动画 |
| `activeToolCounts` | sessionId → number | `beginToolPhase` / `endToolPhase` | `endToolPhase`（判定归零） | 工具并发计数 |
| `queryActiveCounts` | sessionId → number | `beginQuery` / `endQuery` | `endQuery`（去重）、`isQueryActive`（`> 0`） | 查询计数（`queryBegin` / `queryEnd` 只发一次）；`isQueryActive` 是 `conversationLoaded.hasActiveQuery` 的唯一来源 |

三张表都不做「会话是否存在」的兜底：未记录即视为 `idle` / 计数 0。写入方是
`WebViewUI` 的渲染 handler 与控制面 handler（第 2 节），`SessionUiState` 自己不订阅事件。

## 6. 活动阶段：谁在什么时候写

| 阶段写入 | 调用点（`WebViewUI`） | 说明 |
| --- | --- | --- |
| `markThinking` | `onQueryBegin` | 查询开始立即显示 thinking，覆盖前置耗时 |
| `markThinking` | `onAIBegin` | 每轮 LLM 调用开始 |
| `markThinking` | `onStreamMessage`（`role !== 'assistant'`） | 流式非 assistant 内容 |
| `markText` | `onStreamMessage`（`role === 'assistant'`） | assistant 文本流式输出 |
| `beginToolPhase` | `requestToolPermission` | 进入工具阶段**并递增**并发计数（含等待用户授权 / 权限检查） |
| `markToolPhase` | `onToolCall` | 工具调用确认后保持 tool 阶段，不改计数 |
| `endToolPhase` | `onToolResult` | 递减计数，归零才回 `idle` |
| `markIdle` | `onAIEnd` / `onQueryEnd` | 每轮 LLM 结束 / 整轮查询结束 |

`beginToolPhase` 与 `endToolPhase` 严格 1:1（同一会话可并发多个工具），所以用**计数**而不是
布尔：只要还有一个工具没结束，阶段就停在 `tool`。`endToolPhase` 在计数已为 0 时直接返回
（重复结束不破坏状态）。`markToolPhase` 只改阶段不改计数，因此 `onToolCall` 不会让计数失衡。

## 7. 查询计数：`queryBegin` / `queryEnd` 去重

`beginQuery` / `endQuery` 是**引用计数**，返回值表达「是不是第一个 / 最后一个」：

- `beginQuery` 返回 `true` 仅当该会话本轮第一次 begin。`WebViewUI.onQueryBegin` 只在 `true`
  时 `markThinking` + `setThinkingAnimation(true)` + 投递 `queryBegin`；
  嵌套 begin 打日志后忽略——保证一次查询只发一次 `queryBegin`。
- `endQuery` 返回 `true` 仅当最后一个 end。`WebViewUI.onQueryEnd` 只在 `true` 时 `markIdle` +
  显式 `setThinkingAnimation(false)` + 投递 `queryEnd` +
  `onConversationListChanged()`；没有对应 begin 的 end 打日志后忽略。
- 它**不**参与 abort 判定（那是 core `sessionRuntime` 的事实，见第 8 节）。

同一 session 的 begin / end 可能来自多个调用方（前台查询、子代理、后台任务），计数把它们
收敛成「一次查询」。这也是「查询」与「活动阶段」分开两张表的原因：阶段是最后一次写入的
快照，计数才是可嵌套的事实。

## 8. abort 按钮：读 core 的 `sessionRuntime`，不由这里判定

abort 按钮的三态（红 / 黄 / 灰）与中止范围由 core 的 `sessionRuntime` 根事实决定
（[docs/core/session-runtime.md](../core/session-runtime.md)）——所以它不属于 `SessionUiState`。`queryActiveCounts` 只服务两件事：
`queryBegin` / `queryEnd` 去重，以及 `isQueryActive`（`conversationLoaded.hasActiveQuery` 的
来源，见 10.1 / 第 2 节）。完整规格见 `docs/features/abort-button.md`。

链路（没有宿主推送，全是状态）：

| 环节 | 行为 |
| --- | --- |
| core | `sessionRuntime` 按来源记账 `query` / `waiting` / `compacting` / `background` 并递归子代理 → `sessionRuntimeChanged`（每会话的 `idle` / `waiting` / `queryRunning` / `compacting` / `backgroundRunning` / `subAgentRunning`，以及悬停明细 `backgroundTasks` / `subAgentDescription`） |
| 宿主 | `ConversationManager.dispatchStates` 把状态快照推给 webview（VS Code 推单视图；Electron 广播给所有聊天视图） |
| webview | `App.tsx` 取当前会话快照 + 工作模式 → 纯函数 `resolveAbortButtonState`（`src/host/abortButtonState.ts`）给出 `query` / `background` / `none` → `InputArea` 按状态取红 / 黄 / 灰与可点性；黄色态悬停满 1 秒显示只读明细浮层——任务清单读快照 `backgroundTasks`，子代理由唯一纯函数 `collectRunningSubAgents`（`src/shared/sessionRuntime.ts`）按 `parentSessionId` 聚合（specs/019 FR-002 / FR-003，点击穿透不产生上行） |

好处：前台查询结束后、但后台 Bash 或非 idle 子代理还在时，按钮保留为可点的黄色——
那是「会话仍在收尾」的真实含义，点下去中止的是这些残留工作，而不是再次中止已经停下的查询。
spin 模式同样归入黄色档：父会话的消费循环被 SpinLoop 占用，快照里的 `queryRunning`
为真，但跑的**不是** query engine，按钮只用于中止 spin 的子代理。spin 是单向模式：
循环结束与恢复态 spin 都不退出，空闲时点击为空操作。点下按钮后 Core 侧 `Core::on_abort`
依据同一份事实决定范围：spin 模式递归中止子代理与后台任务并让 SpinLoop 收尾，常规会话
前台有工作只中止前台（`abort_foreground`），前台空闲则中止后台 Bash 任务并递归子代理
（`abort_background_tasks` + 递归 `abort_session_scope`），两阶段都幂等。

## 9. 生命周期：dropSession

三张表是长期存活的 `Map`，不清理会随会话数无限增长。`dropSession(sessionId)` 一次性删除该
会话的全部 per-session 状态。实际调用路径是 `WebViewUI.releaseConversation`
（会话关闭 / 删除 / 空闲回收都会走到它，第 1 节）：

```ts src=src/host/WebViewUI.ts
releaseConversation(sessionId: string): void {
  // 临时 `new-` key 不发 conversationClosed（第 1 节）
  if (!isTemporarySessionId(sessionId)) {
    requireEventBus().emitToCore({ type: 'conversationClosed', sessionId }); // core 卸内存
  }
  this.dropSession(sessionId); // UI 侧 fan-out
}

/** fan-out 给所有持有 per-session 状态的子模块 */
dropSession(sessionId: string): void {
  this.sessionUi.dropSession(sessionId);                    // 阶段 / 工具计数 / 查询计数
  this.userChoiceManager.dropSession(sessionId);            // 挂起的选择回调 + diff 快照
  this.webviewMessageHandler.dropTrackedSession(sessionId); // tracked active session
  this.onQueuedMessage(sessionId, null);                    // 会话释放 → 清排队项（发 clearQueuedMessage）
}
```

**fan-out 覆盖的 per-session 状态**：

| 持有者 | 清理内容 |
| --- | --- |
| `SessionUiState` | `activityPhases` / `activeToolCounts` / `queryActiveCounts` |
| `UserChoiceManager` | `pendingUserChoices` 中属于该会话的回调；diff 快照（仅当归属于该会话） |
| `WebviewMessageHandler` | `trackedActiveSessionId` |
| webview 排队项 | 经 `onQueuedMessage(sessionId, null)` 向该会话的视图发 `clearQueuedMessage` |

`UserChoiceManager` 的 diff 快照是「当前请求」的全局暂存位（不带会话键），
所以用 `diffSnapshotSessionId` 记录最后写入方，`dropSession` 只在归属该会话时清空，
避免误伤其它会话正在进行的 Edit / Write。

**core 侧配套**：`releaseConversation` 发的 `conversationClosed` 由 Core 处理
（`on_conversation_closed` → `drop_session`）：拒绝该会话挂起的用户选择、丢弃 core 侧
该会话的 `idle` / `waiting` 状态（[docs/core/session-runtime.md](../core/session-runtime.md)），避免侧栏黄灯 / 托盘状态点残留——否则等待方
（工具权限确认 / `AskUserQuestion`）会永久挂起，且队列在会话关闭后仍会尝试弹出该会话的选择框。拒绝以异常形式传播：
权限确认按 **deny** 处理（与 `toolPermissionRequested` 的失败兜底同一口径），
`AskUserQuestion` 由工具执行层统一捕获转成工具错误。

## 10. 与 core 的 `SessionRuntimeState` 的边界

`SessionUiState` 是**渲染投影**，不是运行时事实的 owner（[docs/core/session-runtime.md](../core/session-runtime.md)）：

| | `SessionUiState`（host） | `SessionRuntimeState`（core） |
| --- | --- | --- |
| 数据源 | wire 消息（`streamMessage` / `queryBegin` / 工具回调） | core 内部状态（引擎池 / 后台任务 / 子代理 / 压缩 / 待用户输入） |
| 用途 | 每会话动画阶段（`getActivityPhase`） | 运行时根事实（`idle` / `waiting` / `queryRunning` / `compacting` / `backgroundRunning` / `subAgentRunning`），进 `CoreEvent`（abort 按钮读它） |
| 谁写 | 只有 UI handler | 只有 core |
| 角色 | 渲染投影 | 唯一事实 owner |

**禁止互相写值**：`WebViewUI.onSessionRuntimeChanged` 只读转发给
`ConversationManager.updateSessionStates`，不写回；也不能从 `SessionUiState` 反推
`SessionRuntimeState`。互为对账可以，互相写值不行（两者数据源不同：一个看 wire 消息，
一个看 core 内部状态）。

---

## 11. 消息区视图行为：跳到底部、发送模式与一次性通知

三个纯 webview 渲染层行为（宿主类不参与，无新 wire / 事件；发送的入口语义见
[docs/features/user-message-pipeline.md 第 2 节](../features/user-message-pipeline.md#2-功能需求)）：

| 行为 | 规格 |
| --- | --- |
| 跳到底部 | 显示唯一入口是「一次向下的滚动手势」：消息区内相邻向下滚轮输入间隔 ≤150ms 归同一次手势，手势内累计的实际滚动位移（scroll 监听按 scrollTop 增量累加，以「用户已滚离 + 手势窗口活跃」双守卫排除流式跟随等程序化位移；回底即清零重新累计）超过消息区可视高度 1/3 且当前不在底部时，右下角（距右 / 底缘各 12px）以 150ms opacity 过渡淡入圆形按钮。触发源仅限滚轮——键盘、滚动条拖动、触摸产生的滚动不触发；滚动条拖动按下即隐藏且不自动恢复（按下命中 = 事件派发到容器本身且 offsetX 落在滚动条槽）。回底（distance ≤ 2，含点击回底 / End / 会话切换强制回底）、拖动按下、点击按钮、用户向上滚动（任意幅度，以 1s 内有真实用户滚动输入为前提——布局收缩的 scrollTop 回退不误判；同时清零手势累计）任一即隐藏。按钮常驻挂载：`data-hidden` 标记显隐，隐藏态 `pointer-events: none` 不拦点击、不进 a11y 树、不可聚焦；z 序 30——所有真实用户消息常驻 `user-msg-pin` 的 zIndex 10 且消息容器后于按钮绘制，同 z 序会被落进按钮区域的消息盖住，故高于吸附容器（10）、低于会话加载遮罩（40）。点击清滚离抑制并强制回底、恢复自动跟随。自动滚动抑制（滚离标志）与按钮显隐解耦——滚轮上滚仍抑制自动跟随但不再显示按钮；不带未读计数 |
| 发送模式 | 发送按钮为 split 形态：主按钮恒为立即发送；小三角下拉含「立即发送 / 空闲发送」，两项为当次动作（不记住选择），禁用口径与主按钮一致（无内容 / 输入禁用 / 连接或配置加载中 / 已有忙碌排队项或空闲挂起项）。空闲挂起的语义（webview 本地挂起、快照触发、中止回填、清除与重载丢失）见 FR-003 |
| 一次性通知 | `once: true` 的消息不进 `<sid>.jsonl`、不进内存消息列表与 LLM 上下文；core 只把它记进 `meta.json` 的 `onceMessage`（一个对话至多一条，后到覆盖先到），写入点是 LLM 失败回显 / `*User Interrupted*` 两处，清空时机是任一消息落盘（`touch_metadata`）或整批替换（`replace_messages`）。webview 侧：任何**追加新节点**的入口先剥除已有 once 节点（`stripOnce`），就地更新（工具状态推进 / 参数 / 流式增量）保留；`conversationLoaded` 把 `metadata.onceMessage` 追加到时间线末位，因此时间线至多一条且总在末位。宿主失联提示（`bootstrapCore.ts` 的 `markConnectionSessionsFailed`）只当次显示、不记 meta——此刻 Core 已不可写 |
