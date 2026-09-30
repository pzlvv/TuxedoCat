# 规格：Standalone Core（Rust）

本规格描述 Core 的第二种实现——Standalone Core。Core 与 UI 的分离形态见
`docs/core-ui-separation.md`；本规格在其基础上确定 Standalone Core 的进程形态、选择方式、
传输协议与事实归属。事件词汇表见 `DEVELOPMENT.md` 第 3、4 节。

---

## 1. 能力

1. **两种实现并存**：Embedded Core（`src/core`，TypeScript，与 UI 同进程）与
   Standalone Core（Rust，独立进程）实现同一份 core 侧契约。
2. **一个选择变量**：装配哪种 Core 由单一变量 `CORE_KIND` 决定，取值 `embedded` /
   `standalone`；本规格落地时该变量写死为 `standalone`。
3. **契约不变**：两种实现对 UI 呈现同一份 `CoreEvent` / `CoreRequest` / `UiEvent` 词汇表，
   载荷字段逐项一致。
4. **独立进程**：Standalone Core 是独立的可执行文件，承载 core 侧全部职责
   （引擎、工具、历史、配置、MCP、技能）。
5. **平台范围**：当前产出 Windows x64；目标矩阵预留 Windows / Linux × x64 / arm64。
6. **一条帧通道**：UI 与 Standalone Core 之间只有一条双向帧通道；UI 为客户端，Core 为服务端。
7. **一个宿主实例一个 Core 进程**：每个宿主实例 fork 自己的 Core 进程；一个 Core 进程只服务
   它的宿主实例。
8. **生命周期归宿主**：Core 进程由宿主启动、终止，并在崩溃后由宿主重启。
9. **崩溃可恢复**：Core 进程意外退出后宿主重启它并恢复接线；单个宿主实例的 Core 崩溃不
   影响其它宿主实例。

### 1.1 落地阶段

Core 侧业务按里程碑迁入 Core 进程（见 `TODO.md`）。当前：

- `UiEvent` 只经帧通道进入 Core 进程；进程内不注册 core 侧订阅，也不建会话队列；
- 用户消息经 `UiEvent.userMessageSubmitted` 进入 Core，宿主不直接调用引擎；
- Core 进程承担：握手、帧通道、连接态重放、崩溃重启、日志上报，以及会话引擎、
  内置工具（含后台 Bash、子代理与 Skill）、会话落盘、配置读写与高亮语言落盘、
  技能加载与斜杠命令解析（`CommandDispatcher` + 内置命令 + 技能命令）、
  对话压缩（自动 / 手动触发、摘要生成、归档与 `messagesReplaced` 重放）、
  Responses API（`apiType='Responses'`，含内置 Web Search 的缺口见 `TODO.md`）、
  MCP（stdio / Streamable HTTP / 旧版 SSE 三种传输、连接池与会话引用、
  `mcp__*` 工具注入与按会话启用列表过滤）、
  Spin 引擎（`spin.json` 读写、拓扑排序、子代理执行、验收判定、`/spin` 命令）、
  智能命名 / 压缩归档展开 / DeepSeek 余额推送（都要读 core 的磁盘数据，因此整体在 Core 侧）；
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
| Core 实例 | 一个 Standalone Core 进程，归属一个宿主实例 | 宿主启动，Core 自身 |
| 重启 | Core 实例意外退出后由宿主重新启动并恢复接线 | UI |
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
- 产物：单文件可执行；文件名为 `core.binaryName`（Windows 加 `.exe`）。
- 源码位置：`core-rs/`（Cargo 包，包名与二进制名保持中性；对外文件名由构建脚本按配置落位）。
- 进程属性：无窗口、无控制台；标准输入 / 标准输出为帧通道，标准错误为诊断输出。
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

### 4.1 平台矩阵

