---
owner: pzlvv
last_reviewed: 2026-10-14
---

# 规格：Standalone Core 的对等、边界与验收

本规格界定 Standalone Core 与 Embedded Core 的对等范围与已知缺口（第 1 节）、宿主侧读取 core 事实的边界（第 2 节）、不覆盖范围（第 3 节）、验收要点（第 4 节）、落点对照（第 5 节）与测试与覆盖率（第 6 节）。

交叉引用：`docs/core/standalone-core.md`（形态、选择变量、契约、传输与生命周期）、`docs/core/core-parity.md`（两套实现有意保留的差异与 parity 对照表锁定的对等面）、`docs/core/core-daemon.md`（Core 进程的 daemon）、`docs/architecture/core-ui-separation.md`（core 与 UI 的分离形态）、`docs/architecture/layering.md`（分层与依赖规则）。

---

## 1. 与 Embedded Core 的对等

两种实现对同一串 `UiEvent` 产生同一串 `CoreEvent`。对等范围：

1. 用户消息管线（`docs/features/user-message-pipeline.md`）；
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

**已知缺口（Standalone 下暂不可用）**：

| 能力 | 表现 |
| --- | --- |
| Responses API 的内置 Web Search | `apiType='Responses'` 可用，但不下发内置 `web_search` 工具，模型不会自动联网搜索（搜索卡片事件 `web_search_call` 也未迁入） |

缺口能力在 Core 侧表现为明确的提示消息或缺失，不做静默降级；有意保留的行为差异不在此列
（见 `docs/core/core-parity.md`）。

---

## 2. 宿主侧的 core 事实读取

[docs/architecture/layering.md 第 2 节](../architecture/layering.md#2-规则清单)规则 9 允许宿主直接 import core 的只读函数。Standalone Core 下，
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
| 对话空间清空（含完成 / 失败回执） | `clearConversationSpace` | `UiEvent.conversationSpaceCleared` → `CoreEvent.conversationSpaceCleared`（判别联合回执）+ `conversationListChanged` |
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

## 3. 不覆盖范围

- 跨机器部署与网络传输；
- 网络连接断开后的重连（进程崩溃后的重启见 [docs/core/standalone-core.md 第 7.1 节](standalone-core.md#71-崩溃与重启)）；
- Windows arm64 的常态打包（产物可按需构建，见 [docs/core/standalone-core.md 第 4.3 节](standalone-core.md#43-构建与目标平台)；不进默认打包集合）；
- UI 侧的界面表现与 webview 协议；
- `embedded` 实现的改动；
- daemon 的进程模型与协议（见 `docs/core/core-daemon.md`）；
- 远程工作区与 endpoint 传输（见 [docs/core/client-connection.md 第 9 节](client-connection.md#9-落盘与恢复宿主侧)）。

---

## 4. 验收要点

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
13. 产物目录按平台 / 架构解析，Windows x64 与 Linux x64 / arm64 有实际产物；Windows arm64
    可按需构建，不进默认打包集合。
14. `start` 打印监听端口（daemon 留在后台）。

---

## 5. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 选择变量 | `src/host/coreKind.ts` |
| 帧协议与编解码 | `src/host/standalone/protocol.ts` |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（启动 / 重启 / 终止） | `src/host/standalone/CoreProcess.ts` |
| daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（建链器抽象，见 `docs/core/core-daemon.md`） |
| SSH 接入（客户端 / 引导 / 建链） | `src/host/standalone/sshClient.ts`、`sshDaemonBootstrap.ts`、`sshTransport.ts`（见 [docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)） |
| 配置快照 | `src/host/SettingsStore.ts` |
| 平台产物解析 | `src/host/standalone/coreBinary.ts`（产物目录 + 自带的 `ripgrep/`） |
| bootstrap 分支 | `src/host/bootstrapCore.ts` |
| 事件契约 | `src/core/AssistantEventBus.ts` |
| Rust 包 | `core-rs/` |
| 命令行（`--help` / `--version` / 模式） | `core-rs/src/cli.rs` |
| 远程监听 / 目录列举 | `core-rs/src/remote.rs`（见 [docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)） |
| 构建目标参数化 | `core-rs/.cargo/config.toml`、`scripts/build-core.mjs`（平台矩阵 `TARGETS`、打包集 `PACKAGE_DIRS`） |
| 分发产物 | `resources/core/<platform>-<arch>/`（可执行文件 + 自带的 `ripgrep/`） |

## 6. 测试与覆盖率

### 分层

| 层 | 位置 | 跑法 |
| --- | --- | --- |
| Rust 单元测试 | `core-rs/src/<模块>_tests.rs` | `npm run test:core` |
| Rust 覆盖率 | `scripts/coverage-core.mjs` | `npm run coverage:core`（`--html` / `--check 80`） |
| 协议冒烟（真实产物） | `src/test/standaloneBootstrap.test.ts`、`standaloneCoreEngine.test.ts` | `npm run test:all` |
| 工具与权限（真实产物） | `src/test/standaloneCoreTools.test.ts`、`standaloneCorePermission.test.ts` | `npm run test:all` |
| 两种实现对等 | `src/test/permissionParity.test.ts` + `core-rs` 单测读同一份 fixture | `npm run test:all` |
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

### 基线（2025 起随实现更新）

行覆盖 93.6%（6202 行），函数 91.3%，区域 92.5%。`main.rs` 的帧循环已抽成
`run_frame_loop(reader, core, bus)` 以便进程内测试；真实宿主路径由 TS 侧集成测试覆盖。

