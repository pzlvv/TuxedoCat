---
status: 已修
---

# 缺陷：终端窗口标题丢失工作区路径

远程终端的独立窗口标题应含 `ssh://user@host` 与工作区路径（US-54 验收 1），实际只剩
`ssh://user@host`：同主机的多个工作区各开一个终端后，任务栏 / 窗口标题无法区分它们。

## 现状

- `electron/terminalWindow.ts` 建窗时把标题设为 `${target}${ref.path}`（`target` 为
  `ssh://user@host`），但终端页面启动时执行 `document.title = target`
  （`electron/terminal/main.ts` 的 `api.init()` 回调），Electron 的 `page-title-updated`
  默认行为随即用页面标题覆盖窗口标题。
- 结果：窗口标题只剩 `ssh://user@host`，工作区路径丢失；页面侧 `document.title` 之后再无
  任何读取方，覆盖窗口标题没有收益。
- 复现：`e2e/electron/remoteSshExecution.spec.ts` 的「US-54 真实 SSH 终端」用例——
  右键远程工作区标签页 →「打开终端」后读主进程 `BrowserWindow.getTitle()`，得到
  `ssh://pz@172.20.56.28`，期望 `ssh://pz@172.20.56.28/home/pz/tuxedo-e2e-ssh-<pid>`。

## 期望

- 终端窗口的窗口标题恒为 `${target}${ref.path}`（`ssh://user@host` + 远端工作区绝对路径），
  页面加载与初始化完成后不被页面 `<title>` 改写。
- 页面侧的 `document.title` 保持现状（`target`），不新增 IPC 字段、不改 preload 契约。
- 其余窗口（Monaco / 图片 / Markdown 查看器）的标题口径不变：它们的页面标题就是验收要求的
  basename。

## 不变量

- 终端页面的渲染、标签、覆盖层文案（`labels.connectingHint` / `disconnectedTitle` 吃
  `target`）不变。
- 窗口标题在「页面未构建」兜底路径下仍是 `${target}${ref.path}（页面未构建：…）`。
- 每个工作区一个终端窗口、重复触发聚焦复用、关工作区联动关窗等生命周期语义不变。

## 回归测试

- **RT-1**：右键远程工作区标签页 →「打开终端」，断言主进程侧该窗口 `getTitle()` 等于
  `ssh://<user>@<host>` + 远端工作区路径（落点：`e2e/electron/remoteSshExecution.spec.ts`
  的「US-54 真实 SSH 终端」用例；同用例另断言首标签自动连上远端 shell（`uname -s` 输出
  Linux）与 `exit` 后窗口关闭）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app remoteSshExecution -g "US-54 真实 SSH 终端"` | 红 | `Expected: "ssh://pz@172.20.56.28/home/pz/tuxedo-e2e-ssh-14652" / Received: "ssh://pz@172.20.56.28"` |
| 回归用例（修复后） | 同上 | 绿 | 用例 4.8s 通过（标题 = `ssh://pz@172.20.56.28` + 远端工作区路径） |
| 既有回归 | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui` | 绿 | 13 条页面层用例全过（标签 / 断开态 / 主题 / 复制粘贴 / 切换快捷键） |
