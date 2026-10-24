---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：Core 的边界与验收

本规格界定 Core（Rust）的落点对照（第 1 节）、宿主侧读取 core 事实的边界（第 2 节）、测试与覆盖率（第 3 节）、不覆盖范围（第 4 节）与验收要点（第 5 节）。

交叉引用：`docs/core/standalone-core.md`（形态、契约、传输与生命周期）、`docs/core/core-daemon.md`（Core 进程的 daemon）、`docs/architecture/core-ui-separation.md`（core 与 UI 的分离形态）、`docs/architecture/layering.md`（分层与依赖规则）。

---

## 1. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 帧协议与编解码 | `src/host/standalone/protocol.ts`（宿主侧）、`core-rs/src/frame.rs`（Core 侧） |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（启动 / 重启 / 终止） | `src/host/standalone/CoreProcess.ts` |
| daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（建链器抽象，见 `docs/core/core-daemon.md`） |
| SSH 接入（客户端 / 引导 / 建链） | `src/host/standalone/sshClient.ts`、`sshDaemonBootstrap.ts`、`sshTransport.ts`（见 [docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)） |
| 配置快照 | `src/host/SettingsStore.ts` |
| 平台产物解析 | `src/host/standalone/coreBinary.ts`（产物目录 + 自带的 `ripgrep/`） |
| bootstrap | `src/host/bootstrapCore.ts` |
| 事件契约 | `src/shared/AssistantEventBus.ts` |
| Rust 包 | `core-rs/`（引擎 / 工具 / 技能 / 权限 / 提示词 / 压缩 / MCP / 会话落盘 / 帧协议、进程入口、daemon 模式） |
| 命令行（`--help` / `--version` / 动作） | `core-rs/src/cli.rs` |
| 远程监听 / 目录列举 | `core-rs/src/remote.rs`（见 [docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)） |
| 构建目标参数化 | `core-rs/.cargo/config.toml`、`scripts/build-core.mjs`（平台矩阵 `TARGETS`、打包集 `PACKAGE_DIRS`） |
| 分发产物 | `resources/core/<platform>-<arch>/`（可执行文件 + 自带的 `ripgrep/`） |

---

## 2. 宿主侧的 core 事实读取

