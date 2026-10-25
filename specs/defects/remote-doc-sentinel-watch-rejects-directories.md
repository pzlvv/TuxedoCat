---
status: 待修
---

# 缺陷：远端文档视图的 git 哨兵监听注册不上（core 的 watch 只接受普通文件）

远程（SSH）工作区的文档视图与本地「同一口径」（US-63 验收 5）：外部 commit / stage /
checkout 后应自动刷新。实际远端两条监听全部注册失败，文档视图只能靠手动刷新——
同一操作本地自动刷新、远端不刷新。

## 现状

- `electron/sidebarDocWatch.ts` 对本地用 `fs.watch` 监听目录，对远端复用 specs/018 的
  `watchWorkspaceFile` 通道，监听的仍是**目录**：`<gitDir>` 与 `<gitDir>/refs/heads`。
- core 的 `FileWatchRegistry`（`core-rs/src/file_watch.rs` 的 `validate_target`）只接受
  **普通文件**：它监听目标文件的父目录、按文件名过滤事件，目标存在但不是普通文件时直接
  报错 `watch target is not a regular file`。于是远端的两个目录监听都在注册期被拒。
- 后果：远端文档视图的自动刷新从未生效；`DocSentinelManager` 按「建立失败记日志、手动
  刷新兜底」的容错口径把失败降级为日志，功能缺口不显性报错。
- 证据（`E2E_DEBUG=1` 的整应用 e2e 主进程日志，远端真实 SSH 环境）：
  - `doc sentinel: remote watch failed (/home/pz/tuxedo-e2e-ssh-<pid>/docrepo/.git): watch target is not a regular file: …/.git`
  - `doc sentinel: remote watch failed (…/.git/refs/heads): watch target is not a regular file: …/refs/heads`
- 复现：`e2e/electron/remoteSshExecution.spec.ts` 的 US-63 用例——远端建仓、制造未提交
  改动、开启文档视图，然后在会话外 `git commit`；文档视图在 60s 内不刷新（断言「变更集
  清空」超时，122 次轮询仍见 `a.md`）。

## 期望

- 远端工作区的文档视图与本地同口径：外部 commit / stage / checkout 后自动重取文档视图
  数据，无需手动刷新。
- 保持「不轮询」：刷新由远端文件监听事件驱动（`workspaceFileChanged` → 哨兵去抖 →
  失效信号），不引入定时探测。
- 本地监听路径与规格 018 的查看器监听语义不变：只监听工作区根内的目标，越界拒绝。
- 监听建立失败仍然是「记日志 + 手动刷新兜底」，不阻断取数。

## 不变量

- `workspaceFileChanged` 的载荷与 watchId 路由（查看器 ↔ 哨兵分流）不变。
- 本地 `fs.watch` 目录监听的行为与去抖（200ms）不变。
- 非 git 工作区不挂监听；文档视图关闭时监听全部摘除。
- 监听目标越界（`..`、符号链接指向根外）仍被拒绝。

## 回归测试

- **RT-1**：远端建仓并制造未提交改动 → 开启文档视图（列出变更 md 与 +N/-M）→ 会话外
  `git commit` → 不点刷新，文档视图自动变为「没有变更的 Markdown 文档」（落点：
  `e2e/electron/remoteSshExecution.spec.ts` 的 US-63 用例，当前断言的是手动刷新兜底路径，
  修复后改为断言自动刷新）。
- **RT-2**：core 侧单测覆盖「目标为目录」的注册与事件上报（落点：`core-rs/src/file_watch_tests.rs`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（远端自动刷新） | `E2E_DEBUG=1 npx playwright test -c e2e/playwright.config.ts --project=electron-app remoteSshExecution -g "US-63"` | 红 | 60s 内文档视图未刷新；主进程日志两条 `watch target is not a regular file` |
| 兜底路径（手动刷新） | 同上 | 绿 | 当前 e2e 断言的就是该兜底路径（修复后改断言自动刷新） |
| core 侧目录监听 | — | not-run | 修复需改 `core-rs` 并重建双平台 Core 产物 |
