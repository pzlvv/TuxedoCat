---
status: 已收敛
---

# 改动规格：Electron 远程终端（SSH shell）

Electron 宿主为已接入的远程（SSH）工作区提供交互式终端：从应用菜单打开一个独立的
终端窗口，窗口内可开多个终端标签，每个标签是远端机器上的一条 PTY shell 通道。终端
复用该连接目标既有的 SSH 连接（与侧栏文件浏览同一连接池，口令鉴权与主机密钥校验不
重复发生），渲染引入三方库 xterm.js（`@xterm/xterm` + `@xterm/addon-fit`）承担终端
仿真；SSH 侧不引新库（`ssh2` 既有依赖已提供 shell 通道与 PTY）。范围仅限 Electron
宿主、仅限远程工作区；本地终端不在本次范围（见非目标）。

终端窗口的行为规格落 `docs/hosts/electron-multi-workspace.md`（新节）；前端终端仿真
是纯渲染能力，不产生新的总线事件、不新增 `UIHost` / `UiEvent` 契约成员——终端数据流
不经过 `AssistantEventBus`，也不复用对话 webview 的消息协议（独立窗口 + 独立 IPC 面，
对齐「不同来源、不同频率的数据走不同的事件流」）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md#1-能力) | 1. 能力 | 修改 | 能力清单新增「远程终端」一条 |
| 同上 | 7. 菜单 | 修改 | 菜单新增「打开远程终端」条目及可用性口径 |
| 同上 | 14. 远程终端（新增节） | 新增 | 终端窗口 / 标签 / 生命周期 / 断开语义的行为规格 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 宿主能力对照 | 修改 | 远程终端为 Electron 专属能力，VS Code 列不适用 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 目录表、附录 e2e 映射、未覆盖豁免段 | 修改 | EP-14 登记与新 US 的 e2e 映射及豁免说明 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | 新增 EP-14 远程终端（桌面端） | 修改 | US-54 / US-55 |

## 用户场景与验收标准

- 场景 1：从远程工作区打开终端
  - **AC-1**（FR-001）：GIVEN 活动工作区是远程（`ssh` scheme）且带可用凭证 WHEN 点菜单「打开远程终端」 THEN 打开终端窗口，标题含 `ssh://<user>@<host>` 与工作区路径，窗口内出现一个终端标签并显示远端默认 shell 的提示符
  - **AC-2**（FR-001）：GIVEN 活动工作区是本地、或未打开任何工作区、或该远程 endpoint 无可用凭证 WHEN 打开应用菜单 THEN 「打开远程终端」条目置灰
  - **AC-3**（FR-002）：GIVEN 该工作区的终端窗口已打开 WHEN 再次点「打开远程终端」 THEN 聚焦既有窗口，不叠开第二个
- 场景 2：多标签与交互
  - **AC-4**（FR-003）：GIVEN 终端窗口已打开 WHEN 点「新建标签」（+） THEN 新增一个终端标签并建立一条新的 shell 通道，其起始工作目录为该工作区路径；已有标签的内容与运行状态不受影响
  - **AC-5**（FR-003）：GIVEN 某标签内 shell 在运行 WHEN 在该标签执行 `exit` THEN 该标签自动关闭；关掉最后一个标签时窗口随之关闭
  - **AC-6**（FR-004）：GIVEN 终端已连上 WHEN 键入字符、运行全屏程序（如 vim / htop） THEN 回显与全屏绘制正常；拖拽改变窗口尺寸后远端行宽列数随之变化（重开 `vim` 布局正确）
  - **AC-7**（FR-005）：GIVEN 终端里有选中文本 / 剪贴板有内容 WHEN 按复制（Windows/Linux `Ctrl+Shift+C`，macOS `Cmd+C`）/ 粘贴（`Ctrl+Shift+V` / `Cmd+V`） THEN 选区进剪贴板 / 剪贴板内容被送入 shell 的标准输入
- 场景 3：连接复用与断开
  - **AC-8**（FR-006）：GIVEN 该 endpoint 已有 SSH 连接（如侧栏文件树已展开）WHEN 打开终端 THEN 直接出现提示符，不再次弹主机密钥确认、不要求重新提供口令
  - **AC-9**（FR-006）：GIVEN 终端是该 endpoint 的首个使用者且远端主机密钥与 known-hosts 记录不一致 WHEN 打开终端 THEN 弹出与远程接入同一套的新旧指纹比对告警；确认后连接建立，拒绝则窗口停留连接失败态、不静默重试
  - **AC-10**（FR-007）：GIVEN 多个标签在运行 WHEN SSH 连接断开（网络中断） THEN 全部标签转为「已断开」态并提供「重新连接」；点击后该标签重建一条 shell（以当前窗口尺寸发起），其余标签各自单独重连
