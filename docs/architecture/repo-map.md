---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：仓库目录布局

本文描述全仓库的目录与关键文件职责（as-built），是「找代码在哪」的唯一对照表。
架构分层见 [overview.md](overview.md)。

## 目录布局

| 路径 | 职责 |
| --- | --- |
| `src/config/project.json` | 产品身份与工程变量的定义处之一（另一处是 `package.json`）：产品名 / 扩展名 / 配置目录 / 环境变量前缀 / 命令与面板 id / Core 产物名与部署前缀；`src/test/brandLiteral.test.ts` 守卫「其余文件不出现产品字面量」与「两处定义一致」（[docs/hosts/product-identity.md](../hosts/product-identity.md)） |
| `src/config/project.ts` | 上述变量的 TS 只读入口（`PRODUCT_NAME` / `EXTENSION_NAME` / `CONFIG_DIR_NAME` / `ENV_PREFIX` / `CORE_ENV_VAR` / `CORE_BINARY_NAME` / `CORE_DEPLOY_PREFIX` …），源码与用例一律经它取值 |
| `src/core/AssistantEventBus.ts` | 事件类型（`CoreEvent` / `CoreRequest` / `UiEvent`）、处理器映射类型、总线接口、全局注册（`setGlobalEventBus` / `requireEventBus` / `resetGlobalEventBus`） |
| `src/host/webviewMessages.ts` | webview ↔ host 消息协议（wire 联合类型，按方向拆分：`HostToWebviewMessage` / `WebviewToHostMessage` / 双向成员），两端唯一的协议类型来源 |
| `src/core/webviewTypes.ts` | core 侧的展示事实类型（`McpServerInfo` / `ProviderModels` 等），core 产出、host 组装进消息载荷 |
| `src/host/EventBus.ts` | 总线实现 `createEventBus()`，纯内存发布订阅，无宿主依赖 |
| `src/core/initializeCoreEvents.ts` | core 侧 `UiEvent` 订阅的唯一注册入口，由 bootstrap 在 `setGlobalEventBus` 之后调用一次 |
| `src/host/bootstrapCore.ts` | 共享启动接线骨架：locale / 日志 / 扩展路径 / Client 与全局总线 / `WebViewUI.create` / 按工作区打开 Connection / 历史 / 会话队列 / 等待用户读取器 / 异步收尾；按 `CORE_KIND` 装配 embedded / standalone（[docs/core/standalone-core.md 第 3 节](../core/standalone-core.md#3-选择变量)）；导出 `bootstrapSnapshot()`（启动自检）与 `shutdownCore()`（退出清理） |
| `src/host/Client.ts` | 宿主级唯一实例：工作区 / 会话路由表、配置快照推送、就绪门禁；同时实现 `AssistantEventBus`，作为宿主侧的总线路由器（`emitToCore` / `requestCore` 按会话找归属） |
| `src/host/Connection.ts` | 宿主与一个 Core 的一对一连接：持有总线、就绪状态机（`connecting → ready → closed`）、该工作区的会话集合；未就绪时排队 `UiEvent` / 挂起 `requestCore` |
| `src/host/workspaceRef.ts` | 工作区引用 `{ scheme, path, endpoint }` 与去重键；本地 / 远程同构，Core 只见 `path` |
| `src/host/coreKind.ts` | Core 实现的选择变量：`CORE_KIND`（默认 `standalone`，打包时由 esbuild 按 `<envPrefix>_<core.envVarSuffix>` 注入构建期取值）与 `<envPrefix>_<core.envVarSuffix>` 运行期覆盖入口，`resolveCoreKind()` |
| `src/host/standalone/protocol.ts` | Standalone 帧协议：帧类型、编解码、换行分隔 JSON 解码器 |
| `src/host/standalone/coreBinary.ts` | Standalone Core 产物定位：平台 / 架构 → `resources/core/<arch>-<platform>/` |
| `src/host/standalone/CoreProcess.ts` | 单进程形态的 Core 进程管理：启动 / 握手 / 帧收发 / 背压 / 崩溃重启 / 关闭；实现 `CoreChannelTransport` |
| `src/host/standalone/CoreDaemon.ts` | Host 侧 daemon 客户端：一个 endpoint 一个 daemon，每个工作区一条 channel；Core 的重启与终止由 daemon 承担；把 `channelReset` 翻译成重新握手；链路就绪后定期发 `ping` 心跳（daemon 据此回收死连接，[docs/core/core-daemon.md 第 12.5 节](../core/core-daemon.md#125-连接与生命周期)） |
| `src/host/standalone/daemonProtocol.ts` | daemon 控制通道协议：帧类型、`ChannelDescriptor`、编解码与校验 |
| `src/host/standalone/StandaloneEventBus.ts` | `AssistantEventBus` 的帧通道实现（在 `CoreChannelTransport` 之上）：就绪前排队、连接态重放、`CoreRequest` 应答；传输层可以是单进程或 daemon channel |
| `core-rs/` | Standalone Core 的 Rust 包（帧协议、Core 侧总线、进程入口、daemon 模式） |
| `scripts/build-core.mjs` | Standalone Core 构建脚本：按目标三元组 `cargo build` 并落到 `resources/core/` |
| `src/core/sessionRuntime.ts` | 会话运行时状态（`idle` / `waiting` / 前台与后台来源）的唯一 owner，`sessionRuntimeChanged` 的生产者（[docs/core/session-runtime.md](../core/session-runtime.md)） |
| `src/core/tools/PermissionPolicy.ts` | 权限规则加工（agentMode → `resolveToolPermission`）与会话级 agentMode 存储 |
| `src/core/mcp/MCPHost.ts` | MCP 会话引用生命周期的唯一入口。它不是宿主契约，仅有一个 core 侧单例 |
| `src/host/WebViewUI.ts` | 唯一的 UI 实现；订阅总线、处理事件、发送 `UiEvent`；实现 `WebViewUiPort` |
| `src/host/UIHost.ts` | 契约 1：对话 webview 的宿主能力（interface，成员全部必选） |
| `src/host/SpinDesign.ts` | 契约 2：Spin 设计器（interface，`open` / `refresh`） |
| `src/host/settingsFile.ts` | 全局 `settings.json` 的宿主侧写入口（串行读-改-写；core 只读不写） |
| `src/host/ConversationManager.ts` | 契约 3：对话列表、会话运行时状态两条流（abstract class，模板方法），以及空闲会话回收的钩子（实现只在 VS Code 侧；core 不参与计时） |
| `src/host/ui/ports.ts` | `WebViewUiPort`、`WebviewPoster`、`ConversationLoadedExtra` |
| `src/host/ui/toolHandler.ts` | 工具卡片生命周期 |
| `src/host/ui/userChoice.ts` | 用户选择队列与预览 |
| `src/host/ui/webviewMessageHandler.ts` | webview 协议消息分发，并翻译为 `UiEvent` |
| `src/host/ui/types.ts` | 共享子模块的接口定义（`ShowVirtualDocumentEvent` / `ShowDiffInVirtualDocumentEvent` 等） |
| `src/host/ui/spinDesignHtml.ts` | Spin 设计器 HTML 生成 |
| `src/host/SessionUiState.ts` | 会话级 UI 运行时状态（活动阶段 / 工具计数 / 查询计数） |
| `src/host/queryActivity.ts`、`conversationPayload.ts`、`mermaidHtml.ts`、`imageFiles.ts`、`spinDesignExport.ts`、`types.ts`、`workspacePaths.ts` | 共享辅助：活动查询判定、`conversationLoaded` 组装、Mermaid HTML、图片判定、Spin 导出、`HostInfo`、工作目录路径归一与去重 |
| `src/VSCodeUIHost.ts` + `src/VSCodeUIHost/` | `UIHost` 的 VS Code 实现（含 `documentManager.ts` / `diffUris.ts`） |
| `electron/ElectronUIHost.ts` | `UIHost` 的 Electron 实现 |
| `src/VSCodeSpinDesign.ts` / `electron/ElectronSpinDesign.ts` | `SpinDesign` 的两个实现（构造注入 `UIHost`） |
| `src/VSCodeConversationManager.ts` / `electron/ElectronConversationManager.ts` | `ConversationManager` 的两个实现；空闲会话回收（计时 / 巡检 / 关闭动作）只在 VS Code 侧 |
| `electron/shortcut.ts` | Electron 专属：Electron accelerator 解析与规范化（唤醒快捷键）；core 不读不写 |
| `electron/shortcutDialogHtml.ts` + `electron/shortcutPreload.ts` | Electron 专属：唤醒快捷键设置对话框（File - Shortcut...，见[docs/architecture/contracts.md 第 5 节](contracts.md#5-宿主侧入口动作翻译为-uievent)） |
| `electron/titlebar/` + `electron/titlebarPreload.ts` | Electron 专属：自绘标题栏（左侧品牌区 + 单一菜单图标 + 工作目录标签页区；右侧置顶钉 / 模式切换 / 最小化-最大化-关闭，两个图标按钮与窗口按钮同宽同高），替代系统默认标题栏与系统菜单栏 |
| `electron/titlebarMenuHtml.ts` + `electron/titlebarMenuPreload.ts` | Electron 专属：标题栏下拉菜单。菜单由独立 `WebContentsView` 承载（标题栏视图只有 38px 高，自身 bounds 会裁掉向下展开的菜单），首次打开测量尺寸后缓存，再次打开直接摆位显示；子菜单（「添加最近的工作目录」）渲染成右侧飞出面板，默认收起 |
| `electron/sidebar/` + `electron/sidebarPreload.ts` | Electron 专属：原生侧栏（头部搜索框 + 新对话按钮；对话列表；空态「添加工作目录」+ 最近工作目录；底部可折叠的文件浏览器分区，`electron/sidebarFiles.ts` 提供路径校验与目录读取） |
| `src/extension.ts` / `electron/main.ts` | 各自的 bootstrap：构造三契约与宿主句柄 → 调用共享骨架 `bootstrapCore` → 执行宿主专属接线（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主接线)） |
| `tui-rs/` | TUI 宿主实现（第三个宿主，纯 Rust，[docs/hosts/tui.md](../hosts/tui.md)）：直连 Standalone Core 的 stdio 帧通道；`host.rs` 译层（core 帧 ↔ 渲染动作，WebViewUI 行为的移植）；`store.rs` 纯 reducer（Action → 唯一渲染事实）；`settings.rs` 配置快照（`settings.json` / `mcp.json` 规范化 + 模型注册表）；`core_root.rs` Core 产物定位；`app.rs` ratatui 渲染与键盘路由；`composer.rs` / `markdown.rs` / `diffview.rs` 纯函数子集 |
| `installer-rs/` | TUI 版安装程序（[docs/features/tui-installer.md](../features/tui-installer.md)）：纯 Rust 自解压安装器，构建期把 Core / ripgrep / TUI 二进制烧进单文件；`.cargo/config.toml` 配 musl 的 rust-lld |
| `scripts/build-tui-installer.mjs` | 安装程序构建：按目标确保 Core 产物与 TUI 二进制就位 → cargo 交叉构建 → 落位 `release/tui-installer/`（四目标：Windows x64/arm64、Linux x64/arm64 musl） |

**硬约束**：`VSCodeUIHost.ts` / `VSCodeSpinDesign.ts` / `VSCodeConversationManager.ts`
不得放入 `src/host/`。`electron/tsconfig.json` 的 `include` 包含 `../src/host/**/*.ts`，
上述文件若放入该目录会被 electron 侧编译，而它们 `import * as vscode`，将直接编译失败。
因此这三个文件在 `electron/tsconfig.json` 中被逐个显式列出。