| 平台 | 架构 | 目标三元组 | 产物目录（`<core.resourceDir>` = `core`） | 状态 |
| --- | --- | --- | --- | --- |
| Windows | x64 | `x86_64-pc-windows-msvc` | `resources/core/x64-win32/` | 产出 |
| Windows | arm64 | `aarch64-pc-windows-msvc` | `resources/core/arm64-win32/` | 预留 |
| Linux | x64 | `x86_64-unknown-linux-gnu` | `resources/core/x64-linux/` | 预留 |
| Linux | arm64 | `aarch64-unknown-linux-gnu` | `resources/core/arm64-linux/` | 预留 |

产物目录命名与 `resources/ripgrep/` 一致。宿主按运行平台的平台名 / 架构名解析产物目录，
不写死单一平台。

### 4.2 跨平台预留约束

- Core 侧不依赖 Windows 专有 API；平台差异收敛在少量模块：进程管理、路径处理、
  shell 探测、资源定位。
- 构建脚本按目标三元组参数化；当前只构建 Windows x64。
- 宿主侧的启动、帧通道与契约不随平台变化。
- 新增平台时只补产物目录与构建目标，不改契约与磁盘格式。

平台差异的实际落点（审查口径，见 `TODO.md` M8-353）：

| 关注点 | 落点 | 平台差异的处理 |
| --- | --- | --- |
| 进程管理 | `bash_task.rs::kill_tree`、`mcp.rs` 的子进程终止 | `#[cfg(windows)]` 走 `taskkill /T /F`；非 Windows 走 `Child::kill`，与 Embedded（Node `detached: true` + `childProcess.kill()`，同样只杀直接子进程）逐字对齐 |
| 路径处理 | `util.rs` 的 `normalize_path` / `expand_path`、`config.rs` 的 `encodeURIComponent` 等价物 | 盘符与 UNC 的换算都在 `cfg!(windows)` 分支内；非 Windows 走 POSIX 分支，多字节路径按字节比较 |
| shell 探测 | `shell.rs::detect` | 非 Windows 直接用 `$SHELL`（缺省 `/bin/bash`）；Windows 才走 Git Bash → PowerShell → cmd.exe 的优先级 |
| 资源定位 | `tools.rs::ripgrep_path` / `get_pandoc_path`、`config.rs::extension_path` | 可执行名按 `cfg!(windows)` 加 `.exe`；产物目录按 `<arch>-<platform>` 解析，矩阵外直接拒绝而不是猜一个目录 |
| 主目录 | `config.rs::home_dir` | `USERPROFILE` 优先、`HOME` 兜底，两者都缺才报错 |
| 系统语言 | `i18n.rs::get_system_locale` | 仅 Windows 查 PowerShell `Get-UICulture`；其余平台读 `LANG` / `LC_ALL` |
| 控制台窗口 | `util.rs::hide_console` | 仅 Windows 设 `CREATE_NO_WINDOW`，非 Windows 是空操作 |

矩阵一致性由 `src/test/corePlatformMatrix.test.ts` 锁定：构建脚本的目标登记、
运行时的目录解析、产物落位三处必须两两一致，矩阵外的平台组合必须被拒绝。

### 4.3 产出预留平台

目标三元组已登记，装好对应 target 与链接器即可产出：

```bash
rustup target add aarch64-pc-windows-msvc
node scripts/build-core.mjs --target aarch64-pc-windows-msvc
```

已知阻塞（实测记录）：

- **Windows arm64**：`rustup target add` 之后构建会停在 `ring`（`reqwest` 的
  `rustls-tls` 依赖）的自定义构建脚本上，报
  `failed to find tool "clang"`。`ring` 含 ARM64 汇编，交叉编译需要 LLVM/clang
  与 ARM64 的 MSVC 链接器；只装 Rust target 不够。
- **Linux x64 / arm64**：需要 `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`
  目标与对应的交叉链接器（GNU 工具链），当前环境未安装。

