---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：架构原则

各主题规格描述现状，本文把反复出现的判断标准集中写出来。每条都给出代码里的
落点——**原则不是口号，是能指出「违反了哪一行」的那种**。

## 1. 不过度 fallback

**没有明确的合法中间态时，宁可抛错，也不静默降级。** 静默 fallback 会把
「配置漏了 / 顺序错了」推迟到运行期才暴露，而且往往被后面的代码当成正常路径吃下去。

| 场景 | 做法 | 落点 |
| --- | --- | --- |
| 宿主取总线 | `requireEventBus()` 未注册直接抛错 | `src/shared/AssistantEventBus.ts` |
| `onCoreEvents` / `onCoreRequests` 重复注册 | 抛错（处理器表只注册一次，接线错误启动期暴露） | `src/host/standalone/StandaloneEventBus.ts` |
| Core 事件在 UI 注册处理器前到达 | 排队，注册后按序补投（**合法启动窗口**） | 同上 |
| Core 收到无消费方的 `UiEvent` | 记 log 丢弃（**合法中间态**） | `core-rs/src/main.rs` 的 `dispatch_ui_event` |
| 宿主请求无处理器 | `request()` reject；总线不内置超时，**当前两个请求都不设超时**（[events.md 第 6 节](events.md#6-边界语义)） | Core 侧请求失败 → deny |
| webview 读宿主能力 | `getHostInfo()` 逐字段校验，缺失或非法直接抛错 | `src/webview/webviewEnv.ts` |
| 取 UI 单例 | `WebViewUI.getInstance()` 未创建直接抛错（替代静默 `undefined`） | `src/host/WebViewUI.ts` |
| 取启动快照 | `bootstrapSnapshot()` 未执行骨架时抛错 | `src/host/bootstrapCore.ts` |
| Core 取项目根 / 扩展路径 | `project_root(sessionId)`（未登记会话时报错）/ 扩展路径未注入直接报错 | `core-rs/src/config.rs` |
| 宿主契约成员 | 全部必选，禁止 `host.foo?.()` 静默降级（见第 2 节） | `src/host/UIHost.ts` |
| 共享文件读不出来 | 区分「不存在」与「解析失败」；后者**拒绝写入**并抛错，绝不按空内容覆盖 | `src/host/SettingsStore.ts`（第 11 节） |

允许 no-op 的只有**合法瞬时状态**，且必须注释说明理由：

- `SpinDesign.refresh()`：设计器没打开时 no-op——没人在看，不是错误。
- `ConversationManager` 的侧栏出口：侧栏尚未就绪时是 no-op 占位，就绪后由宿主替换。

判据：**这个「没有」是设计允许的状态，还是配置 / 顺序错了？** 后者必须抛。

## 2. 不让接口 / 参数可选

可选参数把「两种调用形态」藏进一个签名，调用点读不出差异，实现里到处 `?.`。
本项目的做法是：**可选语义用 `null` 或判别联合显式表达**。

- `UIHost` 与 `WebViewUiPort` 没有一个可选成员。
- 需要表达「没有」时传 `null`：`openFile(filePath, target: LineSelection | null)`。
- 需要表达「多种互斥结果」时用判别联合（`src/host/UIHost.ts`）：

  ```ts
  // 示意：判别联合表达互斥结果
  type SaveFileResult =
    | { success: true; filePath: string }
    | { success: false; canceled: true }
    | { success: false; canceled: false; error: string };
  ```

- 返回值统一 `Promise<void>`，不用 `void | Promise<void>` 联合。

## 3. 高内聚、低耦合

- **core 不认识 UI**：Core（`core-rs/`）不 import TS 侧任何代码，也不感知 UI / 宿主
  对象；两侧只经帧通道上的事件词汇表通信。
- **`src/host/` 不认识宿主**：不 import `vscode` / `electron`。宿主差异全部收在
  `UIHost` 接口上，新增宿主 = 实现这个接口（[contracts.md 第 1 节](contracts.md#1-uihost对话-webview-的宿主能力)、[docs/hosts/host-matrix.md](../hosts/host-matrix.md)）。
- **只有一份 UI 实现**：`WebViewUI` 同时服务 VS Code 与 Electron，只有一份拷贝。
- **窄接口**：`SessionUiState` / `UserChoiceManager` / `WebviewMessageHandler` 之间
  只通过 `WebViewUiPort` 通信，拿不到 UI 契约的全量方法（[contracts.md](contracts.md)）。
- **事件是唯一耦合点**：core 与 UI 之间没有直接引用，只通过 `AssistantEventBus`
  上的 `CoreEvent` / `UiEvent` / `CoreRequest` 按 `type` 分发（[events.md](events.md)）。
- **事件只说「发生了什么」**：不表达「UI 该怎么表现」（[events.md 第 4 节](events.md#4-命名约定)）。

## 4. core 的资源跟 core 的事实走

**core 自己拥有生命周期的东西，触发点必须也在 core。** 反过来，只该由 UI 决定
「什么时候做」的事情，core 不替它决定。

判据：**这个资源（或状态）的 owner 是 core，还是 UI？**

| 资源 / 状态 | owner | 触发点 |
| --- | --- | --- |
| MCP 引用 | Core 进程（`core-rs/src/mcp.rs` 引用计数） | Core：`on_conversation_closed` / `on_conversation_deleted`（[contracts.md 第 3 节](contracts.md#3-mcp-生命周期core-进程内)） |
| 引擎 / 消息缓存 | Core 进程 | 释放在 Core（`on_conversation_closed`）；**时机**由宿主决定（空闲判定只读 Core 推送的运行时快照，[contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)） |
| 会话运行状态 `idle` / `waiting` | Core 进程（`engine.rs` 的运行时状态表） | Core 的各事实变化点，推 `sessionRuntimeChanged`（[docs/core/session-runtime.md](../core/session-runtime.md)） |
| 对话列表刷新 | UI（磁盘是 source of truth，「刷新哪些视图、节流多久」是表现策略） | UI：`onConversationListChanged` → `ConversationManager.refresh()`（[contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)） |
| Spin 设计器内容 | 磁盘 `spin.json` + 面板缓存 | core 发 `spinDesignDataChanged`，UI 决定要不要重读（[contracts.md 第 2 节](contracts.md#2-spin-设计器契约spindesign)） |
| 空闲回收 | 宿主 | `SingleWebViewConversationManager`（[contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)） |

MCP 这条踩过坑：acquire 挂在「webview 打开」上时，引用生命周期就被绑到了 UI 视图上，
多视图宿主为了不泄漏，只能在视图管理器里重建一套引用管理。

## 5. 预览只有一份渲染实现，不做重复

同一份内容不做两套渲染：每种预览只落在**一个**渲染方，另一侧只负责取内容 / 发消息。

| 内容 | 渲染方 | 另一侧 |
| --- | --- | --- |
| Edit / Write 改动（diff） | webview 工具卡片（core 展开进 `displayArgs.diffHunks`，[docs/architecture/host-ui-modules.md 第 2 节](host-ui-modules.md#2-toolhandler)） | `ElectronUIHost.showDiff` 留空——它能开 Monaco diff 窗口，但那是**重复实现**，不做 |
| mermaid 代码块 | 宿主原生窗口（webview 只发 `openMermaidPreview`）：VS Code 复用单个 `WebviewPanel`，Electron 复用单个 `BrowserWindow` | webview 不做页内渲染浮层 |
| 图片 | 宿主：VS Code `vscode.open` 内置图片预览，Electron `openImagePreviewWindow`（`dist/imageViewer`，滚轮缩放 / 拖动平移） | — |
| 完整文本 / 虚拟文档 | 宿主：VS Code `DocumentManager` 虚拟文档标签，Electron Monaco 窗口（`mode: 'content'`） | — |

VS Code 在 manual 模式下额外用 `host.showDiff` 开原生 before/after diff 标签（[docs/architecture/host-ui-modules.md 第 2 节](host-ui-modules.md#2-toolhandler)），
作为工具卡片之外的完整视图；Electron 不跟进（`showDiff` 空实现）。

## 6. core 描述事实，UI 决定表现

core 一旦把「表现策略」（防抖、节流、刷新哪些视图、没打开时怎么办）编码进业务调用点，
UI 就再也改不动自己的表现。所以 core 侧只发**事实事件**：

| 事实 | 曾经的 core 侧表达 | 现在的表达 |
| --- | --- | --- |
| 对话列表数据变了 | `scheduleConversationListRefresh()`（防抖）/ `refreshConversationList()`（立即） | `emitToUi({ type: 'conversationListChanged' })` |
| spin.json 被改了 | `refreshSpinDesign()` | `emitToUi({ type: 'spinDesignDataChanged' })` |
| 会话标题变了 | `setTitle()` | `emitToUi({ type: 'titleChanged' })` |
| 工具卡片参数变了 | `updateToolArgs()` | `emitToUi({ type: 'toolArgsUpdated' })` |

节流与否、刷新哪些视图、未打开设计器时怎么办，全部由 `WebViewUI` / `UIHost` 决定。

同一条分工也适用于**读函数**：core 只返回配置数据（如 `getLLMConfigPanelPayload` 返回面板载荷），
`showLLMConfig` 这条 wire message 的组装与投递由 `WebViewUI.showLLMConfigPanel` 完成（[docs/architecture/host-ui-modules.md 第 3 节](host-ui-modules.md#3-webviewmessagehandler)）。

## 7. 一份事实只有一个写入点

同一份状态被两处写，就会出现「谁是真值」的漂移。做法是**指定唯一 owner，其他都是
只读投影**——投影可以拿来对账，但不许反推。

| 事实 | 唯一 owner | 只读消费方 |
| --- | --- | --- |
| 会话运行时事实（`idle` / `waiting` / `queryRunning` / `compacting` / `backgroundRunning` / `subAgentRunning`） | core `sessionRuntime`（[docs/core/session-runtime.md](../core/session-runtime.md)） | 对话树流水灯、侧栏流水灯、托盘状态点、abort 按钮（都读 `sessionRuntimeChanged`） |
| abort 按钮三态（红 / 黄 / 灰） | 纯函数 `resolveAbortButtonState`（`src/host/abortButtonState.ts`） | `InputArea` 渲染（[docs/features/abort-button.md](../features/abort-button.md)） |
| webview 渲染阶段（thinking / text / tool） | `SessionUiState`（宿主侧渲染投影，[docs/hosts/webview-ui.md](../hosts/webview-ui.md)） | 渲染与 abort 按钮（不参与 abort 判定） |
| 对话列表 | 磁盘（Core 对 `conversationListRequested` 的应答） | `ConversationManager.refresh()` 分发并留快照，`sidebar:get-conversations` 读快照（[contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)） |
| 对话树删除闭包 | 纯函数 `collectConversationClosure`（`src/shared/history/Conversation.ts`，宿主侧）与 Core 进程 `core-rs/src/history.rs` 的删除规则——同一份格式两个读写方，格式变更两侧同步（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)） | Electron 宿主删多视图会话先调 TS 版求闭包；Core 收到 `conversationDeleted` 后按同一规则递归删盘 |
| 「哪个会话在前台」 | UI（VS Code：`SingleWebViewConversationManager` 的 `activeSessionProvider`；Electron：`ChatViewManager.getActiveSessionId`） | 空闲回收的「前台会话不关」、MCP 面板取数。core **不保存**这份状态（曾经在 `Config` 里缓存过一份） |
| 「哪些会话 open」 | UI（Electron：`ChatViewManager.getLoadedSessionIds` → `WebViewUI.setOpenSessions`；VS Code：单视图下 open == active） | `UserChoiceQueue` 判断待答请求能否投递到该会话自己的视图（[docs/architecture/host-ui-modules.md 第 1 节](host-ui-modules.md#1-userchoicemanager)）。core **不保存**这份状态 |
| 视图 ↔ 会话 ID 的绑定 | Electron `ChatViewManager`（`registerSession`） | 由 webview 上报的 `startNewConversation` / `loadConversation` 驱动（这两条消息才表达「这个视图当前属于哪个会话」） |
| 工作区打开集合 / 活动项 | 宿主（VS Code：工作区文件夹；Electron：`main.ts` 的 `openWorkspaces` / `workspacePath`） | `WorkspaceProvider` 的消费方与 `Client`（按工作区建立 Connection，[docs/hosts/host-bootstrap.md 第 1 节](../hosts/host-bootstrap.md#1-宿主接线)） |
| `sessionId → Connection` 归属 | `Client`（`assignSession` 登记，`sessionWorkspaceAssigned` 事件驱动） | 总线路由、`Connection` 的会话集合。`connectionId` 是内部概念，不进任何总线载荷 |
| Core 进程生命周期 | daemon（启动 / 重启 / 终止，见 [docs/core/core-daemon.md](../core/core-daemon.md)） | `Connection` 只消费 `channelReset` / `workspaceClosed` 与 fatal 事件；`CoreProcess.ts` 是单进程形态的传输层实现 |
| 家目录 / 全局配置目录 | `src/config/configDir.ts` 的 `resolveHomeDir()` / `resolveConfigDir()`（口径 `USERPROFILE` → `HOME` → `os.homedir()`，与 `core-rs/src/config.rs` 的 `home_dir()` 同序） | `SettingsStore` / `Logger` / skills 目录 / Electron 旧字段迁移都调它，不各自 `os.homedir()` 或读 `HOME` |
| 全局 `settings.json` 的写入 | `SettingsStore.updateSettings`（宿主侧唯一写入口） | 写前必须拿跨进程锁、拒绝覆盖读不出来的文件、原子落盘（第 11 节） |
| 跨进程文件锁 | `src/shared/utils/fileLock.ts` | `SettingsStore` 用异步入口，`Logger` 的轮转用同步入口；不各自实现一套 |

**禁止从投影反推事实**：`WebViewUI.onSessionRuntimeChanged` 只把 core 的状态转给
`ConversationManager.updateSessionStates`，不参与计算；`SessionUiState` 不产出
`SessionRuntimeState`（[docs/core/session-runtime.md](../core/session-runtime.md)）。

## 8. 契约只写现状，派生字段从根字段推导

契约里冗余的字段迟早会和根字段对不上（漏改一处就长期不一致）。所以：

- **只留根字段**：`HostInfo` 只有 `conversationView: 'single' | 'multi'` 与
  `conversationListOwner: 'host' | 'webview'`，其余能力（`rendersConversationListInWebview` /
  `newConversationEntryOf` / `openConversationModeOf` / `canCloseConversation`）由纯函数从
  根字段推导（[contracts.md](contracts.md)）。
- **校验只校验根字段**：`getHostInfo()` 只检查这两个字段的取值合法性；推导出来的
  能力没有「单独填错」的可能。
- **派生逻辑只有一份**：推导写在 `src/host/types.ts` 的纯函数里，宿主与 webview
  都调它，不在各自代码里各写一遍 `if`。

## 9. 同一字段的默认值只有一处

「磁盘里没有这个字段时取什么值」也必须只有一个答案。默认值散在快照解析、设置面板、
宿主兜底消息三处时，任何一处单独改动都会让「界面显示的默认值」和「Core 实际用的值」
悄悄分叉。

- **配置字段默认值的唯一来源是宿主快照解析** `src/shared/settingsSnapshot.ts`
  （webSearch / thinkingEffort / agentMode / promptMode / enableUsageStats）：
  它是 `settings.json` 的规范化入口，缺字段 / 类型不对 / 取值非法都在这里落默认值。
- **界面语言的默认值归宿主** `src/host/SettingsStore.ts`（`uiLanguage` 只有 UI 消费、
  不进快照，因此缺省取值由宿主决定）。
- **界面字号的默认值归宿主** `src/host/SettingsStore.ts`（`uiFontSize` 只有 UI 消费、
  不进快照；缺省 `medium`，webview 折算为 `--ui-font-offset` 后由 CSS 消费）。
- **模型注册表默认值**（`DEFAULT_API_TYPE` / `FALLBACK_MODEL_PARAMS`）在
  `src/shared/utils/modelConfig.ts`，不重复到别处。
- **Core 侧需要默认值时读快照**（`settings.rs` 的 `settings_snapshot()`），不另声明常量：
  权限策略（`permission.rs`）的「会话未记录询问模式」、压缩（`compact.rs`）的
  摘要思考强度都取快照的对应字段。
- **跨层服务地址**（`DEEPSEEK_BASE_URL`）在 `src/shared/endpoints.ts`：它不是「字段缺省
  取值」，而是设置面板「新增服务商」的预置地址、余额查询目标与服务商识别的共同基准。
  该模块必须**零依赖**（只导出字符串字面量）——webview 也要 import 它。
- 「读取失败」与「默认值」是两回事：失败路径不要伪装成默认值（例如读不到快照时
  不该按默认值弹设置面板），否则用户会以为配置丢了。

**已知例外**（跨语言，靠测试锁死，不强行合并）：`DEEPSEEK_BASE_URL` 与
`MAX_OUTPUT_TOKENS_UPPER_LIMIT` 在 TS 与 Rust 各一份；`utils/modelConfig.ts` 里
模型限值表的默认输出（模型未知）与 `FALLBACK_MODEL_PARAMS.maxOutputTokens`
（模型未命中注册表）是两条不同的兜底语义，各自有注释说明适用场景。

## 10. webview 不持有事实的默认值

[docs/hosts/webview-facts.md](../hosts/webview-facts.md) 的架构原则，落点见
[contracts.md](contracts.md) 与本文第 6 节。

webview 渲染所需的每一项事实都由宿主决定。**webview 不持有配置默认值**：某个字段
「还没从宿主拿到」时，界面给出等待态（转圈），而不是显示一个自己猜的值。

- **事实单向流动**：宿主产出事实，webview 消费事实。webview 不产出配置事实。
- **等待态由「是否到达」决定，不由「值是否为空」决定**：这类事实在 webview 侧用
  `undefined` 表示尚未到达，空集合 / `false` / `0` / `''` 都是**已到达的取值**。
  例：模型列表 `undefined` → 等待项；`[]` → 宿主答了「没有配置模型」。
- **不代宿主决定**：事实未到达时 webview 不下发该字段（`sendMessage` 的会话配置、
  挂载时的 `setAgentMode` / `setPromptMode` / `setModel` 自动回传都遵循此规则），
  否则会把 webview 的猜测写进会话的 `meta.json`。
- **同步注入的事实缺失即接线错误**：`__hostInfo` / `__uiLocale` / `__uiFontSize` /
  `__initialTheme` 在页面首帧之前由宿主写入，没有等待窗口；缺失或取值非法直接抛错
  （与第 1 节的 `getHostInfo()` 同一口径）。两个宿主都必须注入这四项。
- **等待态的统一表现**：输入区在会话配置未到达时禁用发送并显示转圈
  （`configLoading`）；输入区菜单只显示等待项（`agentMode` 未到达）；模型子菜单显示
  等待项（`providerModels` 未到达）。
- **唯一自持的取值是服务地址常量** `DEEPSEEK_BASE_URL`（第 9 节），用于「新增服务商」
  的预置地址；其余字段一律来自宿主。
- **设置面板载荷全必选**：`showLLMConfig` 一次给齐面板需要的全部配置事实，面板入参
  全部必选；宿主读不到配置时不打开面板（不补默认值、不误导用户重配）。

判据：**这个取值是宿主说的，还是 webview 猜的？** 猜的一律删掉，改成等待态。

## 11. 共享文件的写安全

`~/<CONFIG_DIR_NAME>/settings.json` 是**同一台机器上多个宿主进程共写**的文件：VS Code
扩展宿主与多个 Electron 实例都会读写它。这类文件上的「读-改-写」必须满足四条，
缺一条就可能**销毁用户配置**（[core-ui-separation.md 第 4.6 节](core-ui-separation.md#46-写盘规则)）：

| 规则 | 落点 | 不做会怎样 |
| --- | --- | --- |
| 读-改-写整体在跨进程锁内 | `src/shared/utils/fileLock.ts` 的 `withFileLock` | 两个宿主的读-改-写交错，后写者丢掉先写者的改动 |
| 读不出来就拒绝写入 | `SettingsStore.updateSettings` 抛错 | 并发下的半截文件被解析失败 → 当成空配置 → 用 `{}` 覆盖全部配置 |
| 写入原子（临时文件 + `rename`） | `writeFileAtomic` | `writeFile` 先截断再写，读者看到空文件/半截内容 |
| 内容未变化不落盘 | `SettingsStore.updateSettings` | 高频调用反复重写磁盘，放大竞争窗口 |

两条判据：

- **「文件不存在」与「文件读不出来」必须分开**：前者等价于「用户还没配置过」，按空内容
  继续；后者说明磁盘上有我们没读懂的内容，只能保持上一次的良好快照并记日志。
- **凡是要「读-改-写」共享文件的地方，先问有没有锁**：进程内串行（Promise 链）挡不住
  另一个进程；原子写挡不住丢失更新。两者都要。

`Logger` 的日志轮转用同一份锁的同步入口（`acquireLockSync` / `releaseLockSync`）——
它的落盘路径无法异步化。锁只保证**协作进程**之间的互斥，写入本身仍必须原子。

这条同样适用于各规格文档：**只写现状**。已收敛的历史差异不列
（[docs/hosts/host-matrix.md](../hosts/host-matrix.md)），还没定的事进
[open-questions.md](open-questions.md)，不写「计划会怎样」。
