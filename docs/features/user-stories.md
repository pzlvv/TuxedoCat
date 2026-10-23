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
| [桌面端](user-stories/desktop.md) | EP-8 桌面端窗口与标题栏、EP-9 多工作区、EP-10 预览与 Spin、EP-12 侧栏文件浏览器、EP-14 远程终端（桌面端） | US-30～39、US-42～44、US-53～57 |
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
| `e2e/electron/fileExplorer.spec.ts` | US-42、US-43、US-44 | Electron 整应用 |
| `e2e/electron/desktopShell.spec.ts` | US-27、US-31、US-32、US-33、US-34、US-37、US-39、US-53（录制改键与菜单展示） | Electron 整应用 |
| `e2e/electron/preview.spec.ts` | US-14、US-38（文件 Monaco 预览） | Electron 整应用 |
| `e2e/electron/backgroundBash.spec.ts` | US-45 | Electron 整应用 |
| `e2e/electron/subagentConcurrency.spec.ts` | US-49 | Electron 整应用 |
| `e2e/electron/subagentExplorer.spec.ts` | US-51（工具四件套 / 执行侧拒绝 / 视图置灰） | Electron 整应用 |
| `e2e/electron/crossWorkspaceAgent.spec.ts` | US-56（跨工作区派发 / 占位对话 / 跳转 / 中止） | Electron 整应用 |
| `e2e/webview/workspaceMention.spec.ts` | US-57（`@` 候选 / 插入 / 排除本工作区） | webview UI |
| `e2e/webview/subagentOptionsLock.spec.ts` | US-51（role 事实到达后的选项置灰） | webview UI |
| `e2e/terminal/terminalUi.spec.ts` | US-54（首标签自动建立的页面侧）、US-55（标签新建 / 切换 / 关闭、断开态覆盖层与重连、主题跟随、复制粘贴） | terminal 页面 |

未覆盖 e2e 的 US（US-33 的托盘图标状态点与闪烁提醒——属 OS 集成层，提示音默认值由
`src/test/soundSettings.test.ts` 锁定；US-38 的图片查看器窗口，以及查看器单实例顶替与
窗口位置记忆——Playwright 无法断言多 BrowserWindow 生命周期与屏幕坐标，顶替决策与
矩形校验由 `src/test/viewerWindows.test.ts` 锁定，窗口行为人工验证；US-39 的 spin 输入
禁用——需要真实 spin 执行链，禁用 / placeholder 决策由 `src/test/inputAreaState.test.ts` 与
`src/test/abortButtonState.test.ts` 锁定，落盘与恢复由 core-rs `engine_tests` 锁定；
US-42 的远程（SSH）工作区文件浏览——需要真实 SSH/SFTP 远端；US-43 的「在文件资源管理器中
打开」——会弹出真实资源管理器窗口；US-48 的标签页右键菜单——原生 OS 菜单无法被 Playwright
驱动，「关闭」与「打开命令行」复用既有动作实现，批量关闭的判定（候选＝该工作区已打开的会话
视图含子代理对话 / 空闲可关含当前选中的对话 / 忙碌不动 / 汇总确认）由
`src/test/workspaceBatchClose.test.ts` 锁定，菜单弹出与置灰人工验证）
US-54 的真实 SSH 通路（连接复用 / 主机密钥变更告警 / 断开与重连）——需要真实 SSH 服务器
（US-42 同口径），断开语义的状态机由 `src/test/terminalShells.test.ts`（假通道）锁定；
US-54 的终端窗口 BrowserWindow 生命周期（工作区关闭联动关窗、退出全关）——Playwright 无法
断言多 BrowserWindow 生命周期（US-38 同口径），真机手工验证。
US-50 的 Core 侧整链（真实 Search / Fetch 调用）——依赖外网与 DeepSeek 账户，
由 `core-rs` 单测（参数校验 / 请求构造 / 结果拼装 / 错误映射 / 本地一_shot 假服务器）
与 `engine_tests` 的工具注入用例覆盖。
由 `src/test/` 与 `core-rs` 的既有单测与后续补充覆盖。

运行方式与前置构建见 `e2e/README.md`。
