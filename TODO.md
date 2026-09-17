# TODO：DEVELOPMENT.md 检视结果

> 检视日期：2025-09-18
> 检视范围：DEVELOPMENT.md（2131 行，第 1–13 章）全文，逐章与 `src/`、`electron/` 当前代码对照。
> 检视方法：逐条核对事件定义（`src/core/AssistantEventBus.ts`）、契约接口、实现类、bootstrap 接线、
> wire 协议、目录布局与分层规则；`npx tsc --noEmit` 全量类型检查通过（exit 0）。
>
> 总体结论：文档质量较高，第 1–5、7–11 章的主体内容与代码高度一致；问题集中在
> **个别设计已演进但文档未跟上**（预览浮层、refreshAbortState、trackPreviewWindow、onChoiceShown、
> isActiveQueryInScope）、**文档内部两处表格自相矛盾**（8.3 vs 11.1）、**两个真实断链**
> （updateConversationContext 未走总线、dropSessionRuntime 无人调用）。

---

## P0 文档与代码不一致（文档失真，须改文档或改代码）

### 1. §12.5 「预览归 webview」一节基于不存在的组件
- **文档**：§12.5（行 2061–2074）称「webview 里已有页内预览浮层 `src/webview/PreviewOverlay.tsx`
  （`text` / `image` / `diff` / `mermaid` 四种模式），宿主把内容取出来、按 `sessionId` + `clientId`
  回推（`openPreview`）」。
- **代码**：全仓库不存在 `PreviewOverlay`、`openPreview`（webview / host / webviewTypes 均无此消息与文件）。
  现状是：webview 内 mermaid 代码块点击后发 `openMermaidPreview`，由**宿主**开原生窗口
  （VS Code：`WebviewPanel`；Electron：复用 `BrowserWindow`）；diff 只在工具卡片里渲染；
  图片/文本没有页内浮层。
- **影响**：§12.5 的原则表述（「预览归 webview，宿主只在没有页内渲染能力时才开原生窗口」）目前
  只剩 diff 卡片这一处支撑，mermaid 实际走的是「宿主原生窗口」。
- **动作**：改写 §12.5——要么删掉 PreviewOverlay/openPreview 的描述、按现状重写；
  要么真正实现该组件。两者取一，保持「只写现状」。

### 2. §4.3 「宿主尚未经总线发送它们」已过时（conversationStarted 已走总线）
- **文档**：行 757–759：「这两个事件当前由 `handleStartNewConversation` / `handleLoadConversation`
  直接调 core 函数完成（`Integration.createEngine` / `restoreConversationEngine`）；总线上的订阅已就位，
  **宿主尚未经总线发送它们**。」
- **代码**：`src/host/ui/webviewMessageHandler.ts:867` 已
  `await this.emitUiEvent({ type: 'conversationStarted', ... })`，core 侧
  `initializeCoreEvents.ts:80` 订阅后调 `createEngine`。
- **现状**：`conversationStarted` **已经走总线**（表格 #27 本身也是这么写的，仅说明句过时）；
  `conversationOpened` 仍无发送方（`handleLoadConversation` 直接调 `restoreConversationEngine`）。
- **动作**：删除说明句中关于 `conversationStarted` 的部分，只保留 `conversationOpened` 的「无发送方」表述。

### 3. §6.2 / §10.3 `refreshAbortState()` 在代码中不存在
- **文档**：三处提到该方法：
  - §6.2 控制面 handler 表（行 1232、1233）：`onQueryBegin` / `onQueryEnd` 流程里有 `refreshAbortState()`；
  - §6.2 投递路径（行 1253）：`postConversationLoaded` 投递后再 `refreshAbortState()`；
  - §10.3（行 1800–1804）：`onQueryBegin` / `onQueryEnd` 的步骤里有 `refreshAbortState()`。
- **代码**：`refreshAbortState` 在整个 `src/` 中不存在（grep 零命中）。abort 按钮状态已改为
  webview 从 `sessionRuntimeStates` 推导（§10.4 自己也是这么写的）。
- **动作**：删除三处 `refreshAbortState()` 步骤描述（§6.2 两处 + §10.3）。

### 4. §8.2 / §8.4 / §8.6 的 `trackPreviewWindow` 不存在
- **文档**：
  - §8.2 ElectronUIHost 引文（行 1488）：`trackPreviewWindow(win): void;  // 辅助窗口统一关闭（closePreview）`；
  - §8.4 实现要点（行 1551）：ElectronSpinDesign 构造依赖「`host` + `trackWindow`（注册辅助窗口）」；
  - §8.6 electron/main.ts 引文（行 1613）：`new ElectronSpinDesign(host, (win) => host.trackPreviewWindow(win))`。