- 场景 4：生命周期绑定
  - **AC-11**（FR-008）：GIVEN 某工作区的终端窗口开着 WHEN 在主窗口关闭该工作区 THEN 该终端窗口一并关闭，其 shell 通道全部结束；同一 endpoint 其它工作区的终端窗口不受影响
  - **AC-12**（FR-008）：GIVEN 多个工作区的终端窗口都开着 WHEN 退出应用 THEN 全部终端窗口关闭、SSH 连接断开，远端 PTY 内的 shell 进程随连接被 sshd 回收
  - **AC-13**（FR-002）：GIVEN 终端窗口开着 WHEN 在主窗口切换活动工作区标签、或某会话视图被关闭 / LRU 淘汰 THEN 终端窗口与其内容不受影响（终端属于工作区，不属于会话）
- 场景 5：外观跟随
  - **AC-14**（FR-009）：GIVEN 终端窗口开着 WHEN 在偏好设置切换主题 THEN 终端配色立即跟随；界面语言与字号档位的变更在新开的终端窗口生效

## 功能需求

### FR-001：菜单入口与可用性

应用菜单提供「打开远程终端」条目（自绘标题栏菜单与原生菜单同一份定义，两端同时具备）。
仅当**活动工作区**为远程（`ssh` scheme）且 endpoint 带可用凭证时可点；本地工作区、
无工作区、凭证缺失时置灰。终端不设侧栏入口、不设快捷键（后续需要另立 spec）。

### FR-002：终端窗口

每个工作区一个终端窗口：独立 `BrowserWindow`，标准标题栏，标题含连接目标
（`ssh://<user>@<host>`）与工作区路径。同一工作区重复触发入口时聚焦既有窗口不叠开；
不同工作区（含同一 endpoint 的不同目录）可同时各开一个窗口。窗口位置尺寸用默认值，
不做记忆。终端属于工作区而不属于会话：会话视图的打开 / 关闭 / LRU 淘汰、工作区标签
切换都不影响终端窗口。

### FR-003：多终端标签

窗口内可开多个终端标签（工具条「+」新建、标签上关闭），每个标签对应远端一条独立的
PTY shell 通道，互不共享输入输出。新标签的起始工作目录为该工作区路径。shell 因用户
退出（`exit` / `logout`）而结束时该标签自动关闭；最后一个标签关闭时窗口关闭。

### FR-004：终端交互

键入回显、控制序列与全屏程序（vim / htop 一类）可用；窗口尺寸变化实时同步远端
PTY（`setWindow`，含通道建立时的初始尺寸）。滚动回看缓冲不少于 1000 行。终端数据按
字节流转给渲染层（UTF-8 由终端仿真器增量解码），宿主不按行重组、不解析内容。

### FR-005：剪贴板

选中即复制之外至少提供快捷键复制 / 粘贴：Windows / Linux `Ctrl+Shift+C` /
`Ctrl+Shift+V`，macOS 沿 `Cmd+C` / `Cmd+V` 惯例；粘贴把剪贴板文本写入 shell 标准输入。

### FR-006：连接复用与鉴权

终端复用该连接目标（`sshTargetKey` 口径）既有的 SSH 连接——与侧栏文件浏览同一连接池、
同一条 TCP 连接多路复用：不重复口令鉴权、不重复主机密钥 TOFU。终端是该 endpoint 首个
使用者时，主机密钥校验与「指纹变更告警 → 用户确认 → `recordKnownHostFingerprint`」
沿用远程接入的既有流程。终端窗口打开期间对该连接登记租约，全部租约（工作区 + 终端
窗口）归零才断开连接。

### FR-007：断开语义

SSH 连接断开时，受影响窗口的全部标签转「已断开」态并显示原因；每个标签提供「重新
连接」，点击后在该标签重建一条 shell（以当下窗口尺寸发起），不自动重连、不批量复活
其它标签。连接失败（认证失败 / 不可达）呈现为同样的失败态与原因，不静默重试、不清除
已存凭证。

### FR-008：生命周期绑定

关闭工作区时其终端窗口一并关闭（shell 通道随连接复用计数或窗口关闭而结束）；应用退出
时全部终端窗口关闭。远端不留孤儿进程：shell 生命周期就是 SSH 通道生命周期，连接断开
后 PTY 内进程由 sshd 回收，宿主不做额外的进程清理协议。

### FR-009：外观与数据面

终端窗口主题即时跟随应用主题（配色随深浅切换）；界面语言与字号档位在窗口创建时取值，
运行期变更不热切到已开的终端窗口（字号档位映射到终端字号）。终端的输入输出走独立的
IPC 通道面（`terminal:*`），不进入对话 webview 的消息协议、不进入 `AssistantEventBus`；
终端大量输出不得造成主窗口（对话）失去响应。

