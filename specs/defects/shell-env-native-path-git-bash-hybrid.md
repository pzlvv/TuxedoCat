---
status: 待修
---

# 缺陷：从 Git Bash 启动时原生子进程拿到的 PATH 是混合形态，`cmd /c` 与原生 exe 找不到 `node`

Core 的 `shell_env::apply_native` 把「原生形式 PATH」原样注入原生子进程（`rg` / `git` /
`cmd` / MCP stdio server）。当 Core 的祖先进程是 Git Bash / MSYS2 时，进程环境里的 `PATH`
并不是一份干净的 Windows 列表：前半段是分号分隔的 Windows 目录，后半段整段塞在**一个**
token 里，内容是 `/mingw64/bin:/usr/bin:/c/Users/...` 这种 POSIX 列表。原生进程只认
分号分隔的 Windows 目录，混进来的 POSIX 段让它们找不到 `node`——MCP stdio server 因此
一律启动失败，`cargo test mcp::tests` 在 Windows 上 5 项全红。

## 现状

- 复现：在 Git Bash 里跑 `cargo test --manifest-path core-rs/Cargo.toml mcp::tests`，
  21 项里 5 项失败，失败信息统一是「启动 MCP server … 失败: MCP server 已退出」。
- 直接证据（同一个 `cmd /c`，只换 `PATH`）：

  | 注入的 PATH | `cmd /c node --version` |
  | --- | --- |
  | 进程环境原样（含 `/mingw64/bin:/usr/bin:/c/...` 段） | 失败：`'node' 不是内部或外部命令` |
  | 纯 Windows 形式（`C:\Windows\system32;C:\Windows;D:\Program Files\nodejs`） | 成功：`v24.11.1` |

- 根因：`ShellPath.native` 在 Windows 上直接取进程环境里的 `PATH`（`env_path()`），
  而 Git Bash 启动的进程环境 `PATH` 本身就是混合形态。`apply_native` 里没有任何归一。
- 影响面不止 MCP：所有走 `shell_env::apply_native` 的原生子进程（`rg` 兜底、`git`、
  `where`、`cmd`）都拿到这份 PATH。只是这些工具通常也能从别处解析到，MCP 的
  `node -e` 是最先暴露的一条。

## 期望

- `shell_env::apply_native` 注入的 `PATH` 是原生进程可解析的**纯 Windows 形式**：
  - `;` 分隔；每个条目要么 `X:\...` 形态，要么是不含盘符的普通目录；
  - `/c/foo/bar` 归一成 `C:\foo\bar`；
  - 纯 POSIX 目录（`/usr/bin`、`/mingw64/bin`）丢弃——原生进程本来就不认；
  - 条目去重（大小写不敏感），保持首次出现顺序；
- `apply`（shell 形式）**不变**：Git Bash 拉起的工具命令仍然拿到 POSIX 列表。
- 非 Windows 行为不变（`apply_native` 与 `apply` 写同一份）。

## 不变量

- `apply` 的注入值不变（shell 形式仍是探测到的 POSIX / 平台原生列表）。
- `Sandbox` 钉定 PATH 的语义不变：两种形式仍以沙箱 `bin` 目录开头。
- 探测命令、`looks_like_path` 判据、失败口径（直接报错不退回继承）不变。
- [docs/core/standalone-core.md 第 3.2.1 节](../../docs/core/standalone-core.md#321-工具命令的-path)的「注入目标」行描述的两种形式分工不变。

## 回归测试

- **RT-1**：混合形态归一——`C:\Windows\system32;D:\Program Files\Git\usr\bin;/mingw64/bin:/usr/bin:/c/Users/me/bin;/d/Program Files/nodejs;C:\Windows\system32;`
  归一成 `C:\Windows\system32;D:\Program Files\Git\usr\bin;C:\Users\me\bin;D:\Program Files\nodejs`
  （纯 POSIX 段丢弃、`/c/...` 提盘符、重复项去掉、顺序保持）。
  （落点：`core-rs/src/shell_env_tests.rs` 的 `native_path_from_normalizes_git_bash_hybrid_lists`）
- **RT-2**：`apply_native` 写出的 PATH 在 Windows 上不含 `/`，且仍以沙箱 `bin` 目录开头。
  （落点：`core-rs/src/shell_env_tests.rs` 的 `apply_and_apply_native_write_their_own_form`）
- **RT-3**：MCP stdio server 端到端（真实 `node -e` 子进程）在混合形态 PATH 下也能起：
  握手、分页取工具、反向 sampling、进程退出收尾四类用例全绿。
  （落点：`core-rs/src/mcp_tests.rs` 的 `stdio_*` 与 `manager_*` 用例）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml mcp::tests` | 红 | 21 项里 5 项失败，统一报「MCP server 已退出」；`shell_env` 侧无归一函数可测 |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml mcp::tests` | 绿 | 21 passed / 0 failed |
| 归一函数单测（修复后） | `cargo test --manifest-path core-rs/Cargo.toml shell_env` | 绿 | 含 `native_path_from_normalizes_git_bash_hybrid_lists` |
| 全量 core | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1084 passed / 0 failed |
| 既有回归 | `npm run test:unit` | 绿 | 102 通过 / 0 失败 / 2 跳过（跳过项为 `sidebarDocViewGit` 的 Windows 文件名分支与 `sidebarFiles`） |
| 真实产物车道 | `npm run build:core:host` + `npm run test:all` | 部分验证 | 单测与 core 全绿；e2e 248 passed / 1 failed（`sessions.spec.ts` US-22，四车道并行的列表刷新超时，单独重跑与该车道单跑均通过，与本缺陷无关联） |