因此这三项目前只有「目录与构建目标已登记、矩阵一致性有测试锁定」，没有实际产物；
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
- `UiRequest` 的七个请求（`conversationListRequested` / `uiLanguageRequested` /
  `systemLocaleRequested` / `configHomeDirRequested` / `smartNamingRequested` /
  `balanceRequested` / `compactArchiveRequested`）由 UI 发起、Core 应答：
  宿主不直接读 core 的磁盘数据（第 10 节）。未知类型一律回 `ok:false` 的响应，
  不做静默降级。
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
2. Core 校验 `protocol`：通过则回 `ready`；不通过则写诊断并退出。
3. UI 收到 `ready` 后开始发送 `uiEvent` 帧；`ready` 之前的 `uiEvent` 在 UI 侧排队。

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
| 启动 | `CORE_KIND = standalone` 时 bootstrap 定位并启动 Core 进程，完成握手 |
| 就绪前 | UI 侧 `CoreEvent` 处理器已注册；`uiEvent` 帧在 UI 侧排队 |
| 运行 | UI 把 `emitToCore` 写为 `uiEvent` 帧；Core 把 `emitToUi` / `request` 写为帧；`request` 的响应回带 `id` |
| 实例边界 | 一个宿主实例拥有一个 Core 进程；标准输入关闭即连接结束 |
| 终止 | UI 发 `shutdown`，等待 Core 退出；超时后强制结束 |
| 崩溃 | 未决 `request` 全部 reject；宿主重启 Core 进程并恢复接线（第 7.1 节） |

### 7.1 崩溃与重启

- **触发**：Core 进程在收到 `shutdown` 之前退出，或帧通道意外关闭。
- **即时处理**：未决 `request` 全部 reject；宿主把受影响会话的在跑工作标记为失败，并写入
  一条错误消息。
- **重启**：宿主以退避策略重启 Core 进程；重启后重新握手，重放 `hostEnvironmentProvided`，
  并对宿主已打开的会话逐个发 `conversationOpened`（会话工作目录由 Core 读 `meta.json`
  的 `project` 自行恢复）。
- **恢复**：会话数据在磁盘上，重启后按需重建引擎；进程内未落盘的在跑工作不恢复。
- **上限**：时间窗口内重启次数超过上限时停止重启并报告，不静默重试。
- **隔离**：一个宿主实例的 Core 崩溃不影响其它宿主实例；每个宿主实例有自己的 Core 进程。

### 7.2 连接态重放

- 连接态事件（`hostEnvironmentProvided`）保留最后一次取值，每次握手后重放。
- 宿主已打开的会话集合由 UI 侧维护；每次握手后逐个重放 `conversationOpened`。
- 就绪前发出的其它 `UiEvent` 在 UI 侧排队，握手后按原顺序发出。
- 重放由总线适配器承担，业务代码不感知重连。

---

## 8. 事实归属

Standalone Core 下，core 侧事实的归属与 `docs/core-ui-separation.md` 第 4、5 节一致。

| 事实 | owner | 说明 |
| --- | --- | --- |
| 全局配置 `~/<CONFIG_DIR_NAME>/settings.json` | Core | 读与写都在 Core |
| 项目清单 `<conversations>/<project>/settings.json` | Core | 读与写都在 Core |
| 会话数据（元数据 / 消息 / 归档） | Core | 落盘格式与 Embedded 一致 |
| 会话工作目录表 | Core | 单目录宿主（VS Code）在会话首次解析目录前经 `UiEvent.sessionWorkspaceAssigned` 登记；多工作目录宿主（Electron）按来源视图登记；加载对话后由 `meta.json` 的 `project` 校正 |
| 工具执行 | Core | 在 Core 所在机器操作文件系统 |
| MCP 子进程 | Core | 生命周期由 Core 管理 |
| ripgrep / pandoc | Core | 随 Core 分发并定位 |
| 宿主环境（locale / extensionPath / logToConsole） | UI 提供，Core 消费 | 经 `UiEvent.hostEnvironmentProvided` |
| 会话工作目录 | UI 提供，Core 消费 | 经 `UiEvent.sessionWorkspaceAssigned` |
| 日志行 | Core 产生 | 经 `CoreEvent.log` 上报；标准错误仅用于诊断 |
| 界面表现（diff / Mermaid / 外部链接 / 另存为） | UI | 不进 Core |

