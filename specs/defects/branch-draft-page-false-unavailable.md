---
status: 已修
---

# 缺陷：分支草稿页一打开就顶着「分支不可用」

在 Electron 侧栏或顶栏点「分支对话」打开草稿页后，顶栏标题前立刻出现警告色的
「分支对话」标记，悬停提示 `分支不可用：the workspace is no longer inside a git repository`。
会话此时完全正常（worktree 已建、分支已建、首条消息能发出去、工具根也正确），只是 UI 在
用户还没发消息的阶段把分支状态判成了不可用。影响面：所有宿主上的分支草稿页（specs/037
AC-16 明确要求草稿页只显示形态标记）。

## 现状

`Core::emit_branch_state`（`core-rs/src/engine.rs`）在会话状态里已有 `branch` 事实时，
用 `history::project_of_session(session_id)` 反查会话工作目录，再 `detect_repo` 拿仓库根，
交给 `check_available` 判可用性。`project_of_session` 只读磁盘上的 `meta.json`；而分支会话
在**发送第一条消息之前**没有 `meta.json`（既有机制：文件由 `appendMessage` 创建），于是
`project_of_session` 返回 `None` → `check_available` 走 `repo_root is None` 分支 →
`BranchView::Unavailable { reason: NotGit, detail: "the workspace is no longer inside a git
repository" }`。宿主把它当异常提示投给 webview，草稿页标题前就出现警告色的「分支对话」。
`Core::check_branch_before_turn` 有同一处取法。

## 期望

1. 分支草稿页（会话已建、`meta.json` 尚未落盘）的分支视图是 `ready`，标题前只有形态图标，
   没有警告色标记与不可用提示。
2. worktree 真被删掉 / 分支真被删掉时仍转 `unavailable` 并说明（AC-14 不变）——修复不得
   把真实的不可用也一并吞掉。

## 不变量

- `meta.json` 的 `branch` 字段仍是分支事实的唯一落盘点，`branchStateChanged` 仍是唯一
  推送出口（[docs/features/branch-conversation.md](../../docs/features/branch-conversation.md) FR-001 / FR-008）。
- 普通会话的分支视图仍是 `plain`。
- 工具根改向（`tool_root_of`）与依赖策略不受影响：本缺陷只改「可用性核对取哪个工作区」。

## 回归测试

- **RT-1**：会话状态里有 `project` 与 `branch`、磁盘上没有 `meta.json` 时，
  `Core::emit_branch_state` 推的视图是 `ready` 且带 worktree（落点：`core-rs/src/engine_tests.rs`
  `draft_branch_session_reports_ready_before_meta_exists`）。
- **RT-2**：worktree 目录被删后 `check_available` 仍返回 `unavailable`（既有用例已锁，
  落点：`core-rs/src/branch/worktree_tests.rs` 的 `check_available` 系列，本次不改）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml draft_branch_session` | 红 | 把 `project_of` 临时改回 `project_of_session` 后重跑：`assertion left == right failed, left: Some("unavailable"), right: Some("ready")` |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml draft_branch_session` | 绿 | 1 passed / 0 failed |
| Core 全量 | `npm run test:core` | 绿 | 1121 passed / 0 failed（单测）+ 1 passed（`tests/parent_watchdog.rs`）；分支相关 58 个用例全过 |
| 整应用链路 | `xvfb-run -a npx playwright test -c e2e/playwright.config.ts --project=electron-app branchSidebar` | 绿 | 2 passed：草稿页断言 `title-branch-name` 计数为 0、分支图标可见 |
| 类型与风格 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 均无错误 |
