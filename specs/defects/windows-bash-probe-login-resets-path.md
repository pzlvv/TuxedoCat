---
status: 已修
---

# 缺陷：Windows 上用登录 + 交互 shell 探测 PATH，MSYS2 的启动文件会把用户 PATH 重置掉

`core-rs/src/shell_env.rs` 在 Windows 上也用 `bash -l -i -c` 探测 PATH。`-l` 会跑
`/etc/profile`，它按 `MSYS2_PATH_TYPE` / `ORIGINAL_PATH` **重建** PATH：MSYS2 上这两个变量不是
`inherit` 形态时，用户环境变量里的目录——`git` 所在的 `C:\Program Files\Git\cmd`、npm 的
`AppData\Roaming\npm` 之类——被换成一套 MSYS2 基目录加最小 System32 PATH。Core 拉起的工具命令
于是看不到这些目录：`git` 明明在环境变量里，却跑不起来。

## 现状

- 探测参数（Windows 上的 bash 家族）：`-l -i -c`（`core-rs/src/shell_env.rs` 的 `probe_plan`）。
- 复现（父进程是原生进程，与 Core 拉起 bash 一致；`MSYS2_PATH_TYPE=strict` 是 MSYS2 的合法
  配置，直接起 `bash.exe` 而不是走 `msys2_shell.cmd` 时也可能落到非 `inherit` 分支）：

  ```text 示意
  $ PATH='C:\__tc_probe_marker__;C:\Windows\System32' MSYS2_PATH_TYPE=strict \
      bash -l -i -c 'printf "%s\n" "$PATH"'
  /c/Users/.../bin:/clangarm64/bin:/usr/local/bin:/usr/bin:/bin:...     # 环境变量里的目录没了

  $ PATH='C:\__tc_probe_marker__;C:\Windows\System32' bash -c 'printf "%s\n" "$PATH"'
  /c/__tc_probe_marker__:/c/Windows/System32                            # 环境变量原样保留
  ```

- 机制在 `/etc/profile`（MSYS2 与 Git for Windows 是同一份）：`case "${MSYS2_PATH_TYPE:-inherit}"`
  的 `strict` 分支 `unset ORIGINAL_PATH`、其余非 `inherit` 分支换上一套最小 System32 PATH；随后
  `PATH="${MINGW_MOUNT_POINT}/bin:${MSYS2_PATH}${ORIGINAL_PATH:+:${ORIGINAL_PATH}}"`——继承来的
  目录只有进了 `ORIGINAL_PATH` 才活得下来。
- Windows 上并不需要这套机制：宿主（Electron / VS Code / sshd）启动 Core 时已经把用户完整的
  Windows PATH 放进进程环境，探测再跑启动文件只会把它换掉。

## 期望

1. Windows 上探测 bash 家族只跑 `-c`（不带 `-l` / `-i`），不读 `/etc/profile` / `.bashrc`：
   shell 形式 = 进程环境里 Windows PATH 的 POSIX 表示（由 bash 启动时换算）。
2. Windows 上原生形式直接取进程环境里的 Windows PATH（它就是用户终端里的那份），不再经
   `cygpath` 往返派生。
3. 非 Windows 保持 `-l -i -c`（launchd / sshd 只给最小 PATH，`.zshrc` / `.bashrc` 里的目录
   只有登录 + 交互 shell 才读得到），两种形式相同。
4. 其余口径不变：标记行解析、逐段校验、10s 上限、进程内缓存、不降级、`shell_env.rs` 是 PATH
   的唯一写入点。

## 不变量

- `apply` / `apply_native` 的分工不变：shell 子进程拿 shell 形式，原生子进程拿原生形式。
- PowerShell 仍读 `$env:PATH`（两种形式相同）、cmd.exe 仍沿用进程环境。
- 探测失败仍直接报错，不退回继承环境。
- 沙箱 `force_path_for_test` 与用例 `bash_runs_with_the_resolved_path` 的断言口径不变。

## 回归测试

- **RT-1**：Windows 上 bash 家族的探测参数不含 `-l` / `-i`（落点：`core-rs/src/shell_env_tests.rs`
  的 `windows_bash_probe_skips_login_startup`）。
- **RT-2**：登录启动文件会把 PATH 重置掉时，探测仍保留进程环境里的目录
  （落点：`core-rs/src/shell_env_tests.rs` 的 `windows_bash_probe_keeps_the_environment_path`）。
- **RT-3**：文档与代码口径同步——3.2.1 节与 `shell_env.rs` 都写明 Windows 上不读启动文件、
  原生形式取进程环境里的 Windows PATH，且都不再要求 `cygpath`
  （落点：`src/test/docsLint.test.ts` 第 14 组「工具命令的 PATH 口径与代码一致」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1 / RT-2） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml shell_env::tests` | 红 | 15 通过 / 2 失败。RT-1：`Windows 上不读 login 启动文件：["-l", "-i", "-c", ...]`；RT-2：`登录启动文件重置 PATH 后，进程环境里的目录仍要在探测结果里：__TC_PATH__/c/Users/.../bin:/clangarm64/bin:/usr/local/bin:/usr/bin:/bin:...`（marker 目录被 `/etc/profile` 换掉了） |
| 回归用例（修复前，RT-3） | `npm run test:all -- docs-lint` | 红 | `工具命令的 PATH 口径与代码一致（问题 4 处）`：`shell_env.rs` 仍在用 cygpath、`-l` / `-i` 没有按平台区分；3.2.1 节仍要求 cygpath、缺 `MSYS2_PATH_TYPE` |
| 回归用例（修复后，RT-1 / RT-2） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml shell_env::tests` | 绿 | 16 通过 / 0 失败（RT-1 断言参数里没有 `-l` / `-i`；RT-2 断言 `MSYS2_PATH_TYPE=strict` 下 marker 目录仍在、原生形式等于进程环境里的 PATH） |
| 既有回归（Core 全量） | `cargo test --target x86_64-pc-windows-msvc --manifest-path core-rs/Cargo.toml` | 绿 | 895 通过 / 0 失败（190s） |
| 回归用例（修复后，RT-3） | `npm run test:all -- docs-lint` | 绿 | 第 14 组「工具命令的 PATH 口径与代码一致」问题 0 处（整套 docsLint 另因工作树里另一条在改的缺陷规格 `once-replacement-skips-autoscroll.md` 的验证记录取值非法而红，与本次改动无关） |
| 类型与 lint | `npm run check-types`、`npm run lint` | 绿 | — |
| 真实 Core 端到端 | `npm run build:core:host`，再 `npm run test:all -- standaloneCoreTools` | 绿 | 22 断言全通过（Bash 工具经真实 Core 跑 bash、后台任务、PATH 注入） |
