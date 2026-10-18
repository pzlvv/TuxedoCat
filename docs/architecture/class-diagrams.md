---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：架构类图

本文用两张类图描述事件契约与 UI 侧、core 侧与总线的静态结构（as-built），图注给出
逐条边界澄清。分层与模块职责见 [overview.md](overview.md)，事件词汇表见
[events.md](events.md)，宿主契约成员见 [contracts.md](contracts.md)。

## 1. 事件契约与 UI 侧

```mermaid
classDiagram
  direction LR

  %% ==================== 事件契约（core 与 UI 之间唯一的耦合点）====================
  class CoreEvent {
    <<type>>
    message / streamMessage / streamEnd
    toolCall / toolResult / toolArgsUpdated / toolProgress
    aiBegin / aiEnd / messagesReplaced
    queryBegin / queryEnd / titleChanged / sessionCreated
    conversationListChanged / conversationSpaceCleared / sessionRuntimeChanged
    spinDesignDataChanged / compactBegin / compactEnd
    commandDispatched / sessionConfigChanged
  }

  class CoreRequest {
    <<type>>
    toolPermissionRequested
    userChoice
  }

  class UiEvent {
    <<type>>
    abortRequested / compactRequested
    conversationStarted / Opened / Closed
    conversationRenamed / Deleted
    conversationContextUpdated / conversationSpaceCleared
    modelChanged / thinkingEffortChanged / promptModeChanged
    agentModeChanged / webSearchChanged / mcpEnabledChanged
    mcpEnabledListChanged
    editRolledBack
  }

  class CoreEventHandlers {
    <<type>>
    穷尽 CoreEvent 的全部 type
  }

  class CoreRequestHandlers {
    <<type>>
    穷尽 CoreRequest 的全部 type
  }

  class AssistantEventBus {
    <<interface>>
    +emitToUi(event)
    +request(request)
    +onCoreEvents(handlers)
    +onCoreRequests(handlers)
    +emitToCore(event)
    +onUiEvent(type, handler)
  }

  class EventBusModule {
    <<module>>
    +setGlobalEventBus(bus)
    +requireEventBus()
    +resetGlobalEventBus()
  }

  %% ==================== 启动接线（宿主无关）====================
  class BootstrapCore {
    <<module>>
    +bootstrapCore(host, spinDesign, conversations, options)
    +bootstrapSnapshot()
    +shutdownCore()
  }

  %% ==================== UI 实现 ====================
  class WebViewUI {
    唯一的 UI 实现，不实现事件契约
    +create(host, bus, spinDesign, conversations, deps)
    +getInstance()
    +handleWebviewMessage(message, ctx?)
    +releaseConversation(sessionId)
    +closeConversation(sessionId)
    +getActivityPhase(sessionId)
  }

  class WebViewUiPort {
    <<interface>>
    +postToWebview(sessionId, message)
    +postConversationLoaded(sessionId, conversation, extra)
    +onTitleChanged(sessionId, title)
    +onQueuedMessage(sessionId, content, images, fileInfo)
    +dropSession(sessionId)
    +getActiveSessionId()
    +openSpinDesign()
    +refreshConversations()
  }

  class WebviewPoster {
    <<type>>
    投递函数 (sessionId, message)
  }

  %% ==================== 共享子模块 ====================
  class SessionUiState {
    活动阶段与计数
  }
  class ToolHandler {
    工具卡片生命周期
  }
  class UserChoiceManager {
    用户选择队列与预览
  }
  class WebviewMessageHandler {
    webview 消息分发，翻译为 UiEvent
  }

  %% ==================== 宿主 ====================
  class UIHost {
    <<interface>>
    对话 webview 的宿主能力
  }
  class VSCodeUIHost
  class ElectronUIHost
  class DocumentManager
  class ChatViewManager

  class SpinDesign {
    <<interface>>
    +open()
    +refresh()
  }
  class VSCodeSpinDesign
  class ElectronSpinDesign

  class ConversationManager {
    <<abstract>>
    两条流：对话列表与会话运行时状态
    +refresh()
    +updateSessionStates(states)
    #load()
    #dispatchList(list)
    #dispatchStates(states)
    +setStatusListener(fn)
    +setSidebarOutlet(fn)
    +noteSessionActivity(sessionId)
  }
  class SingleWebViewConversationManager {
    空闲会话回收（计时 / 巡检 / 关闭动作分发）
    +setActiveSessionProvider(fn)
    +setIdleCloseHandler(fn)
    +startIdleMonitor()
    +stopIdleMonitor()
    +sweepIdleSessions(now)
  }
  class ElectronConversationManager

  %% ==================== 关系 ====================
  AssistantEventBus ..> CoreEvent : 路由
  AssistantEventBus ..> CoreRequest : 路由
  AssistantEventBus ..> UiEvent : 路由
  AssistantEventBus ..> CoreEventHandlers : 批量注册
  AssistantEventBus ..> CoreRequestHandlers : 批量注册

  WebViewUI ..> AssistantEventBus : onCoreEvents / onCoreRequests / emitToCore
  WebViewUI ..|> WebViewUiPort
  WebViewUI o-- SessionUiState
  WebViewUI o-- ToolHandler
  WebViewUI o-- UserChoiceManager
  WebViewUI o-- WebviewMessageHandler
  WebViewUI o-- WebviewPoster
  WebViewUI ..> UIHost : 构造注入
  WebViewUI ..> SpinDesign : 构造注入
  WebViewUI ..> ConversationManager : 构造注入

  ToolHandler ..> UIHost : 构造注入
  ToolHandler ..> UserChoiceManager : 共享 diff 快照
  UserChoiceManager ..> UIHost : 注入的回调（closePreview / outputChannel）
  UserChoiceManager ..> WebViewUiPort : 注入的回调（getActiveSessionId）
  WebviewMessageHandler ..> UIHost : 构造注入
  WebviewMessageHandler ..> WebViewUiPort : uiPort（构造后回填）
  WebviewMessageHandler ..> AssistantEventBus : 翻译 UiEvent
  WebviewMessageHandler ..> UserChoiceManager : 共享 pending 队列

  UIHost <|.. VSCodeUIHost
  UIHost <|.. ElectronUIHost
  VSCodeUIHost o-- DocumentManager
  ElectronUIHost o-- ChatViewManager

  SpinDesign <|.. VSCodeSpinDesign
  SpinDesign <|.. ElectronSpinDesign
  VSCodeSpinDesign ..> UIHost : 宿主环境（路径 / 主题 / 语言 / 保存 / 日志）
  ElectronSpinDesign ..> UIHost : 同上

  ConversationManager <|-- SingleWebViewConversationManager
  ConversationManager <|-- ElectronConversationManager
  ConversationManager ..> UIHost : dispatchList 时使用 sendToWebview
  ElectronConversationManager ..> ChatViewManager : 订阅 loaded（视图开关）

  EventBusModule ..> AssistantEventBus : 注册与获取
  BootstrapCore ..> EventBusModule : setGlobalEventBus（注册 Client 为全局总线）
  BootstrapCore ..> WebViewUI : create
  BootstrapCore ..> UIHost : 构造注入
  BootstrapCore ..> SpinDesign : 构造注入
  BootstrapCore ..> ConversationManager : 构造注入
```