---

## 9. 与 Embedded Core 的对等

两种实现对同一串 `UiEvent` 产生同一串 `CoreEvent`。对等范围：

1. 用户消息管线（`docs/user-message-pipeline.md`）；
2. 命令在轮次边界解析（内置命令就地执行 / 技能命令注入 Skill tool_use）；
3. 工具执行与权限策略（含 `Skill` 的末位不变式）；
4. 会话运行时状态（`idle` / `waiting`）；
5. 历史落盘格式与目录布局；
6. 配置读写；
7. MCP 会话引用与工具过滤；
8. 技能加载与注入（frontmatter 解析 / 变量替换 / 目录扫描 / 内置注册）；
9. 压缩与归档（阈值 / 触发点 / 摘要 prompt / 归档文件 / `messagesReplaced`）。

差异只在进程边界与资源定位，不在契约与磁盘格式。

---

## 10. 宿主侧的 core 事实读取

`DEVELOPMENT.md` 第 2 节规则 9 允许宿主直接 import core 的只读函数。Standalone Core 下，
core 事实的唯一来源是帧通道：宿主不直接读取 core 的磁盘数据。

| 事实 | Embedded 下的读取 | Standalone 下的来源 |
| --- | --- | --- |
| 对话列表元数据 | `loadConversationList` | 已改：`UiRequest.conversationListRequested`（`conversationListChanged` 仍作为「该刷新了」的信号） |
| 会话运行时状态 | `getSessionRuntimeStates` | 已改：`sessionRuntimeChanged` 的全量推送（宿主缓存快照） |
| 会话工作目录 | `getSessionWorkspace` | 已改：会话上下文事件（宿主不再读） |
| UI 语言 | `readUiLanguageSync` | 已改：`UiRequest.uiLanguageRequested`（握手后预热成同步可读的缓存） |
| 高亮语言 | `readHighlightLanguagesSync` | 已改：`CoreEvent.highlightLanguagesUsed`（Standalone 下 Core 直接并入 `settings.json`） |
| 配置目录 | `getConfigHomeDir` | 已改：`UiRequest.configHomeDirRequested`（握手后预热；未预热时抛错而不是猜路径） |
| 项目对话目录 | `getProjectConversationDir` | 已改：`projectConversationDirReady`（Standalone 下 Core 自己写清单） |

三项「待改」已全部完成：新增 **UI → core 的请求方向**（协议版本 2），
`AssistantEventBus` 增加 `UiRequest` / `UiRequestResultMap` / `UiRequestHandlers`
与 `requestCore()` / `onUiRequests()`，与 `CoreRequest` 完全对称。

Standalone 下宿主侧已不存在对 core 磁盘数据的直接读取。`embedded` 与 `standalone`
的差异只在进程边界：`coreFacts` 是宿主侧的统一入口，按 `CORE_KIND` 分派
（Embedded 直接调 core 的只读函数，Standalone 经 `requestCore`）。

另有两条 UI → core 的请求用于「core 的事实 + 副作用」：`smartNamingRequested`
（读会话 + 调 LLM + 解析标题）与 `compactArchiveRequested`（归档与主 JSONL 合并），
以及 `balanceRequested`（按 hostname 找 DeepSeek provider 的 Key 查余额）。

---

## 11. 不覆盖范围

- 跨机器部署与网络传输；
- 网络连接断开后的重连（进程崩溃后的重启见第 7.1 节）；
- 目标矩阵中预留平台的实际产出；
- UI 侧的界面表现与 webview 协议；
- `embedded` 实现的改动。

---

## 12. 验收要点

