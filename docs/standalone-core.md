# 规格：Standalone Core（Rust）

本规格描述 Core 的第二种实现——Standalone Core。Core 与 UI 的分离形态见
`docs/core-ui-separation.md`；本规格在其基础上确定 Standalone Core 的进程形态、选择方式、
传输协议与事实归属。连接模型（Client / Connection / 工作区引用）见
`docs/client-connection.md`；Core 进程的 daemon 见 `docs/core-daemon.md`。
事件词汇表见 `DEVELOPMENT.md` 第 3、4 节。

---

## 1. 能力

1. **两种实现并存**：Embedded Core（`src/core`，TypeScript，与 UI 同进程）与
   Standalone Core（Rust，独立进程）实现同一份 core 侧契约。
2. **一个选择变量**：装配哪种 Core 由单一变量 `CORE_KIND` 决定，取值 `embedded` /
   `standalone`；本规格落地时该变量写死为 `standalone`。
3. **契约不变**：两种实现对 UI 呈现同一份 `CoreEvent` / `CoreRequest` / `UiEvent` 词汇表，
   载荷字段逐项一致。
4. **独立进程**：Standalone Core 是独立的可执行文件，承载 core 侧全部职责
   （引擎、工具、历史、MCP 子进程、技能）。
5. **平台范围**：当前产出 Windows x64；目标矩阵预留 Windows / Linux × x64 / arm64。
6. **一条帧通道**：UI 与 Standalone Core 之间只有一条双向帧通道；UI 为客户端，Core 为服务端。
7. **一个工作区一个 Core 进程**：每个打开的工作区对应一个 Core 进程；一个 Core 进程只服务
   它的 Connection（`docs/client-connection.md` 第 5 节）。
8. **生命周期归 daemon**：Core 进程由 daemon 启动、终止与重启；daemon 见
   `docs/core-daemon.md`。
9. **崩溃可恢复**：Core 进程意外退出后由 daemon 重启并恢复接线；单个 Connection 的 Core
   崩溃不影响其它 Connection。

### 1.1 落地阶段

Core 侧业务按里程碑迁入 Core 进程（见 `TODO.md`）。当前：

- `UiEvent` 只经帧通道进入 Core 进程；进程内不注册 core 侧订阅，也不建会话队列；
- 用户消息经 `UiEvent.userMessageSubmitted` 进入 Core，宿主不直接调用引擎；
- Core 进程承担：握手、帧通道、连接态重放、日志上报，以及会话引擎、
  内置工具（含后台 Bash、子代理与 Skill）、会话落盘、项目清单读写、
  技能加载与斜杠命令解析（`CommandDispatcher` + 内置命令 + 技能命令）、
  对话压缩（自动 / 手动触发、摘要生成、归档与 `messagesReplaced` 重放）、
  Responses API（`apiType='Responses'`，含内置 Web Search 的缺口见 `TODO.md`）、
  MCP（stdio / Streamable HTTP / 旧版 SSE 三种传输、连接池与会话引用、
  `mcp__*` 工具注入与按会话启用列表过滤）、
  Spin 引擎（`spin.json` 读写、拓扑排序、子代理执行、验收判定、`/spin` 命令）、
  智能命名 / 压缩归档展开 / DeepSeek 余额推送（都要读 core 的磁盘数据，因此整体在 Core 侧）；
- 全局配置与 MCP 配置的读写**不在** Core 侧：两者由 UI 持有，经
  `hostEnvironmentProvided` 的配置快照下发（`docs/core-ui-separation.md` 第 4 节）；
- 尚未迁入的部分见 `TODO.md`「已知缺口」与 `DIFF.md` 第 3 节。

尚未迁入的能力在 Core 侧表现为明确的提示消息或缺失，不做静默降级。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| Core 实现 | core 侧契约的一套实现 | — |
| Embedded Core | `src/core` 的 TypeScript 实现，与 UI 同进程 | core |
| Standalone Core | Rust 实现，独立进程 | core |
| 选择变量 | `CORE_KIND`：装配哪种 Core 实现 | host（bootstrap） |
| 帧 | 帧通道上的一条 UTF-8 换行分隔 JSON 消息 | 传输层 |
| 帧通道 | UI 与 Standalone Core 之间的双向字节流 | 传输层 |
| 客户端 / 服务端 | 帧通道两端；UI 为客户端，Core 为服务端 | 传输层 |
| 握手 | 通道建立后的协议版本确认 | 传输层 |
| 会话 | 一段对话的引擎实例与磁盘数据 | core |
| 宿主实例 | 一个 UI 进程（VS Code 扩展宿主 / Electron 主进程） | UI |
| Core 实例 | 一个 Standalone Core 进程，归属一个工作区的 Connection | daemon 启动，Core 自身 |
| 重启 | Core 实例意外退出后由 daemon 重新启动并恢复接线 | daemon（`docs/core-daemon.md`） |
| Core 可执行文件名 | `core.binaryName`（`src/config/project.json`），Windows 加 `.exe` | 工程配置 |
| Core 产物目录 | `resources/<core.resourceDir>/<arch>-<platform>/` | 工程配置 |