- **代码**：`ElectronUIHost` 没有 `trackPreviewWindow` 方法；`ElectronSpinDesign` 构造只有
  `constructor(private readonly host: UIHost) {}`（`electron/ElectronSpinDesign.ts:24`）；
  `main.ts:1449` 为 `new ElectronSpinDesign(host)`。
- **动作**：删除三处 trackPreviewWindow / trackWindow 描述。

### 5. §8.3 与 §11.1 两张对照表自相矛盾（两行）
- **`getLocale`**：
  - §8.3（行 1511）：`app.getLocale().startsWith('zh') ? 'zh' : 'en'`（归一化）；
  - §11.1（行 1910）：原始 BCP-47，不做归一化。
  - **代码**（`electron/ElectronUIHost.ts:91-95`）：返回原始 `app.getLocale()`，注释明确「与 VS Code 同一值域，不做归一化」。→ §8.3 过时，按 §11.1 / 代码修正。
- **`closePreview`**：
  - §8.3（行 1516）：Electron「关闭全部 `previewWindows`」；
  - §11.1（行 1915）：Electron「空实现：Monaco / Mermaid 是独立窗口，不属于宿主侧预览」。
  - **代码**（`electron/ElectronUIHost.ts:133-140`）：空实现，类中没有 `previewWindows` 字段。→ §8.3 过时，按 §11.1 / 代码修正。
- **动作**：修正 §8.3 这两行，并全文检索是否还有同源旧句。

### 6. §6.1 / §7.1 `onChoiceShown`「Electron 用它刷新侧栏」已过时
- **文档**：三处：行 1135（§6.1 deps 表「Electron 传 `onChoiceShown`（选择框弹出后刷新侧栏）」）、
  行 1310（§7 开头）、行 1326（§7.1 构造依赖表）。
- **代码**：`electron/main.ts:1477-1480` 的 `createUserChoiceManager` **没有传** `onChoiceShown`，
  注释明确「用户选择框弹出（ask user / 权限确认）不再刷新侧栏：waiting 由 core 的
  sessionRuntimeChanged → dispatchStates 推给侧栏（黄灯）与托盘」。
  `src/host/ui/userChoice.ts:40-41` 的钩子还在（可选），但类注释「刷新侧栏流水灯为黄色」也已过时。
- **动作**：文档删除/改写 `onChoiceShown` 相关三处（可注明「当前无人使用的可选钩子」或直接收掉）；
  顺带修 `userChoice.ts` 注释。

### 7. §8.1 `isActiveQueryInScope` 属性不存在
- **文档**：行 1461（§8.1 引文）：`isActiveQueryInScope: (sessionId: string) => boolean; // 默认 () => false`。
- **代码**：`src/VSCodeUIHost.ts` 无此属性；bootstrap 只注入 `getActiveSessionId`。
- **动作**：删除 `isActiveQueryInScope` 行。

### 8. §1.3 目录布局：`DiffUriPair` 不存在
- **文档**：行 121：「`src/host/ui/types.ts` | 共享子模块的接口定义（`DiffUriPair` 等）」。
- **代码**：`src/host/ui/types.ts` 只有 `ShowVirtualDocumentEvent` / `ShowContentInVirtualDocumentEvent` /
  `ShowDiffInVirtualDocumentEvent`；diff URI 相关类型叫 `DiffUris`，且定义在
  `src/VSCodeUIHost/diffUris.ts`（不在共享层）。
- **动作**：改为「（`ShowVirtualDocumentEvent` / `ShowDiffInVirtualDocumentEvent` 等）」。

### 9. §4.1 #1 `message` 触发点多了 `CommandDispatcher`
- **文档**：行 670：触发点含「`CommandDispatcher`」。
- **代码**：`CommandDispatcher.ts` 只发 `commandDispatched`（行 92），不发 `message`。
  `message` 的实际触发点：`Integration`、`Query`、`QueryEngine`、`history/rollback`、
  `spin/Loop`、`initializeCoreEvents`（conversationSpaceCleared 回显）、`utils/replayMessages`。
- **动作**：从触发点列表删去 `CommandDispatcher`（若需补全，可加 `initializeCoreEvents`）。

### 10. 头注「第 12–14 章待补写」与目录矛盾
- **文档**：行 6「当前版本包含第 1–11 章，第 12–14 章待补写」；目录表却是 1–13 全「已完成」且无第 14 章。
- **动作**：头注改为「当前版本包含第 1–13 章」。

### 11.（断链）§4.3 #32 / §7.3 称 `updateConversationContext` 走 UiEvent，代码直调 core
- **文档**：§4.3 #32 将其列为 UiEvent（core 消费方 `history.updateConversationContext`）；
  §7.3 分发表「会话生命周期」区注释「（后三者 → `UiEvent`）」把 `updateConversationContext`
  算在翻译之列；§2 规则 9 / §5.5 也要求「改 core 状态的请求一律翻译为 UiEvent」。
