---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：宿主实现对照与分叉清单

本规格界定三契约在两个宿主上的实现对照（第 1–5 节）与宿主分叉清单（第 6–7 节：有意保留的固有差异、尚未收敛的分叉点）。第三个宿主 TUI 不实现这些契约，见 `docs/hosts/tui.md`；bootstrap 接线、启动期注入点与退出路径见 `docs/hosts/host-bootstrap.md`。

交叉引用：`docs/architecture/contracts.md`（契约定义）、`docs/hosts/host-bootstrap.md`（bootstrap 接线与启动生命周期）、`docs/hosts/webview-ui.md`（唯一 UI 实现）、`docs/core/client-connection.md`（连接模型）、`docs/hosts/electron-multi-workspace.md`（多工作目录）、`docs/hosts/vscode-idle-close.md`（VS Code 空闲回收）、[docs/architecture/overview.md 第 1 节](../architecture/overview.md#1-架构概述)（架构总览）。

---

三个契约各自的实现对照。第 1、2 节只列两个宿主类的骨架，逐成员实现见
第 3 节（`UIHost`）、第 4 节（`SpinDesign`）、第 5 节（`ConversationManager`）；bootstrap 的接线顺序见 [docs/hosts/host-bootstrap.md 第 1 节](host-bootstrap.md#1-宿主接线)。
第三个宿主 TUI（`tui-rs/`，纯 Rust）不在此展开：它直连 Standalone Core 帧通道、不
实现本节契约，core 帧 ↔ 渲染动作的翻译与构建见 `docs/hosts/tui.md`（其分发与 Core 部署见
`docs/features/tui-installer.md`）。

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [VSCodeUIHost](#1-vscodeuihost) |
| 2. | [ElectronUIHost](#2-electronuihost) |
| 3. | [UIHost 实现对照表](#3-uihost-实现对照表) |
| 4. | [SpinDesign 实现对照表](#4-spindesign-实现对照表) |
| 5. | [ConversationManager 实现对照表](#5-conversationmanager-实现对照表) |
| 6. | [宿主固有差异（有意保留）](#6-宿主固有差异有意保留) |
| 7. | [尚未收敛的分叉点](#7-尚未收敛的分叉点) |

---

## 1. VSCodeUIHost

位置：`src/VSCodeUIHost.ts`（+ `src/VSCodeUIHost/documentManager.ts`、`diffUris.ts`）。

```ts src=src/VSCodeUIHost.ts
export class VSCodeUIHost implements UIHost {
  constructor(outputChannel: vscode.OutputChannel);   // 内部创建 DocumentManager

  // ===== bootstrap 专用接线（不属于 UIHost）=====
  setExtensionUri(uri: vscode.Uri): void;
  setWebviewView(webviewView: vscode.WebviewView): void;
  registerWindowStateListener(context: vscode.ExtensionContext): void;   // 幂等；当前不注册监听器
  setShowContentInVirtualDocumentCallback(cb: (e: ShowContentInVirtualDocumentEvent) => void | Promise<void>): void;
  setShowDiffInVirtualDocumentCallback(cb: (e: ShowDiffInVirtualDocumentEvent) => void | Promise<void>): void;

  // ===== bootstrap 注入的读取器（属性，不是构造参数）=====
  getActiveSessionId: () => string | undefined;           // 默认 () => undefined

  // ===== UIHost 实现 =====
  // 逐成员见第 3 节
}
```

要点：

- `webviewView` 未就绪时 `sendToWebview` 静默 no-op——webview 还没解析出来是合法瞬时状态。
- `getActiveSessionId` 用**属性注入**而不是构造参数：它的实现要读 `WebViewUI` 的状态，只能在
  `WebViewUI.create` 之后赋值（见 [docs/hosts/host-bootstrap.md 第 1 节](host-bootstrap.md#1-宿主接线)）。
- 虚拟文档（预览 / diff）由 `DocumentManager` 持有，内容来自 bootstrap 注册的三个
  `TextDocumentContentProvider`：`PREVIEW_SCHEME` / `DIFF_BEFORE_SCHEME` / `DIFF_AFTER_SCHEME`。

## 2. ElectronUIHost

位置：`electron/ElectronUIHost.ts`。

```ts src=electron/ElectronUIHost.ts
export class ElectronUIHost implements UIHost {
  // ===== bootstrap 专用接线（不属于 UIHost）=====
  setMainWindow(win: BrowserWindow): void;
  setSidebarView(view: WebContentsView): void;
  setChatViewManager(m: ChatViewManager): void;    // 记录视图管理器，并注入 activatePrewarmedView 出口
  setWorkspacePath(ref: WorkspaceRef | undefined): void;   // 记录宿主当前工作区引用
  webviewHandleFor(source: WebContents): WebviewViewHandle;   // 来源视图包成句柄

  // ===== UIHost 实现 =====
  // 逐成员见第 3 节
}
```

要点：

- 没有构造依赖：所有外部句柄都由 bootstrap 用 `set*` 注入。
- `setChatViewManager` 同时给 `ChatViewManager` 注入 `onActivatePrewarmedView` 出口：预热视图
  被切到前台时由宿主组装并直发 `activatePrewarmedView`，视图管理器不直连 `webContents.send`。
- `webviewHandleFor(source)` 把来源 `WebContents` 包成 `WebviewViewHandle`，供
  `sendToWebviewView` / `onThemeChanged` 定向投递，并作为 `ctx.sender` 传给
  `WebViewUI.handleWebviewMessage`（[docs/architecture/host-ui-modules.md 第 3 节](../architecture/host-ui-modules.md#3-webviewmessagehandler)）。
- `setWorkspacePath` 记录宿主当前工作目录（`getWorkspacePath()` 的返回值）；侧栏的
  `sidebar:workspaces-changed`（打开集合 + 活动项 + 最近工作目录）由 `main.ts` 的
  `broadcastWorkspaces()` 单独推送。会话的工作目录与它无关：由 `main.ts` 在会话被 core
  解析目录之前按来源视图登记（`registerCoreSessionWorkspace`）。
- 预览窗口辅助：`sendToRenderer`（按 `sessionId` 定向，未命中回退活动视图）、`openImagePreviewWindow`（内置图片查看器窗口，公开——侧栏文件浏览器双击打开图片复用同一入口）、`openMarkdownPreviewWindow`（公开——侧栏双击 `.md` 文件进内置 Markdown 预览：`src/host/markdownHtml.ts` 纯函数渲染并净化内容，只读 HTML 经 data URL 装进沙箱窗口，与 Mermaid 预览同一模式）、`openMonacoWindow`（公开——侧栏双击打开远程文本时带 `content` 复用同一窗口，`filePath` 只用于语法推断）、`openMermaidWindow`。Monaco / 图片 / Markdown 三类查看器共用一个窗口名额：新开请求先关掉现存查看器窗口再开新窗（继承其位置尺寸；`electron/viewerWindowRect.ts` 的纯函数决策），Mermaid 与 Spin 设计器不占名额；Monaco / 图片窗口的标题随打开对象变化（渲染端把 init 数据里的短名设为页面标题）。三类查看器开窗后启动文件监听：本地由 `electron/localFileWatch.ts` 的 `fs.watch` 驱动，远程经 `UiRequest.watchWorkspaceFileRequested` 交给远端 Core 监听并由 `CoreEvent.workspaceFileChanged` 推送；刷新经 `imageviewer-refresh` / `monaco-refresh` / `markdown-refresh` 投递，内容判重、标题标记与 Core 重启重注册在 `electron/viewerWatch.ts`（specs/018）。

## 3. UIHost 实现对照表

| `UIHost` 成员 | VSCodeUIHost | ElectronUIHost |
| --- | --- | --- |
| `sendToWebview(message)` | `webviewView?.webview.postMessage(message)`（失败只记日志；视图未就绪时 no-op） | `sendToRenderer`：有 `sessionId` 且 `chatViews.sendTo` 命中 → 定向；否则 `sendToActive` |
| `broadcastToWebviews(message)` | `sendToWebview(message)`（单 webview） | `chatViews.broadcast(message)`（含隐藏对话视图与后台预热视图） |
| `sendToWebviewView(view, message)` | `sendToWebview(message)`（句柄不参与路由） | 句柄解包为 `WebContents` 后 `webContents.send('webview-message', message)` |
| `onThemeChanged(view)` | `sendToWebview(message)`（句柄不参与路由；值取 `isDarkTheme()`） | `view` 为 `null` → `chatViews.broadcast`；指定句柄 → 解包直发（值取 `isDarkTheme()`） |
| `log(...args)` | `outputChannel.appendLine(...)` | `console.log('[ElectronUIHost] ...')` |
| `getWorkspacePath()` | `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | `this.workspacePath`（宿主当前工作目录；由标签页切换 / 添加 / 关闭驱动） |
| `isDarkTheme()` | `vscode.window.activeColorTheme.kind`（Dark / HighContrast） | `nativeTheme.shouldUseDarkColors` |
| `getLocale()` | `vscode.env.language` | `app.getLocale()`（原始 BCP-47，不做归一化；消费方按 `startsWith('zh')` 判断） |
| `openFile(filePath, target, view)` | 图片 → `vscode.open`；文本 → `openTextDocument` + `showTextDocument` + 选区定位；`openTextDocument` 抛错（二进制）→ 回退 `vscode.open`（`view` 不使用：工作区引用恒为本地） | 远程解析两级（`src/host/remoteFileResolve.ts`）：先按打开集合的远程工作区做 `/` 前缀匹配（活动项优先）；未命中时若 `view` 来源视图所属工作区是远程，按该 endpoint 解析（工作区外文件同样经 SFTP 读出——图片进 `openImagePreviewWindow`、文本进 `openMonacoWindow({ mode: 'view', content })`，读失败也开窗口显示原因，与本地 ENOENT 对齐）；`view` 为 `null`（侧栏 `openLocalFile` 等）不做视图兜底；本地路径：图片 → `openImagePreviewWindow`（内置图片查看器，滚轮缩放），其余 → `openMonacoWindow({ mode: 'view' })` 并定位到行 |
| `showVirtualDocument(content, title)` | 走 bootstrap 注入的 `onShowContentInVirtualDocumentCallback`（`DocumentManager`） | `openMonacoWindow({ mode: 'content' })` |
| `showDiff(options)` | `DocumentManager.showDiff` 打开 before/after 虚拟文档的 diff 标签（按内容哈希去重，先关上一个预览） | **空实现**——没有原生 diff 界面，diff 只在 webview 工具卡片里渲染（[docs/architecture/host-ui-modules.md 第 2 节](../architecture/host-ui-modules.md#2-toolhandler)） |
| `openMermaidPreview(code)` | `vscode.window.createWebviewPanel`（复用 `MERMAID_PANEL_ID`） | `openMermaidWindow`（`data:` URL + 本地 mermaid.min.js） |
| `onWorkspaceFileChanged(event)` | 空实现（编辑器自身随文件更新） | 按 `watchId` 路由到当前查看器窗口，读新内容并投递刷新（specs/018） |
| `closePreview()` | `DocumentManager.closePreview()`（关掉记录的预览标签） | **空实现**——Monaco / Mermaid 是独立窗口，不属于宿主侧预览 |
| `openExternalUrl(url)` | `vscode.env.openExternal(vscode.Uri.parse(url))` | `shell.openExternal(url)` |
| `saveTextFile(content, options)` | `vscode.window.showSaveDialog` + `fs.promises.writeFile` | `dialog.showSaveDialog` + `fs.promises.writeFile` |
| `closeConversationView(sessionId)` | **空实现**——单视图只有一个 webview，没有「关闭会话视图」这个动作（webview 侧 `canCloseConversation` 为 `false`，不渲染关闭按钮） | `chatViews.closeView(sessionId)`——只销毁视图；abort 与 MCP 释放归 core（`conversationClosed`，MCP 生命周期在 Core 进程内） |
| `updateSettingsJson(mutator)` | 共用 `src/host/settingsFile.ts` | 同左 |

**能力归属**（避免再往 `UIHost` 里加错东西）：

| 能力 | 归属 | 原因 |
| --- | --- | --- |
| Spin 设计器（打开 / 刷新） | `SpinDesign`（第 4 节） | 独立 surface：独立面板 / 窗口、独立消息协议 |
| 对话列表 / 会话状态 / 空闲回收 | `ConversationManager`（第 5 节） | 独立 surface：两条流 + VS Code 专属的计时 |
| MCP 会话引用生命周期 | Core 进程内的 `mcp.rs`（[docs/architecture/contracts.md 第 3 节](../architecture/contracts.md#3-mcp-生命周期core-进程内)） | 驱动信号来自 Core 的会话事实，不是宿主视图 |
| 全局配置写入 | `UIHost.updateSettingsJson` | 全局 `settings.json` 是宿主资源；项目清单 `workspace.meta.json` 归 core（[docs/architecture/contracts.md 第 1 节](../architecture/contracts.md#1-uihost对话-webview-的宿主能力)） |

## 4. SpinDesign 实现对照表

| `SpinDesign` 成员 | VSCodeSpinDesign（`src/VSCodeSpinDesign.ts`） | ElectronSpinDesign（`electron/ElectronSpinDesign.ts`） |
| --- | --- | --- |
| `open(sessionId)` | 扫 `vscode.window.tabGroups.all` 找 `viewType === SPIN_DESIGN_PANEL_ID`：已打开则 `panel.reveal()` 复用（会话不同则先按新会话重推数据）；否则 `createWebviewPanel` 并灌入 `getSpinDesignHtml` | 自持 `spinDesignWindow`：已打开则 `restore()`（若最小化）+ `focus()` 复用（会话不同则先按新会话重推数据）；否则 `new BrowserWindow` + `spinPreload.cjs`（注入 `acquireVsCodeApi` shim，让 `spinDesignHtml` 原样复用） |
| `refresh()` | 找到面板 → 经 Core 重读 `spin.json` + Skill 列表 → `panel.webview.postMessage({ type: 'spinDesignData' })`；未打开时 no-op | 找到窗口 → 同上 → `win.webContents.send('spin-design-message', { type: 'spinDesignData', ... })` |
| 归属会话 | `open()` 收到的 `sessionId` 绑定到 `this.sessionId`；`refresh` / 保存都用它，**不回查活动会话** | 同左 |

实现要点：

| | VSCodeSpinDesign | ElectronSpinDesign |
| --- | --- | --- |
| 已打开的设计器 | 从 `tabGroups` 反查（VS Code 没有「面板句柄」的持久引用） | 自持字段，窗口 `closed` 时置空 |
| 读取 `spin.json` | `UiRequest.spinDesignRequested`（Core 侧按会话工作目录读盘，宿主不读本地 `fs`） | 同左 |
| 保存 | `UiRequest.spinDesignSaveRequested`（Core 侧写锁 + 原子落盘）→ `spinSaveResult` | 同左 |
| 错误提示 | `spinDesignError` → 设计器 toast；首次打开失败不建窗口，`WebViewUI` 发 `notice.spin.cannotRead` | 同左 |
| 另存为 | `host.saveTextFile`（`showSaveDialog`） | `host.saveTextFile`（`dialog.showSaveDialog`） |
| 设计器消息 | `panel.webview.onDidReceiveMessage` | `ipcMain.on('spin-design-message')`（preload 转发） |
| 主题 / 语言 | `host.isDarkTheme()` / `host.getLocale()`（不直连宿主 API） | 同左 |
| 初始 HTML 入参 | `data` / 主题 / 语言 / `getSystemLocale()` / `SettingsStore.readUiLanguage()` / Skill 列表 / `saveEnabled` | 同左 |
| 刷新时的数据 | `spinDesignRequested` → `spinDesignData`（含 `skills`） | 同左 |
| 构造依赖 | `host: UIHost`（`isDarkTheme` / `getLocale` / `saveTextFile` / `log`） | `host: UIHost`（同上） |
| 窗口位置尺寸 | 面板归 VS Code 窗口管理 | `workspace-state.json` 的 `spinDesignWindowRect` 记忆：建窗用已存矩形（多屏可见性校验失败回退默认尺寸），move / resize 防抖落盘、关闭补记（与查看器名额独立存储） |

## 5. ConversationManager 实现对照表

两条流的逐项对照见[docs/architecture/contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)，这里只列两个实现之间的差异：

| | SingleWebViewConversationManager（`src/VSCodeConversationManager.ts`） | ElectronConversationManager（`electron/ElectronConversationManager.ts`） |
| --- | --- | --- |
| 构造依赖 | `host: UIHost` | `host: UIHost` + `sendToSidebar(channel, payload)`（侧栏出口，由 `main.ts` 注入）+ `activeWorkspaceKey: () => string`（活动工作区稳定 id，列表快照按它分份；缺省回退宿主工作路径）。广播给聊天视图走 `host.broadcastToWebviews`，不是独立依赖 |
| `dispatchList` | `host.sendToWebview({ type: 'conversationsData', conversations })` | ① `sendToSidebar('sidebar:conversations-updated', list)` ② `host.sendToWebview({ type: 'conversationsData', ... })`；列表条目带 `placeholder`（跨工作区占位父对话，仅 Electron 会产生） |
| `dispatchStates` | `host.sendToWebview({ type: 'sessionRuntimeStates', states })`（对话树流水灯 + abort 按钮） | ① `sendToSidebar('sidebar:session-states-updated', states)` ② `statusListener(states)`（托盘）③ 广播给所有聊天视图（abort 按钮） |
| `setStatusListener` | 不注册 | `main.ts` 注入 `updateTrayStatusFromStates`：托盘状态点 + 「任务结束」闪烁；`updateCompletionAttentionFromStates`：「任务完成」未读呼吸；另驱动系统睡眠阻断（`sleepBlocker.update`） |
| 空闲会话回收 | **承担**（计时 / 巡检 / 关闭动作分发，见[docs/architecture/contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)） | 不承担 |
| 额外通道 | 无 | `sidebar:session-loaded-changed`（`loaded` 由 `ChatViewManager.onLoadedChanged` 单独推，不进两条流）；`dispatchStates` 的 `sidebar:session-states-updated` 由侧栏消费（流水灯）、`statusListener` 走托盘、广播给聊天视图的 `sessionRuntimeStates` 供 abort 按钮 |

---

合并后共享层只有一份 `WebViewUI`；宿主差异集中在四处：

1. **webview 能力声明**：`HostInfo` 决定列表 / 新建 / 关闭 / 打开方式由谁负责（`docs/architecture/contracts.md`）；
2. **三个契约实现**：`UIHost` / `SpinDesign` / `ConversationManager`（`docs/architecture/contracts.md`）；
3. **宿主 bootstrap**：共享骨架 `src/host/bootstrapCore.ts` + 各自 bootstrap
   `src/extension.ts`（VS Code）与 `electron/main.ts`（Electron）；
4. **webview 内的能力分支**：只读 `HostInfo`，不嗅探宿主（[docs/hosts/host-info.md 第 3 节](host-info.md#3-消费点)）。

本章只列**当前仍存在**的分叉：第 6 节是有意保留的宿主固有差异，第 7 节是尚未收敛的分叉点。
文档只描述现状，不列已收敛 / 已消除的历史差异。

## 6. 宿主固有差异（有意保留）

这些差异由契约实现承担，共享代码只调契约方法，不感知宿主。

**`UIHost`**（`src/VSCodeUIHost.ts` / `electron/ElectronUIHost.ts`）

| 方法 | VS Code | Electron |
| --- | --- | --- |
| `sendToWebview` | `webviewView.webview.postMessage`（单 webview） | 按 `sessionId` 路由到 `ChatViewManager` 的对应视图，否则发当前活动视图 |
| `broadcastToWebviews` | `sendToWebview`（单 webview） | `chatViews.broadcast`（含隐藏对话视图与后台预热视图） |
| `sendToWebviewView` | `sendToWebview`（句柄不参与路由） | 句柄解包为 `WebContents` 后直发 |
| `onThemeChanged` | `sendToWebview`（单 webview；值取 `isDarkTheme()`） | `null` → `chatViews.broadcast`；指定句柄 → 直发（值取 `isDarkTheme()`） |
| `log` | `OutputChannel.appendLine` | `console.log`（`[ElectronUIHost]` 前缀）+ `fileLogger.info('host', …)` 落盘 |
| `getWorkspacePath` | `workspaceFolders[0].uri.fsPath`（单一工作目录） | 主进程持有的 `workspacePath`（宿主当前工作目录：打开集合中的一项，由标题栏标签页切换 / 添加 / 关闭驱动） |
| `isDarkTheme` | `activeColorTheme` 为 Dark 或 HighContrast | `nativeTheme.shouldUseDarkColors` |
| `getLocale` | `vscode.env.language`（BCP-47，如 `zh-cn`） | `app.getLocale()`（BCP-47，如 `zh-CN`）——与 VS Code 同一值域，不做归一化 |
| `openFile` | 编辑器打开并选中行；图片 / 二进制退到 `vscode.open` | 远程两级解析：root 内按打开集合、root 外按来源视图工作区（`view` 为 `null` 只按打开集合）经 SFTP 读出进内置窗口；图片开内置查看器；其余开 Monaco 窗口（`mode: 'view'`） |
| `showVirtualDocument` | `DocumentManager` → 虚拟文档预览标签 | Monaco 窗口（`mode: 'content'`） |
| `showDiff` | `DocumentManager.showDiff` → 原生 diff 标签 | 空实现（diff 归 webview） |
| `openMermaidPreview` | 复用单个 `WebviewPanel` | 复用单个 `BrowserWindow`（语义一致） |
| `onWorkspaceFileChanged` | 空实现（编辑器自身随文件更新） | 按 `watchId` 路由到当前查看器窗口，读新内容并投递刷新（specs/018） |
| `closePreview` | 关掉虚拟文档预览标签 | 空实现：Electron 的 Monaco / Mermaid 是独立窗口，不属于「宿主侧预览」 |
| `openExternalUrl` | `vscode.env.openExternal` | `shell.openExternal` |
| `saveTextFile` | `vscode.window.showSaveDialog` + `fs.writeFile` | `dialog.showSaveDialog` + `fs.writeFile` |
| `closeConversationView` | 空实现（单视图没有可关的视图） | `chatViews.closeView(sessionId)` |
| `updateSettingsJson` | 共用 `src/host/settingsFile.ts`（无差异） | 同左 |

> `showDiff` / `showVirtualDocument` / `openMermaidPreview` 这几个预览入口体现一条一般分工：
> **预览类操作归 webview，宿主只在没有页内渲染能力时才开原生窗口**（diff 在 Electron 侧就是空实现）。

**工作目录（多工作目录，Electron 专属）**（`electron/main.ts` + 侧栏 / 标题栏）

工作目录是**对话的属性**：core 按 `sessionId` 解析（[docs/architecture/core-ui-separation.md 第 3.3 节](../architecture/core-ui-separation.md#33-会话工作目录)）。Electron 侧的多工作目录
呈现与交互：

| 方面 | 现状 |
| --- | --- |
| 打开集合 | `openWorkspaces: WorkspaceRef[]`（主进程进程内事实，按标签页顺序；本地 / 远程同构）；活动项 `workspacePath`（打开集合中的一项） |
| 标签页 | 标题栏（原菜单栏区域）：`titlebar:workspaces` 下发 `{ version, workspaces: [{id,path,name,remote,availability}], activeWorkspace, activity }`（与 `titlebar:get-state` 同字段名，均带单调版本号 `version`——每次推送 +1，get-state 响应带当前值；标题栏按版本号丢弃陈旧回包，避免「get-state 回包在途期间状态变化并经推送先到」时把新状态覆盖回旧值，`e2e/webview/titlebar.spec.ts` 锁定该时序；`availability` ∈ `available` / `unavailable` / `connecting`），标题栏按 `id`（`workspaceRefKey`）作身份渲染标签页（活动项高亮、每项可关闭、键盘可切换、可拖拽排序，建链中 / 不可用项同样可激活）+「添加」按钮；宽度够时每张固定 192px，总宽超出时逐张收窄到 56px 下限后横向滚动；打开集合为空时不渲染标签页区域（添加入口在侧栏空态与菜单）；浮窗模式隐藏菜单图标与标签页 |
| 不可用工作区 | 连接状态机 `WorkspaceAvailabilityState`（`electron/workspaceAvailability.ts`，available / unavailable / connecting 三态 + 就绪标记，按去重键，时序不变量由 `src/test/workspaceAvailability.test.ts` 锁定）。启动期判定不可用：本地目录已不存在（恢复时 `isValidWorkspaceDir` 检查），或远程建连失败。**远程标签页从启动起即 connecting**（文字前黄色呼吸点），由 `probeStartupRemoteWorkspaces` 经 `bootstrapCore.probeRemoteEndpoint` 逐 endpoint 探测落定（传输层直连，**3 秒建链超时，远端引导不计入**——opener 的 `prepare` 先完成 SSH 的发现 / 部署 / 启动（冷部署上传产物远超 3 秒），3 秒只管 daemon 就绪后的建链；同一 endpoint 只探测一次，SSH 引导按目标去重（`sshTransport.ts` 的 in-flight 表），探测与正式连接不重复部署；正式连接的长超时如 SSH 120 秒不适用于此）：成功恢复可选，失败转红点。daemon 存活但工作区 channel 建失败（远端 core 起不来）等形态由 `onWorkspaceConnectionState` 的 lost 信号兜底（只对**从未就绪**的远程 Connection 标记；曾就绪过的 Core 退出走重启策略，不标红；Connection 已就绪的判定优先于探测失败）。两条失败信号（lost 与探测落定）到达顺序不定，`markUnavailable` 落定不可用即清建链中（互斥），保证标红推送不再带着黄态、同键重复标记也不丢刷新——探测失败的 catch 分支与成功分支对称地显式刷新标题栏与聊天区。标红时**先推送再执行清理**（销毁该目录的 Connection 与预加载对话视图可能抛错——如预热视图的 `new-*` 临时 key 无归属 Connection——清理失败只落盘诊断日志，不回退状态、不阻断推送）。不可用项**保留在打开集合里且可正常激活**（标签页文字前挂红点，悬停说明原因；不建立 Connection——`getOpenWorkspaceRefs` 过滤，不预加载视图）；活动项落在其上时**不回退**，聊天区由 `syncChatAreaForActiveWorkspace` 改显占位页（不显示对话列表与 webview，侧栏对话列表清空）：目录不存在 → 「目录不存在」+ 路径；远程不可连 → 「无法连接远程主机」+ 路径 + 原因 + **「重新连接」按钮**（占位页经 `chat:reconnect-workspace` 触发 `reconnectWorkspace`：转 connecting，同一 3 秒探测，成功撤销判定、补建 Connection 并切回对话视图，失败回到红点；失败原因落盘（`unavailableReasons` 按去重键留存）并随占位页展示——指纹变更有专属引导（新旧指纹 + 确认指引，`src/test/chatPlaceholderReason.test.ts` 锁定渲染），其余展示原始错误。**SSH 主机密钥变更**（`SshHostKeyError` 携带新旧指纹）走确认例外：弹告警比对指纹，用户确认后 `recordKnownHostFingerprint` 重建信任并立刻重试一次，拒绝则维持不可用）；建链中 → 「正在连接」。打开对话 / 新建对话的入口在建链中与不可用目录上一律忽略。经目录选择器 / CLI 重新提交已验证的目标时同样撤销判定并补建 Connection（`reviveWorkspaceIfRecovered`）；关闭标签页即丢弃判定 |
| 标签页运行指示 | 每个工作目录的聚合运行时状态（`activity`：工作目录 id → `waiting` / `running`），由主进程 `collectWorkspaceActivity()` 读 `ConversationManager` 缓存的全量会话运行时快照（core `sessionRuntimeChanged` 的宿主投影）+ 宿主的「会话 → 工作目录」索引按会话归并（索引未命中时按 Client 会话路由表兜底 `resolveSessionWorkspaceRef`——跨工作区子代理会话由目标工作区 Core 在后台创建，不经「打开对话 / 读列表」路径，索引要等该工作区被激活重读列表才补上；派发时刻 `assignSession` 已登记归属（specs/023 FR-002），按它兜底对方标签页不必等用户切过去才亮）：该目录下任一会话在等待用户操作 → `waiting`（黄，优先），否则任一非 idle → `running`（蓝）。两份输入都取宿主自己的投影（`ConversationManager` 缓存的全量快照 + 宿主的「会话 → 工作目录」索引），不问 Core 索取（[docs/architecture/host-ui-modules.md 第 1 节](../architecture/host-ui-modules.md#1-userchoicemanager)）。状态流每次变化（`setStatusListener` 里）另推 `titlebar:workspace-activity`，渲染层就地切换 class 不重建标签页（重建会打断动画、丢 hover / 焦点 / 拖拽状态）。动效与对话列表 `running-bar` 对齐：运行中＝蓝色流水（渐变滚动），等待用户＝黄色呼吸（只脉动不滚动）——对话列表的黄色同样是呼吸（`.running-bar--waiting` 的 `background` 简写把 `background-size` 复位成 `auto`，流水不产生位移）；标题栏的等待 / 完成条则显式 `background-size: 100% 100%`（基类的 200% 供蓝流水滚动），180° 渐变完整落在条上，与对话列表同为「中间亮、两头暗」。忙闲判定收敛在 core 的 `sessionBusyLevel`（waiting 优先、其次 running、idle 垫底）——标签页流水灯、托盘状态点（`deriveTrayStatusFromStates`）与关闭前的二次确认（对话级 `sessionIsBusy` / 工作区级 `workspaceHasBusySession` / 应用退出的聚合确认）消费同一份派生，不再各写一遍 |
| 未读完成呼吸 | 会话在用户看不到时完成（主窗口失焦 / 归属标签页未激活 / 非当前对话，任一命中）→ 记为「未读完成」；武装即推——可见但未聚焦的窗口当场挂绿色灯条（呼吸一次后保持常亮；最小化 / 隐藏窗口推送无可见效果，恢复后以常亮呈现），直到用户阅读——激活标签页清该标签页项，该对话成为当前对话清该对话项；回窗聚焦那一刻正完全可见的对话（聚焦 + 激活标签页 + 当前对话）在推送前即清——聚焦即已读（`pickReadCompletions`），切到别的对话不补亮。**对话项**按上述三条件武装；**标签页**只在完成时该标签页未激活才武装——激活中的标签页视为已读（里面的完成由对话项的灯当场表达，切走再切回不补亮）。事实归主进程独有（`electron/completionAttention.ts` 对相邻两次 `sessionRuntimeChanged` 全量快照差分出 running → idle——与托盘「任务结束提醒」（`trayAttention.ts`）同一手法，waiting → idle 是用户应答 / 中止的结果不算完成；焦点 / 激活 / 当前对话由 `isMainWindowFocused` / `workspacePath` / `ChatViewManager.getActiveSessionId` 注入，会话归属复用 `collectWorkspaceActivity` 同一套查找），渲染层只吃**幂等全量快照**：`titlebar:workspace-completion`（标签页 id 集合）/ `sidebar:session-completion` 与 webview `sessionCompletionAttention`（sessionId 集合）——重复推送不重播呼吸（侧栏 / webview 按 sessionId 记首次到达时刻，到达后一个动画周期内带呼吸、之后常亮）。推送时机 = 武装即推（失焦也推，不等回窗——可见但未聚焦的窗口当场亮灯）+ 回窗聚焦 / 切换标签页 / 切换窗口模式的幂等补推（新可见表面的灯条补齐）。灯条只挂非活动标签页 / 非当前对话的**顶层对话行**（正在看的就是「已读」；子会话（subagent）行不挂——子会话的完成属于对话整体，由父会话的灯表达）；**非 user 创建的会话完成不武装**（specs/025 FR-003：`creator` 为 agent 形态的会话——本地子代理与 Agent 工具派发的跨工作区对话——在 `completionAttention` 差分的武装源头跳过，对话行绿灯与标签页灯都不亮，完成保持安静）；浮窗没有标签页（标签页集合照推不亮，切回完整模式补齐）。关闭工作区 / 会话从快照消失即从未读集合清除。时序不变量由 `src/test/completionAttention.test.ts` 锁定 |
| 标签页拖拽排序 | 渲染层用 HTML5 drag 事件（`dragstart` / `dragover` / `drop` / `dragend`）：越过目标中线决定插到其前 / 后，`drop-before` / `drop-after` 伪元素画放置指示线；提交完整排列经 `titlebar:reorder-workspaces` → `reorderWorkspaces()`，主进程按去重键校验「同组目录的排列」后才写入打开集合并落盘，非法排列整次忽略；活动项与已打开视图不受顺序影响 |
| 非活动标签页预加载 | 首次启动（`createMainWindow` 打开活动目录的新对话之后）对打开集合里**非活动且可用**的每个目录调用 `chatViews.preloadWorkspace(ws)`（错开 400ms + 250ms×i，避免启动瞬间同时拉起多个渲染进程；不可用工作区跳过）；实现复用后台预热机制（`--prewarm=1` 后台加载渲染、跳过会话初始化），切到该目录时 `setActiveWorkspace` 命中它直接 `show()` + 补发激活消息，不再现建视图 + 等页面加载。`new-` 临时 key 带自增序号，避免同毫秒连续创建撞 key；`setActiveWorkspace` 不再销毁其它目录的预热视图（它们是那些标签页的预加载视图，关闭目录 / 窗口时统一销毁） |
| 菜单 | Windows / Linux 全部收编为单一分区 `main`，标题栏用一个图标按钮表示；条目：打开本地工作区 / 打开远程工作区 / 打开最近的工作区 ▸ / 偏好设置 / 开发者工具 / 关于 / 退出。macOS 沿用系统菜单栏分区 |
| 加号菜单 | 标题栏末尾「加号」改为菜单入口（`titlebar:workspace-menu`），主进程用原生 `Menu.popup` 弹出「打开本地工作区 / 打开远程工作区 / 打开最近的工作区」 |
| 打开远程工作区 | `openRemoteWorkspaceDialog()`：填 SSH 表单 → 经 `listRemoteDirectories()` 完成 SSH 引导并鉴权 → **连接成功后立刻**列出远端主目录，弹出远端目录选择器（`electron/remoteWorkspace/`）；选择器可改路径、进上级（`..`）、新建 / 重命名 / 删除目录（`createRemoteDirectory` / `renameRemoteDirectory` / `deleteRemoteDirectory`，删除两阶段确认）；路径框常驻焦点，上下方向键 / `Ctrl+N` / `Ctrl+P` 移动选中项（恒有选中项），`Tab` / 回车把选中项补全进路径框（详见 [docs/core/core-remote.md 第 2.6 节](../core/core-remote.md#26-远端目录选择)）；选定目录后 `addRemoteWorkspace(endpoint, path)` 加入打开集合（`scheme=ssh`） |
| 侧栏头部 | 「搜索框 + 新对话」：搜索框按标题过滤当前活动工作目录的对话列表 |
| 侧栏文件浏览器 | 侧栏底部常驻「文件资源管理器」分区条（默认折叠，展开占侧栏 50% 高度，展开 / 折叠带 flex-basis 上推过渡与内容淡入——过渡只挂在点击分区条的路径上，切换活动工作区导致的状态变化直接生效），树展示活动工作目录（目录懒加载：展开哪层读哪层，单击目录即展开 / 折叠，Ctrl / Shift 多选不触发展开；`sidebar:files-list`；加载中行显示 spinner 动画），分区条带刷新按钮（刷新后树重新铺满时回到刷新前的滚动位置，刷新在途期间用户主动滚动则以用户位置为准）；右键菜单「复制完整路径 / 复制相对路径 / 在文件资源管理器中打开 / 在此处打开命令行 / 删除」（`sidebar:files-copy-paths` / `sidebar:files-reveal` / `sidebar:files-open-terminal` / `sidebar:files-delete`，菜单项不做危险色强调）。**每个工作区一套独立状态**（渲染层 `WorkspaceFilesState`，按工作区 id 存放）：树缓存、目录展开、选中与折叠状态都随工作区保存——切换标签页只换显示哪一套，不清不重建、不作废在途请求（回包写回它自己的状态，只有正在显示的工作区触发重渲染），切回原样保留；折叠状态按工作区落侧栏 localStorage（id → 布尔表，键 `tuxedo.sidebar.filesExpanded`），工作区被关闭时状态整体丢弃、重新打开按新工作区处理。删除语义分两端：本地走自绘确认框（`electron/styledMessageBox.ts`）+ `shell.trashItem`（移入回收站，可恢复）；远程走 SSH 的 SFTP 递归删除（目录连同内容，永久），确认框文案标明「无法撤销」。复制语义：本地绝对 / 相对路径都按平台分隔符；远程是远端 POSIX 串、相对路径保持 `/` 分隔（不经本地 path 翻译）。「在文件资源管理器中打开」「在此处打开命令行」仅本地工作区提供（远程项在渲染层就不显示这两项菜单，主进程对远程同样拒绝）；「在此处打开命令行」对目录行打开该目录、对文件行打开其父目录，主进程按平台拉起系统终端（Windows 经 `cmd /c start` 开新控制台驻留，macOS 用 `open -a Terminal`，Linux 用 `x-terminal-emulator` / `gnome-terminal`，进程 detached 不随应用退出）。实现：本地读盘 / 校验在 `electron/sidebarFiles.ts`（`resolveWithinRoot` 带 `posix` 分支，远程路径按 win32 解析会变形）；远程经 `electron/sidebarFilesRemote.ts`——一个 endpoint 一条 SSH 连接（`SshClient`，按完整连接目标缓存，连接进行中并发首连去重），列目录 / 删除走 SFTP（`sshClient.ts` 的 `listDirectory` / `removePath`），连接随工作区关闭与应用退出释放。安全口径：root 由渲染层回传、传的是侧栏工作区项的稳定 id（refKey），主进程按 id 回查「打开集合中的工作区」——不按路径回查（工作区项的 `path` 是展示路径，远程项与真实路径不同、且同一路径可在多台机器出现，与「最近打开」点击按 id 回查同一约定），条目相对路径（'/' 分隔约定格式）经越界校验；这组通道只接受侧栏视图来源（`isSidebarSender`）；文件操作（含 SFTP 连接建立与失败原因）落盘 `fileLogger`（`sidebar-files` 组件），打包态无 console 也可事后排查。双击文件行打开（`sidebar:files-open`，本地与远程工作区同样支持）：Markdown（`.md` / `.markdown`）进内置 Markdown 预览窗口（`ElectronUIHost.openMarkdownPreviewWindow`——`src/host/markdownHtml.ts` 用 marked 渲染 GFM 并在生成侧净化内容：原生 HTML 片段转义、非 http(s) / mailto / 锚点协议的链接降级为纯文本，只读 HTML 经 base64 data URL 装进沙箱窗口（只带负责刷新的 preload），深浅色随 `nativeTheme`）；文本（代码 / 配置 / 文本扩展名，以及嗅探不出二进制的未知类型）进内置文本窗口（Monaco `mode: 'view'`，与工具卡片点「Edit」预览同一效果）；图片进内置图片查看器（`dist/imageViewer`，滚轮以光标为锚缩放、放大后可拖动平移、双击在 100% 与适配窗口间切换）；其它二进制调系统默认应用（`shell.openPath`）；三类查看器打开后监听源文件并自动刷新——本地 `fs.watch`、远程 Core 推送，刷新保持缩放 / 滚动 / 光标，删除 / 读取失败在标题标记（specs/018）；**远程二进制不支持打开**——渲染层对已知二进制直接跳过（不发 IPC，省一次 SFTP 嗅探），未知扩展名经主进程嗅探后同样拒绝，错误消息 `remote-binary-unsupported` 按预期行为处理（主进程不弹框、渲染层不报错）。分流与图标共用同一份扩展名根集合（`electron/fileTypes.ts`），编排与临时落盘在 `electron/fileOpen.ts`（`shell.openPath` / 窗口打开经 `FileOpenBridge` 注入，SFTP 读原语在 `electron/sidebarFilesRemote.ts` 的 `remoteFileReaderFor`），目录双击不再翻转（单击已展开 / 折叠，双击的第二下忽略）。分区折叠期渲染层不渲染文件树、不预读根目录（否则启动时刻的目录内容被缓存，首次展开命中陈旧数据——懒加载的根目录读取点必须是首次展开）。打开集合为空不显示分区。选择模型与资源管理器一致（点击 / Ctrl 切换 / Shift 连选 / Ctrl+A / Esc / Delete），定义见 `docs/features/user-stories.md` US-42 / US-43 |
| 远程终端 | 标签页右键「打开终端」为该**远程**工作区打开独立终端窗口（本地工作区同位置为「打开命令行」；每工作区单例；VS Code 宿主无此能力）。窗口内多标签，每标签一条 SSH PTY shell 通道（`src/host/standalone/sshClient.ts` 的 `openShell`），复用侧栏文件浏览的 endpoint 连接池与租约计数（`electron/sidebarFilesRemote.ts` 的 `sharedClientFor` + `retainRemoteFilesClient`）；标签 / 通道状态的 owner 在主进程（`electron/terminalShells.ts`），页面 `electron/terminal/`（xterm.js，vite 入口 `dist/terminal`）是纯投影；数据走独立 `terminal:*` IPC 面，不进对话消息协议、不进总线。工作区关闭联动关窗、退出全关；断开态覆盖层 + 单标签手动重连。行为规格见 [docs/hosts/electron-multi-workspace.md 第 14 节](electron-multi-workspace.md#14-远程终端) |
| 空态 | 打开集合为空时，侧栏显示「打开本地工作区」+ 最近工作区（点击即添加）；聊天区保持纯提示。活动工作区建链中 / 不可用时侧栏对话列表清空（不显示对话列表） |
| 启动等待态 | 侧栏初始化**先取工作区状态**（`sidebar:get-workspaces`，宿主本地事实）并渲染，之后才拉对话列表（要等 core 连接就绪；远程工作区连不上 / core 启动慢时会一直等）。工作区状态未到达前侧栏的 `workspacesState` 为 `null`，`render()` 保持等待态、不画空态——否则 core 未就绪期间会把「尚未取到工作区」错报成「尚未打开工作区」 |
| 添加 | `openWorkspaceDialog()` 支持多选，`addWorkspaces(paths)` 按顺序加入打开集合、末项置为活动项；已在集合中的目录直接切为活动项。远程目录经 `addRemoteWorkspace(endpoint, path)` 加入 |
| 路径去重 | `src/host/workspacePaths.ts`：`normalizeWorkspacePath`（resolve）+ `workspaceKey`（realpath + Windows 大小写不敏感）+ `sameWorkspace` / `dedupeWorkspacePaths`。打开集合、最近工作目录、会话索引都按去重键判等，同一目录的不同表示（尾部分隔符 / 相对路径 / 分隔符风格 / 大小写 / 符号链接 / 8.3 短名）不重复入集合、不重复写最近列表 |
| 关闭 | `closeWorkspace(ref | id)`：移出打开集合、`chatViews.closeWorkspace(ref.path)` 销毁该目录下所有对话视图并中止运行中查询、清 `sessionWorkspaces` 中该目录的条目（顺带丢弃该标签页的不可用 / 建链判定）；关闭活动项后活动权移交相邻项（先右邻再回绕），聊天区由 `syncChatAreaForActiveWorkspace` 对齐（相邻项不可用时显示占位页），集合为空时回到空态 |
| 切换 | `activateWorkspace(ref \| id)`：更新 provider（`uiHost.setWorkspacePath(ref)`）、`chatViews.setActiveWorkspace(ref.path)`（切到该目录最近使用的对话，没有则新建）、刷新侧栏列表与标题栏 |
| 宿主会话工作目录索引 | `sessionWorkspaces: Map<sessionId, path>`：来源为各工作目录对话列表的 `project` 字段 + 视图自己的目录（`ChatViewManager.getWorkspaceForWebContents`）；打开对话时据此注入 `--workspace=` |
| 聊天视图 | `ChatViewManager` 按视图记录所属工作目录（`viewWorkspaces`）；`openConversation(id, workspace)` / `openNewConversation(workspace)` 注入对应 `--workspace=`；切换活动目录不销毁视图 |
| 持久化 | `workspace-state.json` 的 `openWorkspaces`（`SerializedWorkspaceRef`）/ `activeWorkspaceKey`（无活动项写 `null`）；启动恢复打开集合与活动项，已不存在的本地目录**保留并标记为不可用**（红点 + 占位页，见「不可用工作区」），保存的活动项保持为活动项。**远程工作区同样落盘**：`endpoint` 连同凭证（SSH 口令，明文）写进宿主本地状态文件，重启后据此重新接入（[docs/core/client-connection.md 第 9 节](../core/client-connection.md#9-落盘与恢复宿主侧)）。字段缺失或非法即按「没有」处理，不做跨字段回退；旧版本写的是路径字符串 + `activeWorkspace`，读取时按本地引用迁移；升级路径由 `migrateLegacyWorkspaceState()` 一次性迁移（旧 userData 目录 + 旧 `lastWorkspace` 字段），迁移后不再回退读旧字段 |
| userData 目录 | `electron/main.ts` 启动最早期用 `app.setPath('userData', appData + <配置里的应用目录名>)` 显式指定：开发态（`electron dist-electron/main.cjs`）默认名是 `Electron`、打包态是 `productName`，不指定会落到不同目录；指定后两态读写同一份工作目录状态 / 窗口位置 / 缓存。目录名取自 `src/config/project.json` 的 `extensionName`，不硬编码 |
| 浮窗模式 | 以当前活动工作目录（即活动对话的工作目录）为窗口上下文；品牌位显示活动目录名 |

**`SpinDesign`**（`src/VSCodeSpinDesign.ts` / `electron/ElectronSpinDesign.ts`）

| 方法 | VS Code | Electron |
| --- | --- | --- |
| `open` | 复用 `WebviewPanel`（`retainContextWhenHidden`） | 复用 `BrowserWindow`（注入 `acquireVsCodeApi` shim，复用同一份 `spinDesignHtml`） |
| `refresh` | 重读 spin.json + Skill 列表推给面板 | 同左（推给窗口） |

**`ConversationManager`**（`src/VSCodeConversationManager.ts` / `electron/ElectronConversationManager.ts`）

| 成员 | VS Code | Electron |
| --- | --- | --- |
| `dispatchList` | 只推 webview `conversationsData`（子对话树） | 推原生侧栏 `sidebar:conversations-updated` + webview `conversationsData` |
| `dispatchStates` | 推 webview `sessionRuntimeStates`（对话树流水灯 + abort 按钮） | 推侧栏 `sidebar:session-states-updated` + `statusListener`（托盘）+ 广播聊天视图（abort 按钮） |
| 空闲会话回收 | `SingleWebViewConversationManager` 独有（2 小时 / 1 分钟巡检，`isSessionIdle` 判定） | 不做（每个对话一个独立视图，自动关闭等于关掉用户窗口） |
| `setStatusListener` | 不注册 | 注册（驱动托盘状态点与「任务结束」闪烁） |

两条流的数据源相同（core 的 `conversationListChanged` / `sessionRuntimeChanged`），
只是分发出口不同。**对话树流水灯与侧栏流水灯都只读 `sessionRuntimeChanged`**：
VS Code 推给 webview（`sessionRuntimeStates`），Electron 推给侧栏，webview 的流水灯只读这份状态，不从
`queryBegin` / `queryEnd` 自行推导 idle。

列表流每个工作目录各留一份快照：基类 `refresh()` 把活动目录的列表存进 `getCachedList()`，
Electron 的 `sidebar:get-conversations` 直接读它，切换标签页不再每次完整读盘 / 走
`conversationListRequested` 网络往返；列表变化经 `onConversationListChanged()` 重读活动目录、
其余目录标脏（命中脏快照先返回快照、后台补读）；关闭工作目录时
`invalidateCachedList(目录)` 丢掉该目录的快照，重新打开按首次打开处理。

状态流是「变化时才推」的，没有快照：侧栏初始化 / 重载时用 `sidebar:get-session-states`
拉一次 `ConversationManager` 缓存的全量快照（`getSessionStatesSnapshot()`，即 core
`sessionRuntimeChanged` 在本进程的投影）播种，补上推送早于侧栏就绪造成的空档。
**切工作目录不清空这份状态**——`sessionRuntime` 是跨工作目录的全局快照、会话视图切目录时保留，
清空后没有任何通道能补回来，流水灯会一直不亮。

**bootstrap / 传输层**（`src/extension.ts` / `electron/main.ts` + `electron/preload.ts`）

启动接线的共享部分在 `src/host/bootstrapCore.ts`（[docs/hosts/host-bootstrap.md 第 1 节](host-bootstrap.md#1-宿主接线)）；本表只列两端差异。

| 项 | VS Code | Electron |
| --- | --- | --- |
| 启动接线骨架 | `bootstrapCore(...)`（共享） | 同左 |
| 宿主参数 | `locale: vscode.env.language`、`logToConsole: false`、`extensionPath: context.extensionPath` | `locale: app.getLocale()`、`logToConsole: true`、`extensionPath: APP_ROOT` |
| 启动自检 | `bootstrapSnapshot()` 写入 `OutputChannel` | `bootstrapSnapshot()` 写入 `console` |
| 消息通道 | HTML 内联脚本注入 `window.vscode`（`acquireVsCodeApi`） | `contextBridge` 注入 `window.electronAPI` |
| 能力声明注入 | `getWebviewContent()` 内联 `window.__hostInfo` | `preload.ts` `exposeInMainWorld('__hostInfo')` |
| webview 消息入口 | `handleWebviewMessage(message)`（单 webview，`sender` 为 `null`） | `handleWebviewMessage(message, { sender: webviewHandleFor(sender) })`（按来源视图回包） |
| 视图加载时的环境推送 | `resolveWebviewView` 后延时推 `requestTheme` / `requestContextLimit`（走同一 handler） | `did-finish-load` 时 `onThemeChanged(handle)` + 推 `requestContextLimit`（走同一 handler） |
| 编辑器上下文 | 有：`persistCurrentFileContext` → `conversationContextUpdated`（`activeTextEditor` + 选中行） | **刻意没有**：桌面端没有 `activeTextEditor` 等价物，打开 Monaco 只是查看，不改变发消息时附带的文件上下文 |
| 工作区来源 | `workspaceFolders` | 菜单选择的 `workspacePath` |
| 原生侧栏 / 托盘 / Monaco 窗口 / 偏好设置窗口 / 菜单 / 自绘标题栏 / 悬浮窗模式 | 无 | 有 |
| 应用自有页面导航防御 | 无：webview 由 VS Code 承载，页面导航由 VS Code 约束，外链点击走 webview 侧拦截（`src/webview/App.tsx` 的 `openUrl`）→ `vscode.env.openExternal` | `guardViewNavigation`（`electron/viewNavigation.ts`）：聊天视图 / 侧栏 / 标题栏 / 下拉菜单 / 占位页 / 各预览窗口 / 对话框统一拒绝 `window.open` 与渲染进程发起的非 `file://` 导航，外部链接（http(s) / mailto / tel）交系统默认浏览器 |
| 空闲回收 / 状态栏项 / 虚拟文档 provider / 命令注册 | 有 | 无 |
| 系统睡眠阻断 | 无：VS Code 扩展没有电源 API，standalone 下由 Core 子进程自己阻断 | `setStatusListener` → `sleepBlocker.update(states)`（`electron/powerSaveBlocker.ts`） |
| 退出清理 | `deactivate()`：`stopIdleMonitor` + `shutdownCore()` | `will-quit`：注销快捷键、销毁托盘与提醒音播放窗口、释放睡眠阻断、`shutdownCore()` |

两个宿主共用同一层进程退出兜底（`CoreProcess` 的 `process` exit 钩子），见
[docs/hosts/host-bootstrap.md 第 4 节](host-bootstrap.md#4-退出路径)。

**托盘状态点与「任务结束」闪烁提醒**属于 `statusListener` 这条流：它吃的是**会话状态流**，
挂在 `ElectronConversationManager.setStatusListener` 上（`electron/main.ts`）。颜色与闪烁分两步：

- **颜色**（静态与闪烁相位共用）吃**聚合**状态：`deriveTrayStatusFromStates(states)` 按
  `waiting` > `running`（`idle === false`）> `idle` 聚合出黄 / 红 / 绿点；
- **闪烁**（任务结束提醒）由 `diffSessionEndEvents`（`electron/trayAttention.ts`）对**相邻两次**
  全量推送按 sessionId 差分：任一会话从运行中结束（running → idle 完成、running → waiting
  等用户）且窗口处于后台就闪，**不看聚合状态是否变化**——两个对话在跑时其中一个完成同样
  提醒（聚合仍是 running，红点闪）；颜色取当前聚合状态。不算事件的迁移：waiting → running
  （用户已应答继续跑）、idle → waiting、running → running；新出现（启动 / 切换工作区恢复）与
  消失（关闭对话 / 切换工作区）的会话只更新级别表不产生事件。
  **完成提醒过一道确认窗口**（`COMPLETION_ATTENTION_GRACE_MS`，1s）：空闲挂起项
  （[docs/features/user-message-pipeline.md](../features/user-message-pipeline.md) FR-003，webview
  本地事实）与排队压缩等队列续跑都发生在 idle 推送**之后**，差分看到 running → idle 时队列里
  可能还有活——完成先记入 `completedSessions` 挂确认窗口，窗口结束时该会话仍空闲 / 等用户
  （`shouldFireCompletion`）才提醒；期间又跑起来（挂起项提交、队列续跑）则取消，真正的完成由
  续跑任务自己的 running → idle 再触发。转等待立即提醒不设窗口。**非 user 创建的会话
  完成不提醒**：`creator` 为 agent 形态的会话（本地子代理与 Agent 工具派发的跨工作区
  对话，specs/025 FR-002/FR-003）与「仅因子代理在跑而忙」的父会话落回 idle 都不算任务
  结束；**转等待不受抑制**，照常提醒（specs/024 FR-002）。

**提醒音**挂在同一处判定上（`electron/trayAttentionSound.ts` 的编排 + `electron/traySoundWindow.ts`
的播放载体）：`startAttention` 启动闪烁的同时播一次 `electron/assets/meow.aac`——窗口在前台不提醒也
就不出声，闪烁的亮 / 灭相位切换不重复出声，上一次没播完又来提醒则从头重播（单路）。
音频不走 `<audio>`：该文件的 MP4 容器时长元数据与数据不一致（声明 ≈6ms，实际约 1.25s），
Chromium 按声明时长立刻判定结束；播放载体改为隐藏窗口里 `decodeAudioData` 解到文件尾、
经 `GainNode`（按当前音量）与 `AudioBufferSourceNode` 出声（`autoplayPolicy: no-user-gesture-required`，
播完即销毁窗口，不常驻）。是否出声与音量是宿主本地偏好（`workspace-state.json` 的
`soundEnabled` / `soundVolume`，默认关闭 / 50% 音量），在偏好设置窗口里改：关掉后连播放载体都不建；
音量每次播放前现取，同一个载体既播提醒也播试听（拖完音量滑条预览一次）。播放失败只落
`tray-sound` 日志，不打断同一快照上的状态点与睡眠阻断。播放窗口
不常驻：播完自毁，主窗口关闭（`mainWindow.on('closed')`）与应用退出（`will-quit`）时立即
销毁——它也是 BrowserWindow，留着会让 `window-all-closed` 不再触发、`activate` 里
「没有窗口才重建主窗口」的判定失效。**VS Code 宿主没有这条通道**，扩展包（vsix）也不
携带该音频——它是 Electron 应用包里的资源。
e2e 的整应用用例经启动开关关掉它（见 [e2e/README.md](../../e2e/README.md#隔离策略electron-app)）。

托盘右键菜单（`buildTrayMenu()`）与托盘提示（`trayTooltip()`）是系统级 UI，文案与主菜单
同源、走 `tt()` 按宿主语言取词；宿主语言在运行期变化时由 `onHostLocaleChanged` 订阅
`refreshTrayLocale()` 重建（与 `setupMenu()` 一起），不能只在创建时定一次。

**不为此加 `onQueryEnd` 之类的新事件**——闪烁事件由两次全量快照差分得出，core 不新增
单会话结束事件流；状态点的颜色也始终是聚合量，单会话事件表达不了它：

| 状态迁移 | 原因 | 聚合颜色 | 闪烁（单会话差分） |
| --- | --- | --- | --- |
| `idle=false → idle=true` | 查询结束 | 随其余会话聚合，可能仍是红点 | 闪（完成提醒；确认窗口内又跑起来——空闲挂起项提交 / 队列续跑——则不闪） |
| `idle=false → waiting=true` | 查询没结束，但要用户确认（ask user / 权限确认） | 黄点（waiting 优先级最高） | 闪（等待提醒） |
| `idle=false → idle=false` | 主查询结束了，但后台 Bash / 非 idle 子代理还在跑 | 红点 | 不闪（任务没结束） |

core 侧对应 `sessionRuntime`（引擎池 + pending user choice）：它维护每个会话的
`idle` / `waiting`，变化时推**全量** `sessionRuntimeChanged`；托盘只是这份全量状态的一个消费者。
MCP **不在**这个列表里：生命周期归 core（`MCPHost`），留在 UI 侧的只有「把状态读出来给面板看」。

**系统睡眠阻断**挂在同一条 `statusListener` 上：任一会话非 idle（含 `waiting`）→ 阻断系统
进入睡眠 / 休眠，全部空闲 → 释放。判定复用 core 的 `sessionBusyLevel`，与托盘 / 标签页流水灯 /
关闭前的二次确认同一份派生；阻断类型只要求系统不挂起、允许屏幕熄灭（Electron 侧
`prevent-app-suspension`，Core 侧 Windows `ES_SYSTEM_REQUIRED` / Linux `systemd-inhibit
--what=idle:sleep`）。`update()` 幂等：全量快照高频重复推送不会重复申请阻断，也不会误停
已在生效的阻断。

阻断分两处实现，因为「谁的机器需要保持清醒」按进程划分：

| | Electron 宿主（`electron/powerSaveBlocker.ts`） | Standalone Core 进程（`core-rs/src/power.rs`） |
| --- | --- | --- |
| 覆盖的机器 | 宿主所在机器 | Core 进程所在机器（本地子进程 = 本机；远程 daemon = 远端） |
| 触发 | `setStatusListener` 的会话状态流 | `Core::emit_runtime` 推快照前的同一个判定 |
| 为什么需要 | 本地任务跑在宿主进程里 | 远程工作区的长任务在远端执行，宿主那台机器睡不睡与它无关 |

两处同时生效（本地同机时冗余但无害）；VS Code 侧没有宿主实现（VS Code 扩展没有电源
API），本地任务的睡眠阻断由 Core 进程那一份承担——这是
已记录的固有差异，不做静默降级。

**自绘标题栏与窗口模式**（`electron/titlebar/` + `electron/main.ts`）：

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 窗口框架 | `frame: false`（macOS 用 `titleBarStyle: 'hiddenInset'`） | 系统标题栏与系统菜单栏都不再绘制，改由顶部 38px 的 `titlebarView` 自绘 |
| 菜单定义 | `buildMenuSections()` 单一来源 | 同时驱动原生 `Menu`（macOS 系统菜单栏 / role 类行为）与自绘菜单（`toTitlebarMenuNodes` 保留 `submenu` 层级） |
| 主题 | `nativeTheme.themeSource`（`system` / `light` / `dark`）+ 聊天视图 `setTheme` 消息 | 模式持久化在宿主本地状态 `userData/workspace-state.json` 的 `theme` 字段（旧版本写在 settings.json 的 `theme` 由 `migrateLegacyThemeAndShortcut()` 一次性迁移），偏好设置窗口的主题单选切换（`applyThemeMode`）。`themeSource` 驱动原生配色、各渲染进程的 `prefers-color-scheme`（自绘标题栏 / 侧栏 / Monaco 预览 / 偏好设置窗口的浅色覆盖）与窗口兜底底色；聊天 webview 不监听 `prefers-color-scheme`，由 `uiHost.onThemeChanged(null)` 广播 `setTheme`，新视图用 `--theme=` + `window.__initialTheme` 保证首帧底色正确。跟随系统时 OS 切换走 `nativeTheme.on('updated')`：除了刷新底色与广播主题，还要**作废自绘菜单缓存**——菜单配色是生成 HTML 时烘进内联样式的，缓存复用会让菜单停留在旧配色 |
| 二级菜单 | 飞出面板（`.flyout`） | 「最近打开的工作目录」等子菜单默认收起，悬停/点击父项才展开；面板绝对定位在主面板右侧，右侧放不下时改向左展开（`offsetX` 为负）。宽度按内容自适应（`width: max-content`，缺省下限 `TITLEBAR_SUBMENU_WIDTH`），上限由主进程按「锚点到窗口右缘」下发（`flyoutMaxWidth`）：条目短就收缩、不撑满可用宽度，「最近的工作区」长路径最多铺满到上限、完整显示；展开时按实测宽度决定左右方向与 `offsetX` |
| 二级菜单不裁切 | 视图尺寸 = 主面板 ∪ 飞出面板；**页面底色与视图背景都要透明** | 视图比主面板大时多出的区域必须能透出下方内容。实测 `WebContentsView` 的透明区域可与下方兄弟视图正常混叠（无需窗口级 `transparent`）。注意 `view.setBackgroundColor('#00000000')` 与页面 `background: transparent` **两者都要**：只改页面会露出视图默认的白底（表现为白边，已踩过）。展开/收起时页面重新上报尺寸，主进程 `setBounds` 调整视图 |
| 飞出面板不被 `body` 裁掉 | `body` 的 `min-height` = 菜单可用高度上限（`maxHeight`） | 飞出面板是 `body` 的绝对定位子元素，而 `body` 只按主面板 `.menu` 的自然高度撑开，`overflow: hidden` 会把超出主面板的那截飞出面板整段裁掉——此时飞出面板自身 `scrollHeight == clientHeight`（不出现滚动条），后半截条目既看不到也滚不到，「打开最近的工作区」条目多时就是「列表显示不全」。飞出面板底边由 `positionFlyout` 限制在 `maxHeight` 以内，所以 `body` 撑到 `maxHeight` 一定装得下（且撑满后不改变上报尺寸：`reportSize` 量的是主面板/飞出面板的 rect，不是 `body`）。回归用例：`src/test/titlebarMenu.test.ts` |
| 下拉菜单 | 独立 `WebContentsView` | 不用 `BrowserWindow`：开窗有系统动画与层级窗口合成，会「闪一下」；视图只是同窗口内的一块合成区域，摆位即显示。首次打开测量尺寸并缓存 |
| 菜单关闭 | 侧栏/聊天视图 focus + 窗口 blur/hide/move/resize + 点标题栏空白 + Esc | **不要用标题栏 blur 关菜单**：显示菜单视图会让焦点重新计算（可能变成「无焦点视图」），据此关菜单会让菜单刚弹出就被自己关掉（已踩过）。打开时把焦点交给菜单视图（Esc/方向键依赖它），关闭时还给打开前的视图 |
| 菜单置顶 | `addChildView` 重新入栈 | 聊天视图是动态 `addChildView` 的，会盖住菜单视图；显示菜单时再 `addChildView` 一次即可提到最上层。**不要先 `removeChildView`**——那会把焦点掉成「无视图」，菜单随即被关掉 |
| 快捷键 | 原生 accelerator + `before-input-event` 兜底 | 无边框窗口下原生 accelerator 是否生效依平台而定，两处都命中时按 id 去重（250ms）。唤醒快捷键在偏好设置窗口里录制、持久化在 `workspace-state.json` 的 `shortcut` 字段（旧版本写在 settings.json 的 `shortcut` 由 `migrateLegacyThemeAndShortcut()` 一次性迁移）；注册失败（组合键被系统或其它程序占用）不弹窗、落 fileLogger（`shortcut` 组件）与 console.warn 留痕 |
| 窗口模式 | `windowMode: 'normal' \| 'floating'` | floating = 隐藏侧栏（`sidebarView` 收成 0 尺寸）+ 聊天视图占满整宽（`chatViews.setConversationListOwner('webview')`），复用同一批 webview，不重新加载对话 |
| 侧栏宽度 | 右缘拖拽手柄（`electron/sidebar` 的 `#resizeHandle`）+ `sidebar:set-width` | 手柄按住水平拖动改宽度（渲染层 pointer capture，拖出视图边界不丢事件），松手落盘一次（`workspace-state.json` 的 `sidebarWidth` 字段，启动时播种，缺失 / 非法回默认 280）；拖拽过程走 `send` 高频上报不落盘，双击手柄恢复默认。宽度事实在主进程：`currentSidebarWidth()` 做全部夹取（200~640 DIP，且不挤掉聊天区的 320px 最小宽），`layout()` 的侧栏 bounds 与 `ChatViewManager.chatBounds()` 的左缘经构造期注入的 `sidebarWidth()` 读取口取同一份值（一份事实一个写入点）。浮窗模式侧栏收成 0 尺寸，用户宽度保持不动，切回完整模式原样恢复 |
| 浮窗最小化 | `mainWindow.on('minimize')` + `titlebar:minimize` | 完整模式最小化到任务栏；浮窗模式最小化改走 `hide()` 隐藏到系统托盘（隐藏的窗口不在任务栏保留按钮），唤醒入口是托盘图标单击 / 双击与全局快捷键（`showMainWindowFromTray`） |
| 模式切换的异步状态 | `waitForWindowEvent()` + `windowModeSwitching` | 先还原最大化/退出全屏（等 `unmaximize` / `leave-full-screen` 事件落定，1s 超时兜底）再 `setBounds`，否则会被忽略或只改还原尺寸；切换期间用标志位防重入 |
| 模式切换条件 | `canToggleWindowMode()` | 打开集合为空时禁用（浮窗隐藏侧栏，切换后无法再选工作目录） |
| 模式位置与尺寸 | `windowSize` / `floatingWindowSize` | 两种模式各自独立落盘 `{x,y,width,height}`，切换时按各自记录还原（旧坐标失效则退回当前位置）；浮窗默认 480 宽、工作区高度 80% |
| 查看器与设计器窗口位置 | `viewerWindowRect` / `spinDesignWindowRect` | 查看器名额（Monaco / 图片 / Markdown 共用一个窗口，后来者顶替并继承矩形）与 Spin 设计器窗口各自记忆 `{x,y,width,height}`：move / resize 防抖落盘、关闭补记；开窗用已存矩形并做「至少一块现存显示器工作区上可见」校验（与主窗口同一判据，`electron/viewerWindowRect.ts`），失效回退默认尺寸 |
| 模式持久化 | `windowMode` + `readLastWindowMode()` | 切换模式时落盘；启动时优先按上次的模式建窗口（尺寸/位置也取该模式的记录）。**上次是浮窗但本次没有工作区时退回完整模式**（浮窗隐藏侧栏，没有工作区就没法再选） |
| 置顶持久化 | `floatingPinned` + `readLastFloatingPinned()` | 点钉住按钮时落盘（默认 `true`），启动时按它恢复浮窗的「总在最前」；缺失/非法值一律按默认开启处理 |
| 浮窗标题 | `windowTitleForCurrentState()` + `workspaceDisplayName()` + 标题栏品牌位 | 浮窗模式下**窗口标题**（任务栏 / Alt-Tab）与**自绘标题栏的品牌位**都显示当前工作目录的**目录名（basename）**，其余情况显示产品名。取目录名而非完整路径：浮窗标题栏只有 480px 宽、任务栏标签也从右侧截断，而路径里最有信息量的恰好是尾部目录名。窗口是无边框的，光设 OS 标题在窗口里看不到，所以两处都要跟着变；目录名随 `titlebar:mode-state` / `titlebar:get-state` 的 `workspaceName` 下发，切模式与切工作区时同步 |
| 悬浮窗的顶栏形态 | `chatViews.setConversationListOwner()` + `setConversationListOwner` 消息 | 悬浮窗隐藏原生侧栏，对话列表渲染方切到 `webview`：列表改由 webview 顶栏渲染（历史对话入口）、新建入口移到顶栏。视图模式不变（仍是 `multi`：每会话一个 webview、提供关闭当前会话），切换会话照旧复用 / 另开视图。已打开视图就地切换，新建视图走 `--conversationListOwner=` 启动参数；顶栏「+」发 `{ type: 'openNewConversation' }`，由宿主另开 / 复用「未发送的新对话」视图（不原地重载） |
| 置顶 | `applyAlwaysOnTop()` | Electron 44 在部分 Windows 环境下 `setAlwaysOnTop(true)` 不落下 `WS_EX_TOPMOST`，按「默认层级 → `pop-up-menu` → 先取消再设」三级兜底 |

## 7. 尚未收敛的分叉点

- VS Code 对非 `file` scheme 的工作区引用只登记取值、不实现传输（`getWorkspaceRef`，
  `src/VSCodeUIHost.ts`）：打开 remote / ssh scheme 的文件夹时引用带 endpoint，但没有
  传输实现。当前没有 UI 入口能触发它（VS Code 的远程窗口不由本扩展管理），未来接入
  远程能力时要先补齐。

新发现的分叉按同样方式记在这里（现状 + 影响 / 备注）。