产品名、可执行文件名与产物目录名一律取自 `src/config/project.json`；代码与 Rust 包名
不出现产品名。

事件词汇表的 owner 见 `docs/core-ui-separation.md` 第 2 节。

---

## 3. 选择变量

- 名称 `CORE_KIND`；类型 `CoreKind = 'embedded' | 'standalone'`。
- 位置：`src/host/coreKind.ts`。该模块是选择值的唯一来源。
- 默认取值：`'standalone'`。
- 构建期取值：打包（`esbuild.js` / `electron/esbuild.js`）按环境变量
  `<envPrefix>_<core.envVarSuffix>` 用 esbuild `define` 把取值烧进产物，
  默认 `'standalone'`；`embedded` 变体落在 `release/embedded/`，不构建 Rust Core。
- 覆盖入口：环境变量 `<envPrefix>_<core.envVarSuffix>`（`src/config/project.json`）；
  取值为 `embedded` / `standalone` 时生效，未设置或为空时用默认值。
  覆盖入口供开发与测试装配 `embedded`。
- 解析函数：`resolveCoreKind(env?)`；非法取值抛错，不做回退。
- 读取方：`bootstrapCore` 是唯一读取方；宿主实现不各自判断实现种类。
- 取值的效果：
  - `embedded`：装配进程内 Core（`createEventBus` + `initializeCoreEvents`）；
  - `standalone`：装配帧通道与 Rust Core 进程。

---

## 4. Standalone Core 形态

- 语言与工具链：Rust（edition 2021），Cargo 构建。
- 产物：`core.binaryName`（Windows 加 `.exe`）单文件可执行，外加同级的自带工具目录
  （`ripgrep/`）；**部署单元是整个产物目录**，见第 4.1 节。
- 源码位置：`core-rs/`（Cargo 包，包名与二进制名保持中性；对外文件名由构建脚本按配置落位）。
- 进程属性：由宿主启动时不显示窗口；标准输入 / 标准输出为帧通道，标准错误为诊断输出。
  远程服务（`start` 动作）让 daemon 把控制通道换成 TCP（`docs/core-daemon.md` 第 12 节）。
- 可独立运行：`--help` / `--version` 打印用法与版本；没有动作时按 `start` 处理
  （`docs/core-daemon.md` 第 3 节）。
- 进程工作目录不作为业务事实；会话目录取自 `UiEvent`。
- Core 进程创建的所有子进程（shell、ripgrep、git 等）都不显示控制台窗口；
  每次查询都不产生可见的窗口闪烁。
- 需要反复读取的环境事实（如工作目录的 git 状态）在 Core 进程内缓存，
  不按轮次重复 spawn 子进程。
- Core 创建的每个子进程都不继承帧通道（标准输入置空），工具不会读到协议帧。
- Bash 工具按 `src/core/tools/bash/ShellDetector.ts` 的优先级选择 shell：
  Windows 上 Git Bash 优先，cmd.exe 只在全部探测失败时兜底。
- 后台 Bash 任务（`run_in_background` / 前台超时自动转后台）的输出直接由子进程
  写入 `<TMPDIR|TEMP|/tmp>/tuxedo-cat-tasks/<taskId>.output`（对齐
  `tools/bash/TaskOutput.ts` 的 file mode）；任务完成后 Core 把一条
  `origin='bash'` 的完成通知作为 user 消息注入该会话并唤醒消费循环，
  会话关闭 / 中止时终止该会话的全部后台任务。
- 前台 Bash 的超时与中止判定不依赖子进程是否已退出：子进程退出后还要等管道 EOF
  （孙进程可能继承了管道写端，例如 `start` 拉起的 detached daemon），这段时间里
  前台超时照常转后台、abort 照常按中断收尾——对齐 `src/core/tools/bash/Exec.ts`
  的定时器与 abort 监听，二者都与子进程状态无关。

### 4.1 平台矩阵

| 平台 | 架构 | 目标三元组 | 产物目录（`<core.resourceDir>` = `core`） | 状态 |
| --- | --- | --- | --- | --- |
| Windows | x64 | `x86_64-pc-windows-msvc` | `resources/core/x64-win32/` | 产出 |
| Windows | arm64 | `aarch64-pc-windows-msvc` | `resources/core/arm64-win32/` | 预留 |
| Linux | x64 | `x86_64-unknown-linux-musl` | `resources/core/x64-linux/` | 产出（静态 musl；Windows 上交叉编译，见第 4.3 节） |
| Linux | arm64 | `aarch64-unknown-linux-musl` | `resources/core/arm64-linux/` | 预留 |

