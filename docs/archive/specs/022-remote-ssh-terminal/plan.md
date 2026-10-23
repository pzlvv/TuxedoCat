# 实施方案：Electron 远程终端（SSH shell）

技术路线：不加 Core、不加总线——终端是 Electron 原生窗口（对齐 `remote-workspace:*` 的
独立 IPC 面先例），SSH 侧在既有 `SshClient` 上补一个 `openShell`（ssh2 的 shell 请求带
PTY），连接复用侧栏文件浏览的 per-endpoint 连接池；渲染端新建 vite 入口 `electron/terminal/`
（React 不引入，原生 DOM + `@xterm/xterm`，对齐 remoteWorkspace 页面的轻量形态），
样式按 `demo.html` 定稿实现。会话状态（标签表）的 owner 在主进程，渲染端是纯投影。
指向同目录 [spec.md](spec.md)。

## 技术方案

### 模块划分与数据流

```
[electron/terminal/] xterm 渲染端（vite 入口，dist/terminal/）
   │  window.terminalAPI（terminalPreload.cjs 暴露）
   │  invoke: init / new-tab / input / resize / close-tab / reconnect / close-window
   │  事件:   terminal:tabs / terminal:output(tabId, Uint8Array) / terminal:theme
   ▼
[electron/terminalWindow.ts] BrowserWindow 胶水：窗口单例（按 refKey）、IPC 注册、
   │  租约登记、主题 / 语言 / 字号注入、工作区关闭与退出挂点
   ▼
[electron/terminalShells.ts] 标签 / 通道状态机（纯 TS，无 electron import，可单测）
   │  依赖注入 openChannel，不直接依赖 ssh2
   ▼
[electron/sidebarFilesRemote.ts] per-endpoint 连接池（sharedClientFor + 租约）
   ▼
[src/host/standalone/sshClient.ts] SshClient.openShell({ cols, rows })（新增）
   ▼  ssh2 client.shell（PTY，term=xterm-256color）
[远端 sshd → PTY → 登录 shell]
```

- 标签事实（id、label、状态、失败原因）owner 是主进程的 `TerminalSessionGroup`，
  每次变化整表推 `terminal:tabs`（渲染端不回写状态，只发动作）——一份事实一个写入点。
- 输入流：渲染端 `input` → 通道 `write`，返回 false 时等 `drain` 再写后续（按键量小，
  不做丢包策略）；输出流：通道 data 原样 `Uint8Array` 推给渲染端，UTF-8 由 xterm 增量
  解码，宿主不按行重组（spec FR-004）。洪泛路径：输出全量推给 xterm 内部缓冲消化
  （与 VS Code 同做法），主窗口不经手（独立窗口 + 独立 IPC 面，spec FR-009）。
- shell 通道的正常退出与异常断开用 ssh2 的两个事件区分：`exit`（远端进程退出，spec
  FR-003 → 标签自动关闭）与 `close`（无 `exit` 先行即连接层断开，spec FR-007 → 标签转
  断开态）。`TerminalSessionGroup` 把它抽象为 `onRemoteExit` / `onClose` 两个回调注入。
- PTY 初值：建通道时以发起时刻的 cols / rows 发起；后续窗口 resize 由 FitAddon 算出
  后走 `resize` → `channel.setWindow(rows, cols)`（spec FR-004）。

### 关键形态

```ts
// electron/terminalShells.ts（节选，全成员必选）
interface TerminalChannel {                     // ssh2 ClientChannel 的窄接口
  write(data: string): boolean;
  onceDrain(listener: () => void): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onRemoteExit(listener: () => void): void;     // ssh2 'exit'：远端进程正常退出
  onClose(listener: () => void): void;          // ssh2 'close'：通道结束
  resize(rows: number, cols: number): void;     // ssh2 setWindow
  destroy(): void;
}
type TerminalTabStatus = 'connecting' | 'ready' | 'disconnected';
interface TerminalTab {
  id: number;              // 窗口内自增
  label: string;           // "bash N"
  status: TerminalTabStatus;
  failure: string | null;  // disconnected 时的原因；其余恒 null（不用可选字段）
}
```