## 2. Core 侧与总线的交互

Core（`core-rs/`，Rust 独立进程）经帧通道与 UI 通信；下图为 Core 进程内各模块与总线的
静态关系（帧协议层之下，`bus.rs` 把事件写为帧）：

```mermaid
classDiagram
  direction LR

  class CoreEngine {
    engine.rs
    会话消费循环与运行时状态
  }
  class Commands {
    commands.rs
    命令解析与就地执行
  }
  class Compact {
    compact.rs
    压缩与归档
  }
  class Replay {
    replay.rs
    压缩后消息重放
  }
  class Spin {
    spin.rs / spin_host.rs
    Spin 引擎与子代理执行
  }
  class History {
    history.rs
    会话落盘
  }
  class Bus {
    bus.rs
    事件出口（帧）
  }

  class AssistantEventBus {
    <<interface>>
    +emitToUi(event)
    +request(request)
    +onUiEvent(type, handler)
  }

  CoreEngine ..> AssistantEventBus : emit 与 request
  Commands ..> AssistantEventBus : emit
  Compact ..> AssistantEventBus : emit
  Replay ..> AssistantEventBus : emit
  Spin ..> AssistantEventBus : emit
  History ..> Bus : 落盘事件
  Bus ..> AssistantEventBus : emit（帧）
```