产物目录命名与 `resources/ripgrep/` 一致。宿主按运行平台的平台名 / 架构名解析产物目录，
不写死单一平台。

**部署单元**：一个产物目录 = 一个自包含单元，除可执行文件外还有 Core 自带的工具目录
（当前只有 `ripgrep/rg[.exe]`）。Core 以**自己的可执行文件所在目录**为基准
定位自带资源（`tools.rs::ripgrep_path`），因此本地起进程与远端上传用的都是这一个位置，
不依赖宿主提供 `extensionPath`：

```
resources/core/x64-win32/tuxedo-cat-core.exe
resources/core/x64-win32/ripgrep/rg.exe
```

### 4.2 跨平台预留约束

- Core 侧不依赖 Windows 专有 API；平台差异收敛在少量模块：进程管理、路径处理、
  shell 探测、资源定位。
- 构建脚本按目标三元组参数化；当前产出 Windows x64 与 Linux x64（musl 静态）。
  Linux 目标在 Windows 上直接交叉编译（rust-lld + zig，见第 4.3 节），不需要 Linux 环境。
- 宿主侧的启动、帧通道与契约不随平台变化。
- 新增平台时只补产物目录与构建目标，不改契约与磁盘格式。

平台差异的实际落点（审查口径，见 `TODO.md` M8-353）：

| 关注点 | 落点 | 平台差异的处理 |
| --- | --- | --- |
| 进程管理 | `bash_task.rs::kill_tree`、`mcp.rs` 的子进程终止 | `#[cfg(windows)]` 走 `taskkill /T /F`；非 Windows 走 `Child::kill`，与 Embedded（Node `detached: true` + `childProcess.kill()`，同样只杀直接子进程）逐字对齐 |
| 路径处理 | `util.rs` 的 `normalize_path` / `expand_path`、`config.rs` 的 `encodeURIComponent` 等价物 | 盘符与 UNC 的换算都在 `cfg!(windows)` 分支内；非 Windows 走 POSIX 分支，多字节路径按字节比较 |
| shell 探测 | `shell.rs::detect` | 非 Windows 直接用 `$SHELL`（缺省 `/bin/bash`）；Windows 才走 Git Bash → PowerShell → cmd.exe 的优先级 |
| 资源定位 | `tools.rs::ripgrep_path` / `get_pandoc_path`、`config.rs::extension_path` | Core 自带产物以**自己的可执行文件目录**为基准（`<exe 目录>/ripgrep/rg[.exe]`），宿主 `extensionPath` 只作本机开发期的兜底、最后回退 PATH；可执行名按 `cfg!(windows)` 加 `.exe`；产物目录按 `<arch>-<platform>` 解析，矩阵外直接拒绝而不是猜一个目录 |
| 主目录 | `config.rs::home_dir` | `USERPROFILE` 优先、`HOME` 兜底，两者都缺才报错 |
| 系统语言 | 宿主：`src/host/i18n.ts::getSystemLocale`（不在 Core 侧） | 仅 Windows 查 PowerShell `Get-UICulture`；其余平台读 `LANG` / `LC_ALL` |
| 控制台窗口 | `util.rs::hide_console` | 仅 Windows 设 `CREATE_NO_WINDOW`，非 Windows 是空操作 |

矩阵一致性由 `src/test/corePlatformMatrix.test.ts` 锁定：构建脚本的目标登记、
运行时的目录解析、产物落位三处必须两两一致，矩阵外的平台组合必须被拒绝。

### 4.3 构建与目标平台

Linux 产物一律用 **musl**：静态链接、不依赖目标机器的 glibc 版本。这个 core 要拷到别人的
远端机器上跑，发行版未知，gnu 目标很容易撞上 glibc 太旧。

| 目标 | 三元组 | 产物目录 |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | `resources/core/x64-win32/` |
| Linux x64 | `x86_64-unknown-linux-musl` | `resources/core/x64-linux/` |
| Windows arm64 | `aarch64-pc-windows-msvc` | `resources/core/arm64-win32/` |
| Linux arm64 | `aarch64-unknown-linux-musl` | `resources/core/arm64-linux/` |

```bash
npm run build:core            # 打包要携带的全部目标（Windows x64 + Linux x64）
npm run build:core:host       # 只建当前平台 / 架构（本地调试用）
npm run build:core:linux-x64  # 只建 Linux x64（Windows 上就是交叉编译，不需要 WSL）
```