- **代码**：`src/host/ui/webviewMessageHandler.ts:849-860` 的 `handleUpdateConversationContext`
  **直接 `import` 并调用** `updateConversationContext`（core 状态变更函数），没有 `emitUiEvent`。
  `initializeCoreEvents.ts:223` 的订阅目前只服务 `extension.ts` 的 `persistCurrentFileContext`。
- **影响**：同一份 core 状态有两条写入路径（总线 + 直调），违反文档自己声明的原则 12.7
  「一份事实只有一个写入点」与 5.5 的翻译约定。
- **动作**：二选一——
  a) 改代码：`handleUpdateConversationContext` 改为 `emitUiEvent({ type: 'conversationContextUpdated', ... })`
     （注意载荷是 `changes` 数组，与 webview 消息的扁平字段不同，需在 handler 里做映射）；
  b) 或改文档：把它加进 §4.3/§7.3 的「留在 WebviewMessageHandler 的例外」并说明理由。
  建议选 a（与既定原则一致）。

### 12.（断链）§4.5 称 `dropSessionRuntime` 由 `releaseSessionResources` 调用，实际无人调用
- **文档**：§4.5 表最后一行：`dropSessionRuntime(sessionId)` 的调用点是
  「`sessionResources.releaseSessionResources`」。
- **代码**：`dropSessionRuntime` 在生产代码中**零调用**（仅 `sessionRuntime.test.ts` 使用）；
  `releaseSessionResources` 的清理步骤（abort → rejectPending → flush → 引擎池 →
  unmarkPendingCompact → 缓存 → MCP）不包含它；`deleteConversation` 也没有。
- **影响**：会话关闭后，`sessionRuntime` 里该会话的 `running` / `waiting` 残留：
  若会话在「等待用户」时被关闭（空闲回收 / 删除），侧栏黄灯 / 托盘状态点可能长期不熄灭。
- **动作**：修代码——在 `releaseSessionResources`（以及 `deleteConversation` 的清理路径）中调用
  `dropSessionRuntime(sessionId)`；若有意不清理，则改文档并说明理由。

---

## P1 口径不一致（统一措辞）

### 13. §3.7 / §12.1 与代码注释的超时口径矛盾
- **文档**：§3.7「**当前两个请求都不设超时**」；§12.1 同口径。
- **代码注释**：`src/core/AssistantEventBus.ts:16`「request() 的响应方不存在或响应丢失 → 永久挂起；
  **调用点必须自带超时**」；`src/host/EventBus.ts:11`「request() 无内置超时：**调用点必须自带超时兜底**」。
- **动作**：统一为文档口径（「总线不内置超时；当前两个请求都不设超时，调用点自行决定兜底」），
  修改两处代码注释。

### 14. §5.2 「UIHost 已承载 16 个成员」实际是 15 个
- 数一遍 `src/host/UIHost.ts`：sendToWebview、log、getWorkspacePath、isDarkTheme、getLocale、
  openFile、showVirtualDocument、showDiff、openMermaidPreview、closePreview、openExternalUrl、
  saveTextFile、closeConversationView、updateSettingsJson、ensureProjectSettings = 15。
- **动作**：§5.2 理由 2 的「16」改「15」。

### 15. §8.5 / §8.6 ElectronConversationManager 构造依赖少了第三个参数
- **代码**：`electron/ElectronConversationManager.ts:25-33` 构造为
  `(host, sendToSidebar, sendToChatViews)`，第三个参数（`ChatViewManager.broadcast`）
  是 `dispatchStates` 广播给所有聊天视图（abort 按钮数据源）的出口。
- **文档**：§8.5「构造依赖 | `host: UIHost` + `sendToSidebar(channel, payload)`」漏了第三参；
  §8.6 引文同样只给两个参数。
- **动作**：补上 `sendToChatViews(message)`（广播出口）。

### 16. §4.5 `setSessionRuntimeWaitingProvider` 在生产代码中从未注册
- **文档**：§4.5「`setSessionRuntimeWaitingProvider`（「该会话是否有 pending user choice」读取器）
  是它的补充来源」——读起来像生产接线的一部分。
- **代码**：仅 `sessionRuntime.test.ts` 注册过；`extension.ts` / `main.ts` 注册的是另一个
  provider（`sessionResources.setSessionWaitingForUserProvider`，服务 `isSessionBusy`）。
- **动作**：文档注明「当前仅测试使用，生产未注入」；或评估是否该接上（若接上，
  `markQueryRunning` 时 waiting 会随 provider 重算，行为更一致）。

---

## P2 小遗漏 / 润色

### 17. §4.3 #29 `conversationClosed` 的 UI 触发点缺 Electron 视图销毁序列
- §6.4 / §6.1 已说明 `ChatViewManager` 销毁序列走 `releaseConversation`，但 §4.3 表 #29 的
  触发点只列「关闭按钮 / 侧栏关闭 / VS Code 空闲回收」。补「Electron 视图销毁序列
  （`ChatViewManager.closeConversation` → `releaseConversation`）」。

