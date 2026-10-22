# 实施方案：Electron 查看器窗口随源文件更新自动刷新

技术路线见同目录 [spec.md](spec.md)：本地查看器由 Electron 宿主用 `fs.watch` 监听；远程
查看器由远端 Core 用 `notify` 监听并经 `CoreEvent.workspaceFileChanged` 主动推送，宿主
收到事件后经 SFTP 读内容并投递给查看器窗口。契约新增一个 CoreEvent、两个 UiRequest 与
一个 UIHost 成员；宿主侧用 `watchId` 把事件路由到唯一查看器窗口，并负责内容判重、标题
标记、Core 重启后的重注册。

## 技术方案

### 1. 契约层（`src/shared/AssistantEventBus.ts`）

- `CoreEvent` 新增判别成员：
  - `type: 'workspaceFileChanged'`
  - `watchId: string`（宿主生成，注册与事件共用）
  - `path: string`（远端绝对路径，日志与自描述用）
  - `kind: 'changed' | 'deleted' | 'error'`
  - `mtimeMs: number`、`size: number`
  - `error: string | null`（`kind: 'error'` 时非空，其余为 `null`）
- `UiRequest` 新增两个成员：
  - `watchWorkspaceFileRequested`：`watchId`、`workspacePath`、`path`
  - `unwatchWorkspaceFileRequested`：`watchId`、`workspacePath`（仅用于按工作区路由）
- `UiRequestResultMap` 新增：
  - `watchWorkspaceFileRequested: { ok: true } | { ok: false; error: string }`
  - `unwatchWorkspaceFileRequested: null`
- `UIHost` 新增 `onWorkspaceFileChanged(event)`：由 `WebViewUI` 的 CoreEvent handler 转交
  宿主；VSCode 实现为 no-op（编辑器自身随文件更新），Electron 实现路由到查看器窗口。
- 不新增 webview 消息类型：事件不进入 webview，`WebViewUI` 直接转交宿主。

### 2. Core 侧（`core-rs/`）

- 新增 `file_watch.rs`：
  - `FileWatchRegistry` 持有 `watchId → WatchEntry`，`WatchEntry` 保存
    `notify::RecommendedWatcher`、目标路径与去抖发送端。
  - 注册时校验 `path` 落在 `workspacePath` 内（canonicalize 父目录 + 前缀比较，拒绝
    `..` / 跨根 / 不存在）；失败返回 `{ ok: false, error }`，不静默放行。
  - 监听目标文件的**父目录**（`RecursiveMode::NonRecursive`）并按 basename 过滤：原子保存
    的 rename 会让文件级 watcher 失效，父目录监听能同时捕获 replace / delete / recreate。
  - 每个 watch 一条去抖线程：`notify` 回调把原始事件送进 channel，线程按约 50ms 合并，
    最终以「文件当前是否存在」判定 `changed` / `deleted`，经 `SharedBus` 发一条
    `workspaceFileChanged`；watch 自身错误发 `kind: 'error'`。
  - `unwatch` 幂等：删除条目并 drop watcher；未知 `watchId` 返回成功（关闭 / 顶替竞态）。
  - 同一 `watchId` 重复注册先替换旧条目，保证一个 id 只有一个 watcher。
- `Core`（`engine.rs`）增加 `file_watch: FileWatchRegistry` 字段；`Core::new` 初始化。
- `main.rs` 的 `dispatch_ui_request` 增加两个分支：解析字段、调用注册表、返回结果；
  未知类型维持现有报错口径。
- `Cargo.toml` 增加 `notify` 依赖；只使用同步 `RecommendedWatcher`，不引入 async runtime
  特性。交叉编译目标仍为 Windows x64/arm64 与 Linux musl x64/arm64。

### 3. 宿主路由（`src/host/`）

- `coreFacts.ts` 增加 `watchWorkspaceFile()` / `unwatchWorkspaceFile()` 两个宿主入口，内部
  走 `requireEventBus().requestCore(...)`。
- `Client.connectionForRequest` 增加按 `workspacePath` 路由这两个请求的分支（与
  `conversationListRequested` 同口径）；`Connection.requestCore` 已有的就绪前排队逻辑
  直接复用。
- `WebViewUI.buildCoreEventHandlers()` 增加 `workspaceFileChanged` handler，调用
  `this.host.onWorkspaceFileChanged(event)`；不写 webview。
- Core 重启 / Connection 重建后的重注册复用 `bootstrapCore` 已导出的
  `onWorkspaceConnectionState(ref, 'ready', '')`：Electron 侧订阅它，按 `workspacePath`
  重新注册当前查看器监听。

