---
owner: pzlvv
last_reviewed: 2026-10-20
---

# <product-name> 用户故事（US）

本文档描述 <product-name> 当前实现（as-built）面向用户的能力，以用户故事（User Story）形式
组织，作为场景级 UI 测试（`e2e/`）的需求基线：每条故事附验收标准，可验证的条目在
`e2e/webview/` 与 `e2e/electron/` 的用例中以 `US-xx` 编号引用。

- 架构与事件词汇的权威来源是 `docs/` 下的 as-built 规格（地图见 [docs/README.md](../README.md)）；主题性规格按域分目录（architecture / core / hosts / features）。
- 故事按主题（Epic）分组，编号规则：`US-<序号>`，全文唯一；正文按主题分册收录（见目录），
  本文件是索引，保留附录的 US ↔ e2e 映射与未覆盖豁免段。
- 宿主双形态：VS Code 扩展（单视图）与 Electron 桌面端（多视图）。故事默认两种宿主
  都适用，仅桌面端适用的标注「桌面端」。

## 目录

| 分册 | Epic | 收录 |
| --- | --- | --- |
| [对话与输入](user-stories/dialog-core.md) | EP-1 对话核心、EP-2 输入区与会话配置、EP-13 会话交互增强 | US-1～11、US-46～49、US-51～52 |
| [消息呈现与确认](user-stories/messages.md) | EP-3 消息呈现、EP-4 权限与用户确认、EP-11 通知与国际化 | US-12～18、US-40～41 |
| [会话管理与 LLM 配置](user-stories/sessions-and-llm.md) | EP-5 会话管理、EP-6 LLM 配置 | US-19～26 |
| [工具与技能](user-stories/tools.md) | EP-7 工具与技能、US-50 联网搜索（客户端工具） | US-27～29、US-45、US-50 |
| [桌面端](user-stories/desktop.md) | EP-8 桌面端窗口与标题栏、EP-9 多工作区、EP-10 预览与 Spin、EP-12 侧栏文件浏览器、EP-14 远程终端（桌面端） | US-30～39、US-42～44、US-53～57、US-61～65 |
| 附录：US | [与 e2e 场景用例映射](#附录us-与-e2e-场景用例映射) | — |

---

## 附录：US 与 e2e 场景用例映射

| 用例 | 覆盖的 US | 层级 |
| --- | --- | --- |
| `e2e/webview/conversation.spec.ts` | US-1、US-2、US-3、US-4、US-12、US-52（黄灯悬停明细浮层） | webview UI |
| `e2e/webview/permission.spec.ts` | US-18 | webview UI |
| `e2e/webview/sessions.spec.ts` | US-19、US-20、US-21、US-22 | webview UI |
| `e2e/webview/settings.spec.ts` | US-7、US-23、US-24、US-25、US-26、US-50（复选框不置灰） | webview UI |
| `e2e/webview/inputMenu.spec.ts` | US-5、US-8、US-9、US-29 | webview UI |
| `e2e/webview/inputExtras.spec.ts` | US-1、US-6、US-10、US-11 | webview UI |
| `e2e/webview/messagePresentation.spec.ts` | US-13、US-16、US-17、US-50（工具卡片） | webview UI |
| `e2e/webview/notifications.spec.ts` | US-40 | webview UI |
| `e2e/webview/language.spec.ts` | US-24、US-41 | webview UI |
| `e2e/webview/titlebar.spec.ts` | US-36（标题栏渲染层快照时序） | webview UI |
| `e2e/webview/bashBackgroundButton.spec.ts` | US-45 | webview UI |
| `e2e/webview/sendModes.spec.ts` | US-46 | webview UI |
| `e2e/webview/jumpToBottom.spec.ts` | US-47 | webview UI |
| `e2e/webview/bashOutputCollapse.spec.ts` | US-14（Bash 输出折叠） | webview UI |
| `e2e/electron/assistant.spec.ts` | US-1、US-2、US-14、US-15、US-18、US-28 | Electron 整应用 |
| `e2e/electron/smartNaming.spec.ts` | US-21 | Electron 整应用 |
| `e2e/electron/sessions.spec.ts` | US-19、US-20、US-21、US-22 | Electron 整应用 |
| `e2e/electron/workspace.spec.ts` | US-30、US-35、US-36、US-53（标签页快捷键切换与环绕） | Electron 整应用 |
| `e2e/electron/remoteWorkspace.spec.ts` | US-36（SSH 连接表单与历史） | Electron 整应用 |
| `e2e/electron/remoteSshExecution.spec.ts` | US-37、US-42（远端文件浏览：树读取 / 刷新 / 永久删除）、US-54（打开终端 / 标题含工作区路径 / shell 退出关窗）、US-62（远端条目修改时间）、US-63（远端文档视图：git 口径 / 行数 / 远端哨兵自动刷新） | Electron 整应用 |
| `e2e/remoteWorkspace/picker.spec.ts` | US-36（远端目录选择器：路径框编辑 / 选中项 / Tab 补全 / 焦点常驻） | 远端目录选择器页面 |
| `e2e/electron/fileExplorer.spec.ts` | US-42、US-43、US-44、US-61、US-62、US-63 | Electron 整应用 |
| `e2e/electron/desktopShell.spec.ts` | US-27、US-31、US-32、US-33、US-34、US-37、US-39、US-53（录制改键与菜单展示） | Electron 整应用 |
| `e2e/electron/preview.spec.ts` | US-14、US-38（文件 Monaco 预览） | Electron 整应用 |
| `e2e/electron/backgroundBash.spec.ts` | US-45 | Electron 整应用 |
| `e2e/electron/subagentConcurrency.spec.ts` | US-49 | Electron 整应用 |
| `e2e/electron/subagentExplorer.spec.ts` | US-51（工具四件套 / 执行侧拒绝 / 视图置灰） | Electron 整应用 |
| `e2e/electron/crossWorkspaceAgent.spec.ts` | US-56（跨工作区派发 / 占位对话 / 跳转 / 中止） | Electron 整应用 |
| `e2e/electron/crossWorkspaceTransfer.spec.ts` | US-60（本地↔本地递归传输 / 守卫零写入） | Electron 整应用 |
| `e2e/webview/workspaceMention.spec.ts` | US-57（`@` 候选 / 插入 / 排除本工作区） | webview UI |
| `e2e/webview/todoProgress.spec.ts` | US-59（进度按钮 / 悬停 100ms / 固定与取消 / 恢复 / 压缩不丢） | webview UI |
| `e2e/webview/subagentOptionsLock.spec.ts` | US-51（role 事实到达后的选项置灰） | webview UI |
| `e2e/terminal/terminalUi.spec.ts` | US-54（首标签自动建立的页面侧）、US-55（标签新建 / 切换 / 关闭、断开态覆盖层与重连、主题跟随、复制粘贴） | terminal 页面 |
| `e2e/webview/userChoicePaging.spec.ts` | US-58（分页进度 / 单选翻页 / 多选与其他并存 / Enter 语义 / answers 载荷） | webview UI |
| `e2e/webview/spinModeInput.spec.ts` | US-39（spin 输入禁用的渲染层：禁用 + placeholder + 停止按钮转黄 + 单向不退出） | webview UI |
| `e2e/electron/tabContextMenu.spec.ts` | US-48（菜单条目与顺序 / 置灰终态 / 关闭动作 / 他区忙碌汇总确认） | Electron 整应用 |
| `e2e/electron/remoteTaskSurvival.spec.ts` | US-64（三选对话框 / 后台运行存活的远端 Core / 立即关闭终止 / 退出确认链取消中止）、US-65（认领原 Core / 孤儿期间内容可见 / 任务继续完成 / 离场完成后重开绿灯） | Electron 整应用（真实 SSH 远端，`electron-ssh` 车道） |
| `e2e/electron/completionAfterRestart.spec.ts` | US-65（离场完成的未读绿灯：重开按 `unreadCompletions` 补武装 / 打开即阅读清除） | Electron 整应用（本地车道，meta.json 计数预置） |

未覆盖 e2e 的 US（US-33 的托盘图标像素外观与原生右键菜单弹窗——状态点三色、任务结束
闪烁与左键唤出由 `e2e/electron/desktopShell.spec.ts` 桩住 `Tray` 原型断言，颜色聚合口径由
`src/test/trayStatusIcon.test.ts` 锁定，只剩图标渲染与原生菜单外观人工验证；US-38 的远程
查看器自动刷新（验收 6 的远程口径）——需要真实 SSH 远端，本地刷新与窗口名额 / 矩形记忆由
`e2e/electron/preview.spec.ts` 与 `src/test/viewerWindows.test.ts` 锁定；US-39 的真实 spin
执行链——渲染层的禁用 / placeholder / 停止按钮转黄 / 单向不退出由
`e2e/webview/spinModeInput.spec.ts` 覆盖，`meta.json` 的 `workMode` 落盘与恢复、SpinLoop 与
子代理编排（验收 4）由 core-rs `engine_tests` 锁定；US-48 的原生菜单弹窗外观——菜单条目、
置灰终态与点击动作由 `e2e/electron/tabContextMenu.spec.ts` 桩住 `Menu.buildFromTemplate`
断言，只有弹窗渲染人工验证；US-50 的 Core 侧整链（真实 Search / Fetch 调用）——依赖外网与
DeepSeek 账户，由 `core-rs` 单测（参数校验 / 请求构造 / 结果拼装 / 错误映射 / 本地一_shot
假服务器）与 `engine_tests` 的工具注入用例覆盖；US-54 的连接复用、主机密钥变更告警、
断开与重连、关闭工作区联动关窗——打开终端 / 首标签连上远端 shell / 标题含工作区路径 /
shell 退出后窗口关闭由 `e2e/electron/remoteSshExecution.spec.ts` 覆盖，其余需真实 SSH
服务器（通道已打通，尚未补用例），断开语义的状态机由 `src/test/terminalShells.test.ts`
（假通道）锁定；US-63 的远端 git 哨兵——远端
git 口径（变更集 / 行数 / 未跟踪文档）与 commit 后的自动刷新由
`e2e/electron/remoteSshExecution.spec.ts` 覆盖，本地 git 行数口径由
`src/test/sidebarDocViewGit.test.ts`（临时真实 git 仓）与 `src/test/sidebarDocWatch.test.ts`
锁定；US-64 / US-65 的退出逐区三选混合决策（多远程工作区各选各的）、孤儿期间挂起
请求的重弹与 1 小时超时不再重弹、daemon 空闲判定的宽限口径——`remoteTaskSurvival.spec.ts`
覆盖对话框与主链路，其余场景依赖真实远端的多实例与长等待，由 `core-rs` 的 `daemon_tests`
（孤儿化 / 认领 / 空闲判定 / 并发认领）与 `src/test/remoteCoreDaemon.test.ts` 锁定；
US-66 的双实例争用——双实例场景依赖两个宿主进程（electron 车道单应用启动），e2e 豁免，
锁语义由 core-rs `session_lock_tests`（双进程争用、崩溃接管、并发接管至多一胜、同 Core
重入、未知版本拒外、宿主离场不释放、变更守卫）锁定，占用文案键由 `core_text_tests`
对照 `core-rs/fixtures/coreTextKeys.json` 锁定；US-67 的 detach 闸门与授权——构造判据、
闸门文案与权限分级由 core-rs 单测（`tools_tests` / `permission_tests` 的 detach 用例）
锁定，确认弹窗复用既有权限确认组件（US-18 的 e2e 已覆盖渲染与提交链路），不新增
e2e 用例）。

运行方式与前置构建见 `e2e/README.md`。