### 18. §5.5 「载体 / 视图层动作」未列 webview → 宿主的视图层消息
- `closeWebview` / `openConversation` / `prewarmViewReady` 由 `electron/main.ts` 直接处理
  （不经 `WebviewMessageHandler`、不走总线）。§5.5 该行只列了侧栏 IPC 四条，建议补这三条，
  并注明它们在 `main.ts` 的消息入口直接消化。

### 19. §1.4 类图 `WebViewUI` 成员缺 `releaseConversation`
- §6.4 已列；类图补 `+releaseConversation(sessionId)`（与 §6.1 的拆分描述呼应）。

---

## 代码注释与文档漂移（改代码注释即可，不改行为）

### 20. 「abort scope」是残留概念
- `src/host/WebViewUI.ts:36,162` 与 `src/host/ui/ports.ts:44` 注释里的
  「阶段 / 工具计数 / 查询计数 / **abort scope**」——`SessionUiState` 没有这个概念
  （abort 判定归 core `sessionRuntime`，§10.4）。删去「abort scope」字样。

### 21. `userChoice.ts` 的 `onChoiceShown` 注释过时
- 类注释 / 字段注释仍写「Electron 用它刷新侧栏（黄灯）」，实际 Electron 不再传该回调
  （见 P0 #6）。与文档一起修正。

### 22. 总线头注释的超时措辞（同 P1 #13）
- `src/core/AssistantEventBus.ts:16`、`src/host/EventBus.ts:11`。

---

## 核对通过、无需处理的部分（摘要）

以下经逐条对照确认**与代码一致**，本次未发现问题：

- **事件契约**：`CoreEvent` 23 / `CoreRequest` 2 / `UiEvent` 18，共 43 个，类型与载荷逐一对上；
  `CoreEventHandlers` / `CoreRequestHandlers` 映射类型、`request<T>` 泛型签名、
  `CoreRequestResultMap` 与代码一致；§4 逐事件的触发点与处理方除 P0 #9 外全部准确。
- **总线语义**：`emitToUi` 未注册抛错、`emitToCore` 无订阅者静默丢弃、`request` 无 handler 立即 reject、
  重复注册抛错——与 `src/host/EventBus.ts` 完全一致。
- **bootstrap**：`createEventBus → setGlobalEventBus → initializeCoreEvents → WebViewUI.create`
  顺序、`extension.ts` / `main.ts` 的注入顺序（VS Code 节引文逐行核对通过）。
- **分层规则**（§2）：`src/host/**` 无 `vscode`/`electron` import；无 `host.kind` 嗅探；
  契约成员全部必选；electron/tsconfig 的 include 硬约束描述与实际一致。
- **三契约**：`UIHost`（15 成员逐一对照 §8.3 除两行外准确）、`SpinDesign`（open/refresh + 消息协议）、
  `ConversationManager`（抽象类模板方法、两条流、快照、VS Code 空闲回收 2h/1min、`isSessionBusy` 口径）。
- **`sessionRuntime`**（§4.5）：五个 mark 函数的来源/调用点、按来源合并 running、推全量——一致
  （仅 dropSessionRuntime 调用点除外，见 P0 #12）。
- **`SessionUiState`**（§10）：三张表、方法签名、10.2 写入点、10.3 计数去重、10.5 fan-out——一致。
- **`HostInfo`**（§9）：接口、两个常量、三个派生函数、注入点（extension.ts 内联 / preload
  contextBridge）、校验逻辑、App.tsx / Main.tsx / webviewEnv 消费点——一致。
- **MCPHost**（§5.3）：成员、触发点（createEngine / restoreConversationEngine / releaseSessionResources /
  deleteConversation / bootstrap prune / 退出 shutdown）、opChain 串行——一致。
- **SpinDesign**（§5.2）：契约、共享物、消息协议（refreshSpinDesign / saveSpinDesign /
  exportSpinDesign ↔ spinDesignData / spinSaveResult / spinExportResult）——一致。
- **Electron 侧栏三流**（§5.4/§8.5/§11.1）：`sidebar:conversations-updated` /
  `sidebar:session-states-updated` / `sidebar:session-loaded-changed` 的分工、
  `getCachedList` / `invalidateCachedList` 快照、托盘 `statusListener`——一致。

---

## 建议的处理顺序

1. 先修 P0 #11 / #12（两个真实断链，涉及行为，需单独提交 + 补测试）。
2. 再统一改文档（P0 #1–10、P1 #14–16）与文档内引文（P1 #13、P1 #15）。
3. 最后顺手清理代码注释（P2 #17–19 与代码注释三条），一次小提交。