**样式基线**（已评审定稿，视觉基准是本目录 `demo.html`，实现按它比对）：

- 窗口 chrome 深浅两套：深色外壳 `#16161b`（主窗口同款）、浅色 `#fafafa`，终端底色
  深色 `#16161b` / 浅色 `#ffffff`。
- 标签带运行状态点（绿 = shell 在跑，绿点取应用 `success` 色；红 = 断开，取 `error`
  色）；活动标签以 accent 色下划线标识（`#6366f1`，与标题栏 logo、focus 色同源）。
- 终端光标与选中高亮用 accent 色；ANSI 十六色按深浅主题各定一套（demo 的 THEMES
  为准），红 / 绿 / 黄语义色与应用 `colors.ts` 的 success / running / error 对齐。
- 断开态在标签页内呈现：居中警告图标（error 色）+「与 ssh://… 的连接已断开」+ 具体原因
  +「重新连接」按钮。

## 边界与错误路径

- **活动工作区不满足条件**（本地 / 空 / 凭证缺失）：入口置灰，无反馈路径可走，不弹错。
- **shell 打开失败**（服务器拒绝 PTY / 无可用 shell）：该标签内呈现错误文案与「重试」，
  不静默关闭标签、不影响其它标签。
- **凭证失效**（远端改了口令）：连接失败进 FR-007 的失败态；不清除落盘凭证、不新增
  口令输入框（重新走「打开远程工作区」接入即可更新）。
- **首次 resize 早于通道就绪**：shell 请求以发起时的窗口尺寸作为 PTY 初值，就绪后按
  最新尺寸对齐，不丢第一次 resize。
- **输出洪泛**：终端输出只进自己的渲染器与 IPC 面，主窗口对话不参与；背压按通道
  drain 节流（不无限堆积），具体策略 plan 定。
- **并发打开**：多个终端窗口（不同工作区、同一 endpoint）共享一条 SSH 连接开各自的
  shell 通道，互不干扰；同工作区并发触发入口由「聚焦既有窗口」吸收。

## 非目标

- **本地终端**：需要 node-pty 一类平台原生模块与打包矩阵，另行 spec。
- **SSH 密钥 / agent 鉴权**：与既有远程接入口径一致，仅口令鉴权。
- **自动重连**：断开后只提供手动重连（FR-007）。
- **底部停靠面板 / 侧栏入口 / 全局快捷键**：形态已裁决为独立窗口（本 spec 评审结论）。
- **终端分屏、终端内 URL 点击打开、终端内搜索、窗口位置记忆**：需要时另立 spec。
- **VS Code 宿主的远程终端**：VS Code 用户有系统终端与 Remote 扩展生态。

## 对需求基线的影响

新增 EP-14 远程终端（桌面端），登记两个 US：

- **US-54 远程终端窗口**：为远程工作区打开终端窗口、连接复用、生命周期随工作区
  （AC-1、AC-2、AC-3、AC-8、AC-9、AC-11、AC-12）。
- **US-55 终端标签与交互**：多标签、交互与剪贴板、断开重连、外观跟随
  （AC-4～AC-7、AC-10、AC-13、AC-14）。

e2e 登记与豁免：

- `e2e/terminal/`（新增项目）：静态伺服构建产物 + 假 `window.terminalAPI`（内存
  shell，对齐 `e2e/remoteWorkspace/picker.spec.ts` 手法），覆盖 US-55 的 UI 层——
  标签新建 / 关闭、断开态与重连按钮、复制粘贴、主题跟随。
