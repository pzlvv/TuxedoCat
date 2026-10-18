---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：宿主契约

本规格界定宿主侧的三个契约：`UIHost`（第 1 节）、`SpinDesign`（第 2 节）、`ConversationManager`（第 4 节），Core 进程内的 MCP 生命周期（第 3 节），以及宿主侧入口把动作翻译为 `UiEvent` 的规则（第 5 节）。契约成员全部必选、按 UI surface 划分；分层与依赖规则见 [docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)，事件词汇表见[第 1 节](events.md#1-总线契约)、[第 2 节](events.md#2-事件词汇表)。宿主侧共享子模块与窄端口见 `docs/architecture/host-ui-modules.md`；webview 侧的宿主能力声明与消息通道见 `docs/hosts/host-info.md`。

交叉引用：`docs/hosts/webview-ui.md`（WebViewUI 实现与会话 UI 状态——契约的消费方）、`docs/hosts/host-matrix.md`（两个宿主对三契约的逐成员实现对照）、`docs/hosts/webview-facts.md`（webview 的事实与等待态）、[docs/architecture/principles.md](principles.md)（架构原则）。

---

宿主差异全部收敛在三个宿主契约上；MCP 的生命周期整体在 Core 进程内：

| 名称 | 形态 | 服务的 surface | 实现 |
| --- | --- | --- | --- |
| `UIHost` | interface（`extends WorkspaceProvider`） | 对话 webview 的宿主能力 | `VSCodeUIHost` / `ElectronUIHost` |
| `WorkspaceProvider` | interface | 工作区（进程级环境事实，不是 UI surface） | 同上两个宿主类 |
| `SpinDesign` | interface | Spin 设计器（独立面板 / 窗口） | `VSCodeSpinDesign` / `ElectronSpinDesign` |
| MCP 生命周期 | Core 进程内的模块（`core-rs/src/mcp.rs`，**不是宿主契约**） | MCP 的会话级生命周期 | 唯一实现，无宿主分支 |
| `ConversationManager` | abstract class | 对话列表 / 会话运行时状态（空闲会话回收在 VS Code 实现里） | `SingleWebViewConversationManager` / `ElectronConversationManager` |

契约按 **UI surface** 划分（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 7）：新增面板、窗口或列表类功能时，先确定其所属
surface，而不是向 `UIHost` 追加成员。工作区是进程级环境事实，不属于任何 UI surface，
因此 `WorkspaceProvider` 单独成契约，供只需要工作区的消费方依赖；`UIHost` 继承它，
保持「对话 webview 宿主」契约的完整性。

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [UIHost：对话 webview 的宿主能力](#1-uihost对话-webview-的宿主能力) |
| 2. | [Spin 设计器契约：SpinDesign](#2-spin-设计器契约spindesign) |
| 3. | [MCP 生命周期（Core 进程内）](#3-mcp-生命周期core-进程内) |
| 4. | [对话相关数据：ConversationManager](#4-对话相关数据conversationmanager) |
| 5. | [宿主侧入口：动作翻译为 UiEvent](#5-宿主侧入口动作翻译为-uievent) |

---

## 1. UIHost：对话 webview 的宿主能力

位置：`src/host/UIHost.ts`（interface）。

设计约束：

| 约束 | 理由 |
| --- | --- |
| 成员全部必选，不出现 `?` | 调用方不必用 `host.foo?.()` 静默降级；可选语义用 `null` 或判别联合表达 |
| 能力命名表达语义，不暴露宿主类型 | 共享代码里不出现 `host.kind === '...'` 形式的宿主嗅探（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 5） |
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
`sessionId` 解析（见[docs/architecture/core-ui-separation.md 第 3.3 节](core-ui-separation.md#33-会话工作目录)）。宿主在会话首次被 core 解析目录之前把目录登记进去
（`WebviewMessageHandler.ensureSessionWorkspace`，见[docs/hosts/host-bootstrap.md 第 2 节](../hosts/host-bootstrap.md#2-启动期状态写入入口与读取器)）。

`WebviewViewHandle` 是名义类型（必须是该类实例，任意对象无法冒充）：多视图宿主用它包裹自己的
视图对象，单视图宿主的 `sendToWebviewView` 等价于 `sendToWebview`（句柄不参与路由）。句柄的产出
方式见[docs/hosts/host-bootstrap.md 第 1 节](../hosts/host-bootstrap.md#1-宿主接线)。

`showDiff` 由工具权限流程调用（`ToolHandler.requestToolPermission`，见[docs/architecture/host-ui-modules.md 第 2 节](host-ui-modules.md#2-toolhandler)）：VS Code 打开
before/after 两个虚拟文档组成的 diff 标签，Electron 空实现（diff 只在 webview 里渲染）。
**仅 manual 模式调用**——auto / risk 下改动自动放行，不弹原生 diff
（webview 工具卡片里的 diff 仍然展示）。

全局配置 `~/<CONFIG_DIR_NAME>/settings.json` 是宿主资源，写入口唯一（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 9）：

| 文件 | 内容 | 写入口 |
| --- | --- | --- |
| `~/<CONFIG_DIR_NAME>/settings.json` | 全局配置（llm / mcp / uiLanguage / uiFontSize / highlightLanguages / defaultAgentMode / defaultPromptMode…） | `updateSettingsJson` |

项目对话目录清单 `<conversations>/<project>/workspace.meta.json` **不在这里**：它归 core，
由 core 在建目录时自己写（Core 进程 `core-rs/src/config.rs`；宿主侧共享读写库
`src/shared/history/Config.ts` 的 `ensureProjectConversationDir` 服务同一格式的宿主
读写），宿主不参与写盘。

`theme` / `shortcut` 不属于这份文件：它们是 Electron 宿主本地偏好，落
`userData/workspace-state.json`（`electron/workspaceStateStore.ts`，临时文件 + rename 原子落盘、内容未变不落盘），core 不读不写（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)）。

两个宿主共用 `src/host/settingsFile.ts`：`updateSettingsJson` 委托给
`SettingsStore.updateSettings`，串行化「读-改-写」（避免并发写坏文件或丢字段），
写盘后重新解析快照并通知订阅者——`bootstrapCore` 注册的那次订阅会把整份快照推给
Connection（[docs/architecture/core-ui-separation.md 第 4.6 节](core-ui-separation.md#46-写盘规则)）。core 侧没有读缓存，也没有
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
逐成员对照见[docs/hosts/host-matrix.md 第 3 节](../hosts/host-matrix.md#3-uihost-实现对照表)。

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
（`WebViewUI` 转发到 `spinDesign.open()`），维持「子模块只认窄端口」的约定（[docs/architecture/host-ui-modules.md](host-ui-modules.md)）。

## 3. MCP 生命周期（Core 进程内）

位置：`core-rs/src/mcp.rs`（连接池与会话引用）、`core-rs/src/mcp_config.rs`（会话启用列表）、
`core-rs/src/mcp_http.rs`（Streamable HTTP / SSE 传输）。

MCP 的生命周期**不是宿主契约**：没有 VSCode / Electron 两个实现，整体在 Core 进程内。
放在本章，是因为它**不挂在 `UIHost` 上**：**MCP 的生命周期由 Core 的会话事实决定，
不由 UI 的视图生命周期决定**，所以「会话打开」不能是宿主能力。

职责：把「会话生命周期 → MCP 引用」的映射收口到一处，驱动信号全部来自 Core 的
会话事实：

| 入口 | 触发 | 语义 |
| --- | --- | --- |
| `host_session_opened(sessionId)` | `start_conversation` / `on_conversation_opened` | 按该会话的启用列表建立引用（幂等；可能耗时，后台执行不阻塞）；连接 / 断开结束后广播 `sessionConfigChanged(mcpEnabled)` |
| `host_session_closed(sessionId)` | `on_conversation_closed` / `on_conversation_deleted` | 释放该会话的全部引用（归零的 server 进入延迟回收） |
| `host_session_enabled_changed(sessionId)` | 启用列表变化（`mcpEnabledChanged` / `mcpEnabledListChanged`） | 差量同步；结束后广播 `sessionConfigChanged(mcpEnabled)` |
| `prune()` | Core 启动收尾 | 清理没有任何会话引用的残留进程 |
| `shutdown()` | Core 进程退出 | 结束全部 MCP 子进程，避免留下孤儿进程 |

`host_session_opened` / `host_session_enabled_changed` 在连接 / 断开进入最终状态
（running 或 error）后广播 `sessionConfigChanged(mcpEnabled)`（servers-changed 出口，
sink 注册在 `main.rs`）：连接是异步的，缺这条事实，webview 的 MCP 菜单会一直停在
乐观更新 / 首次推送时的「连接中」。UI 收到后重新读取运行时状态并回推 `setMcpServers`
（[docs/architecture/events.md 第 2.1 节](events.md#21-coreeventcore--ui单向)的 `sessionConfigChanged`）。

另提供只读查询：`get_tools` / `get_tools_for_servers`（按会话启用列表过滤的
`mcp__*` 工具注入）、`get_server_status`（运行时状态，MCP 面板经
`UiRequest.mcpServersRequested` 索取）、`call_tool`（工具执行与子进程终止）。

**留在 UI 侧的 MCP 代码**（只读展示，与生命周期无关）：

| 位置 | 内容 |
| --- | --- |
| `webviewMessageHandler.handleRequestMcpServers` / `pushMcpServers` | 经 `UiRequest.mcpServersRequested` 读配置 + 会话启用列表 + 运行时状态，推给面板 |
| `webviewMessageHandler` 的 `setMcpEnabled` 翻译 | 发 `UiEvent.mcpEnabledChanged`；写盘与差量同步由 Core 侧处理 |
| `webviewMessageHandler` 的 `setMcpEnabledList` 翻译 | 发 `UiEvent.mcpEnabledListChanged`（整表覆盖，设置面板「应用到当前对话」）；同上一条链路 |
| `webviewMessageHandler.handleSaveLLMConfig` 的钉住 | 保存全局默认 MCP 列表前，先读该会话生效的启用列表并发 `mcpEnabledListChanged` 把它钉住：全局默认只改新对话默认值，当前对话是否跟随由 webview 的确认框决定。钉住失败不阻断保存，只回 `mcpPinFailed`，由 webview 给出提示 |
| webview 侧 MCP 面板 | 纯展示 |

**启用状态的两层与「钉住」**：生效值 = 会话覆盖（`meta.json` 的 `context.mcpEnabled`，
Core 进程内另有一份内存覆盖）优先，其次全局默认（`settings.json` 的 `mcp.enabled`，
经配置快照下发）。输入框菜单的勾选只写会话覆盖；设置面板「默认配置」只写全局默认。
全局默认变更会让 Core 重同步**其它**已注册会话，但当前对话在写盘前已被宿主钉在
它当前的列表上（`mcpEnabledListChanged`），因此不会静默跟随——是否跟随由设置面板的
「应用到当前对话」确认框决定（[docs/hosts/webview-facts.md 第 6 节](../hosts/webview-facts.md#6-设置面板)）。

**按会话暴露 MCP 工具**：MCP 进程是进程级全局的（多个会话可共享同一个 server），但
「把哪些 MCP 工具发给某个会话的 LLM」必须按该会话的启用列表过滤，否则 A 会话已取消勾选、
却因为 B 会话仍启用（进程继续存活）而把该 MCP 工具发给 A：

| 环节 | 做法 |
| --- | --- |
| 组装请求 | 组装 LLM 请求时按该会话生效的启用列表（`get_tools_for_servers`；子代理经 `parentSessionId` 继承父会话）过滤 `tools` |
| 缓存失效 | 会话启用列表变化时，差量同步单独失效该会话的提示词缓存，**不依赖**全局工具集合是否变化 |
| 工具执行 | 执行侧仍用全局 `get_tools()` 解析，保证历史消息里已发出的工具调用仍能按名解析 |

## 4. 对话相关数据：ConversationManager

位置：`src/host/ConversationManager.ts`（abstract class）。

它分发**两条互相独立的流**（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 8）：

| | 流 1：对话列表 | 流 2：会话运行时状态 |
| --- | --- | --- |
| 内容 | 磁盘元数据：`title` / `createdAt` / `updatedAt` / `messageCount` / `parentSessionId` | 运行时根事实与派生 `idle`（`SessionRuntimeState`，[docs/architecture/events.md 第 2 节](events.md#2-事件词汇表) / [docs/core/session-runtime.md](../core/session-runtime.md)） |
| source of truth | 磁盘（Core 对 `conversationListRequested` 的应答） | Core 的会话运行时状态（[docs/core/session-runtime.md](../core/session-runtime.md)） |
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
空闲」读 Core 推送的 `sessionRuntimeChanged` 快照缓存（`getSessionStatesSnapshot`）：
该会话 `idle` 为假（压缩中 / 等待用户 / 后台 Bash / 非 idle 子代理（递归）/ 引擎消费中
任一为真）即非空闲，快照里找不到该会话时保守视为「非空闲」；未注入关闭回调时不关闭任何
会话。关闭动作走 `idleCloseHandler`（`WebViewUI.closeConversation` = 发 `conversationClosed` +
宿主销毁视图）。

活动来源：宿主侧上报（打开 / 新建 / 用户发消息，经 `WebViewUiPort.noteSessionActivity`）
与 `updateSessionStates` 的状态跃迁。

`idle` / `waiting` 的运行时事实 owner 是 Core 进程：宿主经 `UiEvent.userChoicePendingChanged`
上报「用户选择是否在等待应答」（webview 弹出 / 应答时），Core 侧落到该会话的运行时状态
（[docs/architecture/events.md 第 2.3 节](events.md#23-uieventui--core单向)，[docs/core/session-runtime.md](../core/session-runtime.md)）。

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
import core 的只读函数与类型（[docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)规则 9）。

| 入口 | 位置 | 翻译为 |
| --- | --- | --- |
| webview 协议消息 | `webviewMessageHandler` 的 `messageHandlers` 表 | 多数映射为 `UiEvent`（[docs/architecture/events.md 第 2.3 节](events.md#23-uieventui--core单向)） |
| 关闭会话 / 空闲回收（仅 VS Code） | `WebViewUI.closeConversation` → `releaseConversation` | `conversationClosed` |
| 编辑器上下文 | `extension.ts` 的 `persistCurrentFileContext` | `conversationContextUpdated` |
| Electron 侧栏：关闭 | `sidebar:close-conversation` | `WebViewUI.closeConversation(sid)`（= `conversationClosed` + 关视图） |
| Electron 侧栏 / webview 顶栏：删除 | `sidebar:delete-conversation` / `deleteConversationWithViews`（webview 的 `deleteConversation` 在多视图宿主由 `electron/main.ts` 接管） | 两条入口共用 `deleteConversationWithViews`：先用 `collectConversationClosure`（`src/shared/history/Conversation.ts`）求受影响闭包（自身 + 所有层级子孙，与 Core 的删除规则同一份格式），对闭包里**已打开**的视图逐个 `closeConversation`（没打开的会话没有可卸资源，也不发 `conversationClosed`——它按会话路由不到归属），再对 root 发 `conversationDeleted`（Core 对闭包逐个删盘并释放引擎 / MCP / 运行时状态） |
| Electron 侧栏：重命名 | `sidebar:rename-conversation` | `conversationRenamed` |
| Electron 侧栏：智能命名 | `sidebar:smart-name-conversation` | LLM 起名后发 `conversationRenamed` |
| Electron 菜单：偏好设置 | 「偏好设置...」窗口（`electron/main.ts` 的 `openPreferenceDialog`） | 写宿主本地状态（`workspace-state.json` 的 `theme` / `shortcut` / `soundEnabled` / `soundVolume` 字段），不经总线 |

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

**偏好设置窗口**（Electron 专属，菜单「偏好设置...」）

主题、唤醒快捷键、提示音都是宿主能力，不能放进 webview：页面收不到被系统抢占的组合键，
也无法注销已注册的全局快捷键。因此它们是 Electron 的一个独立窗口（`electron/main.ts` 的
`openPreferenceDialog` + `electron/preferencePreload.ts` + `electron/preferenceDialogHtml.ts`）：

| 环节 | 做法 |
| --- | --- |
| 主题 | 单选立即生效：`applyThemeMode(mode)` 写 `nativeTheme.themeSource` 与宿主本地偏好（`writeThemeMode`），窗口配色走 `prefers-color-scheme` 自己跟着变 |
| 打开（快捷键） | `suspendWakeShortcut(win.webContents)` 注销当前全局快捷键（与窗口销毁时的兜底恢复配对），避免用户按下的组合键先触发唤醒 |
| 按键捕获 | 点快捷键字段开始录制，主进程 `before-input-event` → `electron/shortcut.ts` 的 `acceleratorFromKeyboardEvent`（页面只负责显示） |
| 保存（快捷键） | 录到合法组合即写宿主本地偏好（`writeWakeShortcut`）；关闭回调按最新偏好重新注册 |
| 取消录制 / Esc | 录制中 Esc 只退出录制；未录制时 Esc 关闭窗口；关闭后按最新偏好恢复注册 |
| 提示音开关 | 写宿主本地偏好（`writeSoundEnabled`）；打开时预览播放一次 |
| 提示音音量 | 拖完滑条（change）写宿主本地偏好（`writeSoundVolume`）并预览播放一次；提醒与预览共用同一播放载体 |
| 注册入口 | `registerWakeShortcutValue(shortcut)`：先注销旧值再注册新值，失败静默忽略 |
