---
status: 已修
---

# 缺陷：worktree 路径越过 Windows MAX_PATH，分支对话建不出来

分支对话把 worktree 建在 `<Core 数据目录>/conversations/<URI 编码的完整工作区路径>/worktrees/<branch>/`。
其中 `conversations/<...>` 这一层的目录名由**工作区完整路径**经 URI 编码得到，长度随路径线性增长；
再拼两级 `worktrees/<branch>/` 后，worktree 内部还要建 `.git` 文件，很容易越过 Windows 的
260 字符 `MAX_PATH`。越限时 git 建 worktree 直接失败，分支对话无法创建，且各版本 git 报出的
文案不同（`fatal: '$GIT_DIR' too big` / `Filename too long`），从错误信息看不出是路径长度问题。

影响面：Windows 上工作区路径较深（临时目录下的测试、`C:\Users\<长用户名>\Documents\work\...`
一类真实项目）时必现；Linux 因单条路径上限为 4096 字节且路径通常更短，不会暴露。

## 现状

`worktrees_root` 复用会话空间目录（`config::project_conversation_dir`）后再拼 `worktrees`，
于是 worktree 路径深度与工作区路径长度耦合。实测（`GitSandbox` 的临时工作区，路径 86 字符）：

```
git -C .../git-repo worktree add \
  ".../.test-core/conversations/C%3A%5CUsers%5C...%5Cgit-repo/worktrees/yanagi-n31" \
  -b tuxedo/yanagi-n31 HEAD
→ fatal: '$GIT_DIR' too big
```

同一路径手工用 git 复现时（把 `C:\...` 换成等长 Linux 风格前缀）报的是
`fatal: could not create leading directories of '<path>/.git': Filename too long`——两者同一成因。

Windows 上 `cargo test` 的 4 个 worktree 用例因此全红：
`worktree_lives_in_the_core_data_directory` / `reuse_keeps_uncommitted_changes` /
`self_destruction_commands_are_rejected` / `work_summary_counts_commits_and_files`。

## 期望

worktree 路径长度**与工作区路径长度无关**，且始终为 Windows `MAX_PATH` 留出余量。

1. worktree 根与 `conversations/` **平级**：`<Core 数据目录>/worktrees/<工作区短名>/`，
   其中 `<工作区短名>` 是 `w-<sha256 前 12 位>`（固定长度）。
2. 同一工作区的两种分隔符写法（`D:\a\b` 与 `D:/a/b`）解析到**同一个**短名——不能让一份
   数据裂成两份 worktree 根。
3. 依赖 overlay 的 upper 仍在 worktree 之外：`<Core 数据目录>/worktrees/<工作区短名>/deps/<branch>/`。
4. 工作区全路径不丢：仍由 `meta.json` 的 `branch.worktree` 承载（唯一事实源），不在目录名里
   重复编码。

## 不变量

- **可见性边界不动**：worktree 仍不在仓库目录树内，主工作区的 `git status` / IDE 资源管理器 /
  `Grep` / `Glob` / `Bash ls` / 文件监视器都看不到它。
- **成果出口不动**：仍是真实分支 `tuxedo/<name>`，用户在主工作区 `git merge` 取用。
- **`meta.json` 的 `branch` 字段形态不动**（`name` / `worktree` / `baseCommit` / `baseBranch`），
  TS 侧 `ConversationMetadata.branch` 无需改动。
- **既有会话可读**：`branch.worktree` 是绝对路径，旧会话（若已建出）按记录复用，不依赖路径
  推导规则；升级后不因目录布局变化而认不出既有 worktree。
- 清理顺序不动：卸载挂载 → `git worktree remove --force` → `git branch -D` → 删 upper。

## 回归测试

- **RT-1**：worktree 路径与工作区深度无关——深路径与浅路径推出的根目录**分量数相同**，
  且 worktree + `deps/<branch>/node_modules` 的完整长度 ≤ 200 字符（为 `.git` 与
  `MAX_PATH` 留余量）。（落点：`core-rs/src/branch/worktree_tests.rs`
  的 `worktree_path_stays_short_regardless_of_workspace_depth`）
- **RT-2**：同一工作区的 `\` 与 `/` 两种写法落到同一个 worktree 根。（同文件同用例的第二段断言）
- **RT-3**：Windows 上 `create_or_reuse` 能真正建出 worktree（原 4 个用例：
  `worktree_lives_in_the_core_data_directory` / `reuse_keeps_uncommitted_changes` /
  `self_destruction_commands_are_rejected` / `work_summary_counts_commits_and_files`）。
- **RT-4**：启动对账的孤儿路径断言按**路径**比较而非字符串——git 在 Windows 上也用正斜杠
  输出，字符串直接比较会假红。（落点：`reconcile_keeps_valid_worktrees_and_reports_orphans`）
- **RT-5**：单文件本地配置的两种档位各自成立——符号链接档跟随后续原子替换，复制档是快照、
  不跟随（Windows 未启用开发者模式时 `symlink_file` 返回 `ERROR_PRIVILEGE_NOT_HELD`，
  产品按设计退化为复制）。（落点：`ignored_local_config_is_linked`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml branch::worktree::tests` | 红 | 4 个用例 `panicked ... create branch: "Preparing worktree (new branch 'tuxedo/<name>')\nfatal: '$GIT_DIR' too big"` |
| 复现（手工） | `git worktree add <233 字符路径> -b tuxedo/yanagi-n31 HEAD` | 红 | `fatal: could not create leading directories of '<path>/.git': Filename too long` |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml branch::` | 绿 | 54 passed / 0 failed（含 RT-1 ~ RT-5） |
| 既有回归 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 见下方「全量」行；本行在实施时先跑 branch 子集确认无连带 |
| 全量 Rust | `npm run test:core` | 绿 | `1116 passed / 0 failed`（225.43s） |
| 类型与风格 | `npm run check-types && npm run lint` | 绿 | — |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | — |

补充说明（不改变契约）：

- 修复实际落地时**顺带**发现两处测试自身的问题，一并按上面 RT-4 / RT-5 的口径修好：
  孤儿路径的字符串比较在 Windows 上假红；本地配置用例硬要求符号链接，而产品在无符号链接
  权限的 Windows 上按设计走复制档。
- 本机（Windows，未启用开发者模式、非管理员）实测 `symlink_file` 返回
  `os error 1314 ERROR_PRIVILEGE_NOT_HELD`，因此 RT-5 的两条分支在 CI（Linux）与本机
  （Windows）各覆盖一条。