## 3. 图注说明

1. **core 与 UI 之间不存在直接引用。** core 仅 import `AssistantEventBus` 与事件类型；
   `WebViewUI` 不实现任何事件契约，在构造时通过 `onCoreEvents` / `onCoreRequests`
   一次性注册处理器，需要通知 core 时调用 `emitToCore`。
2. `CoreEvent` / `CoreRequest` / `UiEvent` 是纯数据类型，不包含行为，
   因此 core 与 UI 对它们的依赖不构成耦合。
3. 架构中不设 `WebViewEventBus` / `WebViewNotifier` / `AssistantNotifier` / `AssistantController`。
   总线本身即路由，`WebViewUI` 直接订阅；渲染与控制均在 `WebViewUI` 内实现，
   「需要处理哪些事件」由 `CoreEventHandlers` 映射类型在编译期强制穷尽。
4. `SessionUiState` / `ToolHandler` / `UserChoiceManager` / `WebviewMessageHandler` /
   `WebviewPoster` 均由 `WebViewUI` 创建并持有。
5. 三个共享子模块（`ToolHandler` / `UserChoiceManager` / `WebviewMessageHandler`）
   只依赖 `UIHost`（宿主能力）与若干回推回调；`WebviewMessageHandler` 另有一个构造后回填的
   窄端口 `uiPort`（`WebViewUiPort` 的子集，见[contracts.md](contracts.md)）。
   其中 `WebviewMessageHandler` 还负责将 webview 协议消息翻译为 `UiEvent` 并发送至总线。
6. `WebViewUI ..> UIHost` 为构造注入（依赖关系），`VSCodeUIHost` / `ElectronUIHost` 为对应实现。
7. `SpinDesign` 是**第二个契约**，与 `UIHost` 平行。Spin 设计器是独立面板 / 窗口，
   具有独立的生命周期与消息协议，与对话 webview 不共享状态。
   其实现反向依赖 `UIHost` 以获取宿主环境（工作区路径 / 主题 / 语言 / 保存文件 / 日志）。
8. `ConversationManager` 是**第三个契约**，采用抽象类而非接口：`load()` 在两个宿主上一致，
   仅 `dispatch*()` 不同，因此由模板方法将共享部分固定在基类。
   它同样反向依赖 `UIHost`（分发时使用 `sendToWebview`）。
   它分发**两条独立的流**：对话列表（磁盘元数据）与会话运行时状态（`idle` / `waiting`）。
   两条流各自拥有独立的事件、分发方法与消费者，不合并为单一带标记列表。
   空闲会话回收（计时、巡检、关闭动作分发）只在 VS Code 的实现里（Electron 每个对话一个
   独立视图，自动关闭等于关掉用户的窗口），core 不参与计时。
9. MCP 生命周期**不是第四个宿主契约**。它在 Core 进程内（`core-rs/src/mcp.rs`），负责
   「会话生命周期 → MCP 引用」的映射，驱动信号全部来自 Core 的会话事实，而非宿主视图
   生命周期（[contracts.md 第 3 节](contracts.md#3-mcp-生命周期core-进程内)）。