- `TerminalSessionGroup`：构造注入 `{ openChannel(opts: { cols, rows }): Promise<TerminalChannel>; cwd: string; notify: (tabs, output) => void }`。方法：`newTab(size)` /
  `input(id, data)` / `resize(id, size)` / `closeTab(id)` / `reconnect(id, size)` /
  `dispose()`。
- 纯函数（同一文件，供菜单与单测）：`canOpenRemoteTerminal(ref)`（`endpoint` 非空且
  `auth.kind === 'sshPassword'`）、`terminalFontSizePx(pref)`（medium 14 / large 16 /
  xlarge 18——字号映射唯一出处）。
- IPC 载荷全必选；`sender` → 窗口状态按 `BrowserWindow.fromWebContents` 解析，
  跨窗口的消息不串（每窗口一个 group）。

### 复用与接线

- **连接复用**（spec FR-006）：`sidebarFilesRemote.ts` 的 `clientFor` 导出为
  `sharedClientFor(endpoint, log)`；终端窗口创建时 `retainRemoteFilesClient(endpoint)`、
  关闭时 `releaseRemoteFilesClient(endpoint)`（租约语义不变：工作区 + 终端窗口归零才断）。
  主机密钥 TOFU 与指纹变更告警由 `SshClient` 既有逻辑承担（终端窗口在 `connect` 抛
  `SshHostKeyError` 时走既有 `confirmHostKeyChange` 流程，确认后重试）。
- **菜单入口**（spec FR-001）：`buildMenuSections()` 增 `main.openRemoteTerminal`
  （`CmdOrCtrl+Alt+T`），`enabled` 由 `canOpenRemoteTerminal(activeWorkspaceRef)` 在构建
  时算出——菜单已在工作区增删 / 切换时重建（`setupMenu()` 的既有调用点），无需新刷新
  机制；自绘与原生菜单同源。
- **生命周期挂点**（spec FR-008）：`closeWorkspace()` 关掉该 `refKey` 的终端窗口（先关
  shell 通道再 release 租约）；`before-quit` 关全部终端窗口（在 `disposeAllRemoteFilesClients`
  之前）。同一工作区重复触发入口 → `focus()` 既有窗口（spec FR-002）。

### 渲染端（electron/terminal/）

