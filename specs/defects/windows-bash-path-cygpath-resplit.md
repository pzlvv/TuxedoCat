---
status: 已修
---

# 缺陷：Windows 上抓用户 PATH 时整串转成 Windows 形式，shell 子进程拿到的是往返转换后的路径

`core-rs/src/shell_env.rs` 在 Windows 上探测用户终端 PATH 时执行
`bash -l -i -c 'cygpath -wp "$PATH"'`，把整串 POSIX 列表换成 Windows 形式，并且**只**保留这
一份：`Bash` 前台工具与后台任务（`$SHELL -c` 拉起的 bash）拿到的也是它。bash 子进程靠
cygwin 在启动时把 Windows 条目转回 POSIX，这个往返有损：`$PATH` 里带驱动器冒号的写法在
bash 里本来就按 `:` 切碎，转成 Windows 形式再转回来会粘成 `C:/c/Users/me/bin` 这种路径；
另外整串 `cygpath -p` 只要有一条目录转不动（如 `/c/foo/../bar`），整个探测直接失败，
工具命令一律不可用。

## 现状

- 探测脚本（Windows + bash 家族）：`cygpath -wp "$PATH"`（`core-rs/src/shell_env.rs` 的
  `probe_plan`），输出是**唯一**的 PATH 形式，`shell_env::apply` 把它写给所有子进程。
- 往返转换有损（实测，父进程是原生进程，与 Core 拉起 bash 的情形一致）：

  ```text 示意
  $ bash -l -i -c 'cygpath -wp "$PATH"'        # 用户 .bashrc 里 export PATH="$PATH:C:\Users\me\bin"
  C:\Program Files\Git\usr\bin;C;C:\Users\me\bin

  $ env PATH='C:\Program Files\Git\usr\bin;C;C:\Users\OseasyVM\.cargo\bin' /usr/bin/bash -c 'echo "$PATH"'
  /usr/bin:C:/c/Users/OseasyVM/.cargo/bin
  ```

  即 `~/.cargo/bin` 变成 cwd 下的相对路径 `C:/c/Users/...`，`cargo` 不在 PATH 上。干净列表
  也会走一趟往返：`/bin` 别名丢失、`/usr/bin` 重复出现。

- 一条转不动的目录让整个探测失败：

  ```text 示意
  $ bash -l -i -c 'PATH="/usr/bin:/c/foo/../bar"; cygpath -wp "$PATH"'
  cygpath: error converting "/usr/bin:/c/foo/../bar" - Unknown error -1
  ```

  退出码非 0，`run_probe` 按失败处理，`Bash` 工具把错误原样返回给模型。

- 三处用例把这个写法锁成了契约：`core-rs/src/shell_env_tests.rs` 的
  `bash_probe_script_matches_platform` 断言脚本含 `cygpath -wp`，
  `src/test/docsLint.test.ts` 第 14 组断言 `shell_env.rs` 与 3.2.1 节含 `cygpath -wp`。

## 期望

1. 探测取 **shell 自己的形式**：Windows 上的 Git Bash / MSYS2 / Cygwin 原样输出 POSIX 列表，
   不做 POSIX → Windows 的转换、也不做往返；注入 shell 子进程（`Bash` 前台工具、后台任务）
   的就是这一份，条目原样保留（含用户启动文件里写进去的 `C:\...` / `C:/...` 条目）。
2. 原生子进程（`rg` / `git` / `where` / `cmd` / MCP server）要 Windows 形式，由同一份列表
   **逐条**派生：每条单独交给 `cygpath -w`，条目与 shell 自己看到的一一对应；某条转不动就
   保留原文，空条目按 `.` 处理——一条转不动不让整个探测失败。
3. 两种形式同源，仍只有 `shell_env.rs` 一个写入点；注入入口按目标区分（shell 子进程 /
   原生子进程），由调用点显式选。
4. 解析口径仍不降级：取不到 shell 形式、或取到的内容不像 PATH，就报错。

## 不变量

- 非 Windows 平台行为不变：脚本仍取 `$PATH` 原文，两种形式相同。
- PowerShell 仍读 `$env:PATH`、cmd.exe 仍沿用进程环境；两者的 shell 形式与原生形式相同
  （Windows 上它们本来就输出 Windows 形式）。
