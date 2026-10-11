# 规格：宿主契约与端口

本规格界定宿主侧全部契约与端口，分三部分：三契约 `UIHost` / `SpinDesign` / `ConversationManager`（第 1–5 节，含 MCP 生命周期入口 `MCPHost`）、共享子模块端口（第 6–9 节：`UserChoiceManager` / `ToolHandler` / `WebviewMessageHandler` / `WebViewUiPort`）、webview 侧契约 `HostInfo`（第 10–13 节）。契约成员全部必选、按 UI surface 划分；分层与依赖规则见 [DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)，事件词汇表见[第 3 章](../DEVELOPMENT.md#3-核心契约assistanteventbus)、[第 4 章](../DEVELOPMENT.md#4-事件列表)。

交叉引用：`docs/webview-ui.md`（WebViewUI 实现与会话 UI 状态——契约的消费方）、`docs/host-matrix.md`（两个宿主对三契约的逐成员实现对照）、`docs/webview-facts.md`（webview 的事实与等待态——`HostInfo` 的消费语义）、[DEVELOPMENT.md 第 5 章](../DEVELOPMENT.md#5-架构原则)（架构原则）。

---

宿主差异全部收敛在四个宿主契约上，外加一个 core 侧的 MCP 生命周期入口：

| 名称 | 形态 | 服务的 surface | 实现 |
| --- | --- | --- | --- |
| `UIHost` | interface（`extends WorkspaceProvider`） | 对话 webview 的宿主能力 | `VSCodeUIHost` / `ElectronUIHost` |
| `WorkspaceProvider` | interface | 工作区（进程级环境事实，不是 UI surface） | 同上两个宿主类 |
| `SpinDesign` | interface | Spin 设计器（独立面板 / 窗口） | `VSCodeSpinDesign` / `ElectronSpinDesign` |
| `MCPHost` | core 单例 | MCP 的会话级生命周期（**不是宿主契约**） | 唯一实现，无宿主分支 |
| `ConversationManager` | abstract class | 对话列表 / 会话运行时状态（空闲会话回收在 VS Code 实现里） | `SingleWebViewConversationManager` / `ElectronConversationManager` |

契约按 **UI surface** 划分（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 7）：新增面板、窗口或列表类功能时，先确定其所属
surface，而不是向 `UIHost` 追加成员。工作区是进程级环境事实，不属于任何 UI surface，
因此 `WorkspaceProvider` 单独成契约，供只需要工作区的消费方依赖；`UIHost` 继承它，
保持「对话 webview 宿主」契约的完整性。

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [UIHost：对话 webview 的宿主能力](#1-uihost对话-webview-的宿主能力) |
| 2. | [Spin 设计器契约：SpinDesign](#2-spin-设计器契约spindesign) |
| 3. | [MCP 宿主：MCPHost](#3-mcp-宿主mcphost) |
| 4. | [对话相关数据：ConversationManager](#4-对话相关数据conversationmanager) |
| 5. | [宿主侧入口：动作翻译为 UiEvent](#5-宿主侧入口动作翻译为-uievent) |
| 6. | [UserChoiceManager](#6-userchoicemanager) |
| 7. | [ToolHandler](#7-toolhandler) |
| 8. | [WebviewMessageHandler](#8-webviewmessagehandler) |
| 9. | [端口：WebViewUiPort](#9-端口webviewuiport) |
| 10. | [注入](#10-注入) |
| 11. | [读取与校验](#11-读取与校验) |
| 12. | [消费点](#12-消费点) |
| 13. | [消息通道](#13-消息通道) |

---

## 1. UIHost：对话 webview 的宿主能力

位置：`src/host/UIHost.ts`（interface）。

设计约束：

| 约束 | 理由 |
| --- | --- |
| 成员全部必选，不出现 `?` | 调用方不必用 `host.foo?.()` 静默降级；可选语义用 `null` 或判别联合表达 |
| 能力命名表达语义，不暴露宿主类型 | 共享代码里不出现 `host.kind === '...'` 形式的宿主嗅探（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 5） |
| 入参显式 | 可选语义用 `null`，而不是省略参数 |
| 返回值统一 `Promise<void>` | 不用 `void \| Promise<void>` 联合 |

成员清单（全部必选，共 20 个：`UIHost` 自身 16 个 + 继承 `WorkspaceProvider` 的 4 个）：

| 分组 | 成员 | 语义 |
| --- | --- | --- |
| 传输 | `sendToWebview(message: WebviewMessage): void` | 有 `message.sessionId` 时定向该会话视图，否则发活动视图 |
| | `broadcastToWebviews(message: WebviewMessage): void` | 所有对话视图 |
| | `sendToWebviewView(view: WebviewViewHandle, message: WebviewMessage): void` | 某个具体视图；`view` 由宿主产出 |
| | `onThemeChanged(view: WebviewViewHandle \| null): void` | 下发当前主题；`view` 为 `null` 广播，指定句柄直发；值取自 `isDarkTheme()` |
| 环境 | `log(...args: unknown[]): void` | 日志输出（VS Code：`OutputChannel`；Electron：`console`） |
| | `isDarkTheme(): boolean` | 当前是否深色主题 |
| | `getLocale(): string` | UI 语言（如 `zh` / `en`） |
| 工作目录（继承 `WorkspaceProvider`） | `getWorkspacePath(): string \| undefined` | 宿主当前工作目录路径；打开集合为空返回 `undefined`（不退回 `process.cwd()`） |
| | `getWorkspaceRef(): WorkspaceRef \| undefined` | 当前工作区引用（`scheme` / `path` / `endpoint`）；未打开返回 `undefined` |
| | `getOpenWorkspaceRefs(): readonly WorkspaceRef[]` | 当前打开的工作区集合（按打开顺序）；Client 据此建立 Connection |
| | `onWorkspaceChanged(listener): () => void` | 订阅工作区打开 / 关闭 / 激活；返回取消订阅 |
| 面板 / 窗口 | `openFile(filePath: string, target: LineSelection \| null): Promise<void>` | 打开文件并定位到行；不需要定位时传 `null` |
| | `showVirtualDocument(content: string, title: string): Promise<void>` | 显示虚拟文档（内容预览） |
| | `showDiff(options: ShowDiffOptions): Promise<void>` | 显示一次改动的 before / after（仅 manual 模式，见下） |
| | `openMermaidPreview(code: string): Promise<void>` | 打开 Mermaid 预览 |
| | `closePreview(): void` | 关闭当前预览（diff / 虚拟文档 / 预览窗口）；句柄由宿主自己持有 |
| | `openExternalUrl(url: string): Promise<void>` | 用系统默认浏览器打开外部链接 |
| | `saveTextFile(content: string, options: SaveFileOptions): Promise<SaveFileResult>` | 弹出「另存为」对话框并写入文本文件 |
| 会话 / 状态 | `closeConversationView(sessionId: string): Promise<void>` | 只销毁该会话的 UI 视图（不删磁盘数据、不释放运行时内存） |
| 配置文件 | `updateSettingsJson(mutator: (cfg: Record<string, any>) => void \| Record<string, any>): Promise<void>` | 串行化「读-改-写」全局 `settings.json` |

`WorkspaceProvider`（同文件）是**宿主侧**的工作区契约：路径（`getWorkspacePath`）、引用
（`getWorkspaceRef`）、打开集合（`getOpenWorkspaceRefs`）与变化订阅（`onWorkspaceChanged`）。
它是宿主内部的事实来源——消费方是宿主自己的界面（对话列表 `ConversationManager`、
Spin 设计器）与 `Client`（按工作区建立 Connection），core 不读取它。

**对话自己的工作目录**不经该契约表达：它是对话的属性，由 core 的会话工作目录表按
`sessionId` 解析（见[docs/core-ui-separation.md 第 3.3 节](core-ui-separation.md#33-会话工作目录)）。宿主在会话首次被 core 解析目录之前把目录登记进去
（`WebviewMessageHandler.ensureSessionWorkspace`，见[docs/host-matrix.md 第 7 节](host-matrix.md#7-启动期状态写入入口与读取器)）。

`WebviewViewHandle` 是名义类型（必须是该类实例，任意对象无法冒充）：多视图宿主用它包裹自己的
视图对象，单视图宿主的 `sendToWebviewView` 等价于 `sendToWebview`（句柄不参与路由）。句柄的产出
方式见[docs/host-matrix.md 第 6 节](host-matrix.md#6-宿主接线)。

`showDiff` 由工具权限流程调用（`ToolHandler.requestToolPermission`，见第 7 节）：VS Code 打开
before/after 两个虚拟文档组成的 diff 标签，Electron 空实现（diff 只在 webview 里渲染）。
**仅 manual 模式调用**——auto / risk 下改动自动放行，不弹原生 diff
（webview 工具卡片里的 diff 仍然展示）。

全局配置 `~/<CONFIG_DIR_NAME>/settings.json` 是宿主资源，写入口唯一（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 9）：

| 文件 | 内容 | 写入口 |
| --- | --- | --- |
| `~/<CONFIG_DIR_NAME>/settings.json` | 全局配置（llm / mcp / uiLanguage / uiFontSize / highlightLanguages / defaultAgentMode / defaultPromptMode…） | `updateSettingsJson` |

项目对话目录清单 `<conversations>/<project>/workspace.meta.json` **不在这里**：它归 core，
由 core 在建目录时自己写（Embedded `history/Config.ensureProjectConversationDir`，
Standalone 的 Rust `config`），宿主不参与写盘。

`theme` / `shortcut` 不属于这份文件：它们是 Electron 宿主本地偏好，落
`userData/workspace-state.json`（`electron/workspaceStateStore.ts`，临时文件 + rename 原子落盘、内容未变不落盘），core 不读不写（[docs/host-matrix.md 第 12 节](host-matrix.md#12-宿主固有差异有意保留)）。

两个宿主共用 `src/host/settingsFile.ts`：`updateSettingsJson` 委托给
`SettingsStore.updateSettings`，串行化「读-改-写」（避免并发写坏文件或丢字段），
写盘后重新解析快照并通知订阅者——`bootstrapCore` 注册的那次订阅会把整份快照推给
Connection（[docs/core-ui-separation.md 第 4.6 节](core-ui-separation.md#46-写盘规则)）。core 侧没有读缓存，也没有
`resetSettingsCache()` 这类调用。

字段名与合并规则以**纯函数**给出（不写盘），例如
`host/highlightLanguages.ts` 的 `highlightLanguagesMutator`（去重 + 上限 60）、
`host/llmConfigSave.ts` 的 `applyLlmConfigSave`（LLM 配置整段 mutation）。
调用方把 mutator 交给宿主执行：`WebviewMessageHandler.handleSaveLLMConfig`（LLM 配置）、
`WebViewUI.onHighlightLanguagesUsed`（高亮语言）。

`closeConversationView` **只销毁视图**：不删磁盘数据，也不释放运行时内存。两件事归属不同——
关视图归宿主（本方法），卸内存归 core（`UiEvent.conversationClosed` →
`sessionResources.releaseSessionResources`）。

两个实现：`src/VSCodeUIHost.ts`（+ `src/VSCodeUIHost/`）与 `electron/ElectronUIHost.ts`；
逐成员对照见[docs/host-matrix.md 第 3 节](host-matrix.md#3-uihost-实现对照表)。

## 2. Spin 设计器契约：SpinDesign

位置：`src/host/SpinDesign.ts`（interface）。

Spin 设计器是**独立于对话 webview 的第二个 UI surface**：VS Code 里是 `WebviewPanel`，
Electron 里是 `BrowserWindow`。它有自己的生命周期（打开 → 复用 → 刷新）、自己的消息协议、
自己的数据源（`spin.json` + Skill 列表），与对话 webview 零共享状态。

与 `UIHost` 分开的理由：

1. 独立面板 / 窗口，生命周期与消息协议都与对话 webview 无关；
2. `UIHost` 已承载 16 个成员，再混进 Spin 专属成员会让「宿主能力」失真；
3. 拆出后 Spin 的整块（HTML 生成 + 导出 + 面板管理）可整体替换或搬走。

接口只有两个成员：

| 成员 | 语义 |
| --- | --- |
| `open(workspacePath?)` | 打开设计器；已打开则复用（**目录不同则切到新目录的数据**）。`workspacePath` 是发起方会话的工作目录——`spin.json` 与技能清单都归属它；不传时回退宿主当前工作目录（兼容旧调用 / 无会话场景） |
| `refresh()` | 从磁盘重读 `spin.json` + Skill 列表推给已打开的设计器；未打开时 no-op |

`refresh` 的必要性：SpinLoop 执行过程中会直接更新磁盘 meta，若设计器仍持有旧缓存，
用户后续保存会覆盖执行结果，因此执行完成后必须刷新。

**归属目录必须由调用方传入，不能回查活动目录**：多工作目录宿主（Electron）里设计器是
单例窗口，从别的标签页再 `/spin` 时活动目录可能已经变了；实现内部把 `open()` 收到的目录
**绑定**下来，`refresh()` 与保存都用它（保存不回查活动目录，否则会把当前目录的内容写进
另一个目录的 `spin.json`）。

**构造依赖**：`constructor(host: UIHost)`。实现只用其中 5 个成员——`getWorkspacePath()`
（未显式传目录时的回退）、`isDarkTheme()` / `getLocale()`（生成 HTML）、`saveTextFile()`
（导出）、`log()`。**不反向要求 `UIHost` 知道 Spin 的存在。**

**设计器消息协议**（设计器 ↔ 宿主，不走 `AssistantEventBus`）：

| 方向 | 消息 |
| --- | --- |
| 设计器 → 宿主 | `refreshSpinDesign` / `saveSpinDesign` / `exportSpinDesign` |
| 宿主 → 设计器 | `spinDesignData` / `spinSaveResult` / `spinExportResult` |

core 与它只有一条连接：`CoreEvent.spinDesignDataChanged` → `WebViewUI.onSpinDesignDataChanged()`
→ `SpinDesign.refresh()`。

**共享物**（宿主无关）：

| 位置 | 内容 |
| --- | --- |
| `src/host/ui/spinDesignHtml.ts` | 设计器 HTML 生成器 |
| `src/host/spinDesignExport.ts` | `exportSpinDesignJson(host, data, title)`：序列化 + 默认文件名 / 文件过滤器 |

`WebviewMessageHandler` 不直接持有 `SpinDesign`：它走 `WebViewUiPort.openSpinDesign()`
（`WebViewUI` 转发到 `spinDesign.open()`），维持「子模块只认窄端口」的约定（第 6 节）。

## 3. MCP 宿主：MCPHost

位置：`src/core/mcp/MCPHost.ts`。

它**不是宿主契约**：没有 VSCode / Electron 两个实现，只有一个 core 侧单例。放在本章，是因为
它**不挂在 `UIHost` 上**：**MCP 的生命周期由 core 的会话事实决定，不由 UI 的视图生命周期
决定**，所以「会话打开」不能是宿主能力。

职责：把「会话生命周期 → MCP 引用」的映射收口到一处，驱动信号全部来自 core：

| 成员 | 触发 | 语义 |
| --- | --- | --- |
| `onSessionOpened(sessionId)` | `Integration.createEngine` / `restoreConversationEngine` | 按该会话的启用列表建立引用（幂等；可能耗时，后台执行不阻塞）；连接 / 断开结束后广播 `sessionConfigChanged(mcpEnabled)` |
| `onSessionClosed(sessionId)` | `sessionResources.releaseSessionResources` / `history.deleteConversation` | 释放该会话的全部引用（归零的 server 进入延迟回收） |
| `onSessionEnabledChanged(sessionId)` | 启用列表变化 | 差量同步；结束后广播 `sessionConfigChanged(mcpEnabled)` |
| `prune()` | bootstrap | 清理没有任何会话引用的残留进程 |
| `shutdown()` | 宿主退出 | 结束全部 MCP 子进程，避免留下孤儿进程 |

`onSessionOpened` / `onSessionEnabledChanged` 在串行链内 `await` 到 server 进入最终状态
（running 或 error）后广播 `sessionConfigChanged(mcpEnabled)`：连接是异步的，缺这条事实，
webview 的 MCP 菜单会一直停在乐观更新 / 首次推送时的「连接中」。UI 收到后重新读取运行时
状态并回推 `setMcpServers`（[DEVELOPMENT.md 第 4.1 节](../DEVELOPMENT.md#41-coreeventcore--ui单向)事件 21）。

另提供三个只读转发：`getTools()` / `getServerStatus()` / `readServers(sessionId)`；工具聚合
与面板读取的实际路径是 `mcp/Manager` 与 `mcp/Config`。

**与 `McpManager` 的分工**：`MCPHost` 管「什么时候」，`McpManager`（`mcp/Manager.ts`）管
「怎么做」。

| | `MCPHost` | `McpManager` |
| --- | --- | --- |
| 知道 | 「会话打开 / 关闭 / 启用列表变化」意味着什么 | 只认 `sessionId` 集合 |
| 职责 | 会话生命周期 → 引用计数调用；`prune` / `shutdown` 的时机 | 引用计数、子进程启动与延迟回收、配置签名、工具列表重建 |
| 调用方 | core（`Integration` / `sessionResources` / `history` / `initializeCoreEvents`）、宿主侧 MCP 面板的默认值变更路径、bootstrap | 写路径只有 `MCPHost`；UI 面板的只读状态读取直接调 `mcp/Manager` 的 `getServerStatus()` |

所有操作经内部串行链（`opChain`）排队，避免并发造成进程重复启动或状态错乱。

**留在 UI 侧的 MCP 代码**（只读展示，与生命周期无关）：

| 位置 | 内容 |
| --- | --- |
| `webviewMessageHandler.handleRequestMcpServers` / `pushMcpServers` | 读 `mcp.json` + 会话启用列表 + 运行时状态，推给面板 |
| `webviewMessageHandler` 的 `setMcpEnabled` 翻译 | 发 `UiEvent.mcpEnabledChanged`；写盘与差量同步由 core 侧处理 |
| `webviewMessageHandler` 的 `setMcpEnabledList` 翻译 | 发 `UiEvent.mcpEnabledListChanged`（整表覆盖，设置面板「应用到当前对话」）；同上一条链路 |
| `webviewMessageHandler.handleSaveLLMConfig` 的钉住 | 保存全局默认 MCP 列表前，先读该会话生效的启用列表并发 `mcpEnabledListChanged` 把它钉住：全局默认只改新对话默认值，当前对话是否跟随由 webview 的确认框决定。钉住失败不阻断保存，只回 `mcpPinFailed`，由 webview 给出提示 |
| webview 侧 MCP 面板 | 纯展示 |

**启用状态的两层与「钉住」**：`mcp/Config` 里生效值 = 会话覆盖（`meta.json` 的
`context.mcpEnabled`，进程内还有一份内存覆盖）优先，其次全局默认（`settings.json` 的
`mcp.enabled`，经配置快照下发）。输入框菜单的勾选只写会话覆盖；设置面板「默认配置」只写
全局默认。全局默认变更会让 core 重同步**其它**已注册会话，但当前对话在写盘前已被宿主钉在
它当前的列表上（`mcpEnabledListChanged`），因此不会静默跟随——是否跟随由设置面板的
「应用到当前对话」确认框决定（[docs/webview-facts.md 第 6 节](webview-facts.md#6-设置面板)）。

**按会话暴露 MCP 工具**：MCP 进程是进程级全局的（多个会话可共享同一个 server），但
「把哪些 MCP 工具发给某个会话的 LLM」必须按该会话的启用列表过滤，否则 A 会话已取消勾选、
却因为 B 会话仍启用（进程继续存活）而把该 MCP 工具发给 A：

| 环节 | 做法 |
| --- | --- |
| 组装 prompt | `QueryEngine.ensureFullSystemPrompt` 读取该会话生效的启用列表（`readEnabledMcps(sessionId)`；子代理经 `parentSessionId` 继承父会话），据此过滤工具 |
| 组装请求 | `QueryEngine.getPromptStateForQuery()` 把启用集合交给 `Query`，`Query` 用 `getAllTools(enabledMcpServers)` 只把本会话启用的 server 的 MCP 工具放进 `tools` |
| 缓存失效 | 会话启用列表变化时，`McpManager.syncSessionInternal` 调 `invalidateSessionPromptCache(sessionId)` 单独失效该会话的 prompt 缓存，**不依赖**全局工具集合是否变化 |
| 工具执行 | `RunTools` 仍用全局 `getAllTools()`，保证历史消息里已发出的工具调用仍能按名解析 |

## 4. 对话相关数据：ConversationManager

位置：`src/host/ConversationManager.ts`（abstract class）。

它分发**两条互相独立的流**（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 8）：

| | 流 1：对话列表 | 流 2：会话运行时状态 |
| --- | --- | --- |
| 内容 | 磁盘元数据：`title` / `createdAt` / `updatedAt` / `messageCount` / `parentSessionId` | 运行时根事实与派生 `idle`（`SessionRuntimeState`，[DEVELOPMENT.md 第 3.1 节](../DEVELOPMENT.md#31-事件定义) / [第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)） |
| source of truth | 磁盘（core 的 `loadConversationList()`） | core 的 `sessionRuntime`（[DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)） |
| 变化频率 | 低（落盘 / 改名 / 删除 / 新建） | 高（查询开始结束、等用户、用户响应） |
| 触发 | `CoreEvent.conversationListChanged` | `CoreEvent.sessionRuntimeChanged` |
| 消费者 | webview 子对话树、Electron 原生侧栏 | VS Code webview 对话树流水灯、Electron 侧栏流水灯、系统托盘状态点、未读完成呼吸（Electron）、系统睡眠阻断（宿主进程与 Core 进程各一份） |

两条流**不合并**：把 `idle` / `waiting` 贴到磁盘列表上一起推送，会让列表接口失真
（磁盘元数据里混进运行时状态），且每次状态变化都要重读一遍盘；托盘也只能从对话列表反推
会话状态。拆开之后各自只在自己变化时推，托盘直接吃状态流。

**用抽象类而不是接口**：`load()` 在两个宿主上一致，只有 `dispatch*()` 不同，由模板方法把
共享部分固定在基类。

| 成员 | 语义 |
| --- | --- |
| `refresh()` | 重新读取**当前活动目录**的对话列表并分发给该宿主所有需要它的界面（顺带存成该目录的快照） |
| `load()`（protected） | 读磁盘对话列表（source of truth，两端一致） |
| `dispatchList(list)`（abstract） | 把纯磁盘列表分发给该宿主的界面 |
| `onConversationListChanged()` | 列表变化入口：活动目录立即重读，**已有快照**的其它目录标脏（返回重读完成；fire-and-forget 调用加 `void`） |
| `getCachedList()` | 当前活动目录的列表快照（没有快照时为 `null`）。每个目录各留一份：多工作目录宿主（Electron）切换标签页直接命中，不再每次完整读盘 / 走 `conversationListRequested` 网络往返。Electron 的 `sidebar:get-conversations` 读它 |
| `isCachedListStale()` | 当前目录的快照是否可能落后于磁盘（`onConversationListChanged` 标脏）。命中脏快照的约定：先返回快照让界面即时渲染，后台 `refresh()` 补读并经 `dispatchList` 推送（stale-while-revalidate） |
| `invalidateCachedList(workspace)` | 丢弃指定目录的快照（关闭工作目录等场景），下次拉取重新读盘；其它目录不受影响 |
| `updateSessionStates(states)` | 把最新的会话状态分发出去（VS Code 实现还在这里刷新空闲计时，见下） |
| `dispatchStates(states)`（abstract） | 把会话状态分发给该宿主的界面 |
| `setStatusListener(fn)` | 注册会话状态回调（Electron 托盘与系统睡眠阻断用；VS Code 不注册） |
| `setSidebarOutlet(fn)` | 设置「推侧栏」的出口（Electron 专用） |
| `noteSessionActivity(sessionId)` | 记录会话活动（重置空闲计时）。基类默认无操作，只有 VS Code 实现覆盖 |
| `getSessionStatesSnapshot()` | 最近一次分发的全量会话状态快照（Electron 侧栏播种 / 宿主恢复时读） |
| `workspaceCacheKey()`（protected） | 当前缓存目录的键：基类用工作目录路径，Electron 实现换成稳定 refKey（切目录不清快照） |

两个实现：

| | `SingleWebViewConversationManager`（`src/VSCodeConversationManager.ts`） | `ElectronConversationManager`（`electron/ElectronConversationManager.ts`） |
| --- | --- | --- |
| `dispatchList` | `host.sendToWebview({ type: 'conversationsData', conversations })` | ① `sendToSidebar('sidebar:conversations-updated', list)`<br>② `host.sendToWebview({ type: 'conversationsData', ... })` |
| `dispatchStates` | `host.sendToWebview({ type: 'sessionRuntimeStates', states })`——对话树流水灯 + abort 按钮的唯一数据源 | ① `sendToSidebar('sidebar:session-states-updated', states)`<br>② `statusListener(states)`（托盘）<br>③ 广播给所有聊天视图（abort 按钮） |
| 空闲会话回收 | 承担（见下） | 不承担 |

**空闲会话回收只在 VS Code 生效**（计时 owner 在宿主层，core 不参与计时）：

| | VS Code | Electron |
| --- | --- | --- |
| 是否回收 | 是 | 否 |
| 理由 | 只有一份 webview，关闭空闲对话只是卸内存 | 每个对话一个独立视图，自动关闭等于关掉用户的窗口 |
| 实现位置 | `SingleWebViewConversationManager` | —（基类的 `noteSessionActivity` 是空实现） |

VS Code 实现里的成员：

| 成员 | 语义 |
| --- | --- |
| `noteSessionActivity(sessionId)`（覆盖） | 记录会话活动，重置该会话的空闲计时 |
| `setActiveSessionProvider(fn)` | 注入「当前激活会话」读取器（前台会话永不关闭，且持续刷新计时） |
| `setIdleCloseHandler(fn)` | 注入「关闭对话」回调（bootstrap 指向 `WebViewUI.closeConversation`） |
| `startIdleMonitor()` / `stopIdleMonitor()` | 启动 / 停止巡检（间隔 `SESSION_IDLE_CHECK_INTERVAL_MS` = 1 分钟） |
| `sweepIdleSessions(now)` | 巡检一次：关闭所有满足条件的空闲会话，返回被关闭的 sessionId 列表 |
| `updateSessionStates(states)`（覆盖） | 先刷新空闲计时再调 `super`（会话进入工作、或从工作回到空闲时都算一次活动） |

规则：非激活会话在最后一次活动后空闲超过 `SESSION_IDLE_CLOSE_MS`（2 小时）即关闭；「是否
空闲」由 core 的只读查询 `sessionResources.isSessionIdle` 判定（压缩中 / 等待用户 /
后台 Bash / 非 idle 子代理（递归）/ 引擎消费中任一为真即非空闲），判定失败时保守视为
「非空闲」；未注入关闭回调时不关闭任何会话。
关闭动作走 `idleCloseHandler`（`WebViewUI.closeConversation` = 发 `conversationClosed` +
宿主销毁视图）。

活动来源：宿主侧上报（打开 / 新建 / 用户发消息，经 `WebViewUiPort.noteSessionActivity`）
与 `updateSessionStates` 的状态跃迁。

`isSessionIdle` 的「等待用户」事实读 core 自己的 `sessionRuntime`（`isSessionWaiting`）：
入队时 `Integration.requestUserChoice` 标记，webview 弹出 / 应答时宿主经
`UiEvent.userChoicePendingChanged` 上报（[DEVELOPMENT.md 第 4.3 节](../DEVELOPMENT.md#43-uieventui--core单向)），core 侧由 `markSessionWaiting` 落地。

**调用方**：

| 流 | 触发 | 路径 |
| --- | --- | --- |
| 列表 | core 侧数据变化 | `CoreEvent.conversationListChanged` → `WebViewUI.onConversationListChanged()` → `conversations.refresh()` |
| 列表 | UI 主动查询 | webview 的 `getConversations` 消息 → `WebViewUiPort.refreshConversations()` → `conversations.refresh()` |
| 状态 | core 侧状态变化 | `CoreEvent.sessionRuntimeChanged` → `WebViewUI.onSessionRuntimeChanged()` → `conversations.updateSessionStates(states)` |
| 视图（仅 Electron） | 视图 open / close / LRU 淘汰 | `ChatViewManager.onLoadedChanged(ids)` → `sidebar:session-loaded-changed` → 侧栏绿点 |
| 空闲回收（仅 VS Code） | 定时巡检 | `sweepIdleSessions()` → `idleCloseHandler` |

**`loaded`（视图已打开）不进这两条流**：它是 Electron 视图层的状态（`ChatViewManager` 知道
哪些会话的视图开着），不是 core 的事实，也不属于磁盘列表；`ChatViewManager` 是这份状态的
owner，由它**单独推送**给侧栏（`sidebar:session-loaded-changed`），与列表流、状态流并列。
侧栏渲染时把三条流合并：列表提供行、状态流提供流水灯、loaded 流提供绿点。

## 5. 宿主侧入口：动作翻译为 UiEvent

宿主（webview 协议消息、Electron 原生侧栏 IPC、Electron 菜单、VS Code 编辑器事件、VS Code
空闲回收）**改 core 状态的请求一律翻译为 `UiEvent`**，不直接调 core 的状态变更函数；宿主可以
import core 的只读函数与类型（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 9）。

| 入口 | 位置 | 翻译为 |
| --- | --- | --- |
| webview 协议消息 | `webviewMessageHandler` 的 `messageHandlers` 表 | 多数映射为 `UiEvent`（[DEVELOPMENT.md 第 4.3 节](../DEVELOPMENT.md#43-uieventui--core单向)） |
| 关闭会话 / 空闲回收（仅 VS Code） | `WebViewUI.closeConversation` → `releaseConversation` | `conversationClosed` |
| 编辑器上下文 | `extension.ts` 的 `persistCurrentFileContext` | `conversationContextUpdated` |
| Electron 侧栏：关闭 | `sidebar:close-conversation` | `WebViewUI.closeConversation(sid)`（= `conversationClosed` + 关视图） |
| Electron 侧栏 / webview 顶栏：删除 | `sidebar:delete-conversation` / `deleteConversationWithViews`（webview 的 `deleteConversation` 在多视图宿主由 `electron/main.ts` 接管） | 两条入口共用 `deleteConversationWithViews`：先用 core 的 `collectConversationClosure` 求受影响闭包（自身 + 所有层级子孙，与 `deleteConversation` 同一条规则），逐个 `closeConversation`，再对 root 发 `conversationDeleted`（core 递归删盘） |
| Electron 侧栏：重命名 | `sidebar:rename-conversation` | `conversationRenamed` |
| Electron 侧栏：智能命名 | `sidebar:smart-name-conversation` | LLM 起名后发 `conversationRenamed` |
| Electron 菜单：唤醒快捷键 | File - Shortcut... 对话框（`electron/main.ts`） | 写宿主本地状态（`workspace-state.json` 的 `shortcut` 字段），不经总线 |

**留在宿主 / 共享子模块内、不翻译为事件的**：

| 类别 | 内容 |
| --- | --- |
| 纯宿主操作 | `openFile` / `openMermaidPreview` / `openSpinDesign` / `openUrl` / `showVirtualDocument` / `requestToolMeta` / `debugLog` |
| 无副作用查询 | `requestModels` / `fetchProviderModels` / `detectProviderModelApiTypes` / `requestLLMConfig` / `requestSettingsDefaults` / `requestMcpServers` / `requestSkills` / `requestConversationSpaces` / `requestSmartNaming` |
| 纯显示操作 | `expandCompact`（只读归档 + 重放消息到 webview，不改 core 状态） |
| 配置文件写入 | `UIHost.updateSettingsJson`（LLM 配置 / MCP 默认值 / 高亮语言）——写全局 `settings.json` 是宿主能力；项目清单 `workspace.meta.json` 归 core，不在宿主 |
| 宿主本地偏好写入 | `electron/main.ts` 的 `writeThemeMode` / `writeWakeShortcut`（`theme` / `shortcut`）——经 `electron/workspaceStateStore.ts` 落 `userData/workspace-state.json`（原子落盘），与 core 的 settings.json 无关 |
| 载体 / 视图层动作 | Electron 的 `sidebar:new-conversation` / `sidebar:open-conversation` / `sidebar:get-active-session` / `sidebar:active-session-changed`（开视图与视图层状态，随后由新视图自己发 `loadConversation`）；webview 的 `closeWebview` / `openConversation` / `openNewConversation` / `prewarmViewReady` 由 `electron/main.ts` 的消息入口直接消化，不经 `WebviewMessageHandler`、不走总线。`deleteConversation` 在多视图宿主（Electron）由同一入口接管：先关该会话的视图（含子会话闭包，与侧栏删除共用 `deleteConversationWithViews`），再发 `conversationDeleted`；单视图宿主没有可关的视图，仍走 `WebviewMessageHandler` 的 UiEvent 翻译 |
| 环境查询（按来源回包） | webview 的 `requestTheme` / `requestContextLimit` 在 `WebviewMessageHandler` 内处理（按 `ctx.sender` 回包），但不走总线——它们只读 core 的配置函数与宿主环境，不改 core 状态。宿主在视图加载时也推同一对消息（`UIHost.onThemeChanged` / `WebViewUI.pushContextLimit`），但那次推送受时序约束（VS Code `resolveWebviewView` 后延时、Electron `did-finish-load`），由 webview 主动拉取才能尽早解除首屏 Loading，也让多视图宿主下的后台预热视图拿到回包 |

**唤醒快捷键对话框**（Electron 专属，File - Shortcut...）

唤醒快捷键是宿主能力，不能放进 webview：页面收不到被系统抢占的组合键，也无法注销已注册的
全局快捷键。因此它是 Electron 的一个独立对话框（`electron/main.ts` 的 `openShortcutDialog` +
`electron/shortcutPreload.ts` + `electron/shortcutDialogHtml.ts`）：

| 环节 | 做法 |
| --- | --- |
| 打开 | `suspendWakeShortcut(win.webContents)` 注销当前全局快捷键（与窗口销毁时的兜底恢复配对），避免用户按下的组合键先触发唤醒 |
| 按键捕获 | 主进程 `before-input-event` → `electron/shortcut.ts` 的 `acceleratorFromKeyboardEvent`（页面只负责显示） |
| 保存 | 写宿主本地偏好（`writeWakeShortcut`），写完后关闭窗口；关闭回调按最新偏好重新注册 |
| 取消 / Esc | 直接关闭；关闭后按最新偏好恢复注册 |
| 注册入口 | `registerWakeShortcutValue(shortcut)`：先注销旧值再注册新值，失败静默忽略 |

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
| `host: UIHost` | 宿主能力（投递消息、日志、打开文件…）；子模块不 import `vscode` / `electron`（[DEVELOPMENT.md 第 2 章](../DEVELOPMENT.md#2-分层与依赖规则)规则 3、4） |
| 回调 | 回推 webview 或通知 `WebViewUI`：`postToWebview` / `postConversationLoaded` / `setTitle` / `closePreview` … |

`WebviewMessageHandler` 另有一个**构造后回填**的窄端口 `uiPort`（只声明自己用到的 7 个成员）。
回填是因为 `WebViewUI` 只能在构造期间把自己交出去；端口内容是 `WebViewUiPort`（第 9 节）的子集。

子模块之间只有一条依赖：`ToolHandler` 与 `WebviewMessageHandler` 都持有**同一个**
`UserChoiceManager` 实例（共享 diff 快照与 pending 队列）。该实例由宿主工厂
（`WebViewUI.create` 的 `deps.createUserChoiceManager`）创建——它是唯一需要宿主差异的模块
（VS Code 注入 `OutputChannel`，Electron 注入 `console` 包装的日志出口）。

## 6. UserChoiceManager

共享模块本身不依赖任何宿主 API；需要宿主能力时用注入的回调。**diff 预览不在本模块内**：
权限确认的 diff 由 core 展开进 `displayArgs.diffHunks`，随工具卡片在 webview 里渲染
（第 7 节）；宿主侧的 diff 预览归 `UIHost.showDiff`。

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
| `showUserChoice(sessionId, options)` | 弹出选择框并等待应答（队列投递与未接线兜底的共同落点）：① 保存 diff 快照（`beforeContent` / `afterContent` / 上下文 / 起止行）② 投递 `requestUserChoice` ③ 发 `UiEvent.userChoicePendingChanged(pending: true)`（`idle` / `waiting` 归 core，见[DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)；Embedded 入队时 `Integration.requestUserChoice` 已提前标记、Standalone 由 Core 的 `waiting_request` 标记，此处幂等）④ 返回 Promise，`resolve` 时 `closePreview()` + 发 `userChoicePendingChanged(pending: false)` |
| `hasPendingChoice(sessionId)` | 该会话是否有待答选择：`pendingUserChoices`（已弹出）或 `userChoiceQueue`（已入队未投递，会话尚未 open）任一命中即为真。供 core `isSessionIdle` 判定「非空闲，不回收」 |
| `saveDiffSnapshot(sessionId, snapshot)` | 写入 diff 快照（`beforeContent` / `afterContent` / 上下文 / 起止行）并登记归属会话。`ToolHandler.requestToolPermission` 调用（`showUserChoice` 也直接写同一份快照） |
| `dropSession(sessionId)` | 会话 UI 侧状态释放：拒绝该会话在 `UserChoiceQueue` 里尚未投递的请求（Standalone 的 Core 进程不持有宿主队列，Embedded 由 core 的 `releaseSessionResources` 负责，此处幂等），清掉该会话的 `pendingUserChoices` 回调，并在 diff 快照归属该会话时清空快照。由 `WebViewUI.dropSession` fan-out 调用（[docs/webview-ui.md 第 9 节](webview-ui.md#9-生命周期dropsession)） |
| `pendingUserChoices: Map<choiceId, {sessionId, resolve}>` | 待答选择表；`WebviewMessageHandler.handleRespondUserChoice` 按 `choiceId` 取出并 resolve |
| `currentBeforeContent` / `currentAfterContent` / `currentContextBefore` / `currentContextAfter` / `currentStartLine` / `currentEndLine` | 当前 diff 快照，**与 `ToolHandler` 共享**（`ToolHandler` 经 `saveDiffSnapshot` 写入，两边都读）；`diffSnapshotSessionId` 记录归属会话，供 `dropSession` 精确清理 |

调用方：`WebViewUI.requestUserChoice`（`CoreRequest.userChoice` 的处理方）与
`WebviewMessageHandler.handleRespondUserChoice`（响应回填）。

## 7. ToolHandler

构造依赖：`{ host, postToWebview, userChoiceManager }`。`userChoiceManager` 只用于共享
diff 快照——**确认框不在这里弹**（见下）。

| 成员 | 语义 |
| --- | --- |
| `requestToolPermission(sessionId, toolUseId, toolName, permResult, displayArgs, agentMode)` | `CoreRequest.toolPermissionRequested` 的处理方。① 仅当 `permResult` 真的带 `beforeContent`（Edit / Write）时经 `userChoiceManager.saveDiffSnapshot` 写入 diff 快照（同时登记归属会话）——否则会把上一次 Edit 的 diff 挂到本次失败卡片上 ② 投递工具卡片（`addMessage`，`status: 'normal'`）③ 带 diff 且 `agentMode === 'manual'` 时调 `host.showDiff`（见下）④ 追加写 `_meta`（`updateToolUseMeta`，append-only）⑤ 原样返回 `permResult` |
| `onToolCall(sessionId, toolUseId, toolName)` | 投递 `updateToolStatus: 'running'` |
| `onToolResult(sessionId, toolUseId, toolName, output, status)` | Edit 失败时清空卡片上的 diff；成功时补 `contextBefore` / `contextAfter` / 起止行；最后投递 `updateToolStatus`（`success` / `fail` + `output`） |

**不做权限判断**：`permResult` 已由 core 按 agentMode 规则加工完（`allow` / `deny` / `ask`，
见[DEVELOPMENT.md 第 4.2 节](../DEVELOPMENT.md#42-corerequestcore--ui请求-响应)）。`ask` 的确认框由 core 侧发起（Embedded：`RunTools` → `Integration.requestUserChoice`；
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

## 8. WebviewMessageHandler

构造依赖：`{ host, postToWebview, postConversationLoaded, setTitle, userChoiceManager }`
（外加可选的 `onUserChoiceResponded`），构造完成后由 `WebViewUI` 回填 `uiPort`。

| 成员 | 语义 |
| --- | --- |
| `handleWebviewMessage(message, ctx?)` | 唯一入口（宿主 webview 的 `onDidReceiveMessage`）；按 `message.type` 查表分发，未知类型只记日志；异常兜底成一条日志，不冒泡成未处理的 rejection。`ctx.sender` 标识消息来源视图（`WebviewRequestContext`）：多视图宿主传入句柄，单视图宿主 / 宿主主动推送省略（缺省 `{ sender: null }`）；需要按来源回包的消息依赖它定向投递 |
| `getActiveSessionId()` | UI 自己维护的「当前前台会话」（core 不感知） |
| `setActiveSessionId(sessionId)` | 宿主切换前台会话时同步「当前活跃会话」。多视图宿主（Electron）切到**已打开**的视图不会再走 `loadConversation` / `startNewConversation`，必须由宿主在活动视图变化时显式同步（`ChatViewManager.show` → `onActiveSessionChanged` → `WebViewUI.setActiveSessionId`）；否则 `trackedActiveSessionId` 停在旧视图，按会话解析的数据（project skills / MCP 启用列表）会取到别的标签页的工作目录 |
| `dropTrackedSession(sessionId)` | 会话关闭 / 删除时清掉 `trackedActiveSessionId`（若指向该会话） |
| `emitUiEvent(event)` | `requireEventBus().emitToCore(event)`——**改 core 状态的唯一出口** |
| `buildMessageHandlers()` | 42 个消息类型 → 处理器（见下）；其中 `sendMessage` 是用户消息的唯一入口（`handleUserMessage`），wire 类型不区分「新消息 / 排队消息」：是否登记排队项由宿主按 core 的会话运行时快照决定（第 9 节 `onQueuedMessage`） |

**消息分发表**（`buildMessageHandlers`，按代码注释分区）：

| 分区 | 内容 |
| --- | --- |
| 纯宿主操作 | `openFile` / `requestToolMeta` / `showVirtualDocument` / `openMermaidPreview` / `openSpinDesign` / `openUrl` / `debugLog` |
| 无副作用查询 | `requestModels` / `fetchProviderModels` / `detectProviderModelApiTypes` / `requestLLMConfig` / `requestSettingsDefaults` / `requestSkills` / `requestConversationSpaces` / `requestMcpServers` / `requestSessionRuntimeStates` / `getConversations` |
| 环境查询 | `requestTheme`（→ `host.onThemeChanged(ctx.sender)`）/ `requestContextLimit`（→ `pushContextLimit(ctx.sender, modelRefOf(msg.provider, msg.model))`：读该模型身份（provider + model）的上下文配置，经 `sendToWebviewView` / `sendToWebview` 回包 `contextLimitUpdated`；`ref` 为 `undefined` 时按 active provider 的默认模型算，视图加载初始化推送即走这条）；`pushContextLimit` 也是 `WebViewUI` 的对外方法，供宿主在视图加载时主动推同一份内容 |
| 请求响应 / 显示 | `respondUserChoice` / `expandCompact` / `rollbackEdit`（→ `UiEvent`） |
| 消息 / 压缩 / 中止 | `sendMessage`（→ `handleUserMessage`：登记排队项 / 乐观回显后发 `UiEvent.userMessageSubmitted`）/ `abort` / `backgroundBashTool`（Bash 卡片「转后台」，→ `UiEvent.bashBackgroundRequested`）/ `discardQueuedMessage` / `requestCompress`（除 `sendMessage` 外均 → `UiEvent`） |
| 会话生命周期 | `loadConversation` / `startNewConversation` / `deleteConversation` / `renameConversation` / `updateConversationContext` / `clearConversationSpace`（`deleteConversation` / `renameConversation` / `updateConversationContext` / `clearConversationSpace` → `UiEvent`；多视图宿主的 `deleteConversation` 由宿主消息入口先接管，见第 5 节「载体 / 视图层动作」） |
| 会话配置 | `setModel` / `setThinkingMode` / `setPromptMode` / `setAgentMode` / `setWebSearch` / `setMcpEnabled` / `setMcpEnabledList`（全部 → `UiEvent`，core 处理后广播 `sessionConfigChanged` 回推多端）。`setModel` 的 wire 载荷是扁平的 `model` + `provider`，在 handler 入口组装成 `ModelRef`（provider 空串非法：记录日志并忽略，不回退到其它 provider） |
| 其它 | `saveLLMConfig` / `requestSmartNaming` |

前两个分区留在本模块内（只操作宿主或只读 core）；其余要么发 `UiEvent`，要么是**显示类**动作。
完整映射见[DEVELOPMENT.md 第 4.3 节](../DEVELOPMENT.md#43-uieventui--core单向)的「UI 侧触发点」列。

**LLM 配置面板**：`requestLLMConfig`（用户点设置按钮）与 `startNewConversation` 的配置引导都委托
`WebViewUI.showLLMConfigPanel(trigger, sessionId)`；视图加载补弹由两个 bootstrap 用同一方法触发
（`trigger='startup'`）。core 只提供配置事实（`getLLMConfigPanelPayload` /
`hasActiveProviderSetting` / `readMcpServersForDefaults`），wire message 的组装与投递在 UI 层
（[docs/contracts.md 第 6 节](contracts.md#6-userchoicemanager)）。三条触发路径共用同一份面板载荷（含 MCP 默认启用列表），差异只在守卫。

**留在模块内的两处例外**：

- `handleExpandCompact`：只读归档文件并把消息重放给 webview，不改 core 状态（纯显示）。
- `handleSaveLLMConfig`：`settings.json` 的写经 `host.updateSettingsJson`（core 只读不写，
  见第 1 节），其余仍是「组装 mutator + 回推协议消息」。

**并发防护**：`loadConversationSeq` 单调递增，`loadConversation` 的每个 `await` 之后都校验
序号，丢弃过期结果（用户快速连点两个对话时，后发的请求可能先完成）。

## 9. 端口：WebViewUiPort

位置：`src/host/ui/ports.ts`。由 `WebViewUI` 实现，子模块用它回推 webview 或读取 UI 侧状态，
**拿不到事件处理方法**。

| 成员 | 语义 |
| --- | --- |
| `postToWebview(sessionId, message)` | 补 `sessionId` 后投递到宿主 webview |
| `postConversationLoaded(sessionId, conversation, extra)` | 推送 `conversationLoaded`（含 `activityPhase`，见[docs/webview-ui.md 第 2 节](webview-ui.md#2-内部流程约定)） |
| `onTitleChanged(sessionId, title)` | 会话标题变化（`WebviewMessageHandler` 的 `setTitle` 回调走它） |
| `dropSession(sessionId)` | 该会话的 UI 侧状态已释放 |
| `onQueuedMessage(sessionId, queued)` | 登记 / 清除该会话的排队项（`queued` 为 `null` 表示清除，载荷类型 `QueuedMessageState`）。登记调用点：`WebviewMessageHandler.handleUserMessage`（会话运行时快照 `idle === false` 时，见 [docs/user-message-pipeline.md 第 1 节](user-message-pipeline.md#1-能力)）；清除调用点：内置命令就地执行（`onCommandSend`）、会话释放（`dropSession`）、进入上下文的用户消息由补发的 `addMessage`（带 `messageUuid`）清除 |
| `getActiveSessionId()` | 当前前台会话 |
| `openSpinDesign()` | 打开 Spin 设计器（子模块不直接持有 `SpinDesign`，见第 2 节） |
| `refreshConversations()` | 重新读取并分发对话列表 |
| `getSessionRuntimeStatesSnapshot()` | 最近一次会话运行时状态快照（`ConversationManager` 缓存）；Standalone 下进程内 `sessionRuntime` 不被写入，拉取必须走这份缓存 |
| `isQueryActive(sessionId)` | 该会话**自己的**查询是否在跑（`SessionUiState.isQueryActive`）；`conversationLoaded.hasActiveQuery` 的来源，**不用** `sessionRuntime.idle`（后者含后台子代理 / 后台 Bash / 压缩，见`docs/webview-ui.md`） |
| `isSessionOpen(sessionId)` | 该会话的聊天视图是否 open（多视图：有聊天视图；单视图：open == active）；经 `bootstrapCore` 注入给 `UserChoiceManager` 的 `isSessionOpenInternal`，core `UserChoiceQueue` 借它决定立即投递还是保留 pending（第 6 节） |
| `noteSessionActivity(sessionId)` | 记录会话活动（重置空闲计时；空闲回收只在 VS Code 生效，见第 4 节） |
| `showLLMConfigPanel(trigger, sessionId)` | 打开 LLM 配置面板：core 给配置事实，`WebViewUI` 组装 `showLLMConfig` 并投递（`trigger` 见下） |

配套类型：

| 类型 | 语义 |
| --- | --- |
| `LLMConfigPanelTrigger` | `'startup'` / `'new-conversation'` / `'request'`：决定是否弹（补弹 / 引导 / 无条件） |
| `WebviewPoster` | `(sessionId, 消息体) => void`：补全后投递的投递器，`WebViewUI` 内部统一用它 |
| `ConversationLoadedExtra` | `conversationLoaded` 的附加信息（`pendingToolUseIds` / `savedContext` / `parentSessionId` / `agentMode` / `hasActiveQuery` / `hasCompactArchive` / `model`），由 `WebviewMessageHandler` 提供，`WebViewUI` 再补 `activityPhase`。`hasActiveQuery` 只表示本会话自己的查询在跑（`isQueryActive`），不是 `sessionRuntime` 的「会话非空闲」 |

---

位置：`src/host/types.ts`（接口与两个常量）、`src/webview/webviewEnv.ts`（读取与校验）。

`HostInfo` 是**宿主能力声明**：宿主在 webview 启动前把自己「是什么、哪些 UI 由谁渲染」写进
`window.__hostInfo`，webview 据此渲染。它是 webview 感知**宿主能力差异**的唯一入口——
「对话列表归谁渲染 / 新建对话入口在哪 / 打开会话用哪种方式」都只读这张表，不做宿主嗅探
（嗅探只能回答「有没有 Electron preload」，无法表达这类能力差异）。

```ts src=src/host/types.ts
export interface HostInfo {
  /**
   * 会话视图模式：每个会话是否有独立的 webview。它是「切换会话 / 关闭会话」这一组
   * 行为的根，由宿主在启动时注入，运行期不变：
   * - multi：多视图。每会话一个独立 webview；切换会话由宿主另开 / 切换视图
   *   （openConversation），并提供关闭按钮销毁当前视图。
   * - single：单视图。一个 webview 承载全部会话；切换会话在当前 webview 内原地加载
   *   （loadConversation）；没有独立视图可关，因而不提供关闭按钮。
   */
  conversationView: 'single' | 'multi';
  /**
   * 对话列表的渲染方（唯一 owner），可在运行期切换：
   * - host：宿主原生侧栏（Electron 完整模式）
   * - webview：webview 顶栏下拉（VS Code / Electron 悬浮窗）
   */
  conversationListOwner: 'host' | 'webview';
}
```

两个字段正交：`conversationView` 是宿主的静态能力，`conversationListOwner` 只表达「列表与新建
入口画在哪里」。**其余差异由这两个字段推导**，收敛成 `src/host/types.ts` 里的四个纯函数，
避免各处重复写 `=== 'multi'`：

| 派生函数 | 语义 |
| --- | --- |
| `rendersConversationListInWebview(info)` | `conversationListOwner` 为 `webview` 时列表内嵌在 webview 顶栏；`host` 时由宿主原生侧栏渲染 |
| `newConversationEntryOf(info)` | 新建对话入口跟列表走：列表在原生侧栏时按钮也在侧栏，列表搬到顶栏后入口跟着搬 |
| `openConversationModeOf(info)` | `multi` → `openConversation`（另开视图）；`single` → `loadConversation`（原地重载） |
| `canCloseConversation(info)` | 仅 `multi` 为 `true`：只有多视图有可销毁的独立视图 |

两个常量是同一接口的两份取值：

| 常量 | 使用方 | `conversationView` | `conversationListOwner`（初始值） | 派生：列表渲染 | 派生：打开方式 | 派生：关闭按钮 |
| --- | --- | --- | --- | --- | --- | --- |
| `VSCODE_HOST_INFO` | VS Code 扩展 | `single` | `webview` | webview 顶栏 | `loadConversation` | 无 |
| `ELECTRON_HOST_INFO` | Electron 桌面窗口（`preload.ts`） | `multi` | `host` | 原生侧栏 | `openConversation` | 有 |

Electron 悬浮窗只把 `conversationListOwner` 切到 `webview`（原生侧栏没有位置可放），
`conversationView` 恒为 `multi`：切换会话照旧复用 / 另开视图，不原地重载。

## 10. 注入

同步注入的事实（页面首帧之前写入 `window`，webview 只读，缺失即接线错误，见[docs/contracts.md 第 10 节](contracts.md#10-注入)）：

| 事实 | 读取方 | VS Code（`src/extension.ts` 的 `getWebviewContent()` 内联脚本） | Electron（`electron/preload.ts`） |
| --- | --- | --- | --- |
| 宿主能力 `HostInfo` | `getHostInfo()` | `window.__hostInfo = ${JSON.stringify(VSCODE_HOST_INFO)}` | `contextBridge.exposeInMainWorld('__hostInfo', hostInfoForConversationListOwner(ELECTRON_HOST_INFO, conversationListOwner))`；`conversationListOwner` 取自 `--conversationListOwner=`（悬浮窗为 `webview`，完整模式为 `host`，见 9.3.2） |
| 界面语言 | `i18n` 的 `readInitialUiLanguage()` | `window.__uiLocale = "${uiLanguage}"`（宿主 `settings.json` 的 `uiLanguage`） | `exposeInMainWorld('__uiLocale', uiLanguage)` |
| 界面字号 | `fontSize` 的 `readInitialUiFontSize()` | `window.__uiFontSize = "${uiFontSize}"`（宿主 `settings.json` 的 `uiFontSize`） | `exposeInMainWorld('__uiFontSize', uiFontSize)`（取自 `--uiFontSize=`） |
| 首帧主题 | `getInitialTheme()` | `window.__initialTheme`（`activeColorTheme.kind === Light` → `'light'`，否则 `'dark'`） | `exposeInMainWorld('__initialTheme', initialTheme)` |

注入都在 webview 的 module 脚本执行之前完成，读取方首次调用时一定已就绪。

## 11. 读取与校验

位置：`src/webview/webviewEnv.ts`。

```ts src=src/webview/webviewEnv.ts
export function getHostInfo(): HostInfo;
```

- 首次调用读 `window.__hostInfo`，**逐字段校验**（`conversationView` / `conversationListOwner` 的取值），
  任一缺失或非法直接抛错；不做默认值兜底——「新宿主忘记声明能力」在启动期暴露。
- 校验通过后缓存到模块级 `_hostInfo`，后续调用直接返回。
- 全局类型声明在 `src/webview/declarations.d.ts`（`Window.__hostInfo?: HostInfo`）。
- **消息通道不在这里**：`resolveHostMessageApi()` 另外按「有没有 `window.electronAPI` / `window.vscode`」
  解析（Electron preload vs VS Code），那是传输层的存在性判断，不是能力声明（见第 13 节）。

## 12. 消费点

webview 只按能力渲染，不判断宿主类型：

| 消费点 | 读取 | 行为 |
| --- | --- | --- |
| `App.tsx` 顶栏 | `rendersConversationListInWebview(hostInfo)` | `true` 时渲染对话历史下拉（`Dropdown`）；`false` 时由 Electron 原生侧栏接管，webview 不渲染 |
| `App.tsx` 历史对话按钮提醒 | `sessionRuntimeStatesRef` 的 `waiting` + 本视图 `conversations` 的 `sessionId` 集合 | 对话列表由 webview 渲染（VS Code / Electron 悬浮窗）时，**本视图对话列表里**有「其它会话」在等待用户操作（ask user / 权限确认）时给历史按钮加黄色呼吸提醒（`history-btn--attention`）。只认本视图列表里的会话：列表按工作目录读盘（`loadConversationList(workspace)`），因此其它工作目录的 `waiting` 不提醒——浮窗顶栏只能看 / 切到本目录的对话，提醒了也过不去。列表与运行时状态都是**视图本地缓存**：列表只推给活动视图、状态只在变化时推，所以切到 webview 渲染列表时 `App.tsx` 会主动补发 `getConversations` + `requestSessionRuntimeStates`，避免「之前不是活动视图」的浮窗用旧数据判断（[docs/contracts.md 第 8 节](contracts.md#8-webviewmessagehandler)） |
| `App.tsx` 顶栏 | `newConversationEntryOf(hostInfo) === 'webview'` | 渲染「新建对话」按钮；`'host'` 时由侧栏按钮触发。点击后按 `openConversationModeOf(hostInfo)` 分支：`openConversation`（多视图）只发 `{ type: 'openNewConversation' }` 交给宿主另开 / 复用「未发送的新对话」视图，本视图不改自己的会话状态；`loadConversation`（单视图）在当前视图内原地新建（发 `startNewConversation`） |
| `App.tsx` 历史对话下拉的删除 | `openConversationModeOf(hostInfo)` | 删除当前对话后：`openConversation`（多视图）由宿主连同该会话的视图一起关（`deleteConversationWithViews`），关掉当前视图后由 `switchAwayFromClosedSession` 另开一个新对话视图，webview 不再自己新建；`loadConversation`（单视图）在当前视图内原地新建 |
| `App.tsx` 顶栏 | `canCloseConversation(hostInfo)` | `true` 时渲染关闭按钮，发 `{ type: 'closeWebview' }`（销毁 webview，释放渲染进程） |
| `App.tsx.navigateToSession()`（会话跳转的唯一 UI 入口，内部委托 `webviewEnv.navigateToConversation()`） | `openConversationModeOf(hostInfo)` | 对话列表 / 对话树 / 子代理 From 链接 / 返回父会话跳转时：`openConversation` 只发消息交给宿主另开视图；`loadConversation` 在当前视图内原地加载。任何入口都不得直连 `navigateToConversation`，否则会绕过 loading（统一入口见 9.3.1） |
| `Main.tsx` | 是否注入 `window.electronAPI` | 独立宿主（Electron）给 `<html>` 加 `standalone-host` class（深色背景 CSS）；VS Code 扩展不加。**不要用 `conversationListOwner` 判定**：悬浮窗注入的是 `webview`，但它仍是独立窗口，一样需要深色兜底 |

### 3.1 会话跳转的唯一入口

会话跳转（对话列表、对话树、子代理 From 链接、返回父会话按钮）**有且只有 `App.tsx` 的
`navigateToSession()` 一个 UI 入口**。它统一完成切换前的固定动作——暂存新对话草稿、进入
`useConversationLoading` 的 loading 状态、清空消息与排队横幅——最后才委托
`webviewEnv.navigateToConversation()` 把消息发给宿主。

`webviewEnv.navigateToConversation()` 是**底层原语，不是入口**，只允许被 `navigateToSession()`
调用。历史上返回父会话按钮与 From 链接曾直连该原语，导致同一类跳转「有的显示 loading、
有的直接换内容」的双路径不一致（直连路径还会让旧会话内容在 `conversationLoaded` 到达前
继续显示，且失败时没有超时兜底）。新增跳转入口时必须走 `navigateToSession()`。

### 3.2 渲染方的运行期切换

`conversationListOwner` 不只由注入值决定。Electron 悬浮窗会隐藏原生侧栏，此时宿主发
`{ type: 'setConversationListOwner', owner }` 消息，`webviewEnv` 写进模块级渲染方
并通知订阅者；`App.tsx` 用 `useState` + `onConversationListOwnerChanged` 重渲染，其余消费点统一读
`getEffectiveHostInfo()`（= `hostInfoForConversationListOwner(getHostInfo(), 当前渲染方)`），
不再直接读 `getHostInfo()`。

宿主侧同一个入口负责「布局 + 能力声明」：`ChatViewManager.setConversationListOwner(owner)`
同步更新原生侧栏的显隐与 `--conversationListOwner=` 启动参数，已打开的视图收
`setConversationListOwner` 消息就地切换，新建视图直接带新参数（避免顶栏闪一下）。

`conversationView` 不参与运行期切换：Electron 悬浮窗仍是多视图，切换会话照旧复用 / 另开视图。
`Main.tsx` 的 `standalone-host` 不看渲染方，改用 `window.electronAPI` 判定宿主类型
（见第 12 节表格）：渲染方会随悬浮窗变化，而「是否独立窗口」不会。

## 13. 消息通道

能力声明之外的另一条契约：webview 往宿主发消息。位置：`src/webview/webviewEnv.ts`。

```ts src=src/webview/webviewEnv.ts
interface HostMessageApi {
  postMessage(message: unknown): void;
}
export function getHostMessageApi(): HostMessageApi;   // 取通道；缺失抛错
export function hasHostMessageApi(): boolean;          // 探测通道；不抛错
export function postMessage(msg: unknown): boolean;    // 有通道则发，返回是否发出
```

`getHostMessageApi()` 首次调用按固定顺序解析并缓存到模块级 `_hostMessageApi`：
`window.electronAPI.postMessage`（Electron preload）优先，其次 `window.vscode.postMessage`
（VS Code `acquireVsCodeApi()` / 浏览器 shim）；两者都没有直接抛错——宿主集成缺失，
不做静默降级（[DEVELOPMENT.md 第 5.1 节](../DEVELOPMENT.md#51-不过度-fallback)）。`hasHostMessageApi()` 走同一套探测但不抛错、不写缓存，供可选发送路径先行判断。

| 宿主 | 注入方 | 通道 | 消息去向 |
| --- | --- | --- | --- |
| VS Code | `extension.ts` `getWebviewContent()` 内联脚本 | `window.vscode` | 扩展主进程 |
| Electron | `electron/preload.ts` `contextBridge` | `window.electronAPI` | `ipcRenderer.send('webview-message')` → 主进程 |

Electron 下 `getHostMessageApi()` 返回 `electronAPI` 的包装对象，`window.vscode` 在该宿主不存在；
VS Code 下返回 `acquireVsCodeApi()` 实例本身。

反向通道（宿主 → webview）两宿主统一成 `window` 的 message 事件：preload 把 `webview-message`
的 `ipcRenderer` 事件转发为 `window.postMessage(msg, '*')`，webview 只写一份
`addEventListener('message')`（`electron/preload.ts` 文件头注释）。

这条通道只回答「怎么发」，不表达宿主能力差异；UI 行为差异一律读 `__hostInfo`（第 11 节 / 第 12 节）。
