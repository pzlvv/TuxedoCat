---
status: 已修
---

# 缺陷：远端批处理 git 命令丢了工作目录，远程变更视图整条失败

侧栏「文档 / 差异」两个变更视图在**远程（SSH）工作区**上取数时，git 批处理命令在
SSH 登录目录（远端 `$HOME`）执行，而不是在工作区。远端工作区不是登录目录时四条命令
全部报 `fatal: not a git repository (or any of the parent directories): .git`，取数
返回 `{ ok: false }`，侧栏显示「读取失败，点击重试」而不是变更清单。本地工作区不走
批处理，因此缺陷只在远程暴露。

## 现状

`electron/main.ts` 的 `remoteGitRunner`（`GitCommandRunner` 的远程实现）有两条 git
出口，工作目录只在其中一条上拼接：

| 出口 | 命令形态 | 工作目录 |
| --- | --- | --- |
| `run`（逐条） | `git -C '<root>' '<args…>'` | 带 |
| `runBatch`（批量，`collectGitEntries` 的唯一入口） | `git '<args…>'` | **丢** |

`buildGitBatchScript`（`electron/sidebarDocView.ts`）只负责把子命令拼成一段 POSIX sh，
它不知道工作区在哪；把 `-C` 拼上去是调用方（`electron/main.ts`）的职责，而
`runBatch` 直接把 `collectGitEntries` 给的裸子命令（`rev-parse` / `diff` / `ls-files`）
交给了它。

后果链：SSH exec 的默认 cwd 是远端登录目录 → 四条命令全部以 128 / 129 退出（
`not a git repository`）→ `collectGitEntries` 按既有错误路径返回
`git ls-files 失败: fatal: not a git repository…` → 侧栏渲染错误行。`probeGitWorkspace`
走的是 `run`（带 `-C`），所以探测结果是 `'yes'`——**界面确实进 git 口径，紧接着整条
失败**，这正是「明明在仓里却说读取失败」的形态。

复现路径：连一台真实 SSH 远端 → 在远端 `$HOME` 之外建 git 仓（如
`~/tuxedo-e2e-ssh-<pid>/docrepo`）→ 打开该仓为工作区 → 侧栏切到「差异」或「文档」→
「读取失败，点击重试」。

## 期望

1. **工作目录只有一处拼接**：`run` 与 `runBatch` 共用同一份 `buildRemoteGitCommand`
   / `buildRemoteGitBatchScript`（`electron/sidebarDocView.ts`），`-C '<root>'` 由这一
   处补上，参数仍逐个单引号转义。
2. **批处理脚本形态不变**：`buildGitBatchScript` 仍只拼接调用方给的参数列表，段标记、
   退出码还原、单条失败不影响其它段的语义都不变。
3. **失败语义不变**：真不在仓里时仍由 `probeGitWorkspace` 判 `'no'` 走记录口径
   （「差异」返回 `not-a-git-workspace` 提示），不因这次修复改成别的判别值。

## 不变量

- 本地工作区取数形态不变（`localGitRunner` 逐条 spawn，`-C` 由 spawn 参数给）。
- 远端 `run` 的命令串形态不变（`git -C '<root>' '<args…>'`）：`gitFileContent.ts`
  与探测都依赖它。
- 批处理输出解析（`parseGitBatchOutput`）与解析 / 组装（`parseNumstat` /
  `parseLsFiles` / `buildDocRows`）不变。
- 不新增总线事件 / 契约成员 / IPC 通道 / 落盘字段。

## 回归测试

- **RT-1**：远端的单条命令与批量命令都以 `git -C '<root>'` 开头，工作目录含空格时
  仍被单引号包住。
  （落点：`src/test/sidebarDocView.test.ts` 的「RT-1 远端单条命令」）
- **RT-2**：批处理脚本里**每条**命令都带同一份 `-C <root>`，子命令顺序与入参一致。
  （落点：`src/test/sidebarDocView.test.ts` 的「RT-2 远端批处理」）
- **RT-3**：真实 SSH 远端上，工作区是远端 `$HOME` 下的 git 仓时，侧栏「差异」与
  「文档」都列出变更行（修复前两侧都是「读取失败」）。
  （落点：`e2e/electron/remoteChangeList.spec.ts` 的
  「RT-1/RT-2 远端 git 仓：差异视图列出变更而非读取失败」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- sidebar-doc-view` | 红 | RT-1 / RT-2 失败：`buildRemoteGitCommand` / `buildRemoteGitBatchScript` 不存在，批处理脚本里只有 `git 'rev-parse' …`、无 `-C`；其余 31 项通过 |
| 诊断（远端实机） | 直接驱动 `buildGitBatchScript` + SSH exec | 红 | 四条命令退出码 `128 / 129 / 128 / 128`，stderr 均为 `fatal: not a git repository (or any of the parent directories): .git`；同一 runner 上 `probeGitWorkspace` 返回 `yes`（它走 `run`，带 `-C`） |
| 端到端（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList` | 红 | 6 失败 / 1 通过；侧栏两个变更视图都是「读取失败，点击重试」 |
| 回归用例（修复后） | `npm run test:unit -- sidebar-doc-view` | 绿 | `sidebarDocView` 34 通过 / 0 失败；`sidebarDocViewGit` 5 通过 / 0 失败 / 1 段跳过（Windows 文件名分支，既有） |
| 远端实机（修复后） | SSH exec 跑同一批命令 | 绿 | 四条命令退出码全 0，`collectGitEntries` 返回 `{ ok: true, mode: 'git', entries: [{ path: 'a.md', plus: 1, minus: 0 }, { path: 'c.md', plus: 1, minus: 0 }] }` |
| e2e 车道（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList` | 绿 | 7 通过 / 0 失败（2.6 分钟） |
| 既有远程文档视图用例 | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteSshExecution -g US-63` | 绿 | 修复前该用例同样停在「读取失败」（1.1 分钟后超时）；修复后 11.8 秒通过 |