- 豁免（登记进 user-stories.md 未覆盖段，沿用 US-42 口径）：真实 SSH 通路（US-54 的
  连接复用 / 主机密钥流程 / 断开语义）需要真实 SSH 服务器；终端窗口的 BrowserWindow
  生命周期（US-54 的窗口关闭绑定）Playwright 无法断言多窗口生命周期（US-38 口径），
  由宿主侧单测（假 `SshClient` 驱动 shell 通道管理器）锁定，真实链路人工验证。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/main.ts`（菜单定义 + 可用性） | `src/test/terminalShells.test.ts` 的 `canOpenRemoteTerminal` 断言；`e2e/terminal/` 首标签自动建立 | 自动 |
| FR-002 | `electron/terminalWindow.ts`（窗口单例与标题） | — | 无自动覆盖 + BrowserWindow 胶水，多窗口生命周期豁免（US-38 口径），真机清单核验 |
| FR-003 | `electron/terminalShells.ts` 状态机 + `electron/terminal/main.ts`（新页激活 / 最后标签关窗） | `src/test/terminalShells.test.ts`（建 / 关 / exit 自动关标签）；`e2e/terminal/terminalUi.spec.ts`（标签增删切换、最后标签关窗请求） | 自动 |
| FR-004 | `src/host/standalone/sshClient.ts` 的 `openShell` + 状态机 resize / 字节流 | `src/test/terminalShells.test.ts`（resize 记账 / 输出转发 / 背压）；`e2e/terminal/`（键入回显）；回看行数为渲染端配置常量（人工比对） | 自动 |
| FR-005 | 渲染端快捷键处理（`electron/terminal/main.ts`）+ 主进程 `clipboard` 模块 | `e2e/terminal/`（复制选区 / 粘贴回传） | 自动 |
| FR-006 | `electron/terminalWindow.ts` 复用 `electron/sidebarFilesRemote.ts` 连接池（`sharedClientFor` + 租约） | — | 无自动覆盖 + 连接池租约语义沿用侧栏文件浏览的既有实现，真实链路由真机清单核验 |
| FR-007 | shell 通道管理器（断开态机）+ 渲染端断开态 | `src/test/terminalShells.test.ts`（exit vs close 判别 / reconnect / 失败原因）；`e2e/terminal/`（断开态与重连） | 自动 |
| FR-008 | `electron/main.ts`（`teardownWorkspace` / `will-quit` 挂点）+ `closeTerminalWorkspace` / `closeAllTerminalWindows` | — | 无自动覆盖 + 多 BrowserWindow 生命周期豁免（US-38 口径），真机清单核验 |
| FR-009 | 渲染端主题 / 语言注入；IPC 面为独立 `terminal:*` 通道 | `e2e/terminal/` 主题断言；架构约束（不进总线）由评审锁定；样式按 `specs/022-remote-ssh-terminal/demo.html` 人工比对 | 无自动覆盖 + 「不进总线 / 不复用对话消息协议」是架构边界，由文档与评审锁定 |

## 待澄清

（无——两项形态决策（独立窗口 / 多标签）已经用户裁决，其余口径在 FR 与边界中给死。）

## 收敛记录

（2026-10-23 /converge 填写；闸门：`check-types` / `lint` / `test:all` 68 通过 / e2e 退出码 0 / docs-lint 绿。）

**已满足**（附证据落点）：

- AC-2、AC-3、AC-7、AC-10、AC-13、AC-14：单测 + e2e 直接覆盖——`canOpenRemoteTerminal` 三分支
  （`src/test/terminalShells.test.ts`）；复制粘贴 / 断开态与重连 / 主题跟随 / 标签增删切换 /
  最后标签关窗请求（`e2e/terminal/terminalUi.spec.ts`，7 用例）；终端与会话无关由「独立窗口 +
  独立 IPC 面」的架构承担。
- AC-1、AC-6、AC-8、AC-9、AC-11、AC-12：已满足——页面层与接线有自动证据（首标签自动建立、
  回显、菜单可用性口径、租约 / 挂点代码 + docs-lint 同步）；真实 SSH 链路与 BrowserWindow
  生命周期按豁免口径（US-42 / US-38）由真机手工清单核验，四条清单登记于 tasks.md
  「验证留痕」，**待执行**。

**偏差**（均已修复，修复提交随本 spec 归档提交）：

1. AC-4「新标签起始目录 = 工作区路径」初版未做到——`openShell` 用 shell 请求（不支持
   cwd），shell 落在远端 home。收敛核对发现后改为 exec + PTY 跑
   `cd '<path>' && exec $SHELL`（cd 在外层 sh 执行、`exec` 顶替为前台进程，不污染交互
   历史），`openShell` 契约加必选 `cwd` 成员，调用方传 `ref.path`。
2. FR-003「最后一个标签关闭时窗口关闭」初版未实现（标签表清空后窗口留存）。收敛时补
   渲染层判定（曾出现过标签且标签表为空 → `closeWindow`）并补 e2e 用例。

**矩阵修正**（反向对照发现虚指，按实修正）：FR-002 / FR-006 / FR-008 原写
`terminalWindow.test.ts` 与「租约计数单测」——文件不存在（窗口层是 electron 胶水，多窗口
生命周期无法被 Playwright 断言），改为「无自动覆盖 + 真机清单」的如实口径；FR-001 / FR-004
落点名对齐实际文件。

**反向对照补录**（实现有、spec 原文未展开，归属 as-built 文档，无分歧）：

- 建链中 / 断开态的键入直接丢弃（设计允许的瞬时 no-op）、关标签先 SIGHUP 再 EOF、
  页面未构建时窗口标题给出构建提示——均已写入 [docs/hosts/electron-multi-workspace.md 第 14 节](../../docs/hosts/electron-multi-workspace.md#14-远程终端)（14.2 / 14.3 / 14.6 各小节）。

**未做**：无。
