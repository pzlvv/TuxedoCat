# 任务分解：Electron 远程终端（SSH shell）

按依赖排序：SSH 通道 → 状态机 → 窗口与挂点 → 入口 → 渲染端与构建链 → e2e → 文档同步
→ 全量闸门。每步完成即勾选并跑该步判据；指向 [spec.md](spec.md) 与 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-004）：`src/host/standalone/sshClient.ts` 新增 `openShell({ cols, rows })`——ssh2 `client.shell`（PTY，`term: 'xterm-256color'`），返回原始 `ClientChannel`，不设 encoding（字节流直通）；依赖：—；完成判据：`npm run check-types` 绿，`npm run test:all -- ssh-transport` 既有用例不红。
- [x] **T002**（FR-006）：`electron/sidebarFilesRemote.ts` 导出 `sharedClientFor(endpoint, log)`（现 `clientFor` 改名导出，语义不变，模块注释补「终端共用此池」）；依赖：—；完成判据：`npm run check-types && npm run lint` 绿。
- [x] **T003**（FR-003、FR-004、FR-007）：新增 `electron/terminalShells.ts`——`TerminalChannel` 窄接口、`TerminalSessionGroup` 状态机（建标签 / 输入背压 / resize / `exit` 自动关标签 / 无 `exit` 的 `close` 转断开态 + 原因 / `reconnect` / `dispose`）、纯函数 `canOpenRemoteTerminal` 与 `terminalFontSizePx`；新增 `src/test/terminalShells.test.ts` 用假通道逐项锁定；依赖：—；完成判据：`npm run test:all -- terminal-shells` 全绿。
- [x] **T004**（FR-002、FR-006、FR-008）：新增 `electron/terminalWindow.ts` + `electron/terminalPreload.ts`——按 `refKey` 的窗口单例（重复触发 `focus()`）、`terminal:*` IPC 注册（init / new-tab / input / resize / close-tab / reconnect / close-window 与 tabs / output / theme 三条下行）、租约 retain/release、ssh2 `ClientChannel → TerminalChannel` 适配器（绑定 `exit` / `close` 事件）、`SshHostKeyError` 走既有 `confirmHostKeyChange`；`electron/main.ts` 挂点：`closeWorkspace` 关对应终端窗口、`before-quit` 关全部（先于 `disposeAllRemoteFilesClients`）；依赖：T001、T002、T003；完成判据：`npm run compile` 绿。
- [x] **T005**（FR-001）：`electron/main.ts` 的 `buildMenuSections()` 增 `main.openRemoteTerminal`（`CmdOrCtrl+Alt+T`），`enabled: canOpenRemoteTerminal(活动工作区)`，点击打开活动工作区的终端窗口；依赖：T004；完成判据：`npm run compile` 绿；可用性口径由 T003 的 `canOpenRemoteTerminal` 单测锁定。
- [x] **T006**（FR-004、FR-005、FR-009）：新增渲染端 `electron/terminal/`（index.html / main.ts / xtermThemes.ts / labels.ts，样式按 `demo.html`：状态点、active accent 下划线、断开态面板）+ 构建链（`src/config/project.json` 两 outDir、`project.config.cjs` 暴露、`electron/esbuild.js` preload 条目、`vite.terminal.config.ts`、`package.json` 的 `build:terminal` / `watch:terminal` 并入 `build:webview` 与 `watch`）；剪贴板快捷键（Win/Linux `Ctrl+Shift+C/V`，macOS `Cmd+C/V` 有选区才拦）；依赖：T004；完成判据：`npm run build:terminal` 产出 `dist/terminal/index.html`，`npm run compile` 绿。
- [x] **T007**（FR-005、FR-009）：`e2e/playwright.config.ts` 增 `terminal-ui` 项目 + `e2e/terminal/terminalUi.spec.ts`——静态伺服 `dist/terminal/` + 假 `window.terminalAPI`（手法对齐 `e2e/remoteWorkspace/picker.spec.ts`）：标签增删与切换、断开态面板与重连按钮、主题跟随、复制 / 粘贴快捷键、键入路由到 input；依赖：T006；完成判据：`npm run test:e2e -- --project=terminal-ui` 全绿。
- [x] **T008**（文档同步）：按 spec「影响基线」同步——`docs/hosts/electron-multi-workspace.md`（[1. 能力](../../docs/hosts/electron-multi-workspace.md#1-能力) + [7. 菜单](../../docs/hosts/electron-multi-workspace.md#7-菜单) + 新节「[14. 远程终端](../../docs/hosts/electron-multi-workspace.md#14-远程终端)」）、`docs/hosts/host-matrix.md`（能力对照行）、`docs/features/user-stories.md`（EP-14 目录行 + e2e 映射 + 豁免段：真实 SSH 通路按 US-42 口径、多窗口生命周期按 US-38 口径）与 `docs/features/user-stories/desktop.md`（US-54 / US-55）；依赖：T007；完成判据：`npm run test:all -- docs-lint` 绿。
- [x] **T009**（收尾）：全量闸门——`npm run check-types && npm run lint`、`npm run test:all`、`npm run test:e2e`（webview / electron / remote-workspace-ui / terminal-ui 四项目不回归）；真机 SSH 手工验证清单（连接复用不重复鉴权、主机密钥变更告警、断开与重连、工作区关闭联动）按豁免口径执行并留痕；提交 `Flow: L3` + `Spec: 022`；依赖：T008；完成判据：各命令退出码 0，手工清单记录进本文件下方。

## 验证留痕

- `npm run check-types` / `npm run lint`：绿（2026-10-23）。
- `npm run build:core:host` 后 `npm run test:all`：68 通过 / 0 失败（standalone 系列驱动真实 Core 二进制，含 docs-lint 与 terminalShells 27 条断言）。
- `npm run test:e2e`（五项目全跑）：170 通过、退出码 0；webview conversation 等个别用例在整跑负载下 flaky，隔离重跑 6/6 绿（非回归）；tui-installer 部分「did not run」为本机未构建 TUI 产物的既有状态。
- **真机 SSH 手工清单（待用户执行，豁免口径的补位验证）**：
  1. 连接复用：侧栏展开过文件树后打开终端，不重复弹主机密钥确认、不要求重输口令；
  2. 主机密钥变更：换远端主机密钥后开终端，出现新旧指纹告警，确认后可连、拒绝停留失败态；
  3. 断开与重连：断开远端网络，全部标签转断开态并显示原因，逐标签「重新连接」可用；
  4. 工作区关闭联动：关工作区标签页，其终端窗口随之关闭；同 endpoint 其它工作区的终端不受影响。
