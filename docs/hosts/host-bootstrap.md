---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：宿主启动接线与生命周期

本规格界定两个宿主的启动接线与进程生命周期：bootstrap 的接线顺序（第 1 节）、启动期注入点的写入入口与读取器（第 2 节）、启动自检（第 3 节）、退出路径（第 4 节）、一致性守护（第 5 节）与新增启动期注入点的检查清单（第 6 节）。

交叉引用：`docs/hosts/host-matrix.md`（两宿主实现对照与宿主分叉清单）、`docs/architecture/events.md`（事件词汇表与 bootstrap 顺序）、`docs/hosts/webview-ui.md`（`WebViewUI` 的创建与子模块接线）、`docs/core/standalone-core.md`（Core 装配）、`docs/hosts/electron-multi-workspace.md`（多工作目录宿主）、`docs/hosts/tui.md`（第三个宿主的启动接线）。

---

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [宿主接线](#1-宿主接线) |
| 2. | [启动期状态：写入入口与读取器](#2-启动期状态写入入口与读取器) |
| 3. | [启动自检](#3-启动自检) |
| 4. | [退出路径](#4-退出路径) |
| 5. | [一致性守护](#5-一致性守护) |
| 6. | [新增启动期注入点检查清单](#6-新增启动期注入点检查清单) |

---

## 1. 宿主接线

本节覆盖进程启动阶段（VS Code 的 `activate` / Electron 的 `main()`；TUI 的启动接线在 `tui-rs/src/main.rs`，见 [docs/hosts/tui.md 第 2 节](tui.md#2-接入架构)）完成的接线：core 全局
单例与宿主能力提供者的注册、事件总线的创建与订阅、`WebViewUI` 的创建与子模块接线、
历史系统 / 会话队列 / 配置目录 / MCP 残留清理，以及退出路径对 core 资源的
释放。窗口 / 面板 / 菜单 / 托盘 / 快捷键等宿主界面构造与 webview 内容注入属于宿主实现层，
不在本节范围。

启动接线分成两层：**共享骨架**（`src/host/bootstrapCore.ts` 的 `bootstrapCore`）与
**宿主专属接线**（各自 bootstrap 内）。骨架内的顺序固定（[docs/architecture/events.md 第 5 节](../architecture/events.md#5-全局注册与-bootstrap-顺序)），
宿主差异以 `CoreBootstrapOptions` 的必选成员传入——漏传是编译错误。

```ts src=src/host/bootstrapCore.ts
export interface CoreBootstrapOptions {
  /** 宿主 locale 原始值（BCP-47）；「是否中文」的收敛由宿主 i18n（`src/host/i18n.ts`）承担 */
  locale: string;
  /** 日志出口：core Logger / WebViewUI / UserChoiceManager 共用 */
  log: (...args: unknown[]) => void;
  /** core 日志是否同时输出到控制台 */
  logToConsole: boolean;
  /**
   * 扩展 / 应用根目录：定位 Core 产物目录
   * （`resources/core/<arch-platform>/`，其中已含 Core 自带的 `ripgrep/`）。
   */
  extensionPath: string;
  /**
   * 测试注入：为一个工作区打开 Core 通道。
   * 默认经 daemon 启动配置中的 Core 可执行文件。
   */
  openStandaloneChannel?: (ref: WorkspaceRef) => OpenedCoreChannel;
}

bootstrapCore(host, spinDesign, conversations, options): { bus, client, ui }
```

工作区集合来自 `UIHost` 的 `WorkspaceProvider`（`getWorkspaceRef` / `getOpenWorkspaceRefs` /
`onWorkspaceChanged`）：骨架为每个打开的工作区打开一个 Connection，
全部登记后把**活动 Connection 对齐到宿主当前工作区**（Connection 按打开集合顺序建立，
「最后建立的」不等于「正显示的活动标签页」；恢复标签页不触发 activated 事件——状态没变。
不对齐的话，统计 / 清空这类「跟当前连接走」的请求会落到别的连接上），并订阅打开 / 关闭 / 激活事件。没有打开的工作区时用一个空引用打开占位 Connection，
保证宿主环境与空态视图的只读请求（技能列表 / 对话列表等）仍可应答；
打开第一个真实工作区时占位 Connection 被关闭。

每个接线项有唯一归属，归属只有三种：

| 归属 | 含义 |
| --- | --- |
| 共享骨架 | 由 `bootstrapCore` 执行，两个宿主都执行且只执行一次 |
| 宿主专属 | 只有一个宿主需要的接线，留在该宿主的 bootstrap 内 |
| 宿主参数 | 两端都执行、但取值来自宿主环境，以必选参数传入共享启动函数 |

**共享骨架**（`src/host/bootstrapCore.ts`；该模块位于 `host/`，不 import `vscode` / `electron`）：

| 接线项 | 说明 |
| --- | --- |
| locale / UI 语言 / 扩展路径 / 日志出口 | 取值来自宿主参数 |
| Client 创建与全局总线注册 | `setGlobalEventBus(client)`（Client 是宿主侧路由器；处理器表由 `WebViewUI.create` 注册到 Client，Connection 建立时挂到自己的总线） |
| 配置快照订阅 | `SettingsStore.subscribe` → `client.emitToCore(hostEnvironmentProvided)`，一份快照推给所有 Connection |
| `WebViewUI.create` 与 `UserChoiceManager` 工厂 | 工厂在骨架内构造，日志出口取自 `options.log`；宿主不提供该工厂。处理器注册在 Client 上，Connection 建立时把同一份表注册到自己的总线 |
| 按工作区打开 Connection | `client.openWorkspace(ref)`；连接建立时推送 `hostEnvironmentProvided`（扩展路径 / 日志出口开关 / 配置目录名 / 配置快照 / MCP 服务器表）。core 侧没有对应的直接注入入口 |
| 工作区打开 / 关闭 / 激活订阅 | `host.onWorkspaceChanged` → `client.openWorkspace` / `closeWorkspace` / `activateWorkspace` |

**宿主参数**：

| 参数 | VS Code 取值 | Electron 取值 |
| --- | --- | --- |
| `locale` | `vscode.env.language` | `app.getLocale()` |
| `log` | `(...args) => outputChannel.appendLine(args.map(String).join(' '))` | `console.log('[WebViewUI]', …)` 之外经 `fileLogger.info('host', …)` 落盘（远端工作区的问题只在日志文件里可见） |
| `logToConsole` | `false` | `true` |
| `extensionPath` | `context.extensionPath` | `APP_ROOT` |

**宿主专属**（在共享骨架返回之后执行，且只读写宿主自身持有的句柄）：

| 接线项 | 宿主 | 说明 |
| --- | --- | --- |
| `host.setExtensionUri` / `registerWindowStateListener` | VS Code | 扩展资源与窗口状态 |
| `host.getActiveSessionId = () => ui.getActiveSessionId()` | VS Code | `UIHost` 的读取器属性 |
| 空闲会话巡检（`setActiveSessionProvider` / `setIdleCloseHandler` / `startIdleMonitor`） | VS Code | 空闲回收只在 VS Code 生效 |
| 虚拟文档 provider（预览 / diff 三个 scheme） | VS Code | 无对应 Electron 能力 |
| `registerWebviewViewProvider` / 命令 / 状态栏项 | VS Code | 扩展界面入口 |
| `host.setMainWindow` / `setSidebarView` / `setChatViewManager` / `setWorkspaceSource` | Electron | 主进程句柄注入；`setWorkspaceSource` 提供打开集合 / 活动项 / 变化订阅（Client 据此建立 Connection） |
| `conversations.setStatusListener` | Electron | 托盘状态点、闪烁提醒、未读完成呼吸与系统睡眠阻断 |
| 侧栏出口（`sendToSidebar`） | Electron | 原生侧栏三条流 |
| `chatViews.closeConversation = (sid) => ui.releaseConversation(sid)` | Electron | 视图销毁序列只卸内存 |
| 菜单 / 托盘 / 全局唤醒快捷键 / 单实例锁 | Electron | 桌面端集成 |
| 自绘标题栏（`titlebarView` + 菜单视图 + `titlebar:*` / `titlebar-menu:*` IPC） | Electron | 无边框窗口下替代系统标题栏与菜单栏；菜单定义与原生菜单同源（`buildMenuSections`），无边框窗口下原生 accelerator 是否生效依平台而定，故另挂 `before-input-event` 兜底并按 id 去重 |
| 窗口模式（`applyWindowMode` / `floatingWindowSize` / `chatViews.setConversationListOwner`） | Electron | 完整模式（侧栏 + 聊天视图）↔ 悬浮窗模式（隐藏侧栏、列表移到 webview 顶栏、可置顶）；两种模式尺寸独立落盘。布局开关与能力声明由 `setConversationListOwner` 一起更新，不再单独暴露侧栏开关 |

```ts
// src/extension.ts
const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
const host = new VSCodeUIHost(outputChannel);
const conversations = new SingleWebViewConversationManager(host);

const { ui } = bootstrapCore(host, new VSCodeSpinDesign(host), conversations, {
  locale: vscode.env.language,
  log: (...args) => outputChannel.appendLine(args.map(String).join(' ')),
  logToConsole: false,
  extensionPath: context.extensionPath,
});

// 骨架之后才能注入的读取器（读 ui 的状态）
host.setExtensionUri(context.extensionUri);
host.registerWindowStateListener(context);
host.getActiveSessionId = () => ui.getActiveSessionId();

// VS Code 专属：空闲回收（计时 owner 在 SingleWebViewConversationManager）
conversations.setActiveSessionProvider(() => ui.getActiveSessionId() ?? null);
conversations.setIdleCloseHandler((sid) => ui.closeConversation(sid));
conversations.startIdleMonitor();

outputChannel.appendLine(`[bootstrap] ${JSON.stringify(bootstrapSnapshot())}`);

// 虚拟文档 provider（预览 / diff）与 webview provider
context.subscriptions.push(
  vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, virtualDocumentProvider),
  vscode.workspace.registerTextDocumentContentProvider(DIFF_BEFORE_SCHEME, virtualDocumentProvider),
  vscode.workspace.registerTextDocumentContentProvider(DIFF_AFTER_SCHEME, virtualDocumentProvider),
  vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
);
```

```ts
// electron/main.ts（initCore）
const host = new ElectronUIHost();
const spinDesign = new ElectronSpinDesign(host);
const conversations = new ElectronConversationManager(
  host,
  sendToSidebar,
  () => refKey(workspacePath),   // 列表快照按工作区稳定 id 分份
);
conversations.setStatusListener((states) => {   // 托盘与睡眠阻断都只吃这条状态流
  updateTrayStatusFromStates(states);           // 状态点 + 「任务结束」闪烁
  sleepBlocker.update(states);                  // 任一会话非 idle 即阻断系统睡眠
});

const { ui } = bootstrapCore(host, spinDesign, conversations, {
  locale: app.getLocale(),
  log: (...args) => console.log('[WebViewUI]', args.map(String).join(' ')),
  logToConsole: true,
  extensionPath: APP_ROOT,
});

host.setMainWindow(mainWindow);      // 宿主句柄在骨架之后注入
host.setSidebarView(sidebarView);
host.setChatViewManager(chatViews);
host.setWorkspacePath(workspacePath);   // 宿主当前工作目录（打开集合中的一项）

chatViews.closeConversation = (sid) => ui.releaseConversation(sid);   // 视图销毁序列只卸内存
// chatViews 的 onLoadedChanged → sidebar:session-loaded-changed（视图层状态，独立成流）

console.log(`[bootstrap] ${JSON.stringify(bootstrapSnapshot())}`);
```

`bootstrapSnapshot()`（`src/host/bootstrapCore.ts`）返回本进程的接线快照，两个宿主在骨架
之后各输出一行；字段与守卫测试见第 3、5 节。

**向对话 webview 下发消息**：宿主侧（bootstrap 或 `WebViewUI` / `WebviewMessageHandler`）组装 wire
消息后经 `UIHost` 的传输成员投递，不直接操作 webview / webContents（[docs/architecture/contracts.md 第 1 节](../architecture/contracts.md#1-uihost对话-webview-的宿主能力)）。

| 目标 | 成员 | VS Code | Electron |
| --- | --- | --- | --- |
| 指定会话视图 / 活动视图 | `sendToWebview(message)` | `contextLimitUpdated`（`sender` 为 `null`） / `setCurrentFile` / `showLLMConfig`（无 target） | 同左 |
| 所有对话视图 | `broadcastToWebviews(message)` | `sessionRuntimeStates` 等全局变更 | 同左（含隐藏对话视图与后台预热视图） |
| 某个具体视图 | `sendToWebviewView(view, message)` | 单 webview，句柄不参与路由 | `contextLimitUpdated`（按 `ctx.sender`，含预热视图） / `focusInput` / `activatePrewarmedView` |
| 当前主题 | `onThemeChanged(view)` | `setTheme`（句柄不参与路由） | `setTheme`（`null` 广播，指定句柄直发） |

Electron 的视图句柄：`ElectronUIHost.webviewHandleFor(source)` 把来源 `WebContents` 包成
`WebviewViewHandle`（bootstrap 接线方法，不属于 `UIHost` 契约），`sendToWebviewView` 与
`onThemeChanged` 解包后直发，也作为消息入口的 `ctx.sender`（[docs/architecture/host-ui-modules.md 第 3 节](../architecture/host-ui-modules.md#3-webviewmessagehandler)）。
主题值统一取自 `UIHost.isDarkTheme()`（[docs/architecture/contracts.md 第 1 节](../architecture/contracts.md#1-uihost对话-webview-的宿主能力)）。

`ChatViewManager` 只负责视图集合与路由，消息的组装与投递在宿主：预热视图的
`activatePrewarmedView` 出口由 `ElectronUIHost.setChatViewManager` 注入
（`onActivatePrewarmedView`），视图管理器不直连 `webContents.send`。

两个 bootstrap 的差异（共享骨架之外的宿主专属接线）：

| | VS Code（`extension.ts`） | Electron（`main.ts`） |
| --- | --- | --- |
| 宿主句柄注入 | 构造时给 `outputChannel`；`webviewView` 在 `resolveWebviewView` 时 `setWebviewView` | 全部用 `set*` 在骨架之后注入 |
| 向聊天视图下发消息 | 经 `UIHost` 传输成员（单 webview） | 经 `UIHost` 传输成员（`ChatViewManager` 路由 / 广播 / 句柄直发） |
| 工作区来源 | `vscode.workspace.workspaceFolders` | 菜单 / 命令行 `--workspace=` / 上次记录（`setWorkspacePath`） |
| 空闲回收 | 启用（`startIdleMonitor`） | 不启用 |
| 托盘 | 无 | `setStatusListener` → 状态点 + 闪烁提醒 |
| 系统睡眠阻断 | 无（VS Code 扩展没有电源 API）；由 Core 进程自己阻断（[docs/hosts/host-matrix.md 第 6 节](host-matrix.md#6-宿主固有差异有意保留)） | `setStatusListener` → `sleepBlocker.update(states)`（`electron/powerSaveBlocker.ts` 的 `powerSaveBlocker`） |
| 侧栏 | 无（webview 内下拉） | 原生 `WebContentsView` + 四条流：`sidebar:conversations-updated` / `sidebar:session-states-updated` / `sidebar:session-loaded-changed` / `sidebar:session-completion`（未读完成，见 [docs/hosts/host-matrix.md 第 6 节](host-matrix.md#6-宿主固有差异有意保留)「未读完成呼吸」） |
| 虚拟文档 | 注册三个 `TextDocumentContentProvider` | 无（用 Monaco 辅助窗口） |
| 退出清理 | `deactivate()`：`stopIdleMonitor` + `shutdownCore()` | `will-quit`：注销全局快捷键、停托盘闪烁并销毁托盘与提醒音播放窗口、释放睡眠阻断、`shutdownCore()` |

## 2. 启动期状态：写入入口与读取器

Core 的启动期状态按来源分两类。

**A. 经总线传入**（宿主环境差异）：core 侧没有直接注入入口，
唯一写入路径是 `UiEvent`，Core 进程的 `dispatch_ui_event` 分派到落地函数。

| 状态 | 来源（`UiEvent`） | Core 侧落地与读取 | 未到达时 |
| --- | --- | --- | --- |
| 扩展路径 | `hostEnvironmentProvided.extensionPath` | `on_host_environment` 落地，`config.rs` 的 `extension_path()` 读取 | 报错 |
| 日志出口开关 | `hostEnvironmentProvided.logToConsole` | `on_host_environment` 落地 | 静默丢弃（可接受） |

宿主 locale 不在其中：Core 不感知语言，`hostEnvironmentProvided` 没有 locale 字段
（[docs/architecture/core-ui-separation.md 第 4.8 节](../architecture/core-ui-separation.md#48-文本语言)）。

会话工作目录表是 Core 的对话属性：Core 进程内 `config.rs` 的
`set_session_workspace(sessionId, path)` → `session_workspace(sessionId)`，目录由宿主在
会话首次被 Core 解析目录之前经 `UiEvent.sessionWorkspaceAssigned` 登记；未登记时
`project_root(sessionId)` 报错。宿主侧 `src/shared/history/Config.ts` 另存一份索引
（`getSessionWorkspace` / `setSessionWorkspace`），只用于「发事件前取会话自己的目录」，
不参与 Core 的目录解析（例外表见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。

**B. 进程内注入**（不跨进程，仍由骨架直接接线）：

| 状态 | 写入入口 | 读取入口 | 未注入时 |
| --- | --- | --- | --- |
| 全局事件总线 | `setGlobalEventBus(bus)` | `requireEventBus()` | 抛错 |

UI 语言（`uiLanguage`）是**宿主状态**，不在 core 的启动期状态里：宿主读自己的
`settings.json` 后收敛到宿主 i18n（`src/host/i18n.ts` 的 `setHostUiLanguage`），
webview 用自己的翻译表（`src/webview/i18n/`）。收敛入口是 `coreFacts.primeHostLocale(hostLocale)`
（读 `settings.json` 的 `uiLanguage` + 宿主 locale），由共享骨架 `bootstrapCore` 在
**启动接线内同步调用**——不依赖 Connection 就绪事件（拉起 Core 进程完成握手的耗时不定），
因此宿主原生 UI（Electron 菜单 / 托盘、Spin 设计器）从构建起
就用对语言。收敛顺序是「先记录宿主 locale，再按 `uiLanguage` 收敛」：显式 `zh` / `en`
覆盖宿主 / 系统语言，`auto` 才回落到宿主 locale / 系统语言（顺序写反会把显式 `en` 覆盖
回中文）。Electron 主进程还会在创建托盘 / 菜单之前提前调用一次同一步：托盘早于
`bootstrapCore` 创建，不提前收敛就会先按默认英文建好。

规则：

- 消费点调用读取入口，不使用可选链静默降级。
- 允许默认值的项（日志出口开关）以「缺失不构成错误」为前提：
  其取值不影响跨端一致性，且无业务分支依赖「是否已到达」。
- 抛错的项（总线 / 扩展路径）在启动接线内保证写入，因此启动完成后不存在未写入状态。
- 宿主语言变化用 `onHostLocaleChanged(listener)`（`src/host/i18n.ts`）通知订阅者
  （Electron 原生菜单与托盘右键菜单据此重建）；只在**有效语言**真正变化时触发，
  单个订阅者抛错不影响其它订阅者。

`「会话是否空闲」的运行时事实在 Core 进程内（`waiting` 来源见
[docs/core/session-runtime.md](../core/session-runtime.md)），宿主消费 `sessionRuntimeChanged`
快照，没有需要保证注入的读取器（[docs/architecture/contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)）。

## 3. 启动自检

`src/host/bootstrapCore.ts` 导出：

```ts src=src/host/bootstrapCore.ts
export interface BootstrapSnapshot {
  locale: string;
  uiLanguage: 'auto' | 'zh' | 'en';
  eventBusRegistered: boolean;
  uiCreated: boolean;
  extensionPathProvided: boolean;
  logToConsole: boolean;
  connectionCount: number;
}

/** 当前进程的接线快照（只读；用于启动日志） */
export function bootstrapSnapshot(): BootstrapSnapshot;
```

- 快照在 `bootstrapCore` 返回前写入；未执行骨架时调用抛错。
- 布尔字段由宿主侧实际查询得出（总线 / UI 单例 / 活动连接数）；`extensionPathProvided`
  恒为真（扩展路径是必选宿主参数）；`logToConsole` 直接取宿主参数的自报值。
  core 侧状态在 Core 进程内，快照只报告宿主自己掌握的接线事实。
- 两个宿主的 bootstrap 在骨架返回后各输出一行快照日志：
  VS Code 写 `OutputChannel`，Electron 写 `console`。
- 快照用于两个宿主的对照：两端日志的字段差异即漂移点。

## 4. 退出路径

core 资源的释放有单一入口：

```ts src=src/host/bootstrapCore.ts
/** 释放 core 侧进程级资源（Connection / Core 进程 / MCP 子进程） */
export function shutdownCore(): Promise<void>;
```

| 宿主 | 退出钩子 | 调用 |
| --- | --- | --- |
| VS Code | `deactivate()` | `stopIdleMonitor()`（宿主专属）+ `shutdownCore()` |
| Electron | `app.on('will-quit')` | 宿主专属清理（快捷键 / 托盘 / 定时器 / 睡眠阻断）+ `shutdownCore()` |

`shutdownCore` 先 `client.closeAll()` 销毁全部 Connection（逐个关闭 channel / 本地
`stdio` Core 进程），再断开远程 daemon 的控制链路——**不发 `shutdown`**：
daemon 侧任一连接的 shutdown 是全局停机，SSH 引导的 daemon 自带 idle-exit，最后一条
链路断开后自行退出。Core 进程退出时自行结束 MCP 子进程（`core-rs/src/mcp.rs` 的
`shutdown`）；宿主不持有 MCP 子进程。

`deactivate()` / `will-quit` 之外还有一层进程退出兜底：`CoreProcess` 在构造时注册
`process` 的 `exit` 事件，退出时同步 `child.kill()` 当前 Core 子进程，不等 `shutdown`
应答。它兜住「宿主清理钩子没机会执行」的情况（扩展宿主崩溃 / 被强杀 / 升级替换），
见 [docs/core/standalone-core.md 第 5.4 节](../core/standalone-core.md#54-关闭)。

## 5. 一致性守护

**编译期**：

- `CoreBootstrapOptions` 除测试注入的 `openStandaloneChannel?`（缺省时经 daemon 启动配置里的
  Core 可执行文件）外，成员全部必选，不出现其它 `?`。
- 骨架函数的形参顺序固定：三个契约在前，宿主参数在后。

**测试期**：`src/test/bootstrapWiring.test.ts`（`npm run test:unit -- bootstrap-wiring`）断言：

1. 骨架执行完毕后，`bootstrapSnapshot()` 的各字段如实反映本次装配（`locale` 保留宿主
   传入的原始值、`logToConsole` 保留宿主传入值——VS Code 恒为 `false`）；
2. `requireEventBus()` 可调用（不抛错）；
3. 连接建立即推送宿主环境与配置快照；配置写盘触发整份快照重推且重推后生效。

测试怎么跑、单元测试与宿主集成测试怎么分工、新测试写在哪，见 `src/test/README.md`。

## 6. 新增启动期注入点检查清单

新增一个启动期注入点时，依次完成：

1. 在 Core 中定义写入入口（`dispatch_ui_event` 的分发分支或 `hostEnvironmentProvided`
   的新字段）；
2. 在 Core 中定义对应的读取入口（未写入报错，或说明默认值可接受的理由）；
3. 判断它属于哪一类（第 2 节）：
   - **宿主环境 / 工作目录 / 用户选择**：加一条 `UiEvent`，在 Core 进程的分发入口
     处理；取值来自宿主时，在 `bootstrapCore` 内发出该事件，并确定它在顺序中的位置；
   - **进程内**：在 `bootstrapCore` 内加入接线步骤，并确定它在顺序中的位置；
4. 若取值来自宿主环境，加入 `CoreBootstrapOptions` 的必选成员；
5. 在 `bootstrapSnapshot` 中暴露其状态（布尔或取值）；
6. 在 `src/test/bootstrapWiring.test.ts` 的断言中登记；
7. 同步本文档对应章节的表格。