### 4. Electron 宿主（`electron/`）

- 新增 `viewerWatch.ts`：宿主侧 `ViewerWatchController`，持有当前查看器窗口的
  `watchId`、目标、基础标题、最后内容与监听句柄。职责：
  - `open(target, initialContent, title)`：保存状态、启动本地 watcher 或发远程注册请求；
  - `handleCoreEvent(event)`：只接受当前 `watchId`，迟到事件丢弃；
  - `handleConnectionReady(ref)`：目标工作区就绪时重新注册并立即读一次内容补齐断档；
  - `close()`：停本地 watcher / 发远程注销，清状态；
  - 内容判重：文本按字符串、图片按字节比较；内容未变不投递；
  - 标题标记：基础标题 + `tt('（文件已删除）', '(File deleted)')` /
    `tt('（读取失败）', '(Read failed)')` / `tt('（自动刷新不可用）', '(Auto-refresh unavailable)')`。
- 新增 `localFileWatch.ts`：`fs.watch(parentDir)` + basename 过滤 + 约 50ms 去抖 +
  `stat` 判定删除；错误回调给控制器。与 Core 侧同一套行为口径。
- `ElectronUIHost`：
  - 查看器 init 增加 `watchTarget`（本地绝对路径，或远程 `endpoint + workspacePath +
    absPath`；虚拟文档 / diff / Mermaid 为 `null`）。
  - 开窗后创建 `ViewerWatchController`；窗口 `closed` / 被 `takeViewerSlot()` 顶替时
    `close()`；新查看器替换旧状态。
  - `onWorkspaceFileChanged(event)` 转给控制器；控制器读内容成功后经现有 preload 通道
    投递刷新消息。
  - 远程内容读取复用 `remoteFileReaderFor(endpoint, log)`；本地用 `fs.promises`。
- `fileOpen.ts` / `main.ts`：`openMarkdownViewer`、`openImageViewer`、`openTextViewer` 的
  init 带 `watchTarget`；本地侧栏打开 Markdown / 图片时补绝对路径，远程侧栏与
  `openRemoteFile` 补 `endpoint + workspacePath + absPath`；`openLocalFile` 的 Monaco
  `view` 模式补本地路径。远程文本仍用 `filePath` 只做语法推断，监听目标单独字段。

### 5. 查看器刷新通道（`electron/` 渲染端）

- 图片：`imageViewerPreload.ts` 增加 `imageviewer-refresh` 桥接；`imageViewer/main.ts`
  收到后替换 `img.src`，保留 `scale` / `offset`，新图尺寸越界时夹到允许范围。
- Monaco：`monacoPreload.ts` 增加 `monaco-refresh` 桥接；`monaco/main.ts` 用
  `editor.saveViewState()` → `model.setValue(content)` → `editor.restoreViewState()`，
  只对 `mode: 'view'` 生效。
- Markdown：新增 `markdownPreload.ts`（沙箱 preload，只用 `ipcRenderer` + DOM），收到
  `markdown-refresh` 后记录 `scrollTop`、替换 `.markdown-body` 的 innerHTML、恢复滚动；
  `markdownHtml.ts` 拆出 `getMarkdownPreviewBodyHtml()` 供刷新复用，完整页面模板继续
  调用它。`ElectronUIHost.openMarkdownPreviewWindow` 的 `webPreferences` 增加 preload。
- 新 preload 在 `electron/esbuild.js` 与 `project.config.cjs` 登记入口。

### 6. 错误与竞态

- 注册失败：查看器仍显示已读出的内容，标题标记「自动刷新不可用」；`onWorkspaceConnectionState`
  为 `ready` 时重试。
- 读取失败：保留最后内容 + 「读取失败」；下一次事件 / 重连重试。
- 删除 / 重建：`deleted` 标记；`changed` 且文件重新存在时清标记并刷新。
- 窗口关闭 / 顶替 / 换文件：先 `close()` 再开新监听；迟到事件按 `watchId` 丢弃。
- 打开过程中变更：初始内容读完后立即比对一次 `mtime + size`，不一致则再读一次，覆盖
  「读盘完成到监听就绪」之间的修改。
