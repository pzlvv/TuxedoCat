# ADR-0008：查看器文件自动刷新用 Core 主动推送而非宿主轮询

- 状态：已采纳
- 日期：2026-10
- 规格：`docs/hosts/host-matrix.md`、`docs/architecture/events.md`

## 背景

Electron 的内置查看器（Markdown 预览 / 图片查看器 / Monaco 文本查看）打开时把内容读成
快照，外部修改后不刷新。远程（SSH）工作区的文件在远端机器上，宿主只有 SFTP 访问能力，
SSH / SFTP 协议本身没有文件变更通知：

- 宿主侧轮询 `stat` 能工作，但延迟等于轮询周期，且每次轮询都要一次远端请求；
- 远端 Core 进程本来就在目标机器上运行，拥有完整文件系统访问能力，也能经帧通道向
  宿主上报事实。

## 决策

**远程查看器由远端 Core 监听并主动推送，本地查看器由宿主 `fs.watch` 监听**：

- Core 新增 `file_watch.rs`（`notify`，监听父目录 + 50ms 去抖），新增
  `UiRequest.watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested` 注册与注销监听，
  新增 `CoreEvent.workspaceFileChanged` 上报 `changed` / `deleted` / `error`；
- 事件只带 `watchId` / `path` / `kind` / `mtimeMs` / `size` / `error`，不带文件内容；
  宿主收到 `changed` 后经 SFTP 读内容并投递到查看器窗口；
- `WebViewUI` 的 CoreEvent handler 经新增 `UIHost.onWorkspaceFileChanged` 转交宿主；
- 本地查看器不经过 Core，直接用 `electron/localFileWatch.ts` 的 `fs.watch`；
- 监听随查看器窗口打开 / 关闭 / 顶替 / 换文件注册与注销，Core 重启后由宿主按
  `onWorkspaceConnectionState` 重新注册。

## 后果

- 远程刷新延迟从轮询周期降到亚秒级，且空闲时没有轮询请求；
- 契约面扩大：CoreEvent / UiRequest / UIHost 各新增成员，Rust、TS、docsLint 与文档
  需要同步；
- Core 必须常驻（打开工作区即有 Connection / Core 进程）；Core 不可用时查看器显示
  「自动刷新不可用」标记，内容仍可经 SFTP 读出；
- 事件不携带内容，大文件不会占用帧通道；宿主读取失败时保留最后内容并标记。

## 被否决的替代方案

- **SFTP 2 秒轮询**：延迟等于轮询周期，空闲时持续产生远端请求；用户明确要求 Core
  主动推送，轮询后端不保留（需要 Core 不可用时的兜底时另立 spec）。
- **SSH exec 跑 `inotifywait` / `fswatch`**：依赖远端预装工具、需要长连接流式 exec，
  Windows OpenSSH 无等价物，跨平台不可靠。
- **宿主直接订阅 CoreEvent，绕过 `WebViewUI`**：`onCoreEvents` 只允许一次注册，需要新增
  宿主级订阅基础设施；`CoreEventHandlers` 的穷尽保障只在 `WebViewUI`，绕过后新增事件
  不再有编译期漏接保护。选择 `UIHost` 转交。
- **用 `UiEvent` 注册监听**：单向事件没有返回值，路径越界 / 权限 / 监听上限无法如实
  回报；选择 `UiRequest` 的请求-响应。
- **监听整个工作区目录（递归）**：inotify watch 上限、事件量与权限问题；本期只监听当前
  查看器文件，文件树刷新仍走 US-42 的刷新按钮。
