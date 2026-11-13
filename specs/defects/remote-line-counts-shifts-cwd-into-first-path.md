---
status: 已修
---

# 缺陷：远端批量计行把工作区根吃成 `$0`，带未跟踪文件的远程取数整条失败

侧栏「文档 / 差异」在远程（SSH）工作区上取数时，只要这一批里**有未跟踪文件**，
`lineCounts` 的远端实现就以「远端计行失败」告终，两个变更视图整条报错。远端存在
未跟踪的新文件是最常见的情形（新建文档、生成物），因此远程变更清单事实上不可用。

## 现状

`electron/main.ts` 的 `remoteGitRunner` 里，`lineCounts` 用一段 POSIX sh 在远端数行数：

```sh
sh -c '<脚本>' <root> <rel1> <rel2> …
```

`sh -c` 之后的**第一个**参数是脚本的 `$0`（不是 `$1`）。当前把工作区根放在那个位置上，
于是脚本里的参数编号整体前移一位：

| 脚本里写的 | 实际取到的值 |
| --- | --- |
| `cd "$1"` | 第一个相对路径（如 `new.md`） |
| `for rel in "$@"` | 第二个相对路径及其后 |

后果链：`cd "$1"` 试图 `cd` 到一个文件路径 → 失败 → `exit 1` → 远端命令非零退出 →
`lineCounts` 抛 `远端计行失败: …` → `collectGitEntries` 的调用方（`sidebar:files-doc-list`）
走错误路径 → 侧栏显示「读取失败，点击重试」。

复现路径：连一台真实 SSH 远端 → 打开远端一个 git 仓为工作区 → 仓里新建一个**未跟踪**
文件 → 侧栏切到「差异」或「文档」→ 读取失败。同一批若全部是已跟踪改动（没有未跟踪
文件），这次调用根本不发（`pendingLineCounts.length === 0`），缺陷不暴露——这正是它能
躲过既有「US-63 远程文档视图」用例的原因：那条用例的第二段才造未跟踪文件，而首段
只改已跟踪文件。

## 期望

1. **`$0` 显式占位**：命令形态是 `sh -c <脚本> sh <root> <rels…>`，工作区根落在 `$1`。
2. **唯一实现**：脚本正文与 `$0` 占位由 `electron/sidebarDocView.ts` 的
   `buildRemoteLineCountsCommand` 一处给出（与 `buildRemoteGitCommand` /
   `buildRemoteGitBatchScript` 同一层），`electron/main.ts` 只调用它。
3. **计行口径不变**：`grep -a -c ''` 与宿主 `countLines` 同口径（末行无换行不另计、
   空文件 0 行、CRLF 按行），读不到的路径仍按 0 行。

## 不变量

- 未跟踪文件仍按**全文行数**计新增；内容仍不出远端机器。
- 无未跟踪文件时仍不发这次调用（一次往返都不白付）。
- `git` 侧取数（批处理 + `--diff-filter=d` + `--relative`）与解析 / 组装不变。

## 回归测试

- **RT-1**：`buildRemoteLineCountsCommand` 的输出里 `sh -c` 之后的第一个参数是 `$0`
  占位、工作区根是 `$1`，相对路径按单引号转义位置传参（含带 `'` 的路径）。
  （落点：`src/test/sidebarDocView.test.ts` 的「RT-3 远端计行：`sh -c` 的 `$0` 已占位」）
- **RT-2**：真实 SSH 远端上，仓里存在未跟踪文件时，文档视图列出该文件并给出正确的
  `+N`（修复前整条「读取失败」）。
  （落点：`e2e/electron/remoteChangeList.spec.ts` 的
  「RT-3 远端未跟踪文件的行数：N 行 +N、空文件 +0、末行无换行与 countLines 同口径」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 诊断（远端实机） | `sh -c '<现状脚本>' '<root>' 'c.md'` | 红 | 退出码 1，stderr `can't cd to c.md`——工作区根被当成 `$0`、第一个相对路径被当成 `$1` |
| 诊断（远端实机） | `sh -c '<同一脚本>' 'sh' '<root>' 'c.md'` | 绿 | 输出 `2\tc.md`、退出码 0（同一脚本只补 `$0` 占位） |
| 端到端（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList` | 红 | 未跟踪文件的三条用例（RT-3 ×2、RT-7）与 RT-2 都停在「读取失败，点击重试」 |
| 回归用例（修复后） | `npm run test:unit -- sidebar-doc-view` | 绿 | `sidebarDocView` 34 通过 / 0 失败（新增 3 项：远端单条 `-C`、远端批处理 `-C`、远端计行 `$0` 占位）；`sidebarDocViewGit` 5 通过 / 0 失败 / 1 段跳过（Windows 文件名分支，既有） |
| 远端实机（修复后） | `buildRemoteLineCountsCommand` + SSH exec | 绿 | `five.md` → `5`、`empty.md` → `0`、`noeol.md` → `3`（末行无换行不另计），退出码 0 |
| e2e 车道（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteChangeList` | 绿 | 7 通过 / 0 失败（2.6 分钟）：未跟踪文件 `+5` / `+0` / `+3`、12MB 未跟踪文件 `+400000` 且取数 1127ms |