`index.html` + `main.ts`（标签条 / 断开态面板 / xterm 装载）+ `xtermThemes.ts`
（demo 的 THEMES 两套 ANSI 配色）+ `labels.ts`（zh / en，形态对齐
`electron/remoteWorkspace/labels.ts`）。preload 为 `electron/terminalPreload.ts`，
经 `contextBridge` 暴露 `window.terminalAPI`（方法与事件两类，回调式，与
remoteWorkspacePreload 同风格）。剪贴板：xterm `attachCustomKeyEventHandler`——
Win / Linux `Ctrl+Shift+C` / `Ctrl+Shift+V`，macOS `Cmd+C` / `Cmd+V`（有选区才拦），
走 `navigator.clipboard`（spec FR-005）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/standalone/sshClient.ts` | 修改：新增 `openShell({ cols, rows })` | `SshClient` 新方法（host 内部，不入总线契约） |
| `electron/sidebarFilesRemote.ts` | 修改：导出 `sharedClientFor`（原 `clientFor`） | 无新成员；租约函数签名不变 |
| `electron/terminalShells.ts` | 新增：状态机 + 纯函数 | 无总线 / UIHost 契约变化 |
| `electron/terminalWindow.ts` | 新增：窗口与 IPC 注册 | `terminal:*` IPC 面（Electron 专属，remote-workspace 先例） |
| `electron/terminalPreload.ts` | 新增：`window.terminalAPI` | 同上 |
| `electron/terminal/`（index.html / main.ts / xtermThemes.ts / labels.ts） | 新增：渲染端 | 无 |
| `electron/main.ts` | 修改：菜单条目 + 生命周期挂点 + 窗口创建调用 | 菜单定义增 `main.openRemoteTerminal` |
| `src/config/project.json` + `project.config.cjs` | 修改：`terminalOut` / `electronTerminalPreloadOut` | 构建配置 |
| `electron/esbuild.js` | 修改：terminalPreload 打包条目 | 构建配置 |
| `vite.terminal.config.ts` | 新增 | 构建配置 |
| `package.json` | 修改：`build:terminal` / `watch:terminal`，并入 `build:webview` 与 `watch`；依赖已在（demo 阶段安装的 `@xterm/xterm` + `@xterm/addon-fit`） | npm 脚本 |
| `e2e/playwright.config.ts` | 修改：新增 `terminal-ui` 项目 | e2e 配置 |
| `src/test/terminalShells.test.ts` | 新增：状态机 / 可用性 / 字号映射单测（假通道） | — |
| `e2e/terminal/terminalUi.spec.ts` | 新增：静态伺服 + 假 `terminalAPI` 驱动真实页面 | — |
| `docs/hosts/electron-multi-workspace.md`、`docs/hosts/host-matrix.md`、`docs/features/user-stories.md`、`docs/features/user-stories/desktop.md` | 修改：按 spec「影响基线」逐处同步 | 文档 |

不涉及：`core-rs/`、`src/shared/`（总线契约 / 落盘格式零变化）、`src/webview/`、
`src/host/UIHost.ts` / `UiEvent` / `CoreEvent` / `CoreRequest`。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`sshClient.ts` 在 host 层、不 import electron /
      vscode；新增 UI 全部落 `electron/`（宿主实现层），`src/host/` 不新增文件以外的
      耦合；不出现 `host.kind` 嗅探；`src/host/ui/*` 不涉及。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：失败显式呈现（连接 / shell 失败进断开态 + 原因，
      不静默降级）；标签表 owner 唯一（主进程），渲染端纯投影；字号映射单一出处
      （`terminalFontSizePx`）；IPC 载荷全必选，`failure` 用 `null` 不用 `?`。
- [x] Core 行为与落盘格式同步义务：**不涉及**——`core-rs` 零改动，总线契约与
      `src/shared/history/` 落盘格式零改动（终端不经 daemon、不经 Core）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`docs/hosts/electron-multi-workspace.md`
      （[能力清单](../../docs/hosts/electron-multi-workspace.md#1-能力)、[菜单条目表](../../docs/hosts/electron-multi-workspace.md#7-菜单)、新节「[远程终端](../../docs/hosts/electron-multi-workspace.md#14-远程终端)」）、`docs/hosts/host-matrix.md`
      （能力对照行）、`docs/features/user-stories.md` + `desktop.md`（EP-14 /
      US-54 / US-55 / e2e 映射与豁免段）随实现同一提交更新；`npm run test:all -- docs-lint`
      必须绿。

## 被否决的替代方案

1. **主窗口底部停靠面板**——体验评审裁决选独立窗口（本 spec 评审记录）；停靠需要动
   `ChatViewManager` 摆位且与「每工作区一窗口」的生命周期模型相性差。
2. **终端通道走 daemon 控制通道（Core 协议加 shell 帧）**——Core 是会话服务不是通用
   SSH 网关：加 shell 帧会把凭证下发 Core、把 Core 拖进终端转发业务；直连 SSH shell
   通道零 Core 改动、凭证不出宿主进程。
3. **断开自动重连**——重连等于在远端开**新** shell，自动重连会让用户误以为上下文还在；
   v1 手动重连（spec FR-007），断开原因明示。
4. **本地终端共用一套窗口**——需要 node-pty 平台原生模块与打包矩阵（Windows / macOS /
   Linux × x64 / arm64），与远程终端的正交收益不匹配；渲染端设计成通道来源可注入，
   将来接本地 PTY 只换 `openChannel`。
5. **终端流复用对话 webview 消息协议**——高频率字节流与低频消息不共流（架构规则），
   且主窗口渲染器不应承担终端洪泛；独立窗口 + `terminal:*` IPC 面（spec FR-009）。