1. `CORE_KIND = standalone` 时，bootstrap 启动配置中的 Core 可执行文件并完成握手。
2. UI 进程不加载 core 的引擎、工具与历史模块。
3. 帧载荷字段与 `src/core/AssistantEventBus.ts` 的类型逐项一致。
4. 用户消息 → 流式回复 → 工具执行的完整回路可用。
5. 会话数据落盘格式与 Embedded 一致，两实现可互相读取同一目录。
6. 全局配置与项目清单的写入只在 Core 侧发生。
7. Core 进程被杀死后，宿主重启它并恢复接线；未决请求 reject，不静默挂起。
8. 两个宿主实例各自拥有一个 Core 进程；其中一个的 Core 崩溃不影响另一个。
9. 重启次数超过上限时宿主停止重启并报告。
10. `CORE_KIND = embedded` 时装配进程内 Core。
11. 产物目录按平台 / 架构解析，Windows x64 之外的目录为预留。

---

## 13. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 选择变量 | `src/host/coreKind.ts` |
| 帧协议与编解码 | `src/host/standalone/protocol.ts` |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（启动 / 重启 / 终止） | `src/host/standalone/CoreProcess.ts` |
| 平台产物解析 | `src/host/standalone/coreBinary.ts` |
| bootstrap 分支 | `src/host/bootstrapCore.ts` |
| 事件契约 | `src/core/AssistantEventBus.ts` |
| Rust 包 | `core-rs/` |
| 构建目标参数化 | `core-rs/.cargo/config.toml`、构建脚本 |
| 分发产物 | `resources/core/<platform>-<arch>/` |

## 13. 测试与覆盖率

### 分层

| 层 | 位置 | 跑法 |
| --- | --- | --- |
| Rust 单元测试 | `core-rs/src/<模块>_tests.rs` | `npm run test:core` |
| Rust 覆盖率 | `scripts/coverage-core.mjs` | `npm run coverage:core`（`--html` / `--check 80`） |
| 协议冒烟（真实产物） | `src/test/standaloneBootstrap.test.ts`、`standaloneCoreEngine.test.ts` | `npm run test:all` |
| 工具与权限（真实产物） | `src/test/standaloneCoreTools.test.ts`、`standaloneCorePermission.test.ts` | `npm run test:all` |
| 两种实现对等 | `src/test/permissionParity.test.ts` + `core-rs` 单测读同一份 fixture | `npm run test:all` |
| 真实宿主 | `src/test/suite/` | `npm test`（VS Code）/ Electron 手测 |

### 约定

- 测试放在独立的 `<模块>_tests.rs`，通过 `#[path]` 挂载；这样 `#[cfg(test)]` 代码不混在
  产品代码里，覆盖率统计也能用文件名精确排除测试自身。
- `config` / `prompt` / `tools` / `shell` 都有进程级静态缓存（宿主环境、settings、
  工作目录表、git 分支缓存、shell 探测结果、Todo 表）。触碰它们的用例必须：
  1. 用 `test_support::Sandbox` 拿全局串行闸门并建临时主目录 / 工作目录；
  2. 退出时还原环境变量并清缓存（`Sandbox::drop` 已处理）。
- 需要真实子进程的用例（Bash / Grep / Glob / git 探测）以本机能力为准，缺失时
  `return` 跳过而不是失败。
- `test_support::FakeLlm` 是一个最小 HTTP/SSE 服务，配合 `EngineHarness`（自动应答
  `CoreRequest`）可以在进程内跑完整轮次：用户消息 → 流式回复 → 工具调用 →
  权限确认 → 第二轮。
- 覆盖率只统计产品代码（排除 `*_tests.rs`、`test_support.rs` 与依赖库）。

### 基线（2025 起随实现更新）

行覆盖 93.6%（6202 行），函数 91.3%，区域 92.5%。`main.rs` 的帧循环已抽成
`run_frame_loop(reader, core, bus)` 以便进程内测试；真实宿主路径由 TS 侧集成测试覆盖。
