---
status: 已修
---

# 缺陷：远程工作区重连就绪后侧栏文件树停在「读取失败，点击重试」

远程（SSH）工作区首次连接失败时（远端机器没起来、网络没通、sshd 未起），侧栏文件浏览
器的首读同样失败，目录条目落成错误态（「读取失败，点击重试」）。用户在占位页点「重新
连接」、Connection 成功就绪、标签页恢复绿点后，**文件树不会重读**：它一直停在错误行，
直到用户手动点那一行错误提示或点分区条的刷新按钮。用户看到的是「会话连上了，但文件
资源管理器还是连不上」——两句都来自同一次首连超时，后一句是陈旧的错误态。

这与 US-42 验收 4「远程（SSH）工作区同样支持文件浏览」的可用性前提不一致：
[desktop.md US-42](../../docs/features/user-stories/desktop.md#us-42-侧栏文件浏览器)
要求远程工作区与本地同构可浏览，而恢复可用之后没有任何通道让文件树知道「现在可以读了」。

## 现状

复现路径（Electron 宿主，日志证据）：

1. 远端机器当前不可用（本次是 sshd / 机器没起来），打开或恢复一个远程工作区。
2. 探测落定不可用（3 秒），侧栏若展开则首读目录失败，树显示「读取失败，点击重试」。
3. 远端恢复后，在占位页点「重新连接」：标签转黄、约 3 秒后转绿（Connection ready）。
4. 树**仍是**错误行；点该行（或点刷新按钮）才出现条目。

日志（`<configDir>/logs/` 的应用日志）里可见的时间线印证「第二次根本没跑」：

- `13:45:50.638` `[core] fatal: SSH connection to … failed: Timed out while waiting for handshake`
  （首连 20 秒预算耗尽的落定）；
- `13:45:50.720` `[sidebar-files] list failed (…): SSH connection to … failed: Timed out while waiting for handshake`
  （侧栏的**唯一**一条文件操作日志）；
- `13:46:01.791` `connection ready: ssh://…`（重连成功）。

`connection ready` 之后没有任何 `[sidebar-files]` 行——侧栏再没有发起过读目录。

证据链（只读代码定位）：

- **两条独立的 SSH 连接**：Core 传输层自己建一条（`src/host/standalone/sshTransport.ts`
  的 `createSshDaemonOpener` 里 `new SshClient(...)`），侧栏文件池另建一条
  （`electron/sidebarFilesRemote.ts` 的 `sharedClientFor` 里 `new SshClient(...)`）。
  重连修复的只是第一条；第二条在首连失败时已被移出缓存并 `dispose()`
  （`sharedClientFor` 的失败分支：`clients.delete(key)` + `client.dispose()`），此后无人再碰它。
- **就绪信号只喂到查看器，不喂到侧栏文件树**：`electron/main.ts` 的
  `onWorkspaceConnectionState` 在 `state === 'ready'` 分支里做三件事——收绿点、调
  `uiHost?.onWorkspaceConnectionReady(ref)`、非活动目录补对话列表。而
  `electron/ElectronUIHost.ts` 的 `onWorkspaceConnectionReady` 全文只有一句
  `this.viewerWatch?.handleConnectionReady(ref)`（重注册查看器文件监听），不碰侧栏。
- 侧栏文件树的失效推送只有两个来源：Write 新建（`ElectronUIHost.onToolResult`）与
  git 哨兵（`sidebarDocWatch` 的 `onInvalidate`）。连接就绪不在其中。
- **错误态自身不发起重试**：`electron/sidebar/main.ts` 的 `loadDir` 只在非 loaded /
  loading 时读，错误行由 `renderDirRows` 画成「读取失败，点击重试」，重试只由点击
  该行或刷新按钮触发；`setFilesWorkspace` 的补读条件是 `files.expanded && !files.tree.has('')`
  ——错误条目**在** `tree` 里，`has('')` 为真，于是每次广播工作区状态（含重连成功后的
  那次 `push v7`）都被这条判定跳过。

## 期望

- **远程工作区 Connection 就绪时，侧栏文件树对它的缓存失效并重读**：与 Write 新建
  同一口径（`sidebar:files-invalidate` 的 `tree` 原因），根目录与已展开目录重读，
  展开 / 选中 / 滚动位置语义不变；文档视图开启时按同一入口重取数据。
- 失效**只对远程工作区产生**：本地工作区的文件树读的是宿主自己的 fs，与 Connection
  就绪无关，不能被这条链捎带重读。
- 重连成功后树**无需用户交互**即恢复出条目（当前错误行随失效被丢弃）。
- 首次就绪（新打开远程工作区）同样是「就绪即失效」：侧栏尚未读过该工作区时是
  设计允许的 no-op（没有缓存可失效，也不预读）；已读过则按上一条重读。

## 不变量

- 不新增总线事件与契约成员：失效走 Electron 私有 IPC `sidebar:files-invalidate`（既有两个
  reason 之外的用法不改载荷形状）。
- 侧栏文件树的事实来源不变：目录内容仍由主进程读（本地 fs / 远程 SFTP），渲染层不猜值；
  读取失败仍是错误态（不冒充空列表）。
- 「一份事实一个写入点」不变：就绪事实来自 `onWorkspaceConnectionState`，侧栏只消费推送。
- 分区折叠期不预读根目录（US-42 的懒加载口径）不变：失效只丢缓存，读取入口仍是既有
  `refreshWorkspaceFiles` 的那一套。
- 连接状态机（可用 / 不可用 / 建链中）与占位页「重新连接」流程不变。
- 每个工作区一套独立文件树状态（US-42 验收 3）不变：失效只作用于就绪的那一个工作区。

## 回归测试

- **RT-1**：就绪失效的判定是纯函数——远程引用产出 `{ workspaceId: refKey, reasons: ['tree'] }`，
  本地引用产出 `null`（落点：`src/test/connectionReadySidebar.test.ts`「远程工作区就绪产生
  tree 失效载荷」「本地工作区就绪不产生文件树失效」）。
- **RT-2**：接线存在——`ElectronUIHost.onWorkspaceConnectionReady` 调判定并经
  `pushFilesInvalidate` 推送（落点：`src/test/connectionReadySidebar.test.ts`
  「onWorkspaceConnectionReady 调用判定」「onWorkspaceConnectionReady 经 pushFilesInvalidate 推送」）。
  判定写好没人调正是本缺陷的形态，这条用例专门锁它。
- **RT-3**：真实 SSH 端到端——远端工作区断连标红、占位页点「重新连接」转绿后，主进程
  对该工作区推一次 `tree` 失效（不点错误行、不点刷新）（落点：
  `e2e/electron/remoteSshExecution.spec.ts`「US-42 远程重连就绪后侧栏文件树自动重读（不再
  停在读取失败）」）。用可切换的 TCP 代理制造「先连不上、后恢复」；断言点是侧栏页上
  `onFilesInvalidated` 收到的载荷，而不是文件分区的显隐——后者由启动期那次工作区广播
  是否早于侧栏订阅决定，与本缺陷无关。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- connection-ready-sidebar` | 红 | 编译失败：`error TS2307: Cannot find module '../../electron/connectionReadySidebar'`（判定函数尚不存在，RT-1 / RT-2 均无法执行） |
| 回归用例（修复前，只回退接线） | `git stash push electron/ElectronUIHost.ts` 后 `npm run test:unit -- connection-ready-sidebar` | 红 | 编译通过后 3 通过 / 2 失败：`FAIL onWorkspaceConnectionReady 调用判定`、`FAIL onWorkspaceConnectionReady 经 pushFilesInvalidate 推送`——判定存在但没人调，正是本缺陷的形态 |
| 回归用例（修复后） | `npm run test:unit -- connection-ready-sidebar` | 绿 | 5 通过 / 0 失败 |
| RT-3（修复前） | `xvfb-run -a npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g '侧栏文件树自动重读'`（`dist-electron/main.cjs` 不含修复） | 红 | `expect.poll(...).toBeGreaterThan(0)` 超时 120s：`Received: 0`——重连就绪后侧栏一条 `tree` 失效都没收到 |
| RT-3（修复后） | 同修复前命令（重新 `npm run build:electron`） | 绿 | 4.8s 通过；`[诊断] 失效推送记录: [{"workspaceId":"ssh//pz@127.0.0.1:…/home/pz/tuxedo-e2e-ssh-…","reasons":["tree"]}]` |
| 既有回归（electron-ssh 车道全量） | `xvfb-run -a npx playwright test -c e2e/playwright.config.ts --project=electron-ssh` | 部分验证 | 15 通过 / 4 失败：`remoteSshExecution.spec` 的「US-42 远程文件浏览」「US-63 远程文档视图」与 `remoteTaskSurvival.spec` 的 US-65 两条。前两条在**不含本修复**的构建上同样失败（同一命令实测 2 失败），与本次改动无关，是主机上「侧栏文件分区一直 hidden」的既有环境问题（`#filesHeader` 不可见）；US-65 两条依赖远端 daemon 长驻与空闲退出，属环境/时序敏感用例，本次未逐条复跑取证 |
| 既有回归（单测全量） | `npm run test:unit` | 部分验证 | 99 通过 / 3 失败：`brandLiteral`（`exp/branch-conversation-demo.html` 命中品牌字面量）、`docsLint`（`specs/044-layerfs-fs` 的 5 处链接指向不存在的文件）、`docsLintLocalOnlyPaths`——三者均为本机既有的未跟踪文件引起的既有失败，与本缺陷无关（本次只新增 `specs/defects/sidebar-file-tree-stale-after-ssh-reconnect.md` 与 `src/test/connectionReadySidebar.test.ts`） |
| 类型与 lint | `npm run check-types && npm run lint` | 绿 | tsc 三份配置与 eslint 均无输出错误；`npm run check-types:e2e` 另有 12 处 `e2e/pycharm/` 的既有 `implicitly any` 报错（与本改动无关，已单独核对：回退本改动的 e2e 文件后同样 12 处） |
| 手动复现（生产日志） | 读 `<configDir>/logs/tuxedo-cat.log` | 部分验证 | 用户报告的那次事故日志确认了缺陷形态（`list failed` 只有一条、`connection ready` 之后无任何 `[sidebar-files]` 行）；修复后的自动重读由 RT-3 覆盖，未在用户原环境上重演 |
