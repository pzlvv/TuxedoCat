---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：Core 与 UI 分离

本规格描述 Core 与 UI 的分离形态。Core 与 UI 之间只有一条边——事件总线；Core 持有会话
状态与工具执行，可独立进程部署；UI 以连接的方式接入 Core。宿主环境差异（扩展路径、
日志出口、配置快照）都收敛到这条边上；全局配置与 MCP 配置由 UI 持有并推给 Core；
会话的工作目录是对话的属性，由 UI 在会话首次被 Core 解析目录之前登记。

连接模型（Client / Connection / 工作区引用）见 `docs/core/client-connection.md`；Core
（Rust 独立进程）的进程形态见 `docs/core/standalone-core.md`；Core 进程的 daemon 见
`docs/core/core-daemon.md`。

参考 [docs/architecture/layering.md 第 2 节](layering.md#2-规则清单)（分层与依赖规则）、[第 1 节](events.md#1-总线契约)（核心契约：AssistantEventBus）、
[第 2 节](events.md#2-事件词汇表)（事件列表）、[docs/architecture/contracts.md 第 1 节](contracts.md#1-uihost对话-webview-的宿主能力)（UIHost）、[docs/hosts/host-bootstrap.md 第 1 节](../hosts/host-bootstrap.md#1-宿主接线)（宿主接线）、
[第 2 节](../hosts/host-bootstrap.md#2-启动期状态写入入口与读取器)（注入点与读取器）、[docs/architecture/principles.md 第 7 节](principles.md#7-一份事实只有一个写入点)（一份事实只有一个写入点）。

---

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [能力](#1-能力) |
| 2. | [术语与事实来源](#2-术语与事实来源) |
| 3. | [总线：唯一的边](#3-总线唯一的边) |
| 4. | [配置归 UI](#4-配置归-ui) |
| 5. | [Core 的部署形态](#5-core-的部署形态) |
| 6. | [连接模型](#6-连接模型) |
| 7. | [Core 就绪](#7-core-就绪) |
| 8. | [请求超时](#8-请求超时) |
| 9. | [不覆盖范围](#9-不覆盖范围) |
| 10. | [验收要点](#10-验收要点) |
| 11. | [落点对照](#11-落点对照) |

---

## 1. 能力

1. **唯一的边**：Core 与 UI 之间只有事件总线一条通信路径。两侧不互相引用，也不共享行为。
2. **宿主环境差异经总线传递**：扩展路径、日志出口、Core 数据目录名、配置快照与 MCP
   服务器表由 UI 经总线交给 Core。
3. **配置归 UI**：全局 `settings.json` 与 `mcp.json` 的读与写都由 UI 承担；Core 只消费
   快照，不感知这两个文件的路径。
4. **Core 独立进程部署**：Core 不依赖 UI 所在进程；工具在 Core 所在机器上执行。
5. **连接一对一**：一个 Core 同一时刻只服务一个 Connection；已有连接时新连接被拒绝并
   得到提示。
6. **请求不设超时**：本地与远程同一口径，`request()` 不内置计时器。
7. **Core 有就绪状态**：Core 处理完宿主环境（含配置快照）后才就绪；就绪前收到任何
   `UiEvent` 记 log 拒绝。
8. **Core 不感知语言**：Core 不输出本地化文案；面向用户的文本以「键 + 参数」表达，
   由 UI 翻译。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| Core | 对话引擎、工具、历史 | core |
| UI | 宿主（VS Code 扩展 / Electron）与 webview | host |
| Client | 宿主级唯一实例：配置快照与路由 | host |
| Connection | 宿主与一个 Core 之间的一对一连接 | host |
| 总线 | `AssistantEventBus`：Core 与 UI 之间唯一的事件契约 | 契约由 core 定义 |
| 宿主环境 | 扩展路径、日志出口、Core 数据目录名 | UI 提供，Core 消费 |
| 配置快照 | 规范化后的全局配置与 MCP 服务器表 | host |
| 会话工作目录 | 对话所属工作目录（对话的属性） | UI 在会话首次被 Core 解析目录之前登记 |
| 全局配置 | `~/<CONFIG_DIR_NAME>/settings.json` | host |
| MCP 配置 | `~/<CONFIG_DIR_NAME>/mcp.json` | host |
| 项目清单 | `<conversations>/<project>/workspace.meta.json` | core |
| Core 数据目录 | `~/<CONFIG_DIR_NAME>`（conversations / logs / fail_logs） | core |

---

## 3. 总线：唯一的边

### 3.1 事件契约

三组词汇表构成 Core 与 UI 的公共词汇：

| 词汇表 | 方向 | 语义 |
| --- | --- | --- |
| `CoreEvent` | core → UI | 单向事实通知 |
| `CoreRequest` | core → UI | 请求-响应 |
| `UiEvent` | UI → core | 单向，报告用户动作与宿主环境 |

`UiRequest`（UI → core 的请求-响应）保留，用于「core 的事实 + 副作用」（第 3.6 节）。

### 3.2 宿主环境与配置快照

宿主环境与配置快照合并为一条 `UiEvent.hostEnvironmentProvided`，在 Connection 建立后、
Core 就绪前传递一次。

| 事实 | 性质 | 说明 |
| --- | --- | --- |
| `extensionPath` | 静态 | 扩展 / 应用根目录；Core 自带资源（ripgrep）以**自己的可执行文件目录**为基准定位，这里只作本机开发期的兜底 |
| `logToConsole` | 静态 | 日志是否同时输出到控制台 |
| `configDirName` | 静态 | Core 数据目录名（`~/<configDirName>`） |
| `settings` | 静态 | 配置快照（第 4.3 节） |
| `mcpServers` | 静态 | 规范化后的 MCP 服务器定义（来自 `mcp.json`） |

- 事实在 Connection 建立后传递一次；这是唯一一次传递，没有增量。
- 配置变更后重推**整份**快照（第 4.5 节）：同一条事件、同样的字段，没有增量语义。
- **`locale` 不在其中**：Core 不感知语言（第 4.8 节）；宿主 locale 只用于宿主进程内的
  原生 UI（`src/host/i18n.ts`）。
- **配置路径不在其中**：Core 不感知 `settings.json` / `mcp.json` 的位置。
- Core 侧的读取入口在对应事实到达前抛错，与 `requireEventBus()` 同一口径。
- 这条事件是**连接态事件**：保留最后一次取值，每次握手后重放
  （[docs/core/standalone-core.md 第 6.2 节](../core/standalone-core.md#62-连接态重放)）。

### 3.3 会话工作目录

- **工作目录不是宿主环境差异，而是对话的属性**：Core 持有会话工作目录表
  （`sessionId` → 路径），由 UI 在会话首次被 Core 解析目录之前登记
  （`UiEvent.sessionWorkspaceAssigned`）。Core 不感知「当前工作目录是谁」。
- 登记的是**目标机器上的路径**：远程工作区的 endpoint 与凭证不下发到 Core
  （[docs/core/client-connection.md 第 4 节](../core/client-connection.md#4-工作区引用)）。
- 会话工作目录登记后，Core 以该路径缓存需要反复读取的环境事实（如工作目录的 git
  状态；缓存按工作目录分桶，不同工作目录不互相命中）。

### 3.4 宿主状态上报

宿主自己知道、Core 需要用来判定的事实，由宿主经 `UiEvent` 上报。Core 不持有宿主的判定
闭包，也不反向调用宿主。

| 事实 | 上报时机 | Core 侧落地 |
| --- | --- | --- |
| 该会话的用户选择是否在 webview 里等待应答 | webview 弹出选择 / 用户应答 / 视图释放 | Core 的会话运行时状态（`waiting` 来源，[docs/core/session-runtime.md](../core/session-runtime.md)） |

「会话是否空闲」是 Core 的事实：Core 在 `CoreEvent.sessionRuntimeChanged` 的全量快照里
给出每个会话的 `idle`，宿主只消费快照，不读宿主闭包。

### 3.5 日志

Core 的日志出口在 Core 侧。UI 需要展示日志时经 `CoreEvent` 接收。

### 3.6 UI → core 的请求

`UiRequest` 只承载「core 的事实 + 副作用」，不承载配置读写：

| 请求 | 语义 |
| --- | --- |
| `conversationListRequested` | 会话列表元数据 |
| `smartNamingRequested` | 读会话 + 调 LLM + 解析标题 |
| `balanceRequested` | 按 provider 的 Key 查余额 |
| `compactArchiveRequested` | 归档与主 JSONL 合并 |

配置读写不在其中：写归 UI（第 4 节），读经快照（第 4.3 节）。

### 3.7 边界语义

| 场景 | 语义 |
| --- | --- |
| `emitToUi` 时 `onCoreEvents` 尚未注册 | 抛错（接线缺失在启动期暴露） |
| `emitToCore` / `onUiEvent` 对某 type 无订阅者 | 静默丢弃（允许某动作暂无消费方） |
| `request()` 时无对应处理器 | 立即 reject |
| `request()` 的响应未到达 | 挂起，由调用点自行兜底 |
| 就绪前收到 `UiEvent` | Core 记 log 拒绝（顺序错误在启动日志可见） |

---

## 4. 配置归 UI

### 4.1 归属

| 项 | owner | 说明 |
| --- | --- | --- |
| 全局配置 `~/<CONFIG_DIR_NAME>/settings.json` | host | 读与写都在 UI |
| MCP 配置 `~/<CONFIG_DIR_NAME>/mcp.json` | host | 读与写都在 UI |
| 项目清单 `<conversations>/<project>/workspace.meta.json` | core | 在 Core 数据目录内，读与写都在 Core：`workspacePath` 建目录时写一次，`modifiedDocs`（被工具修改过的 md 集合，specs/030 FR-004）由工具成功修改非 git 工作区内的 md 后更新；宿主只读（`src/shared/workspaceMeta.ts`） |
| 宿主本地偏好 `theme` / `shortcut` | host | 落宿主本机（Electron 为 `userData/workspace-state.json`），不进 `settings.json` |
| 会话级配置 `<conversations>/<project>/<sid>.meta.json` 的 `context.*` | core | 唯一写入点是 `Core` 的配置事件处理器（`on_session_config_changed` / `on_context_updated`）；宿主经 `UiEvent` 请求、只读 `conversationLoadRequested` 的结果。档案缺失时由 `history.update_context` 兜底建档（首条消息前改配置也要能从对话恢复），零消息条目被对话列表的空对话过滤排除 |

- Core 侧没有配置文件写入口，也没有配置文件读入口。
- UI 侧是唯一写入点；写操作串行化，按调用顺序排队。
- 项目清单随会话数据留在 Core 侧：它记录会话目录对应的 `path`，是 Core 数据的一部分
  （[docs/core/client-connection.md 第 4.1 节](../core/client-connection.md#41-与-core-数据目录的关系)）。

### 4.2 快照与磁盘文件是两个东西

| | 磁盘文件 | 配置快照 |
| --- | --- | --- |
| 形态 | 用户可见的 JSON | 传给 Core 的规范化对象 |
| 字段范围 | 全部字段，含 UI 专属字段与未知字段 | 只含 Core 需要的字段 |
| 缺字段 | 可能缺 | 由 UI 补默认值，全部必选 |
| 未知字段 | 读-改-写时原样保留 | 不传递；发现时记日志 warning |

写盘一律走读-改-写，不做整份替换，避免丢掉 Core 不认识的字段。

### 4.3 快照字段

快照字段全部必选（Core 侧类型穷尽、无 optional）：

| 字段 | 内容 |
| --- | --- |
| `llm.activeProvider` | 当前 provider 键；未配置或指向不存在的 provider 时为空串 |
| `llm.webSearch` | WebSearch / WebFetch 工具注入开关（新对话默认值） |
| `llm.thinkingEffort` | 默认思考强度 |
| `llm.model` | 顶层遗留模型名；只在没有会话级 provider 覆盖时优先于 provider 默认模型 |
| `llm.maxTokens` | 配置级输出上限（与模型限值取更严的那个） |
| `llm.enableUsageStats` | 是否上报 usage 统计 |
| `llm.providers` | provider 表：`baseURL` / `apiKey` / `models` / `defaultModel` / `modelLimits` |
| `llm.modelLimitsFallback` | 模型限值的全局兜底（未配置 provider、或模型未命中任何 `modelLimits`） |
| `mcp.enabled` | 全局默认启用的 MCP 服务器名列表 |
| `defaultAgentMode` | 新会话默认询问模式 |
| `defaultPromptMode` | 新会话默认提示词模式 |

- `provider.modelLimits` 是**按 provider 预解析**的模型限值表，条目含 `context` /
  `output` / `apiType` / `thinkingTokenBudget` / `multimodal`。**内置模型注册表归 UI**：
  合并规则在 UI 侧执行，Core 只做「查表，查不到用兜底」，不持有注册表、不做模型名匹配。
  `multimodal` 为 `false` 的模型，Core 发送 LLM 请求前过滤全部图片内容
  （用户消息与工具结果，三种协议一致；过滤只作用于请求副本，落盘记录保留完整图片）。
  context / output 的合并优先级（specs/013-model-settings-popup）：面板「设置」弹层的
  显式值 > 已有 `modelConfigs` 值 > 内置注册表 > 兜底；弹层清空该字段即移除显式值，
  写回注册表数字——与从未设置的模型保存后的落盘内容逐字节同态。
- 兜底是全局常量、与 provider 无关，因此放在 `llm` 级而不是每个 provider 一份。
- `provider.baseURL` **允许为空串**：快照原样携带 provider 表，是否可用由消费方各自判定
  （调 LLM 要求非空；余额查询按 provider key / hostname 匹配，允许没有 baseURL）。
- 快照**不含** `uiLanguage`、`uiFontSize` 与 `highlightLanguages`：这三个字段只有 UI 消费
  （第 4.8、4.10 节）。
- 快照**不含** endpoint 与凭证：那是 Connection 的配置，不是 Core 的
  （[docs/core/client-connection.md 第 4 节](../core/client-connection.md#4-工作区引用)）。

### 4.4 Core 侧的单一入口

- 写入入口唯一：`core-rs/src/settings.rs` 的 `apply_settings_snapshot`，由
  `hostEnvironmentProvided` 的处理器（同文件 `apply_from_host_environment`）调用。
- 读取入口唯一：同文件 `settings_snapshot()`，返回当前快照。
- Core 侧不出现配置文件路径与文件读取，全部消费点读快照。
- 快照未到达时 `settings_snapshot()` 抛错（`has_settings_snapshot()` 为假），
  与扩展路径的读取同一口径。
- Core 不提供默认值：缺字段视为协议错误（快照类型全必选）。

### 4.5 同步点

UI 推快照的时机只有三处，全部收敛到 `SettingsStore`：

| 同步点 | 触发 | 形态 |
| --- | --- | --- |
| Connection 建立 | 打开工作区 | 随 `hostEnvironmentProvided` 一次 |
| LLM 配置保存 | 设置面板保存 | 整份快照，推给所有已就绪的 Connection |
| MCP 默认启用列表变更 | 设置面板保存 | 整份快照，推给所有已就绪的 Connection |
| `settings.json` 外部修改被察觉 | 打开设置面板 / webview 挂载（`refreshFromDisk`） | 内容有变化才重推整份快照 |

明确**不**触发推送的变更：

- `uiLanguage` 变更：该字段不进快照，Core 不感知。
- `uiFontSize` 变更：该字段不进快照，Core 不感知。
- `highlightLanguages` 变更：该字段不进快照，Core 不感知。
- `mcp.json` 文件变更：只在 Connection 建立时读一次；中途修改不通知 Core，
  重开工作区生效。
- `settings.json` 的外部修改（用户手工编辑）：UI **不监听文件**（不装 watcher）；
  但打开设置面板 / webview 挂载时会调 `SettingsStore.refreshFromDisk()` 重读一次，
  内容有变化就按上面的同步点重推快照。启动期读到残缺文件时因此不必重载窗口。
  设置面板仍是唯一受支持的写入口。

架构约束：快照的构造只发生在 `SettingsStore` 内；Core 侧只有 `applySettingsSnapshot` /
`getSettings` 两个入口。新增配置字段时必须同时更新快照类型（全必选，缺字段编译或协议
报错），不允许在 Core 侧另开读取路径。

### 4.6 写盘规则

- 写操作串行化，按调用顺序排队。
- 单次写操作失败不影响后续队列；失败记日志（[docs/architecture/principles.md 第 11 节](principles.md#11-共享文件的写安全)）。
- 后写覆盖：不做冲突检测与合并提示。
- 写盘完成后重新构造快照并推给所有已就绪的 Connection。
- 写入口唯一：`SettingsStore.updateSettings`（宿主侧）；Core 侧没有写入口，
  也没有「保存配置」这条请求/事件。
- 推快照由 `bootstrapCore` 在 `SettingsStore` 上订阅一次完成，不在各个写调用点手工触发。

**共享文件的写安全**（`settings.json` 是「同一台机器上多个宿主进程共写」的文件）：

| 规则 | 理由 |
| --- | --- |
| 读-改-写整体在跨进程锁内执行（`src/shared/utils/fileLock.ts`） | 无互斥时两个宿主的读-改-写交错，后写者丢掉先写者的改动 |
| **读不出来就拒绝写入** | 「文件存在但解析失败」不等于「用户没配置过」。当成空配置继续写，会用 `{}` + 本次改动覆盖掉用户的全部配置 |
| 写入原子（临时文件 + `rename`） | 直接 `writeFile` 先截断再写入，并发读者会看到空文件或半截内容；`rename` 在同一文件系统内原子。Windows 上 `rename` 覆盖已有文件可能被杀毒软件 / 索引器瞬时占用目标文件（`EPERM` / `EACCES`），做有限次退避重试，重试用尽仍失败才报错 |
| 内容未变化时不落盘 | 高频调用（如记录高亮语言）不必反复重写磁盘，也缩小竞争窗口 |

「读不出来」与「文件不存在」必须分开：前者保持上一次的良好快照并记日志，后者按空配置
处理。两者混同会让一次并发读失败演变成配置被清空。

锁只保证**协作进程**之间的互斥；写入本身仍必须原子，否则不遵守约定的读者照样会看到
半截文件。

### 4.7 MCP 配置

- `mcp.json` 由 UI 解析、规范化，随快照一次下发（`mcpServers`）。
- 解析失败或文件缺失时按空表处理并记日志；这是 UI 侧行为，Core 不参与。
- Core 侧的 MCP 子进程生命周期不变（[docs/core/standalone-core.md 第 7 节](../core/standalone-core.md#7-事实归属)）。

### 4.8 文本语言

- **Core 不感知语言**：Core 不读 `uiLanguage`，不持有 locale，不输出本地化文案。
- i18n 归 UI：翻译表、语言选择与渲染都在 UI 侧（`src/host/i18n.ts`）。
- 宿主语言收敛：宿主读自己的 `settings.json`（`uiLanguage`）与宿主 locale，经
  `coreFacts.primeHostLocale()` 收敛到 `src/host/i18n.ts`；共享启动骨架 `bootstrapCore`
  在启动接线内**同步**调用（不等 Connection 就绪），Electron 另在
  创建托盘 / 菜单之前提前调用一次。显式 `uiLanguage`（zh / en）覆盖宿主 / 系统语言，
  `auto` 才回落。运行期语言变化由 `onHostLocaleChanged` 通知订阅者（原生菜单 / 托盘菜单
  据此重建）。
- Core 面向用户的文本以「键 + 参数」表达，由 UI 翻译；键缺失时 UI 显示键本身并记日志。
- 对等约束：Core 用到的每个键必须在 UI 的翻译表里存在，由测试锁定。
- **LLM prompt 与 UI 语言无关**：prompt 是 Core 的内部实现，不随语言变化，不参与键化。
- **落盘文本统一英文**：进入会话历史（JSONL / LLM 上下文）的文本由 Core 生成，
  一律用英文常量。历史不随语言切换重渲染。

### 4.9 瞬时状态通知

描述瞬时状态的提示（压缩已排队、回滚结果、命令输出、LLM API 错误提示等）不是消息，
不进消息流，也不落盘。它们经 `CoreEvent.notice` 表达：

```
CoreEvent.notice { sessionId, key, params, level }
```

- UI 收到后翻译并以瞬时提示呈现，不写入会话历史。
- 消息流（`CoreEvent.message` / `streamMessage` / `messagesReplaced`）只承载对话内容。
- 高亮语言由 webview 扫描并上报 UI（`highlightLanguages` 只有 UI 消费），Core 不参与；
  UI 启动时把已知列表注入 webview。

### 4.10 界面字号

- **Core 不感知字号**：`uiFontSize` 只有 UI 消费，不进配置快照，不影响任何 Core 事实。
- 取值 `medium` / `large` / `xlarge`，默认 `medium`；缺省取值由宿主决定
  （`SettingsStore.readUiFontSize()`），webview 不持有该取值。
- 宿主把档位同步注入 webview（`window.__uiFontSize`，与 `__uiLocale` 同一路径）；
  webview 侧 `src/webview/fontSize.ts` 把它折算为根元素 CSS 变量 `--ui-font-offset`
  （0 / 2 / 4 px），受影响的字号统一写成 `calc(<基准>px + var(--ui-font-offset))`
  （`src/webview/styles/index.css` 的 `ui-fs-*`）。运行期变更经设置面板保存回传后即时生效。
- 影响范围：输入框、输入框 context 用量、MessagesView、菜单项、历史对话项、设置面板、标题。

---

## 5. Core 的部署形态

- Core 与 UI 位于各自的进程；两者可以在同一台机器，也可以在不同机器。
- 工具（Bash、文件读写、ripgrep、MCP stdio server）在 Core 所在机器上执行，操作 Core
  侧的文件系统。
- 会话状态、历史落盘、项目清单读写、Spin 设计 `spin.json` 读写都在 Core 侧。
- 配置读写、MCP 配置解析、模型注册表在 UI 侧。
- UI 侧保留表现与宿主界面能力：diff 预览、Mermaid 预览、打开外部链接、另存为、界面构造。

---

## 6. 连接模型

- 一个 Core 同一时刻服务一个 Connection。
- Connection 已存在时，新连接被拒绝，并得到提示。
- 总线契约不感知连接数量：`connectionId` 是 UI 侧的内部概念，不进入任何载荷。
- 一个宿主可以有多个 Connection（每个打开的工作区一个）；分层与路由见
  `docs/core/client-connection.md`。

---

## 7. Core 就绪

| 状态 | 含义 |
| --- | --- |
| 启动 | Core 已建立连接，尚未收到宿主环境与配置快照 |
| 就绪 | 已处理 `hostEnvironmentProvided` |

- Core 处理完 `hostEnvironmentProvided` 后发出 `CoreEvent.coreReady`。
- **每次应用快照都发一次**：首次握手一次，之后每次重推快照（配置变更）再一次。
  Core 侧的就绪状态本身是幂等的——快照就是判据（`settings.rs` 的
  `has_settings_snapshot()`），不需要额外的状态位。
- **就绪前只接受 `hostEnvironmentProvided`，其它 `UiEvent` 直接拒绝**：挡住的责任在
  UI 侧（[docs/core/client-connection.md 第 7 节](../core/client-connection.md#7-就绪状态机)）；Core 侧把顺序错误记一条 log
  并丢弃该事件（帧通道没有反向异常通路），把顺序错误变成启动期可见的诊断。
- 重连不在本规格范围内（第 9 节）。

---

## 8. 请求超时

- `request()` 不内置计时器，本地与远程同一口径。
- 权限确认与用户选择的耗时上界由用户决定，不设上界。
- 断线导致的未决请求另行处理。

---

## 9. 不覆盖范围

- 事件在连接上的序列化与反序列化格式（见 [docs/core/standalone-core.md 第 5 节](../core/standalone-core.md#5-传输与协议)）。
- 流式事件的节流与合并。
- 断线后的恢复与重连。Core 崩溃后的进程重启（[docs/core/core-daemon.md 第 6 节](../core/core-daemon.md#6-重启)）是同一
  channel 内的连接重置，不属于跨连接的断线重连。
- 远程工作区的实现（见 [docs/core/client-connection.md 第 9 节](../core/client-connection.md#9-落盘与恢复宿主侧)）；跨机器部署时宿主直接读
  Core 磁盘的例外需要迁到 `UiRequest`（见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。
- 多 Connection 的界面呈现。

---

## 10. 验收要点

1. Core 与 UI 之间只有总线一条通信路径。
2. 会话工作目录登记后，该路径的系统动态信息被预热；不同工作目录的会话各自命中自己的缓存。
3. 扩展路径 / 日志出口 / Core 数据目录名 / 配置快照 / MCP 服务器表在 Connection 建立后
   传递一次；Core 侧读取入口在此之前抛错。
4. 全局配置与 MCP 配置的写入只有 UI 一处；Core 侧不存在配置文件路径与文件读写。
5. 项目清单的写入只有 Core 一处。
6. 第二个连接到达时被拒绝并得到提示。
7. `request()` 在响应到达前保持挂起，不因计时器 reject。
8. Core 不持有任何宿主提供的判定闭包；「会话是否空闲」只看 Core 自己的事实。
9. Core 处理完 `hostEnvironmentProvided` 前收到任何 `UiEvent` 都记 log 拒绝。
10. 快照字段全必选；Core 侧只有 `applySettingsSnapshot` / `getSettings` 两个入口。
11. Core 侧不存在本地化文案：面向用户的文本以键 + 参数表达，落盘文本为英文常量。
12. 瞬时状态提示经 `CoreEvent.notice` 表达，不进入消息流与历史。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 总线契约与词汇表 | `src/shared/AssistantEventBus.ts` |
| 帧通道总线实现 | `src/host/standalone/StandaloneEventBus.ts`（宿主侧）、`core-rs/src/frame.rs`（Core 侧） |
| Client / Connection | `src/host/Client.ts`、`src/host/Connection.ts`（见 `docs/core/client-connection.md`） |
| 配置快照 | `src/host/SettingsStore.ts` |
| 快照契约与解析（纯函数） | `src/shared/settingsSnapshot.ts`（`resolveSettingsSnapshot`） |
| `mcp.json` 纯解析 | `src/shared/mcp/parse.ts`（`parseMcpServerDefinitions`） |
| Core 侧快照入口 | `core-rs/src/settings.rs`（`apply_settings_snapshot` / `settings_snapshot` / `mcp_server_definitions`） |
| Core 数据目录与项目清单 | `core-rs/src/config.rs`、`core-rs/src/history.rs` |
| 会话工作目录登记与预热 | `core-rs/src/config.rs`（`set_session_workspace`）与 Core 进程内的环境事实缓存 |
| 用户选择等待状态 | `src/host/ui/userChoice.ts`（上报）、Core 的会话运行时状态（`core-rs/src/engine.rs`，落地与读取） |
| i18n | `src/host/i18n.ts` |
| 瞬时通知渲染 | `src/host/WebViewUI.ts` |
| 启动接线 | `src/host/bootstrapCore.ts` |