`build-core.mjs` 的目标分三档：不带参数时构建 `PACKAGE_DIRS`（打包要携带的 Windows x64 +
Linux x64，本机构建不了的组合跳过并说明）；`--host` 只建当前平台 / 架构；`--target <三元组>`
只建指定目标。本地调试（`dev:electron`、`watch:app` 的 Rust 重建）走 `--host`，不白编 Linux 那份。

交叉编译到 Linux 需要两样东西，**都在本机解决，不用 Linux 环境**：

1. **Rust 目标与链接器**：`rustup target add x86_64-unknown-linux-musl`。链接器用 rustup
   自带的 `rust-lld` + self-contained 的 musl crt / libc（配在 `core-rs/.cargo/config.toml`），
   不需要系统上的交叉链接器。
2. **C 编译器**：`ring`（`reqwest` 的 `rustls-tls` 依赖）里有 C + 汇编，cc-rs 需要一个能产出
   该目标文件的 C 编译器。用 [zig](https://ziglang.org/)：它自带 clang 与 musl 头文件 / libc，
   一个可执行文件就够。装好保证 `zig` 在 PATH 上即可（装在别处用环境变量 `ZIG` 指定）；
   构建脚本会注入 `CC` / `CFLAGS` / `AR`，缺 zig 时直接报错、不静默降级。

打包（`npm run package:ext` / `package:app`）会校验要携带的 Core 产物
（`scripts/verify-core-artifacts.mjs`）：产物缺失、比 `core-rs/src/**` 旧、或没同步进
`dist/resources/` 都直接报错。平台列表取自构建脚本的 `PACKAGE_DIRS`，两处不各写一份。
`build:core` 默认就构建这两个平台，所以打包链不会再漏掉 Linux 那份；校验仍然拦住
「改了 Rust 源码没重编」与「`copy-assets` 没跑」——那两种情况会把上一次的旧产物
静默打进 vsix / 安装包。

**预留平台**：Windows arm64 / Linux arm64 已登记目标与产物目录（矩阵一致性由
`src/test/corePlatformMatrix.test.ts` 锁定），但还没有实际产物。已实测的阻塞：

- **Windows arm64**：构建会停在 `ring` 的自定义构建脚本上，报 `failed to find tool "clang"`。
  `ring` 含 ARM64 汇编，交叉编译需要 clang 与 ARM64 的 MSVC 链接器；只装 Rust target 不够。
- **Linux arm64**：同理需要 `aarch64-unknown-linux-musl` 的 C 交叉工具链（zig 支持
  `aarch64-linux-musl`，但 `ring` 的 ARM64 汇编路径尚未实测）。

这与第 11 节「目标矩阵中预留平台的实际产出」不属于覆盖范围一致。

---

## 5. 契约

- Standalone Core 实现 core 侧：发 `CoreEvent` 与 `CoreRequest`，收 `UiEvent`，
  回 `CoreRequestResultMap` 的结果。
- 用户消息进入 core 的唯一入口是 `UiEvent.userMessageSubmitted`；宿主不直接调用会话引擎。
- 工具权限按会话的 agentMode 加工：`manual` 一律询问、`risk` 只拦截危险操作、`auto` 全放行。
  `ask` 表示「需要弹确认框」，由 Core 再发一次 `CoreRequest.userChoice` 取用户选择；
  权限结果的语义是「保持询问」而不是「拒绝」。
- 载荷字段名与 TypeScript 类型逐项一致（`camelCase` 原样）。
- `CoreEvent` 的每个 `type` 在两种实现下语义一致（`DEVELOPMENT.md` 第 4.1 节）。
- `CoreRequest` 的两个请求（`toolPermissionRequested` / `userChoice`）由 Core 发起、UI 应答。
- `UiRequest` 的四个请求（`conversationListRequested` / `smartNamingRequested` /
  `balanceRequested` / `compactArchiveRequested`）由 UI 发起、Core 应答：
  宿主不直接读 core 的磁盘数据（第 10 节）。未知类型一律回 `ok:false` 的响应，
  不做静默降级。
- 配置不走请求：Core 不读 `settings.json` / `mcp.json`，也不请求写配置；配置由 UI 经
  `hostEnvironmentProvided` 的快照下发（`docs/core-ui-separation.md` 第 4 节）。
  设置面板的整段 mutation（provider 表 + `modelConfigs` 补齐 + 顶层默认值 + MCP
  默认启用列表）在 UI 侧执行，写盘后重新推整份快照——Core 侧没有「保存配置」这条通路。
- Core 不感知语言：`hostEnvironmentProvided` 没有 locale 字段，也没有与语言相关的请求。
  Core 面向界面的文本以「键 + 参数」表达（`CoreEvent.notice`、内置命令描述），
  翻译在 UI（`docs/core-ui-separation.md` 第 4.8 / 4.9 节）。
- 边界语义沿用 `docs/core-ui-separation.md` 第 3.5 节，在帧通道上如此落地：
  - UI 侧 `onCoreEvents` 尚未注册时到达的 `CoreEvent` 先缓存，注册后按序补投；
  - 某 `UiEvent` 在 Core 侧无消费者 → 丢弃并记录；
  - `request()` 不内置超时；UI 侧未注册 `CoreRequest` 处理器时回 `ok: false` 的响应，
    不让对端挂起。
- 协议版本在握手中校验；不匹配时 Core 拒绝服务并退出，UI 报错。
- 事件类型未知视为契约漂移：该帧被丢弃并记录，连接保持。

---

## 6. 传输与协议

### 6.1 帧

- 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧。
- 帧内换行以 JSON 转义表达；帧边界只由 `\n` 决定。
- 无帧大小上限，按行读取。

### 6.2 帧类型

| 方向 | 帧 | 载荷 |
| --- | --- | --- |
| UI → Core | `hello` | `{ kind: 'hello', protocol: 1 }` |
| Core → UI | `ready` | `{ kind: 'ready' }` |
| Core → UI | `event` | `{ kind: 'event', event: CoreEvent }` |
| Core → UI | `request` | `{ kind: 'request', id: number, request: CoreRequest }` |
| UI → Core | `response` | `{ kind: 'response', id: number, ok: true, result: … }` 或 `{ kind: 'response', id: number, ok: false, error: string }` |
| UI → Core | `uiEvent` | `{ kind: 'uiEvent', event: UiEvent }` |
| UI → Core | `shutdown` | `{ kind: 'shutdown' }` |

- `id` 由 Core 生成，在单个连接内唯一；`response` 回带同一个 `id`。
- 同一方向上的帧按写入顺序处理。

### 6.3 握手

1. UI 启动 Core 进程后发送 `hello`。
2. Core 校验 `protocol`：通过则回帧 `ready`；不通过则写诊断并退出。
3. UI 收到帧 `ready` 后，先发 `hostEnvironmentProvided`（含配置快照与 MCP 服务器表），
   再按原顺序发出排队的其它 `uiEvent`。
4. Core 处理完 `hostEnvironmentProvided` 后发出 `CoreEvent.coreReady`；在此之前收到任何
   `UiEvent` 都抛错（`docs/core-ui-separation.md` 第 7 节）。

注意区分帧 `ready`（握手通过）与 `CoreEvent.coreReady`（Core 就绪）：前者是传输层事实，
后者是 Core 业务状态。

### 6.4 关闭

- UI 发 `shutdown`；Core 结束在跑的工作、释放 MCP 子进程、以退出码 0 退出。
- UI 在等待超时后终止进程。

### 6.5 背压

- 不丢帧、不合并帧；帧顺序在单方向内保持。
- 写入方维护有序出站队列，底层流接受数据时按序冲刷：UI 侧在 `write()` 返回 false 时等待
  `drain`；Core 侧用阻塞写。
- 出站队列越过软水位时记录诊断；不因此丢弃帧。
- 读取方逐行读取，不阻塞同进程的其它工作。

---

## 7. 生命周期

| 阶段 | 行为 |
| --- | --- |
| 启动 | 打开工作区时，Client 经 daemon 请求一个 Core 进程；daemon 起进程，完成握手 |
| 就绪前 | UI 侧 `CoreEvent` 处理器已注册；`uiEvent` 帧在 Client 侧排队，不投递 |
| 就绪 | Core 处理完 `hostEnvironmentProvided` 后发 `CoreEvent.coreReady`；Client 解除门禁 |
| 运行 | UI 把 `emitToCore` 写为 `uiEvent` 帧；Core 把 `emitToUi` / `request` 写为帧；`request` 的响应回带 `id` |
| 实例边界 | 一个工作区拥有一个 Core 进程；连接结束即标准输入关闭 |
| 终止 | 关闭工作区时，Client 发 `shutdown`，等待 Core 退出；超时后由 daemon 强制结束 |
| 崩溃 | 未决 `request` 全部 reject；daemon 重启 Core 进程并恢复接线（第 7.1 节） |

### 7.1 崩溃与重启

- **触发**：Core 进程在收到 `shutdown` 之前退出，或帧通道意外关闭。
- **即时处理**：未决 `request` 全部 reject；Client 把受影响会话的在跑工作标记为失败，并写入
  一条错误消息。
- **重启**：daemon 以退避策略重启 Core 进程（`docs/core-daemon.md` 第 5 节）；重启后重新
  握手，重放 `hostEnvironmentProvided`（含配置快照），并对已打开的会话逐个发
  `conversationOpened`（会话工作目录由 Core 读 `meta.json` 的 `project` 自行恢复）。
- **恢复**：会话数据在磁盘上，重启后按需重建引擎；进程内未落盘的在跑工作不恢复。
- **上限**：时间窗口内重启次数超过上限时停止重启并报告，不静默重试。
- **隔离**：一个 Connection 的 Core 崩溃不影响其它 Connection；每个工作区有自己的 Core 进程。

### 7.2 连接态重放

- 连接态事件（`hostEnvironmentProvided`）保留最后一次取值，每次握手后重放。
- `hostEnvironmentProvided` 的重放排在最前，其余重放（`conversationOpened` 等）在其后。
- 宿主已打开的会话集合由 Client 侧维护；每次握手后逐个重放 `conversationOpened`。
- 就绪前发出的其它 `UiEvent` 在 Client 侧排队，握手后按原顺序发出。
- 重放由总线适配器承担，业务代码不感知重连。

---

## 8. 事实归属

Standalone Core 下，core 侧事实的归属与 `docs/core-ui-separation.md` 第 4、5 节一致。

| 事实 | owner | 说明 |
| --- | --- | --- |
| 全局配置 `~/<CONFIG_DIR_NAME>/settings.json` | UI | 读与写都在 UI；Core 只消费快照 |
| MCP 配置 `~/<CONFIG_DIR_NAME>/mcp.json` | UI | 读与写都在 UI；Core 只消费快照 |
| 配置快照 | UI 提供，Core 消费 | 经 `UiEvent.hostEnvironmentProvided`，一次全量 |
| 内置模型注册表 | UI | 合并进快照的 `modelLimits`；Core 不持有 |
| 项目清单 `<conversations>/<project>/workspace.meta.json` | Core | 在 Core 数据目录内，读与写都在 Core |
| 会话数据（元数据 / 消息 / 归档） | Core | 落盘格式与 Embedded 一致 |
| 会话工作目录表 | Core | 单目录宿主（VS Code）在会话首次解析目录前经 `UiEvent.sessionWorkspaceAssigned` 登记；多工作目录宿主（Electron）按来源视图登记；加载对话后由 `meta.json` 的 `project` 校正 |
| 工具执行 | Core | 在 Core 所在机器操作文件系统 |
| MCP 子进程 | Core | 生命周期由 Core 管理 |
| ripgrep / pandoc | Core | 随 Core 分发并定位：与 Core 可执行文件同级（`<exe 目录>/ripgrep/`），本地起进程与远端上传的是同一个目录 |
| 宿主环境（extensionPath / logToConsole / configDirName） | UI 提供，Core 消费 | 经 `UiEvent.hostEnvironmentProvided` |
| 会话工作目录 | UI 提供，Core 消费 | 经 `UiEvent.sessionWorkspaceAssigned` |
| 日志行 | Core 产生 | 经 `CoreEvent.log` 上报；标准错误仅用于诊断 |
| 界面表现（diff / Mermaid / 外部链接 / 另存为） | UI | 不进 Core |
| i18n（翻译表与语言选择） | UI | Core 不感知语言，面向用户的文本以键 + 参数表达 |

---

## 9. 与 Embedded Core 的对等

两种实现对同一串 `UiEvent` 产生同一串 `CoreEvent`。对等范围：

1. 用户消息管线（`docs/user-message-pipeline.md`）；
2. 命令在轮次边界解析（内置命令就地执行 / 技能命令注入 Skill tool_use）；
3. 工具执行与权限策略（含 `Skill` 的末位不变式）；
4. 会话运行时状态（`idle` / `waiting`）；
5. 历史落盘格式与目录布局（含项目清单 `workspace.meta.json`）；
6. 配置快照的消费（同一份快照 → 同一组行为；两种实现都不读配置文件）；
7. MCP 会话引用与工具过滤；
8. 技能加载与注入（frontmatter 解析 / 变量替换 / 目录扫描 / 内置注册）；
9. 压缩与归档（阈值 / 触发点 / 摘要 prompt / 归档文件 / `messagesReplaced`）；
10. 就绪判据（处理完 `hostEnvironmentProvided` 后发 `coreReady`）与就绪前的 `UiEvent` 抛错。

差异只在进程边界与资源定位，不在契约与磁盘格式。

---

## 10. 宿主侧的 core 事实读取

`DEVELOPMENT.md` 第 2 节规则 9 允许宿主直接 import core 的只读函数。Standalone Core 下，
core 事实的唯一来源是帧通道：宿主不直接读取 core 的磁盘数据。

| 事实 | Embedded 下的读取 | Standalone 下的来源 |
| --- | --- | --- |
| 对话列表元数据 | `loadConversationList` | `UiRequest.conversationListRequested`（`conversationListChanged` 仍作为「该刷新了」的信号） |
| 会话运行时状态 | `getSessionRuntimeStates` | `sessionRuntimeChanged` 的全量推送（宿主缓存快照） |
| 会话工作目录 | `getSessionWorkspace` | 会话上下文事件（宿主不再读） |
| 压缩归档展开 | core 的归档读取函数 | `UiRequest.compactArchiveRequested` |
| 会话内容 / 元数据 / 派生事实 | `loadConversation` + `hasCompactArchive` + `getPendingToolUseIds` + `getStoredSessionAgentMode` | `UiRequest.conversationLoadRequested` |
| 斜杠命令与技能列表 | `getBuiltinCommands` + `getBundledSkills` + `getSkillDirCommands` | `UiRequest.skillsRequested` |
| MCP 面板列表（配置 + 启用状态 + 运行时状态） | `readMcpServers` + `getMcpManager().getServerStatus()` | `UiRequest.mcpServersRequested` |
| 对话空间统计 | `getConversationSpaces` | `UiRequest.conversationSpacesRequested` |
| 会话挂起持久化收尾 | `QueryEngine.flush()` | `UiRequest.flushSessionRequested` |
| 智能命名 / 余额 | core 模块直接调用 | `UiRequest.smartNamingRequested` / `balanceRequested` |
| Core 就绪 | — | `CoreEvent.coreReady` |

例外（Standalone 下与本机 Core 共用同一份磁盘，远程工作区落地时需要迁到 `UiRequest`）：

| 事实 | 宿主侧读取 | 说明 |
| --- | --- | --- |
| 会话工作目录索引 | `history/Config.ts` 的 `getSessionWorkspace` / `setSessionWorkspace` | 宿主侧另存一份 `sessionId → workspacePath`，只用于「发事件前取会话自己的目录」；权威表在 Core 进程内，由 `sessionWorkspaceAssigned` 同步 |
| 工具 `_meta` 的 before/after | `ToolHandler` → `updateToolUseMeta` | 权限确认时追加写入会话 JSONL；与 Core 的写入共用同一份磁盘 |

以下事实已从「core 事实」移出，归 UI 自己：

| 事实 | 现在归谁 |
| --- | --- |
| UI 语言 | UI：`uiLanguage` 不进快照，Core 不感知 |
| 高亮语言 | UI：webview 扫描并上报，Core 不感知 |
| 配置目录 | UI：`settings.json` / `mcp.json` 的路径由 UI 自己解析，不问 Core |
| 项目清单 | Core：在 Core 数据目录内，由 Core 自己写，不经总线 |

`coreFacts` 是宿主侧的统一入口，按 `CORE_KIND` 分派；随着 UI 语言 / 高亮语言 / 配置目录
三项归 UI，它的职责收缩为「按需向 Core 取数」。

---

## 11. 不覆盖范围

- 跨机器部署与网络传输；
- 网络连接断开后的重连（进程崩溃后的重启见第 7.1 节）；
- 目标矩阵中预留平台的实际产出；
- UI 侧的界面表现与 webview 协议；
- `embedded` 实现的改动；
- daemon 的进程模型与协议（见 `docs/core-daemon.md`）；
- 远程工作区与 endpoint 传输（见 `docs/client-connection.md` 第 9 节）。

---

## 12. 验收要点

1. `CORE_KIND = standalone` 时，打开工作区经 daemon 启动配置中的 Core 可执行文件并完成握手。
2. UI 进程不加载 core 的引擎、工具与历史模块。
3. 帧载荷字段与 `src/core/AssistantEventBus.ts` 的类型逐项一致。
4. 用户消息 → 流式回复 → 工具执行的完整回路可用。
5. 会话数据落盘格式与 Embedded 一致，两实现可互相读取同一目录。
6. 全局配置与 MCP 配置的写入只在 UI 侧发生；Core 侧不存在这两个文件的路径与读写。
7. 项目清单 `workspace.meta.json` 的写入只在 Core 侧发生。
8. Core 处理完 `hostEnvironmentProvided`（含配置快照）前收到 `UiEvent` 抛错；处理完发出
   `CoreEvent.coreReady`。
9. Core 进程被杀死后，daemon 重启它并恢复接线；未决请求 reject，不静默挂起。
10. 两个工作区各自拥有一个 Core 进程；其中一个的 Core 崩溃不影响另一个。
11. 重启次数超过上限时 daemon 停止重启并报告。
12. `CORE_KIND = embedded` 时装配进程内 Core，恒一个 Connection。
13. 产物目录按平台 / 架构解析，Windows x64 与 Linux x64 有实际产物，其余为预留。
14. `start` 打印 `IP:端口` 与 token（daemon 留在后台）；token 不匹配的连接被拒绝。

---

## 13. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 选择变量 | `src/host/coreKind.ts` |
| 帧协议与编解码 | `src/host/standalone/protocol.ts` |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（启动 / 重启 / 终止） | `src/host/standalone/CoreProcess.ts` |
| daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（建链器抽象，见 `docs/core-daemon.md`） |
| SSH 接入（客户端 / 引导 / 建链） | `src/host/standalone/sshClient.ts`、`sshDaemonBootstrap.ts`、`sshTransport.ts`（见 `docs/core-daemon.md` 第 12.8 节） |
| 配置快照 | `src/host/SettingsStore.ts` |
| 平台产物解析 | `src/host/standalone/coreBinary.ts`（产物目录 + 自带的 `ripgrep/`） |
| bootstrap 分支 | `src/host/bootstrapCore.ts` |
| 事件契约 | `src/core/AssistantEventBus.ts` |
| Rust 包 | `core-rs/` |
| 命令行（`--help` / `--version` / 模式） | `core-rs/src/cli.rs` |
| 远程监听 / token / 目录列举 | `core-rs/src/remote.rs`（见 `docs/core-daemon.md` 第 12 节） |
| 构建目标参数化 | `core-rs/.cargo/config.toml`、`scripts/build-core.mjs`（平台矩阵 `TARGETS`、打包集 `PACKAGE_DIRS`） |
| 分发产物 | `resources/core/<platform>-<arch>/`（可执行文件 + 自带的 `ripgrep/`） |

## 14. 测试与覆盖率

### 分层

| 层 | 位置 | 跑法 |
| --- | --- | --- |
| Rust 单元测试 | `core-rs/src/<模块>_tests.rs` | `npm run test:core` |
| Rust 覆盖率 | `scripts/coverage-core.mjs` | `npm run coverage:core`（`--html` / `--check 80`） |
| 协议冒烟（真实产物） | `src/test/standaloneBootstrap.test.ts`、`standaloneCoreEngine.test.ts` | `npm run test:all` |
| 工具与权限（真实产物） | `src/test/standaloneCoreTools.test.ts`、`standaloneCorePermission.test.ts` | `npm run test:all` |
| 两种实现对等 | `src/test/permissionParity.test.ts` + `core-rs` 单测读同一份 fixture | `npm run test:all` |
| 远程 daemon（真实 TCP） | `core-rs/src/remote_tests.rs`（服务端）、`src/test/remoteCoreDaemon.test.ts`（Host 侧） | `npm run test:core` / `npm run test:all` |
| 真实宿主 | `src/test/suite/` | `npm test`（VS Code）/ Electron 手测 |

### 约定

- 测试放在独立的 `<模块>_tests.rs`，通过 `#[path]` 挂载；这样 `#[cfg(test)]` 代码不混在
  产品代码里，覆盖率统计也能用文件名精确排除测试自身。
- `config` / `prompt` / `tools` / `shell` 都有进程级静态缓存（宿主环境、配置快照、
  工作目录表、git 分支缓存、shell 探测结果、Todo 表）。触碰它们的用例必须：
  1. 用 `test_support::Sandbox` 拿全局串行闸门并建临时主目录 / 工作目录；
  2. 退出时还原环境变量并清缓存（`Sandbox::drop` 已处理）。
- 配置快照的用例经 `apply_settings_snapshot` 注入。`Sandbox::new` 默认注入一份
  **空配置**，模拟「宿主已连接、配置为空」；`Sandbox::write_settings` 扮演 Host 的
  角色（写盘 + 按 Host 口径产出快照并注入），需要「快照尚未到达」状态的用例自己调
  `settings::reset_settings_snapshot()`。
- 就绪状态要有独立用例：未收到 `hostEnvironmentProvided` 时其它 `UiEvent` 被拒绝，
  收到后发 `coreReady`。
- 需要真实子进程的用例（Bash / Grep / Glob / git 探测）以本机能力为准，缺失时
  `return` 跳过而不是失败。
- `test_support::FakeLlm` 是一个最小 HTTP/SSE 服务，配合 `EngineHarness`（自动应答
  `CoreRequest`）可以在进程内跑完整轮次：用户消息 → 流式回复 → 工具调用 →
  权限确认 → 第二轮。
- 覆盖率只统计产品代码（排除 `*_tests.rs`、`test_support.rs` 与依赖库）。

### 基线（2025 起随实现更新）

行覆盖 93.6%（6202 行），函数 91.3%，区域 92.5%。`main.rs` 的帧循环已抽成
`run_frame_loop(reader, core, bus)` 以便进程内测试；真实宿主路径由 TS 侧集成测试覆盖。