[docs/architecture/layering.md 第 2 节](../architecture/layering.md#2-规则清单)规则 9 允许宿主 import `src/shared/` 的只读函数与类型。
core 事实的唯一来源是帧通道：宿主不直接读取 core 的磁盘数据，统一经同名 `UiRequest`
索取（宿主侧入口 `src/host/coreFacts.ts`）。

| 事实 | 来源 |
| --- | --- |
| 对话列表元数据 | `UiRequest.conversationListRequested`（`conversationListChanged` 仍作为「该刷新了」的信号） |
| 会话运行时状态 | `sessionRuntimeChanged` 的全量推送（宿主缓存快照，`ConversationManager.getSessionStatesSnapshot`） |
| 压缩归档展开 | `UiRequest.compactArchiveRequested` |
| 会话内容 / 元数据 / 派生事实 | `UiRequest.conversationLoadRequested` |
| 会话 Todo 清单 | `UiRequest.sessionTodosRequested`（表里有就直接给，没有就按会话文件里最后一条成功的 `TodoWrite` 重建）；变更时另有 `CoreEvent.todosChanged` 推送 |
| 斜杠命令与技能列表 | `UiRequest.skillsRequested` |
| Spin 设计（`spin.json` 内容 + 设计器技能清单） | `UiRequest.spinDesignRequested` |
| Spin 设计保存 | `UiRequest.spinDesignSaveRequested` |
| MCP 面板列表（配置 + 启用状态 + 运行时状态） | `UiRequest.mcpServersRequested` |
| 对话空间统计 | `UiRequest.conversationSpacesRequested` |
| 对话空间清空（含完成 / 失败回执） | `UiEvent.conversationSpaceCleared` → `CoreEvent.conversationSpaceCleared`（判别联合回执）+ `conversationListChanged` |
| 会话挂起持久化收尾 | `UiRequest.flushSessionRequested` |
| 智能命名 / 余额 | `UiRequest.smartNamingRequested` / `balanceRequested` |
| Core 就绪 | `CoreEvent.coreReady` |
| 远程工作区文件监听注册 | `UiRequest.watchWorkspaceFileRequested`（`watchId` + `workspacePath` + `path`；失败回 `{ ok: false, error }`） |
| 远程工作区文件监听注销 | `UiRequest.unwatchWorkspaceFileRequested`（`watchId` + `workspacePath`；未知 id 幂等） |
| 远程工作区文件变化 | `CoreEvent.workspaceFileChanged`（只带 `watchId` / `path` / `kind` / `mtimeMs` / `size` / `error`，不带文件内容；宿主经 SFTP 读内容） |

例外（与本机 Core 共用同一份磁盘，远程工作区落地时需要迁到 `UiRequest`）。Spin 设计器
曾直接读宿主本地磁盘，已迁到 `spinDesignRequested` / `spinDesignSaveRequested`；例外表
只剩以下两项：

| 事实 | 宿主侧读取 | 说明 |
| --- | --- | --- |
| 会话工作目录索引 | `src/shared/history/Config.ts` 的 `getSessionWorkspace` / `setSessionWorkspace` | 宿主侧另存一份 `sessionId → workspacePath`，只用于「发事件前取会话自己的目录」；权威表在 Core 进程内，由 `sessionWorkspaceAssigned` 同步 |
| 工具 `_meta` 的 before/after | `ToolHandler` → `updateToolUseMeta` | 权限确认时追加写入会话 JSONL；与 Core 的写入共用同一份磁盘 |

以下事实不属于「core 事实」，归 UI 自己：

| 事实 | 归属 |
| --- | --- |
| UI 语言 | UI：`uiLanguage` 不进快照，Core 不感知 |
| 高亮语言 | UI：webview 扫描并上报，Core 不感知 |
| 配置目录 | UI：`settings.json` / `mcp.json` 的路径由 UI 自己解析，不问 Core |
| 项目清单 | Core：在 Core 数据目录内，由 Core 自己写，不经总线 |

`coreFacts` 是宿主侧的统一入口；随着 UI 语言 / 高亮语言 / 配置目录三项归 UI，
它的职责是「按需向 Core 取数」。

---

## 3. 测试与覆盖率

### 分层

| 层 | 位置 | 跑法 |
| --- | --- | --- |
| Rust 单元测试 | `core-rs/src/<模块>_tests.rs`（行为对照表数据在 `core-rs/fixtures/`） | `npm run test:core` |
| Rust 覆盖率 | `scripts/coverage-core.mjs` | `npm run coverage:core`（`--html` / `--check 80`） |
| 协议冒烟（真实产物） | `src/test/standaloneBootstrap.test.ts`、`standaloneCoreEngine.test.ts` | `npm run test:all` |
| 工具与权限（真实产物） | `src/test/standaloneCoreTools.test.ts`、`standaloneCorePermission.test.ts` | `npm run test:all` |
| 远程 daemon（真实 TCP） | `core-rs/src/remote_tests.rs`（服务端）、`src/test/remoteCoreDaemon.test.ts`（Host 侧） | `npm run test:core` / `npm run test:all` |
| 真实宿主 | `src/test/vscodeHost/` | `npm test`（VS Code）/ Electron 手测 |

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

### 基线（随实现更新）

行覆盖 93.6%（6202 行），函数 91.3%，区域 92.5%。`main.rs` 的帧循环已抽成
`run_frame_loop(reader, core, bus)` 以便进程内测试；真实宿主路径由 TS 侧集成测试覆盖。

---

## 4. 不覆盖范围

- 跨机器部署与网络传输；
- 网络连接断开后的重连（进程崩溃后的重启见 [docs/core/standalone-core.md 第 6.1 节](standalone-core.md#61-崩溃与重启)）；
- UI 侧的界面表现与 webview 协议；
- daemon 的进程模型与协议（见 `docs/core/core-daemon.md`）；
- 远程工作区与 endpoint 传输（见 [docs/core/client-connection.md 第 9 节](client-connection.md#9-落盘与恢复宿主侧)）。

---

## 5. 验收要点

1. 打开工作区经 daemon（或本机 `stdio`）启动 Core 可执行文件并完成握手。
2. UI 进程不加载 core 的引擎、工具与历史实现（core 侧职责全部在 Core 进程内）。
3. 帧载荷字段与 `src/shared/AssistantEventBus.ts` 的类型逐项一致。
4. 用户消息 → 流式回复 → 工具执行的完整回路可用。
5. 会话数据落盘格式与宿主侧 `src/shared/history/` 读写库一致（同一份格式两个读写方，
   由 Rust 测试对照表锁定）。
6. 全局配置与 MCP 配置的写入只在 UI 侧发生；Core 侧不存在这两个文件的路径与读写。
7. 项目清单 `workspace.meta.json` 的写入只在 Core 侧发生。
8. Core 处理完 `hostEnvironmentProvided`（含配置快照）前收到 `UiEvent` 记 log 拒绝；
    处理完发出 `CoreEvent.coreReady`。
9. Core 进程被杀死后，daemon 重启它并恢复接线；未决请求 reject，不静默挂起。
10. 两个工作区各自拥有一个 Core 进程；其中一个的 Core 崩溃不影响另一个。
11. 重启次数超过上限时 daemon 停止重启并报告。
12. 产物目录按平台 / 架构解析，Windows x64 / arm64 与 Linux x64 / arm64 四份都有实际产物，
    且都进默认打包集合。
13. `start` 打印监听端口（daemon 留在后台）。