- 标题同步：刷新消息与标记同时更新 `document.title`（渲染端）与 `BrowserWindow` 标题
  （主进程），e2e 可直接读页面标题。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/Cargo.toml` | 修改 | 无：新增 `notify` 依赖 |
| `core-rs/src/file_watch.rs` | 新增 | `CoreEvent.workspaceFileChanged` 的 Core 侧产出 |
| `core-rs/src/engine.rs` | 修改 | 无：`Core` 持有 `FileWatchRegistry` |
| `core-rs/src/main.rs` | 修改 | `UiRequest.watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested` 分派 |
| `core-rs/src/file_watch_tests.rs` | 新增 | 无 |
| `core-rs/src/main_tests.rs` | 修改 | 无：请求分派用例 |
| `src/shared/AssistantEventBus.ts` | 修改 | `CoreEvent.workspaceFileChanged`；两个 `UiRequest` 成员与结果映射 |
| `src/host/UIHost.ts` | 修改 | 新增 `onWorkspaceFileChanged` 成员 |
| `src/VSCodeUIHost.ts` | 修改 | 新成员 no-op（VS Code 编辑器自身刷新） |
| `src/host/WebViewUI.ts` | 修改 | `workspaceFileChanged` handler 转交宿主 |
| `src/host/coreFacts.ts` | 修改 | 新增 watch / unwatch 宿主入口 |
| `src/host/Client.ts` | 修改 | `connectionForRequest` 按 `workspacePath` 路由新请求 |
| `src/host/bootstrapCore.ts` | 复用 | 不改：`onWorkspaceConnectionState` 已导出，供重注册订阅 |
| `electron/ElectronUIHost.ts` | 修改 | 无：集成 `ViewerWatchController`、扩展查看器 init、标题标记 |
| `electron/viewerWatch.ts` | 新增 | 无：watchId 生命周期、内容判重、重注册 |
| `electron/localFileWatch.ts` | 新增 | 无：`fs.watch` 父目录 + 去抖 |
| `electron/fileOpen.ts` | 修改 | 无：打开载荷带 `watchTarget` |
| `electron/main.ts` | 修改 | 无：`FileOpenBridge` 透传 watch target |
| `electron/imageViewerPreload.ts` / `electron/imageViewer/main.ts` | 修改 | 无：`imageviewer-refresh` |
| `electron/monacoPreload.ts` / `electron/monaco/main.ts` | 修改 | 无：`monaco-refresh` |
| `electron/markdownPreload.ts` | 新增 | 无：`markdown-refresh` |
| `electron/markdownHtml.ts` | 修改 | 无：拆出 body HTML 纯函数 |
| `electron/esbuild.js` / `project.config.cjs` | 修改 | 无：登记 markdown preload 入口 |
| `src/test/helpers/fixtures.ts` / `src/test/conversationListWorkspace.test.ts` | 修改 | 无：UIHost fake 补 no-op |
| `src/test/viewerWatch.test.ts` | 新增 | 无：控制器单测 |
| `src/test/fileOpen.test.ts` | 修改 | 无：打开载荷用例 |
| `e2e/electron/preview.spec.ts` | 修改 | 无：本地三类查看器刷新 / 删除标记 |
| `docs/features/user-stories.md` | 修改 | US-38 / US-42 验收 |
| `docs/architecture/events.md` | 修改 | CoreEvent 数量 / 2.1 表 / UiRequest 数量 |
| `docs/architecture/contracts.md` | 修改 | UIHost 新成员 |
| `docs/core/standalone-core-boundaries.md` | 修改 | 两个 UiRequest |
| `docs/core/standalone-core.md` | 修改 | Core 侧文件监听能力 |
| `docs/hosts/webview-ui.md` | 修改 | `onCoreEvents` 数量与枚举 |
| `docs/hosts/host-matrix.md` | 修改 | 第 2 / 3 / 6 节 |

## 测试计划

| 需求 / AC | 测试落点 | 说明 |
| --- | --- | --- |
| FR-001 / AC-1 ～ AC-3 | `e2e/electron/preview.spec.ts` | 本地 Markdown / 图片 / Monaco 打开后改文件，断言内容更新且窗口不重开 |
| FR-002 / AC-4 ～ AC-7 | `src/test/viewerWatch.test.ts`、`core-rs/src/file_watch_tests.rs` | 假 Core 事件 + 假读取验证推送刷新、删除 / 重建、按 `watchId` / 工作区路由；Rust 侧验证监听与事件 |
| FR-003 / AC-11 ～ AC-15 | `src/test/viewerWatch.test.ts` | 关闭 / 顶替 / 换文件注销；工作区关闭停监听；`onConnectionReady` 重注册并补读 |
| FR-004 / AC-8 ～ AC-10 | `e2e/electron/preview.spec.ts` | 图片滚轮缩放后刷新保持 transform；Markdown 滚动位置；Monaco `saveViewState` 后的滚动 / 光标 |
| FR-005 / AC-16 ～ AC-19 | `core-rs/src/file_watch_tests.rs`、`src/test/viewerWatch.test.ts` | 原子保存去抖一次；相同内容不刷新；连续事件合并；打开期间修改补读 |
| FR-006 / AC-20 ～ AC-22 | `src/test/viewerWatch.test.ts`、`core-rs/src/main_tests.rs` | 注册失败标记；读取失败标记与重试；断线重连重注册；删除 / 重建 |
| 契约与文档 | `src/test/docsLint.test.ts` | CoreEvent 28、UiRequest 13、UIHost 成员数、2.1 表 / webview-ui 枚举 |
| 远程真实 SSH | 无 e2e，沿用 US-42 远程豁免 | 需要真实 SSH / SFTP 远端；由假总线 / 假 Core 单测覆盖协议与状态机 |

补充约定：

- Rust 监听测试用 `tempfile` 临时目录 + `test_support::Capture` 捕获帧；原子保存用
  「写临时文件 + rename」；删除 / 重建用 remove + write；断言用带超时的轮询，避免依赖
  固定 sleep。
- TS 控制器测试注入假 `watchRemote` / `unwatchRemote` / `readContent` / `deliver` /
  `setTitle` / `now`，不启动 Electron 窗口；时间用可控 clock。
- e2e 通过 `app.waitForPage('monaco' | 'imageViewer')` 与 data URL 页面定位 Markdown；
  标题标记通过 `page.title()` 断言（渲染端同步 `document.title`）。
- 涉及 core 的改动先 `npm run build:core:host`，再 `npm run test:all`；CI 会构建 Linux Core。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../../../AGENTS.md#1-分层与依赖评审必查)）：Core 只经 `AssistantEventBus` 帧通道与 TS 侧通信，
      新增事件 / 请求定义在 `src/shared/AssistantEventBus.ts`；`src/host/` 不 import
      `vscode` / `electron`；Electron 窗口与 `fs.watch` 全部落在 `electron/`；无
      `host.kind === ...` 嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：注册失败 / 读取失败都显式标记并记日志，不静默降级；
      新增契约字段全必选（`error` 用 `null` 表示无错误，结果用判别联合）；Core 是监听
      注册表的唯一写入点，Electron 宿主是查看器 watch 状态的唯一写入点；无新增默认值。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../../../AGENTS.md#5-工作流)）：**不涉及**——仓库只有
      `core-rs` 一套 Core 实现，本地与远程共用同一二进制，不存在第二套 Core 需要同步；
      Core 行为改动仍落在 `core-rs/` 并补 Rust 测试；不涉及会话落盘格式（meta.json /
      JSONL）与 `src/shared/history/`，无需双侧格式同步。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../../../AGENTS.md#0-文档要求)）：按 spec「影响基线」同步 11 处文档；事件数量、
      2.1 表、webview-ui 枚举与 UIHost 成员数由 `docsLint` 对照代码校验；实施同提交完成，
      `npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