- 探测参数仍是 `-l -i -c`，单次上限仍是 10s，结果（含失败）仍进程内缓存、不重试。
- 失败口径不变：抓不到 PATH 直接报错，不退回继承环境。
- `PATH` 仍只由 `shell_env.rs` 写入（`src/test/docsLint.test.ts` 第 14 组的存在性断言）。
- 沙箱 `force_path_for_test` 钉死的 PATH 仍是「沙箱 bin 目录 + 继承 PATH」，用例
  `bash_runs_with_the_resolved_path` 断言的标记目录仍出现在工具子进程的 `$PATH` 里。

## 回归测试

- **RT-1**：Windows 上 bash 家族的探测脚本逐条转换，脚本里不再出现整串 `-p` 写法
  （落点：`core-rs/src/shell_env_tests.rs` 的
  `windows_bash_probe_converts_path_entries_one_by_one`）。
- **RT-2**：`$PATH` 里已有 Windows 形式条目时，探测输出的 shell 形式原样保留；干净列表的
  原生形式逐条对应；转不动的条目保留原文、不让探测整体失败
  （落点：`core-rs/src/shell_env_tests.rs` 的
  `windows_bash_probe_keeps_windows_style_entries_intact`）。
- **RT-3**：文档与代码口径同步——`shell_env.rs` 与
  [docs/core/standalone-core.md 第 3.2.1 节](../../docs/core/standalone-core.md#321-工具命令的-path)
  都不再出现整串 `cygpath -wp`，且都声明逐条 `cygpath -w` 与两种形式的注入入口
  （落点：`src/test/docsLint.test.ts` 第 14 组「工具命令的 PATH 口径与代码一致」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml shell_env::tests` | 红 | 11 通过 / 2 失败。RT-1：`整串 -p 转换会把驱动器冒号当列表分隔符：cygpath -wp "$PATH"`；RT-2：`shell 自己的形式要原样保留（含 Windows 形式条目）：C:\Program Files\Git\usr\bin;C;C:\Users\me\bin` |
| 回归用例（修复前，默认 arm64 目标） | `cargo test --manifest-path core-rs/Cargo.toml shell_env::tests` | not-run | 本机是 aarch64 主机：ring 的 C / 汇编经 zig cc 产出后与 link.exe 不兼容（LNK1143 COMDAT），同一份用例改用 `--target x86_64-pc-windows-msvc` 跑 |
| 回归用例（修复前，文档口径） | `npm run test:all -- docs-lint` | 红 | RT-3：`工具命令的 PATH 口径与代码一致（问题 4 处）`——`shell_env.rs` 仍把整串 PATH 交给 `cygpath -p`、缺 `apply_native`；3.2.1 节仍写着整串 `cygpath -wp`、缺「原生形式」 |
| 回归用例（修复后） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml shell_env::tests` | 绿 | 15 通过 / 0 失败（RT-1 / RT-2 / RT-3 对应用例全绿） |
| 既有回归（Core 全量） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml` | 绿 | 894 通过 / 0 失败（190s） |
| 既有回归（文档口径） | `npm run test:all -- docs-lint` | 绿 | 第 14 组「工具命令的 PATH 口径与代码一致」问题 0 处 |
| 类型与 lint | `npm run check-types`、`npm run lint` | 绿 | — |
| 既有回归（TS 全量） | `npm run test:all` | 红 | 61 个测试文件通过，只有 `corePlatformMatrix` 的 `arm64-win32 已产出调试符号（pdb）` 失败：本机产物目录里没有 pdb（旧构建留下的产物，本次改动不碰构建脚本与产物）；重建产物后转绿 |
| 真实 Core 端到端 | `npm run build:core:host`，再 `npm run test:all -- standaloneCoreTools core-platform-matrix` | 绿 | `standaloneCoreTools` 62 断言（Bash 工具经真实 Core 跑 bash、后台任务、PATH 注入）+ `core-platform-matrix` 22 断言全通过 |
| 缺陷规格结构（docsLint） | `npm run test:all -- docs-lint` | 绿 | 评估段曾因缺「修复后的绿」行而红，补上后随第 14 组一起转绿 |
| 评估段的偏差（修复段更正） | `bash -c 'PATH=...; cygpath -wp "$PATH"'` 对比逐条转换 | 部分验证 | 评估段把「驱动器冒号被当列表分隔符」写成 `cygpath -p` 独有，实测 bash 自己也按 `:` 切，整串与逐条在这些条目上产出相同；真正的差异是往返转换有损与「一条转不动整体失败」，`现状` / `期望` / RT-2 已按实测收敛 |
