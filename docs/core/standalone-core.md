---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：Standalone Core（Rust）

本规格描述 Core（Rust 实现的独立进程，历史上称 Standalone Core）。Core 与 UI 的
分离形态见 `docs/architecture/core-ui-separation.md`；本规格在其基础上确定 Core 的
进程形态、传输协议与事实归属。连接模型（Client / Connection / 工作区引用）见
`docs/core/client-connection.md`；Core 进程的 daemon 见 `docs/core/core-daemon.md`；
宿主侧读取边界、不覆盖范围与验收要点见 `docs/core/standalone-core-boundaries.md`。
事件词汇表见 [docs/architecture/events.md 第 1 节](../architecture/events.md#1-总线契约)、[第 2 节](../architecture/events.md#2-事件词汇表)。

---

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [能力](#1-能力) |
| 2. | [术语与事实来源](#2-术语与事实来源) |
| 3. | [Core 形态](#3-core-形态) |
| 4. | [契约](#4-契约) |
| 5. | [传输与协议](#5-传输与协议) |
| 6. | [生命周期](#6-生命周期) |
| 7. | [事实归属](#7-事实归属) |

---

## 1. 能力

1. **唯一实现**：Core 只有 Rust 一套实现（`core-rs/`），以独立进程形态与 UI 分离。
2. **契约稳定**：Core 对 UI 呈现 `CoreEvent` / `CoreRequest` / `UiEvent` 词汇表，
   载荷字段逐项确定。
3. **独立进程**：Core 是独立的可执行文件，承载 core 侧全部职责
   （引擎、工具、历史、MCP 子进程、技能）。
4. **平台范围**：产出 Windows x64 / arm64 与 Linux x64 / arm64 四个目标，全部属于默认打包
   集合（`PACKAGE_DIRS`）；单独重建用 `--target` / `npm run build:core:win32-arm64`。
5. **一条帧通道**：UI 与 Core 之间只有一条双向帧通道；UI 为客户端，Core 为服务端。
6. **一个工作区一个 Core 进程**：每个打开的工作区对应一个 Core 进程；一个 Core 进程只服务
   它的 Connection（[docs/core/client-connection.md 第 5 节](client-connection.md#5-connection-生命周期)）。
7. **生命周期归 daemon**：Core 进程由 daemon 启动、终止与重启；daemon 见
   `docs/core/core-daemon.md`。
8. **崩溃可恢复**：Core 进程意外退出后由 daemon 重启并恢复接线；单个 Connection 的 Core
   崩溃不影响其它 Connection。

### 1.1 Core 侧业务范围

Core 进程承载的 core 侧业务：

- `UiEvent` 只经帧通道进入 Core 进程；进程内不注册 core 侧订阅，也不建会话队列；
- 用户消息经 `UiEvent.userMessageSubmitted` 进入 Core，宿主不直接调用引擎；
- Core 进程承担：握手、帧通道、连接态重放、日志上报，以及会话引擎、
  内置工具（含后台 Bash、子代理与 Skill）、会话落盘、项目清单读写、
  技能加载与斜杠命令解析（`CommandDispatcher` + 内置命令 + 技能命令）、
  对话压缩（自动 / 手动触发、摘要生成、归档与 `messagesReplaced` 重放）、
  Responses API（`apiType='Responses'`）、
  MCP（stdio / Streamable HTTP / 旧版 SSE 三种传输、连接池与会话引用、
  `mcp__*` 工具注入与按会话启用列表过滤）、
  Spin 引擎（`spin.json` 读写、拓扑排序、子代理执行、验收判定、`/spin` 命令）、
  智能命名 / 压缩归档展开 / DeepSeek 余额推送（都要读 core 的磁盘数据，因此整体在 Core 侧）；
- 远程工作区文件监听（`core-rs/src/file_watch.rs`）：按宿主注册的 `watchId` 监听目标文件父目录，50ms 去抖后经 `CoreEvent.workspaceFileChanged` 上报 `changed` / `deleted` / `error`；事件只带路径与元数据（specs/018 FR-002）；
- 系统睡眠阻断（`core-rs/src/power.rs`）：任一会话非 idle（含等待用户确认）时阻断 **Core 进程所在机器**的睡眠 / 休眠——Windows `SetThreadExecutionState(ES_SYSTEM_REQUIRED)`、Linux
  `systemd-inhibit --what=idle:sleep`，都只要求系统不挂起、允许屏幕熄灭。远程工作区的长任务
  在远端执行，宿主那台机器睡不睡与它无关，因此这一份必须在 Core 进程里；Electron 宿主另有
  一份同口径的实现（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)）；
- 全局配置与 MCP 配置的读写**不在** Core 侧：两者由 UI 持有，经 `hostEnvironmentProvided` 的配置快照下发（[docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)）；
尚未覆盖的能力见 [docs/core/standalone-core-boundaries.md 第 4 节](standalone-core-boundaries.md#4-不覆盖范围)的「不覆盖范围」。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| Core | core 侧职责的唯一实现（Rust，`core-rs/`），独立进程 | core |
| 帧 | 帧通道上的一条 UTF-8 换行分隔 JSON 消息 | 传输层 |
| 帧通道 | UI 与 Core 之间的双向字节流 | 传输层 |
| 客户端 / 服务端 | 帧通道两端；UI 为客户端，Core 为服务端 | 传输层 |
| 握手 | 通道建立后的协议版本确认 | 传输层 |
| 会话 | 一段对话的引擎实例与磁盘数据 | core |
| 宿主实例 | 一个 UI 进程（VS Code 扩展宿主 / Electron 主进程） | UI |
| Core 实例 | 一个 Core 进程，归属一个工作区的 Connection | daemon 启动，Core 自身 |
| 重启 | Core 实例意外退出后由 daemon 重新启动并恢复接线 | daemon（`docs/core/core-daemon.md`） |
| Core 可执行文件名 | `core.binaryName`（`src/config/project.json`），Windows 加 `.exe` | 工程配置 |
| Core 产物目录 | `resources/<core.resourceDir>/<arch>-<platform>/` | 工程配置 |
| Core 部署目录 | `~/.local/share/<core.deployPrefix>/<指纹>/`（`coreDeployDirPath`），部署槽位目录，见第 3.4 节 | 工程配置 |

产品名、可执行文件名与产物目录名一律取自 `src/config/project.json`；代码与 Rust 包名
不出现产品名。

事件词汇表的 owner 见 [docs/architecture/core-ui-separation.md 第 2 节](../architecture/core-ui-separation.md#2-术语与事实来源)。

---

## 3. Core 形态

- 语言与工具链：Rust（edition 2021），Cargo 构建。
- 产物：`core.binaryName`（Windows 加 `.exe`）单文件可执行，外加自带的工具目录
  （`ripgrep/`，部署时提升为产品目录的共享位）；部署按指纹落槽位，见第 3.1 节。
- 源码位置：`core-rs/`（Cargo 包，包名与二进制名保持中性；对外文件名由构建脚本按配置落位）。
- 进程属性：由宿主启动时不显示窗口；标准输入 / 标准输出为帧通道，标准错误为诊断输出。
  远程服务（`start` 动作）让 daemon 把控制通道换成 TCP（[docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）。
- 可独立运行：`--help` / `--version` 打印用法与版本；没有动作时按 `start` 处理
  （[docs/core/core-daemon.md 第 3 节](core-daemon.md#3-进程形态)）。
- 进程工作目录不作为业务事实；会话目录取自 `UiEvent`。
- Core 进程创建的所有子进程（shell、ripgrep、git 等）都不显示控制台窗口；
  每次查询都不产生可见的窗口闪烁。
- 需要反复读取的环境事实（如工作目录的 git 状态）在 Core 进程内缓存，
  不按轮次重复 spawn 子进程。
- Core 创建的每个子进程都不继承帧通道（标准输入置空），工具不会读到协议帧。
- Bash 工具按 `core-rs/src/shell.rs` 的探测优先级选择 shell：
  Windows 上 Git Bash 优先，cmd.exe 只在全部探测失败时兜底。
- 后台 Bash 任务（`run_in_background` / 前台超时自动转后台）的输出直接由子进程
  写入 `<TMPDIR|TEMP|/tmp>/<tmpTaskDirName>/<taskId>.output`（对齐
  `tools/bash/TaskOutput.ts` 的 file mode）；任务完成后 Core 把一条
  `origin='bash'` 的完成通知作为 user 消息注入该会话并唤醒消费循环，
  会话关闭 / 中止时终止该会话的全部后台任务。
- 前台 Bash 与后台任务的结束判据同一口径：**shell 退出即收尾**（`bash_task::watch` 的 `try_wait` 口径），不等管道 EOF；孙进程继承管道写端（`start` 拉起的 detached daemon 等）使 EOF 不会到来时，退出后给读线程一段排水宽限（`PIPE_DRAIN_GRACE_MS`）收割已缓冲的输出，宽限内未结束就停掉读线程、用已累积快照收尾，此后 abort 与前台超时不再生效（命令已完成）。
- 前台超时默认 60s（`DEFAULT_BASH_TIMEOUT_MS`）；命令含 `sleep` 子命令时死线后移到 `max(默认超时, sleep 时长总和)`（GNU `NUMBER[s|m|h|d]` 口径，`sleep infinity` 饱和为无超时，解析不出时长（变量、算术、非法参数）回退默认超时——sleep 只把死线后移，不注销死线；工具输入显式给 `timeout`（内部覆盖，schema 之外）时优先）。

### 3.1 平台矩阵

| 平台 | 架构 | 目标三元组 | 产物目录（`<core.resourceDir>` = `core`） | 状态 |
| --- | --- | --- | --- | --- |
| Windows | x64 | `x86_64-pc-windows-msvc` | `resources/core/x64-win32/` | 产出 |
| Windows | arm64 | `aarch64-pc-windows-msvc` | `resources/core/arm64-win32/` | 产出（Windows 宿主交叉编译，见第 3.3 节） |
| Linux | x64 | `x86_64-unknown-linux-musl` | `resources/core/x64-linux/` | 产出（静态 musl；Windows 上交叉编译，见第 3.3 节） |
| Linux | arm64 | `aarch64-unknown-linux-musl` | `resources/core/arm64-linux/` | 产出（静态 musl；Windows 上交叉编译，见第 3.3 节） |

产物目录命名与 `resources/ripgrep/` 一致。宿主按运行平台的平台名 / 架构名解析产物目录，
不写死单一平台。

Electron 打包后产物落在 `app.asar` 内的 `dist/resources/`，但可执行文件必须从磁盘启动：
`electron-builder.config.js` 的 `asarUnpack: ['dist/resources/**']` 把整份产物解包到 `app.asar.unpacked/`，宿主定位候选路径时把 `app.asar` 改写为 `app.asar.unpacked` 并优先取用
（`child_process.spawn` 不做 Electron 的 asar 重定向，直接 spawn asar 内路径必 ENOENT）。

**调试符号不随分发包走**：Windows（MSVC）的行号表在 `<core.binaryName>.pdb` 里，`build-core.mjs::copyDebugSymbols` 把它落在 `resources/core/<dir>/`，`copy-assets` 照常带进 `dist/resources/` 供本地崩溃诊断，但 vsix 白名单与 electron-builder 的默认规则（`includePdb` 未打开时排除 `**/*.pdb`）都把它挡在分发物之外（[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)）。

**部署单元与共享位**：仓库里的产物目录是自包含的——可执行文件与自带工具目录（当前只有 `ripgrep/rg[.exe]`）同级：

```
resources/core/x64-win32/<core.binaryName>.exe
resources/core/x64-win32/ripgrep/rg.exe
```

部署到 `~/.local/share/<core.deployPrefix>/` 时按指纹落槽位，ripgrep 提升为产品
目录里全部槽位共享的一份（rg 与指纹无关，Grep / Glob 的行为不随 Core 版本变）：

```
~/.local/share/<core.deployPrefix>/<指纹>/<core.binaryName>[.exe] + fingerprint
~/.local/share/<core.deployPrefix>/ripgrep/rg[.exe]
~/.local/share/<core.deployPrefix>/tui[.exe]                    # TUI 版安装器附带
```

Core 定位自带 ripgrep 时**以自己的可执行文件为基准**（`tools.rs::ripgrep_path`，按优先级
取第一个存在的）：可执行文件同目录下的 `ripgrep/`（仓库产物与 Electron 打包布局——
`asarUnpack` 解包后 rg 与 Core 在同一层，而 Rust 的 `Path::exists` 看不进 asar 内的
`dist/resources/core/<平台>/ripgrep/`），以及槽位上一级产品目录里的 `ripgrep/`（远端部署
的共享位）。本地起进程、远端上传与 TUI 版安装都在这两条候选内，不依赖宿主提供
`extensionPath`。

**ripgrep 的归属**：Grep / Glob 用的 rg 只有 Core 自带的一份
（`resources/core/<dir>/ripgrep/`，Core 以自己的可执行文件为基准定位）。
`resources/ripgrep/<dir>/` 是构建源目录（`build-core.mjs::copyBundledRipgrep` 拿它
复制成 Core 自带 rg），不随分发包走：`scripts/copy-assets.mjs` 把 `resources/`
复制进 `dist/` 后会清掉 `dist/resources/ripgrep/`（无读取方，约 18M）。

**产品身份单源**：部署产品目录名（`core.deployPrefix`）、Core 二进制名
（`core.binaryName`）、扩展名（`extensionName`）、配置目录名（`configDir`）等产品
身份字段只有一份来源——`src/config/project.json`。Rust 侧（core-rs / tui-rs /
installer-rs）经各自 `build.rs` 构建期烧成 `TC_*` 编译期环境变量，运行期代码经
`env!` 取值，不出现产品字面量；TS 侧经 `src/config/project.ts`。企业版改名只动
project.json 与各 crate 的包名，不改逻辑代码。

### 3.2 跨平台约束

- Core 侧不依赖 Windows 专有 API；平台差异收敛在少量模块：进程管理、路径处理、
  shell 探测、资源定位。
- 构建脚本按目标三元组参数化；当前产出 Windows x64 与 Linux x64 / arm64（musl 静态），
  Windows arm64 可按需构建（见第 3.3 节）。
  Linux 目标在 Windows 上交叉编译（rust-lld + zig + make，见第 3.3 节），不需要 Linux 环境。
- 宿主侧的启动、帧通道与契约不随平台变化。
- 新增平台时只补产物目录与构建目标，不改契约与磁盘格式。

平台差异的实际落点（审查口径）：

| 关注点 | 落点 | 平台差异的处理 |
| --- | --- | --- |
| 进程管理 | `bash_task.rs::kill_tree`、`mcp.rs` 的子进程终止 | `#[cfg(windows)]` 走 `taskkill /T /F`；非 Windows 走 `Child::kill`（都只杀直接子进程树） |
| 路径处理 | `util.rs` 的 `normalize_path` / `expand_path`、`config.rs` 的 `encodeURIComponent` 等价物 | 盘符与 UNC 的换算都在 `cfg!(windows)` 分支内；非 Windows 走 POSIX 分支，多字节路径按字节比较 |
| shell 探测 | `shell.rs::detect` | 非 Windows 直接用 `$SHELL`（缺省 `/bin/bash`）；Windows 才走 Git Bash → PowerShell → cmd.exe 的优先级 |
| 工具 shell 的 PATH | `shell_env.rs` | 抓用户终端里的 PATH：非 Windows 用 `$SHELL -l -i -c`，Windows 上只用 `$SHELL -c`（启动文件会按 `MSYS2_PATH_TYPE` 重建 PATH，把用户环境变量里的目录挤掉）。shell 子进程用 shell 自己的形式（Windows 的 Git Bash 是 POSIX 列表），原生子进程用 Windows 形式（Windows 上就是进程环境里的 PATH）；PowerShell 读 `$env:PATH`，cmd.exe 没有启动文件、沿用进程环境 |
| 资源定位 | `tools.rs::ripgrep_path`、`config.rs::extension_path` | Core 自带产物以**自己的可执行文件目录**为基准（`<exe 目录>/ripgrep/rg[.exe]` 本地打包布局优先，`<exe 目录>/../ripgrep/rg[.exe]` 部署布局的共享位次之——Rust 的 `Path::exists` 看不进 asar），宿主 `extensionPath` 只作本机开发期的兜底、最后回退 PATH；可执行名按 `cfg!(windows)` 加 `.exe`；产物目录按 `<arch>-<platform>` 解析，矩阵外直接拒绝而不是猜一个目录 |
| 主目录 | `config.rs::home_dir` | `USERPROFILE` 优先、`HOME` 兜底，两者都缺才报错 |
| 系统语言 | 宿主：`src/host/i18n.ts::getSystemLocale`（不在 Core 侧） | 仅 Windows 查 PowerShell `Get-UICulture`；其余平台读 `LANG` / `LC_ALL` |
| 控制台窗口 | `util.rs::hide_console` | 仅 Windows 设 `CREATE_NO_WINDOW`，非 Windows 是空操作 |

矩阵一致性由 `src/test/corePlatformMatrix.test.ts` 锁定：构建脚本的目标登记、
运行时的目录解析、产物落位三处必须两两一致，矩阵外的平台组合必须被拒绝。

### 3.2.1 工具命令的 PATH

工具命令（`Bash` 前台 / 后台、`Grep` 的 `rg` 兜底、MCP stdio server）由 Core 以
`$SHELL -c` 拉起，看到的是子进程环境里的 PATH。Core 进程本身的环境来自它的父进程：
macOS 从 launchd 启动时只有最小 PATH，远端 daemon 经 SSH exec 拉起时是 sshd 会话的环境——
这两种环境都不含用户终端里的 PATH（`.zshrc` / `.bashrc` 配的那些目录），工具命令因此找不到
`node` / `cargo` / `git`；Windows 的宿主本来就把用户完整的 Windows PATH 交给了 Core，
缺的只是 bash 看到的那份 POSIX 形式。

`shell_env.rs` 在首次需要时抓一次这份 PATH（非 Windows 用「登录 + 交互」shell，Windows 上只取
进程环境，见下表），缓存后按子进程类型注入两种形式之一——`shell_env::apply` 给 `$SHELL -c`
拉起的 shell 子进程，`shell_env::apply_native` 给原生进程。这两个函数是 PATH 的唯一写入点：

| 项 | 口径 |
| --- | --- |
| 探测命令 | bash / zsh / sh / dash / ksh：非 Windows 用 `-l -i -c`（`-l` 读 `.zprofile` / `.zlogin`，`-i` 读 `.zshrc` / `.bashrc`——zsh 的 `.zshrc` 只在交互时读）；Windows 上只用 `-c`，不读 `/etc/profile` / `.bashrc`：它们按 `MSYS2_PATH_TYPE` / `ORIGINAL_PATH` 重建 PATH，MSYS2 机器上会把用户环境变量里的目录（`git` 所在的 Windows 目录等）整套换掉（`specs/defects/windows-bash-probe-login-resets-path.md`） |
| PowerShell | `-Command "[Console]::Out.Write($env:PATH)"`，**不加** `-NoProfile`：profile 里的 PATH 才是终端里的 PATH |
| cmd.exe | 不读启动文件，终端里的 PATH 就是进程环境里的 PATH |
| 取用范围 | 只取 PATH 一个变量；`.zshrc` 里的 alias、函数、`chpwd` 钩子都不搬进命令执行 |
| 解析规则 | 按标记行 `__TC_PATH__` 取（启动文件打印的内容排在它前面），必须像一条 PATH（含该形式的分隔符、是 POSIX 绝对路径，或本身是目录），否则按失败处理 |
| 上限与缓存 | 单次探测 10s 上限；结果（含失败）在进程内缓存，不重试 |
| 失败口径 | 直接报错，不退回继承环境：`Bash` 工具把错误作为工具结果返回，后台任务与 MCP server 启动失败，系统提示的环境段让整轮查询失败 |
| pty | 不分配：`-c` 不进入交互循环，探测与工具命令都走管道 |
| 注入目标 | shell 子进程（`Bash` 前台工具、后台任务）用 shell 自己的形式；原生子进程（`rg`、`git`、`where`、`cmd`、MCP stdio server）用原生形式——Windows 上的 `cmd /c` 与原生 exe 不认 POSIX 列表，那份就是进程环境里的 Windows PATH |

需要 tty 的命令（要 sudo 密码提示、vim 这类全屏编辑器、依赖终端判断才有颜色的工具）不在本机制范围内：工具命令的 stdin 接空设备，stdout / stderr 是管道。

Windows 上原生形式直接取进程环境里的 PATH，不经过 `cygpath`；只有 shell 形式需要 bash 把
Windows PATH 换算成 POSIX 列表，所以探测要求 shell 是 Git Bash / MSYS2 / Cygwin 这一类。

### 3.3 构建与目标平台

Linux 产物一律用 **musl**：静态链接、不依赖目标机器的 glibc 版本。这个 core 要拷到别人的
远端机器上跑，发行版未知，gnu 目标很容易撞上 glibc 太旧。

Linux 产物的全局分配器是 **mimalloc**（`core-rs/Cargo.toml` 的 musl 依赖 + `core-rs/src/main.rs` 的
`#[global_allocator]`），替掉 musl 自带的 mallocng：会话循环分配密集且跨线程，碎片与峰值偏高。开
`override` 后 libc 的 malloc / free 也归它（`ring` 等 C 依赖与 Rust 侧同堆）；Windows 与 ASAN 变体
（gnu 三元组）不挂它，ASAN 要自己拦截 malloc / free。mimalloc 的 C 源文件由 cc-rs 直接编译，构建链
不需要 autoconf / make，交叉编译只要 zig。

| 目标 | 三元组 | 产物目录 |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | `resources/core/x64-win32/` |
| Linux x64 | `x86_64-unknown-linux-musl` | `resources/core/x64-linux/` |
| Windows arm64 | `aarch64-pc-windows-msvc` | `resources/core/arm64-win32/` |
| Linux arm64 | `aarch64-unknown-linux-musl` | `resources/core/arm64-linux/` |

```bash
npm run build:core            # 打包要携带的全部目标（Windows x64 / arm64 + Linux x64 / arm64）
npm run build:core:host       # 只建当前平台 / 架构（本地调试用）
npm run build:core:linux-x64  # 只建 Linux x64（Windows 上就是交叉编译，不需要 WSL）
npm run build:core:win32-arm64 # 只建 Windows arm64（打包集合成员，见下）
npm run build:core:asan       # 建当前平台 / 架构 + Linux x64 的 ASAN 插桩构建（内存诊断用）
```

`build-core.mjs` 的目标分三档：不带参数时构建 `PACKAGE_DIRS`（本机构建不了的组合跳过并说明）；
`--host` 只建当前平台 / 架构（`dev:electron`、`watch:app` 的 Rust 重建走这条）；`--target` 只建指定目标。

**ASAN 变体**（`npm run package:asan`，单编走 `npm run build:core:asan`）：Core 用 nightly 工具链的
`-Zsanitizer=address` 按 `core-rs/Cargo.toml` 的 `[profile.asan]`（继承 release 的优化与行号表）构建，
产物落 `target/<三元组>/asan/`；默认构建**当前平台 / 架构 + Linux x64**（本机没有 asan 变体时只建
Linux x64，它是 vsix / 桌面包跨平台携带的那份，也是 SSH 远端部署的主目标），其余目标用 `--target`
显式指定。Linux x64 的 ASAN 产物用 **gnu** 三元组（`x86_64-unknown-linux-gnu`）而不是发布产物的
静态 musl（rustc 拒绝 sanitizer 与静态 libc 的组合），gnu 产物动态链接 glibc；Windows 仍用 msvc。
产物落位与 release 相同（同目录同名覆盖本机 / Linux x64 那份），Windows 产物目录额外带 MSVC 的
动态 ASAN 运行库 `clang_rt.asan_dynamic-<arch>.dll`（rustup 工具链不带它，链接期与运行期都用 VS
「C++ AddressSanitizer」组件分发的那份，构建脚本经 vswhere 定位后复制到 exe 同级，缺失直接报错；
ELF 平台的 asan 运行库静态链进二进制，无此文件）。指纹 profile 段为 `asan`、三元组取实际构建三元组
（见[第 3.4 节](#34-构建指纹)），与 release 产物互不混槽：asan 构建后再打 release 包，
`verify-core-artifacts` 会按指纹拦下，重跑 `npm run build:core` 即恢复。变体经环境变量
`<envPrefix>_CORE_ASAN=1` 而不是命令行参数贯穿打包链（`package:ext` 里 vsce 会强制再执行一遍
`vscode:prepublish`，其内嵌的 `npm run build:core` 收不到参数，注入见 `scripts/package-asan.mjs`）；
该变体下校验覆盖本机平台 + Linux x64、TUI 安装器只建本机平台、打包产物整体落 `release/asan/`
（不覆盖正式 release 产物）。

构建的工具链分两段，**都在本机解决**：

1. **Rust 目标与链接器**（`rustup target add <triple>`；asan 变体装在 nightly 上：
   `rustup target add --toolchain nightly <triple>`，缺工具链时构建脚本直接给出安装命令）：
   - Linux musl：链接器用 rustup 自带的 `rust-lld` + self-contained 的 musl crt / libc
     （配在 `core-rs/.cargo/config.toml`），不需要系统上的交叉链接器；
   - Linux gnu（ASAN 变体）：没有自包含的 crt / libc，链接交给 zig 的 cc 驱动（见下）；
   - Windows arm64：MSVC 目标的链接器由 rustc 经 Visual Studio 定位，需要装好 VS 的
     「MSVC ARM64 生成工具」组件（MSVC 链接器不跨平台，只在 Windows 宿主构建）。
2. **C 编译器**：`ring`（`reqwest` 的 `rustls-tls` 依赖）与 mimalloc（Linux musl 产物的分配器）
   都有 C 源码，cc-rs 需要一个能产出该目标文件的 C 编译器。用 [zig](https://ziglang.org/)：
   它自带 clang 与头文件 / libc，一个可执行文件就够。装好保证 `zig` 在 PATH 上即可（装在别处
   用环境变量 `ZIG` 指定）；构建脚本会注入 `CC` / `CFLAGS` / `AR`，缺 zig 时直接报错、不静默
   降级。两个用场：
   - Linux musl / gnu：交叉编译的 C 编译器（`zig cc`，cc-rs 按空白切成命令 + 参数），静态库
     打包用 `zig ar`；gnu 的链接也经 `zig cc`（`zig-cc-linker.mjs` 垫片还原 `-Wl,<绝对路径>`）；
   - Windows arm64：ring 的 build.rs 对该目标**硬性要求 clang**（MSVC 的 cl.exe 不被
     接受），由 zig cc 充当；静态库打包用 VS 的 lib.exe（cc-rs 自行定位，不注入 AR）。

打包（`npm run package:ext` / `package:app`）会校验要携带的 Core 产物（`verify-core-artifacts.mjs`）：
产物缺失、比 `core-rs/src/**` 旧、构建指纹与源码不一致、或没同步进 `dist/resources/` 都直接报错。
平台列表取自 `PACKAGE_DIRS`（asan 变体取 `asanDefaultTargets`，即本机 + Linux x64），两处不各写一份；
`build:core` 默认构建这四个平台（Linux 两份与 Windows arm64 都是交叉编译）；校验拦住「改了 Rust 源码没重编」与「`copy-assets` 没跑」——旧产物会静默打进 vsix / 安装包。

预编译 ripgrep（`resources/ripgrep/<arch>-<platform>/`）四个平台取自同一版本的 ripgrep 官方发布物
（15.2.0；Linux 两份为 `unknown-linux-musl` 静态链接），入库前按官方 `.sha256` 逐份校验。
`build-core.mjs::copyBundledRipgrep` 把它复制成 Core 自带 rg（`resources/core/<dir>/ripgrep/`）。

**Windows arm64**：目标与产物目录已登记（矩阵一致性由 `src/test/corePlatformMatrix.test.ts`
锁定），属于默认打包集合 `PACKAGE_DIRS`，单独重建用 `npm run build:core:win32-arm64`。
TUI 安装器（`scripts/build-tui-installer.mjs`）对缺产物的目标仍按需补建 Core，兜住单目标场景。

### 3.4 构建指纹

每个产物目录带一份**构建指纹**（`scripts/build-core.mjs` 的 `computeFingerprint`）：
产物同级落一个 `fingerprint` 文件（一行 64 位小写 hex），同时经 `CORE_FINGERPRINT`
环境变量由 `core-rs/build.rs` 烧进二进制（`option_env!("CORE_FINGERPRINT")`，daemon
以它区分自己的状态 / 日志文件；`cargo test` / `clippy` 等本地工具链没有这个环境变量，
取固定占位 `manual-build`——发布产物必经 `build-core.mjs`，不会落到占位）。
指纹只由**源码内容与编译器身份**决定，与构建时间、
构建路径无关：同一编译器对同一份源码的两次构建得到同一指纹。

- **输入集**：`core-rs/` 工作树全部文件（排除 `target/`，遍历工作树而非
  `git ls-files`——未提交的新文件也必须改变指纹；`Cargo.lock` 与 `.cargo/config.toml`
  在目录内自然被覆盖），行尾归一（`\r\n` → `\n`，避免 `autocrlf` 不同的构建机分裂
  指纹）；`rustc -vV` 的 release / commit-hash / commit-date（**不含 host 行**，Windows
  与 Linux 构建机上是同一个编译器；asan profile 由 nightly 编译，编译器身份取
  `rustc +nightly -vV`）；目标三元组与 profile（release / debug / asan；asan 取实际构建
  三元组，Linux x64 是 gnu，见第 3.3 节）。
- **不混入** zig / C 工具链版本：指纹是「版本身份」不是「字节一致」，同源码同 rustc
  下 C 部分的工具链差异不构成版本差异；指纹相同的两个构建产物行为一致。
- **用途**：部署按指纹落位槽位目录 `~/.local/share/<core.deployPrefix>/<指纹>/`
  （`coreDeployDirPath`：产品目录取 `src/config/project.json` 的 `core.deployPrefix` 把
  不同产品的槽位分开，指纹用完整 64 位，与按指纹命名的 daemon 状态 / 日志文件
  （`core-daemon-<指纹>.*`，[docs/core/core-remote.md 第 2.3 节](core-remote.md#23-状态文件)）同口径）；自带的
  `ripgrep/` 提升为产品目录的共享位（见第 3.1 节）。多版本 Core 在同一台
  机器上各占一个槽位、各跑一个 daemon，互不覆盖、互不换血；部署以「指纹槽位
  存在即同版本」为准，**不做产物哈希比对**——槽位存在就不再上传，缺失才部署
  并拉起。Electron / vsix 打包把 `fingerprint` 文件与产物一起携带，宿主运行时经
  `readCoreFingerprint` 读取（缺失 / 格式非法抛错，不猜）。

---

## 4. 契约

- Core 实现 core 侧：发 `CoreEvent` 与 `CoreRequest`，收 `UiEvent`，
  回 `CoreRequestResultMap` 的结果。
- 用户消息进入 core 的唯一入口是 `UiEvent.userMessageSubmitted`；宿主不直接调用会话引擎。
- 工具权限按会话的 agentMode 加工：`manual` 保持工具自身判定（只读直接放行、写操作询问）、
  `risk` 危险操作仍询问而普通操作放行、`auto` 把询问放行——但 `AskUserQuestion` 在 `auto`
  下直接拒绝（提问框不可用，拒绝文案由权限对照表锁定）。危险操作口径（破坏性命令 / Bash detach 逃生）见 [bash-detach.md 第 2 节](../features/bash-detach.md#2-功能需求)。
  `ask` 表示「需要弹确认框」，由 Core 再发一次 `CoreRequest.userChoice` 取用户选择；
  权限结果的语义是「保持询问」而不是「拒绝」。
- 载荷字段名与 TypeScript 类型逐项一致（`camelCase` 原样）。
- `CoreEvent` 的每个 `type` 语义唯一确定（[docs/architecture/events.md 第 2.1 节](../architecture/events.md#21-coreeventcore--ui单向)）。
- `CoreRequest` 的两个请求（`toolPermissionRequested` / `userChoice`）由 Core 发起、UI 应答。`userChoice` 的载荷与结果按 `kind` 判别：`permission` 带 `message` / `choices`、结果为 `index` / `reply`；`question`（AskUserQuestion）带 `questions`、结果为 `answers`。
- `UiRequest` 的十四个请求（`conversationListRequested` / `smartNamingRequested` / `balanceRequested` /
  `compactArchiveRequested` / `mcpServersRequested` / `conversationSpacesRequested` / `flushSessionRequested` /
  `conversationLoadRequested` / `sessionTodosRequested` / `skillsRequested` / `spinDesignRequested` /
  `spinDesignSaveRequested` / `watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested`）由 UI 发起、Core 应答：
  宿主不直接读 core 的磁盘数据（[docs/core/standalone-core-boundaries.md 第 2 节](standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。未知类型一律回 `ok:false` 的响应，
  不做静默降级。
  - `balanceRequested`：唯一的异步应答——请求交独立线程执行、应答异步回写同 `id` 的
    `response` 帧；整体超时 3 秒，超时 / 非 2xx / 缺 `balance_infos` 都回 `null`。
  - `spinDesignRequested { sessionId }`：按会话工作目录读 `spin.json` + 设计器技能清单；
    返回 `{ status: 'ok', data, skills }`（`data: null` = 没有设计文件）或
    `{ status: 'error', message }`。
  - `spinDesignSaveRequested { sessionId, data }`：按会话工作目录写 `spin.json`，与 SpinLoop
    的节点 meta 更新共用同一把写锁；返回 `{ status: 'ok' }` 或 `{ status: 'error', message }`。
- 配置不走请求：Core 不读 `settings.json` / `mcp.json`，也不请求写配置；配置由 UI 经
  `hostEnvironmentProvided` 的快照下发（[docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)）。
  设置面板的整段 mutation（provider 表 + `modelConfigs` 补齐 + 顶层默认值 + MCP
  默认启用列表）在 UI 侧执行，写盘后重新推整份快照——Core 侧没有「保存配置」这条通路。
- Core 不感知语言：`hostEnvironmentProvided` 没有 locale 字段，也没有与语言相关的请求。
  Core 面向界面的文本以「键 + 参数」表达（`CoreEvent.notice`、内置命令描述），
  翻译在 UI（[docs/architecture/core-ui-separation.md 第 4.8 节](../architecture/core-ui-separation.md#48-文本语言)/[第 4.9 节](../architecture/core-ui-separation.md#49-瞬时状态通知)）。
- 边界语义沿用 [docs/architecture/core-ui-separation.md 第 3.5 节](../architecture/core-ui-separation.md#35-日志)，在帧通道上如此落地：
  - UI 侧 `onCoreEvents` 尚未注册时到达的 `CoreEvent` 先缓存，注册后按序补投；
  - 某 `UiEvent` 在 Core 侧无消费者 → 丢弃并记录；
  - `request()` 不内置超时；UI 侧未注册 `CoreRequest` 处理器时回 `ok: false` 的响应，
    不让对端挂起。
- 协议版本在握手中校验；不匹配时 Core 拒绝服务并退出，UI 报错。
- 事件类型未知视为契约漂移：该帧被丢弃并记录，连接保持。

---

## 5. 传输与协议

### 5.1 帧

- 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧；帧内换行以 JSON 转义表达，帧边界
  只由 `\n` 决定；无帧大小上限，按行读取。

### 5.2 帧类型

| 方向 | 帧 | 载荷 |
| --- | --- | --- |
| UI → Core | `hello` | `{ kind: 'hello', protocol: 2 }` |
| Core → UI | `ready` | `{ kind: 'ready' }` |
| Core → UI | `event` | `{ kind: 'event', event: CoreEvent }` |
| Core → UI | `request` | `{ kind: 'request', id: number, request: CoreRequest }` |
| Core → UI | `response` | `{ kind: 'response', id: number, ok: true, result: … }` 或 `{ kind: 'response', id: number, ok: false, error: string }`（应答 UI → Core 的 `request`） |
| UI → Core | `request` | `{ kind: 'request', id: number, request: UiRequest }` |
| UI → Core | `response` | 同上形状（应答 Core → UI 的 `request`） |
| UI → Core | `uiEvent` | `{ kind: 'uiEvent', event: UiEvent }` |
| UI → Core | `shutdown` | `{ kind: 'shutdown' }` |

- `request` 的 `id` 由**发起方**生成（Core 发 `CoreRequest`、UI 发 `UiRequest` 各自编号），
  在单个连接内唯一；`response` 回带同一个 `id`。帧按写入顺序处理，但 `request` 的应答
  顺序不受此约束——`balanceRequested` 在独立线程查余额，应答可晚于其后帧的应答（第 4 节）。

### 5.3 握手

1. UI 启动 Core 进程后发送 `hello`。
2. Core 校验 `protocol`：通过则回帧 `ready`；不通过则写诊断并退出。
3. UI 收到帧 `ready` 后，先发 `hostEnvironmentProvided`（含配置快照与 MCP 服务器表），
   再按原顺序发出排队的其它 `uiEvent`。
4. Core 处理完 `hostEnvironmentProvided` 后发出 `CoreEvent.coreReady`；在此之前收到任何
   `UiEvent` 都抛错（[docs/architecture/core-ui-separation.md 第 7 节](../architecture/core-ui-separation.md#7-core-就绪)）。

注意区分帧 `ready`（握手通过）与 `CoreEvent.coreReady`（Core 就绪）：前者是传输层事实，
后者是 Core 业务状态。

### 5.4 关闭

- UI 发 `shutdown`；Core 结束在跑的工作、释放 MCP 子进程、以退出码 0 退出。
- UI 在等待超时后终止进程；本地 stdio 的等待上限是 2 秒（`CoreProcess` 的
  `DEFAULT_SHUTDOWN_TIMEOUT_MS`），给宿主的 `deactivate` 时限留出余量。
- 宿主进程退出时同步结束本次启动的 Core 子进程（`process` 的 `exit` 事件，不等
  `shutdown` 应答）。扩展升级替换 / 崩溃导致 `deactivate` 不执行时，这条是兜底。
- Core 自己另有父进程看门狗：启动时记录父 PID，每 1 秒探测一次，父进程不存在即退出
  （Unix `kill(pid, 0)`、Windows `OpenProcess` + `WaitForSingleObject`）。宿主被强杀
  或标准输入 EOF 迟到时由它结束进程；无权限查询按存活处理，避免误杀。

### 5.5 背压

- 不丢帧、不合并帧；帧顺序在单方向内保持。
- 写入方维护有序出站队列，底层流接受数据时按序冲刷：UI 侧在 `write()` 返回 false 时等待
  `drain`；Core 侧用阻塞写。
- 出站队列越过软水位时记录诊断；不因此丢弃帧。
- 读取方逐行读取，不阻塞同进程的其它工作。

---

## 6. 生命周期

| 阶段 | 行为 |
| --- | --- |
| 启动 | 本地工作区由宿主直接以 `stdio` 启动 Core；远程工作区经 daemon 启动；随后完成握手 |
| 就绪前 | UI 侧 `CoreEvent` 处理器已注册；`uiEvent` 帧在 Client 侧排队，不投递 |
| 就绪 | Core 处理完 `hostEnvironmentProvided` 后发 `CoreEvent.coreReady`；Client 解除门禁 |
| 运行 | UI 把 `emitToCore` 写为 `uiEvent` 帧；Core 把 `emitToUi` / `request` 写为帧；`request` 的响应回带 `id` |
| 实例边界 | 一个工作区拥有一个 Core 进程；连接结束即标准输入关闭；父进程消失即退出（看门狗） |
| 终止 | 关闭工作区时，Client 发 `shutdown`，等待 Core 退出；超时后由宿主（本地 `stdio`）或 daemon（远程）强制结束 |
| 崩溃 | 未决 `request` 全部 reject；daemon 重启 Core 进程并恢复接线（第 6.1 节） |

### 6.1 崩溃与重启

- **触发**：Core 进程在收到 `shutdown` 之前退出，或帧通道意外关闭。
- **即时处理**：未决 `request` 全部 reject；Client 把受影响会话的在跑工作标记为失败，并写入
  一条错误消息。
- **重启**：daemon 以退避策略重启 Core 进程（[docs/core/core-daemon.md 第 5 节](core-daemon.md#5-生命周期与计数)）；重启后重新
  握手，重放 `hostEnvironmentProvided`（含配置快照），并对已打开的会话逐个发
  `conversationOpened`（会话工作目录由 Core 读 `meta.json` 的 `project` 自行恢复）。
- **恢复**：会话数据在磁盘上，重启后按需重建引擎；进程内未落盘的在跑工作不恢复。
- **上限**：时间窗口内重启次数超过上限时停止重启并报告，不静默重试。
- **隔离**：一个 Connection 的 Core 崩溃不影响其它 Connection；每个工作区有自己的 Core 进程。

### 6.2 连接态重放

- 连接态事件（`hostEnvironmentProvided`）保留最后一次取值，每次握手后重放。
- `hostEnvironmentProvided` 的重放排在最前，其余重放（`conversationOpened` 等）在其后。
- 宿主已打开的会话集合由 Client 侧维护；每次握手后逐个重放 `conversationOpened`。
- 就绪前发出的其它 `UiEvent` 在 Client 侧排队，握手后按原顺序发出。
- 重放由总线适配器承担，业务代码不感知重连。

---

## 7. 事实归属

Standalone Core 下，core 侧事实的归属与 [docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)、[第 5 节](../architecture/core-ui-separation.md#5-core-的部署形态)一致。

| 事实 | owner | 说明 |
| --- | --- | --- |
| 全局配置 / MCP 配置 `~/<CONFIG_DIR_NAME>/{settings,mcp}.json` | UI | 读与写都在 UI；Core 只消费快照 |
| 配置快照 | UI 提供，Core 消费 | 经 `UiEvent.hostEnvironmentProvided`，一次全量 |
| 内置模型注册表 | UI | 合并进快照的 `modelLimits`；Core 不持有 |
| 项目清单 `<conversations>/<project>/workspace.meta.json` | Core | 在 Core 数据目录内，读与写都在 Core |
| 会话数据（元数据 / 消息 / 归档） | Core | 落盘格式（meta.json / JSONL），宿主侧 `src/shared/history/` 是同一格式的 TS 读写库 |
| 会话独占锁 `<conversations>/<project>/<sessionId>.session.lock` | Core | OS 建议性文件锁（`core-rs/src/session_lock.rs`）；宿主侧不读写。文件内容（版本 / pid / 启动时刻）只作诊断与版本拒外（specs/032） |
| Spin 设计 `<conversations>/<project>/spin.json` | Core | 读与写都经 `UiRequest.spinDesignRequested` / `spinDesignSaveRequested`；宿主不直接读盘 |
| 会话工作目录表 | Core | 单目录宿主（VS Code）在会话首次解析目录前经 `UiEvent.sessionWorkspaceAssigned` 登记；多工作目录宿主（Electron）按来源视图登记；加载对话后由 `meta.json` 的 `project` 校正 |
| 工具执行 | Core | 在 Core 所在机器操作文件系统 |
| MCP 子进程 | Core | 生命周期由 Core 管理 |
| ripgrep | Core | 随 Core 分发：与可执行文件同级（`<exe 目录>/ripgrep/`），本地与远端上传是同一目录 |
| 宿主环境（extensionPath / logToConsole / configDirName） | UI 提供，Core 消费 | 经 `UiEvent.hostEnvironmentProvided` |
| 会话工作目录 | UI 提供，Core 消费 | 经 `UiEvent.sessionWorkspaceAssigned` |
| 日志行 | Core 产生 | 经 `CoreEvent.log` 上报；stderr 仅诊断 |
| 界面表现（diff / Mermaid / 外链 / 另存为） | UI | 不进 Core |
| i18n（翻译表与语言选择） | UI | Core 不感知语言，面向用户的文本以键 + 参数表达 |