- **SFTP 2 秒轮询**：延迟等于轮询周期，且每 2 秒一次 `stat`；用户明确要求 Core 主动推送。
  轮询后端不保留，需要兜底时另立 spec。
- **SSH exec 跑 `inotifywait` / `fswatch`**：依赖远端预装工具、需要长连接流式 exec、
  Windows OpenSSH 无等价物；跨平台不可靠。
- **宿主直接订阅 CoreEvent，绕过 `WebViewUI`**：`onCoreEvents` 目前只允许一次注册，
  需要新增宿主级订阅基础设施；`CoreEventHandlers` 的穷尽保障只在 `WebViewUI`，绕过后
  新增事件不再有编译期漏接保护。选择 `UIHost.onWorkspaceFileChanged` 转交。
- **用 `UiEvent` 注册监听**：单向事件没有返回值，路径越界 / 权限 / 监听上限无法如实回报；
  选择 `UiRequest` 的请求-响应。
- **监听整个工作区目录（递归）**：inotify watch 上限、事件量与权限问题；本期只监听当前
  查看器文件，文件树刷新仍走 US-42 的刷新按钮。
- **Markdown 刷新重新 `loadURL` data URL**：会丢滚动位置并闪一下；选择沙箱 preload
  替换 `.markdown-body`。
- **本地也走 Core 推送**：本地 `fs.watch` 更轻、不依赖 Core 进程；统一后端留待后续。
- **引入 `notify-debouncer-full`**：单文件去抖只需约 30 行 channel + `recv_timeout`，
  少一个依赖、行为可控；选择手写去抖。

> 「远端文件变更用 Core 推送而非宿主轮询」是跨层决策，建议补 `docs/adr/0008-...`（编号
> 递增、只增不删），记录背景、决策与被否决方案；实施前或与实施同提交落地。
