# 文档地图

本文件是全部文档的**唯一索引**：每篇文档的范围一句话、按类型分组。写作规则（as-built、
章节编号与代码注释引用一一对应等）见 [AGENTS.md 第 0 节](../AGENTS.md#0-文档要求)；「什么内容写到哪」的判据见
下表。文档与代码不一致时，先修其中一方使二者一致（`src/test/docsLint.test.ts` 校验
事件表与载荷列、聚合数字与成员清单、章节引用、文档路径与常量、代码块来源标注、
US↔e2e 映射、specs/ 结构与闸门、缺陷规格、主题规格 frontmatter、特性规格结构、单篇 500 行
上限）。主题规格带
`owner` / `last_reviewed` frontmatter（docsLint 校验字段齐全，`docs/` 递归全部规格，
各级 README.md 地图除外）；引用源码的新鲜度对比出报告：`npm run docs:freshness`
（只出报告，不进 CI 门禁）。单篇超过 500 行即按 surface / 状态机拆（需求基线
`docs/features/user-stories.md` 已按此拆为 `user-stories/` 下的主题分册；各级 `README.md`
是地图 / 导读，两者豁免）。

章节编号与代码注释中的「`docs/<path>.md 第 N 节`」引用一一对应；调整章节标题 / 编号时
必须同步修改引用（`src/test/docsLint.test.ts` 的章节引用组校验）。

## 分类法

| 类型 | 去处 | 判据 / 寿命 |
| --- | --- | --- |
| 门面（快速上手） | `README.md` | 面向新开发者；长期 |
| AI 协作约定 | `AGENTS.md` | 风格与工作流约定；长期 |
| 架构规格 | `docs/architecture/<topic>.md` | 跨模块的架构事实（总览、分层、契约、事件词汇表、原则、待定事项）；长期 |
| 主题规格 | `docs/core/<topic>.md`、`docs/hosts/<topic>.md` | 领域规格（Core 与进程、宿主与 UI）；长期 |
| 特性规格 | `docs/features/<feature>.md`（spec 形态：场景 / FR / AC / 追溯矩阵） | 独立成篇判据：跨多个 surface 或有独立状态机；否则作主题规格的一节 |
| 需求基线 | `docs/features/user-stories.md`（索引）+ `docs/features/user-stories/<主题>.md`（分册） | as-built 用户故事，e2e 用例以 `US-xx` 编号引用；随 e2e 演进 |
| 改动规格 | `specs/<NNN>-<slug>/`（spec / plan / tasks 三件套） | 尚未落地的意图与验收，是「只写现状」的例外之一；生命周期见 `specs/README.md`；收敛后 delta 并入 `docs/`、整目录归档 `docs/archive/specs/` |
| 缺陷规格 | `specs/defects/<slug>.md`（扁平单文件，文件名即 slug） | 缺陷的现状与期望，也是「只写现状」的例外；两段流程（评估+红 → 修复+绿）、不编号、不归档，是回归证据的索引（口径见 `specs/README.md`） |
| 待办清单 | `TODO.md`（根目录） | 只列**未排期**的想法与跨 spec 缺口，每条带验收判据；完成即删；进行中的工作在 specs/ 的 `tasks.md` 勾选跟踪、缺陷规格以 status 跟踪 |
| 决策记录 | `docs/adr/NNNN-<slug>.md` | 只记决策、背景与被否决的替代方案；编号递增，只增不删 |
| 冻结档案 | `docs/archive/` | 已完成工作的溯源记录（含 specs/ 归档），不再更新 |
| 临时文件 | 仓库根 `tmp_*` | 一次性盘点 / 计划；不登记地图、不参与 docsLint 校验；落地或放弃后即删 |
| 子目录导读 | `<dir>/README.md`（如 `src/test/README.md`） | 该目录的测试车道 / 运行方式说明 |

## 地图

### 总纲与门面

| 文档 | 范围 |
| --- | --- |
| `README.md` | 快速上手：环境要求、构建 / 测试命令、Core（Rust）说明 |
| `AGENTS.md` | AI 协作者约定：文档规则、分层依赖、命名约定、架构铁律、工作流 |
| `TODO.md` | 未排期想法与跨 spec 缺口（每条带验收判据；进行中的工作在 specs/ 的 `tasks.md`） |

### 改动规格（进行中的工作）

| 文档 | 范围 |
| --- | --- |
| `specs/README.md` | 改动规格工作流：目录约定、生命周期、需求 ID 与追溯、澄清 / 宪章 / 收敛闸门、docsLint 守卫口径、与 TODO.md 的分工 |
| `specs/_templates/` | spec / defect / plan / tasks 四份模板（保留目录名，docsLint 不扫描） |

### 架构规格（docs/architecture/）

| 文档 | 范围 |
| --- | --- |
| `docs/architecture/overview.md` | 架构总览：shared / host / 宿主实现三层、Core（Rust 独立进程）与 `AssistantEventBus` 唯一边、模块职责 |
| `docs/architecture/layering.md` | 分层与依赖规则：依赖方向、规则清单、shared import 审计结论 |
| `docs/architecture/events.md` | `AssistantEventBus` 契约与四组事件词汇表（载荷 / 触发点 / 处理方 / wire message）、订阅、命名、bootstrap 顺序、边界语义 |
| `docs/architecture/contracts.md` | 宿主契约：`UIHost` / `SpinDesign` / `MCPHost` / `ConversationManager` 与宿主侧入口的 `UiEvent` 翻译 |
| `docs/architecture/host-ui-modules.md` | 宿主侧共享子模块与窄端口：`UserChoiceManager` / `ToolHandler` / `WebviewMessageHandler` / `WebViewUiPort` |
| `docs/architecture/core-ui-separation.md` | Core 与 UI 的分离形态：唯一边、配置快照、就绪判据 |
| `docs/architecture/principles.md` | 架构原则：十一条可落点到代码行的判断标准 |
| `docs/architecture/repo-map.md` | 仓库目录布局：全仓路径与关键文件职责的唯一对照表 |
| `docs/architecture/class-diagrams.md` | 架构类图：事件契约与 UI 侧、core 侧与总线的两张类图 + 图注 |
| `docs/architecture/open-questions.md` | 待定事项：仍未定的方向（现状 + 待定），`[待澄清]` 的去向之一 |

### Core 与进程（docs/core/）

| 文档 | 范围 |
| --- | --- |
| `docs/core/standalone-core.md` | Core（Rust）：形态、平台矩阵、构建指纹、契约、传输与生命周期 |
| `docs/core/standalone-core-boundaries.md` | Core 的边界与验收：宿主侧事实读取、落点与测试 |
| `docs/core/core-daemon.md` | Core 进程的 daemon：进程形态、通道模型、生命周期、控制通道协议 |
| `docs/core/core-remote.md` | Core 远程服务：`start` / `kill`、状态文件、远端目录选择与 SSH 接入 |
| `docs/core/client-connection.md` | 连接模型：宿主级 `Client` 与每工作区 `Connection` |
| `docs/core/session-runtime.md` | 会话运行时状态：Core 为唯一 owner，`sessionRuntimeChanged` 全量推送 |

### 宿主与 UI（docs/hosts/）

| 文档 | 范围 |
| --- | --- |
| `docs/hosts/host-matrix.md` | 两宿主实现对照表与宿主分叉清单 |
| `docs/hosts/host-bootstrap.md` | 宿主启动接线与生命周期：bootstrap 顺序、启动期注入点、自检、退出、一致性守护 |
| `docs/hosts/host-info.md` | webview 侧的宿主能力声明 `HostInfo`（注入 / 读取与校验 / 消费点）与消息通道 |
| `docs/hosts/webview-ui.md` | `WebViewUI` 实现与会话级 UI 状态 `SessionUiState` |
| `docs/hosts/webview-facts.md` | webview 的事实与等待态：宿主决定事实、webview 不猜值 |
| `docs/hosts/electron-multi-workspace.md` | Electron 多工作目录（对话的工作区属性、视图生命周期） |
| `docs/hosts/vscode-idle-close.md` | VS Code 单视图宿主的空闲对话回收 |
| `docs/hosts/tui.md` | TUI（第三个宿主，纯 Rust，直连帧通道） |
| `docs/hosts/product-identity.md` | 产品身份的唯一来源与去字面化契约（占位符约定） |

### 特性规格（docs/features/，spec 形态）

| 文档 | 范围 |
| --- | --- |
| `docs/features/user-stories.md` | as-built 用户故事（US-xx）的需求基线索引：附录 US ↔ e2e 映射与「未覆盖 e2e 的 US」豁免段 |
| `docs/features/user-stories/dialog-core.md` | 分册：EP-1 对话核心、EP-2 输入区与会话配置、EP-13 会话交互增强 |
| `docs/features/user-stories/messages.md` | 分册：EP-3 消息呈现、EP-4 权限与用户确认、EP-11 通知与国际化 |
| `docs/features/user-stories/sessions-and-llm.md` | 分册：EP-5 会话管理、EP-6 LLM 配置 |
| `docs/features/user-stories/tools.md` | 分册：EP-7 工具与技能、US-50 联网搜索 |
| `docs/features/user-stories/desktop.md` | 分册：EP-8 桌面端窗口与标题栏、EP-9 多工作区、EP-10 预览与 Spin、EP-12 侧栏文件浏览器 |
| `docs/features/user-message-pipeline.md` | 用户消息从 webview 输入到进入 LLM 上下文的完整管线 |
| `docs/features/compaction.md` | 对话压缩：触发、摘要、归档、跨压缩的用户输入历史 |
| `docs/features/abort-button.md` | abort 按钮的状态判定与中止范围（含 spin 模式） |
| `docs/features/background-bash.md` | Bash 后台任务：手工转后台（暂停 / 接续）与两类任务提醒 |
| `docs/features/tui-installer.md` | TUI 版分发与 Core 部署安装程序 |
| `docs/features/web-search.md` | 联网搜索与网页抓取（WebSearch / WebFetch 客户端工具） |
| `docs/features/ask-user-question.md` | AskUserQuestion 逐题提问：入参 / 答案 / 逐页选择框 / 错误路径 |
| `docs/features/todo-list.md` | 会话 Todo 清单：Core 持有与重建、索取与推送、输入区任务进度按钮 |
| `docs/features/cross-workspace-agent.md` | 跨工作区多 Agent 通信：工作区代理身份、`Agent.target`、占位父对话、跳转、中止与 `@` 补全 |

### 基础

| 文档 | 范围 |
| --- | --- |
| `docs/adr/README.md` | 架构决策记录（ADR）索引：编号、状态与一句话结论；ADR 只增不删 |
| `docs/archive/` | 冻结档案（Standalone Core 落地清单 M0–M16、已归档 specs 等） |

### 子目录导读

| 文档 | 范围 |
| --- | --- |
| `src/test/README.md` | 测试指南：各车道（单元 / 真实 Core 集成 / Rust / 宿主）的进程模型与运行方式 |
| `src/test/memtest/README.md` | MessagesView 渲染 / 内存 / 性能测试 harness（手动运行，不进正式构建） |
| `e2e/README.md` | e2e（Playwright）场景测试：四个 project 的分层与运行方式 |
