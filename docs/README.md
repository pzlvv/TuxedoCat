# 文档地图

本文件是全部文档的**唯一索引**：每篇文档的范围一句话、按类型分组。写作规则（as-built、
章节编号与代码注释引用一一对应等）见 [AGENTS.md 第 0 节](../AGENTS.md#0-文档要求)；「什么内容写到哪」的判据见
下表。文档与代码不一致时，先修其中一方使二者一致（`src/test/docsLint.test.ts` 校验
事件表与交叉引用）。

## 分类法

| 类型 | 去处 | 判据 / 寿命 |
| --- | --- | --- |
| 门面（快速上手） | `README.md` | 面向新开发者；长期 |
| AI 协作约定 | `AGENTS.md` | 风格与工作流约定；长期 |
| 架构总纲 | `DEVELOPMENT.md` | 架构总览、分层规则、事件词汇表、架构原则、待定事项；长期，控体积 |
| 主题规格 | `docs/<topic>.md`（领域命名） | 跨模块的领域规格（契约、进程模型、管线、事实分工）；长期 |
| 功能规格 | 并入主题规格或独立 `docs/<feature>.md` | 独立成篇判据：跨多个 surface 或有独立状态机；否则作主题规格的一节 |
| 需求基线 | `docs/user-stories.md` | as-built 用户故事，e2e 用例以 `US-xx` 编号引用；随 e2e 演进 |
| 待办清单 | `TODO.md`（根目录） | **只列未完成项**，完成即删；历史不保留在待办里 |
| 决策记录 | `docs/adr/NNNN-<slug>.md` | 只记决策、背景与被否决的替代方案；编号递增，只增不删 |
| 冻结档案 | `docs/archive/` | 已完成工作的溯源记录，不再更新 |
| 临时文件 | 仓库根 `tmp_*` | 一次性盘点 / 计划；不登记地图、不参与 docsLint 校验；落地或放弃后即删 |
| 子目录导读 | `<dir>/README.md`（如 `src/test/README.md`） | 该目录的测试车道 / 运行方式说明 |

## 地图

### 总纲与门面

| 文档 | 范围 |
| --- | --- |
| `README.md` | 快速上手：环境要求、构建 / 测试命令、双 Core 装配说明 |
| `AGENTS.md` | AI 协作者约定：文档规则、分层依赖、命名约定、架构铁律、工作流 |
| `DEVELOPMENT.md` | 架构总纲：总览与目录布局、分层规则、`AssistantEventBus` 契约、事件词汇表、架构原则、待定事项 |
| `TODO.md` | 未完成项清单（流式渲染降级、TCP_NODELAY、Windows arm64 产物） |

### Core 与进程

| 文档 | 范围 |
| --- | --- |
| `docs/core-ui-separation.md` | Core 与 UI 的分离形态：唯一边、配置快照、就绪判据 |
| `docs/client-connection.md` | 连接模型：宿主级 `Client` 与每工作区 `Connection` |
| `docs/core-daemon.md` | Core 进程的 daemon：启动 / 监督 / 终止、控制通道、远程服务（SSH） |
| `docs/standalone-core.md` | Standalone Core（Rust）：形态、选择变量、平台矩阵、契约、已知缺口 |
| `docs/core-parity.md` | 两套 Core 的实现差异与 parity 对照表锁定的对等面 |

### 宿主与 UI

| 文档 | 范围 |
| --- | --- |
| `docs/contracts.md` | 宿主契约与端口：`UIHost` / `SpinDesign` / `ConversationManager`、共享子模块端口、`HostInfo` |
| `docs/webview-ui.md` | `WebViewUI` 实现与会话级 UI 状态 `SessionUiState` |
| `docs/host-matrix.md` | 两宿主实现对照表、bootstrap 接线、宿主分叉清单 |
| `docs/webview-facts.md` | webview 的事实与等待态：宿主决定事实、webview 不猜值 |
| `docs/electron-multi-workspace.md` | Electron 多工作目录（对话的工作区属性、视图生命周期） |
| `docs/vscode-idle-close.md` | VS Code 单视图宿主的空闲对话回收 |
| `docs/tui.md` | TUI（第三个宿主，纯 Rust，直连帧通道） |
| `docs/tui-installer.md` | TUI 版分发与 Core 部署安装程序 |

### 行为规格

| 文档 | 范围 |
| --- | --- |
| `docs/user-message-pipeline.md` | 用户消息从 webview 输入到进入 LLM 上下文的完整管线 |
| `docs/compaction.md` | 对话压缩：触发、摘要、归档、跨压缩的用户输入历史 |
| `docs/abort-button.md` | abort 按钮的状态判定与两阶段中止语义 |
| `docs/background-bash.md` | Bash 后台任务：手工转后台（暂停 / 接续）与两类任务提醒 |

### 基础

| 文档 | 范围 |
| --- | --- |
| `docs/product-identity.md` | 产品身份的唯一来源与去字面化契约（占位符约定） |
| `docs/user-stories.md` | as-built 用户故事（US-xx），e2e 用例的需求基线 |
| `docs/adr/README.md` | 架构决策记录（ADR）索引：编号、状态与一句话结论；ADR 只增不删 |
| `docs/archive/` | 冻结档案（Standalone Core 落地清单 M0–M16 等） |

### 子目录导读

| 文档 | 范围 |
| --- | --- |
| `src/test/README.md` | 测试指南：三条车道（单元 / 场景 / 宿主）的进程模型与运行方式 |
| `src/test/memtest/README.md` | MessagesView 渲染 / 内存 / 性能测试 harness（手动运行，不进正式构建） |
| `e2e/README.md` | e2e（Playwright）场景测试：四个 project 的分层与运行方式 |
