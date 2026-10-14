---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：分层与依赖规则

本文描述模块间的依赖方向与逐条依赖规则（as-built），是代码评审的检查清单。
分层结构见 [overview.md](overview.md)。

## 1. 依赖方向

依赖方向（代码评审必须检查）：

```
core/  ←  host/  ←  宿主实现（VSCode* / Electron*）
         ↑
   AssistantEventBus 是 core 与 UI 之间唯一的边
```

## 2. 规则清单

1. `core/` 不得 import `host/` 的具体实现，只能 import `AssistantEventBus`、事件类型与宿主契约类型。
   core 内部模块之间通过 `requireEventBus()` 发送事件，不得直接调用 UI 的任何方法。
2. `core/` 不得定义「UI 侧处理器契约」类型。UI 需要处理哪些事件，由
   `core/AssistantEventBus.ts` 中的 `CoreEventHandlers` 映射类型表达。
3. `host/` 不得 import `vscode` / `electron`。当前 `src/host/**` 中无任何此类 import。
4. `host/ui/*` 不得 import 任何宿主 API；宿主差异通过 `UIHost` 与 `WebViewUiPort` 注入。
5. 共享代码中不得出现 `host.kind === '...'` 形式的宿主嗅探；宿主差异须以能力字段或独立方法表达。
6. `UIHost` / `SpinDesign` / `ConversationManager` 的成员全部必选，不出现 `?`；可选语义以 `null`
   或判别联合表达。必选性由**构造时序**保证（构造函数内先建立依赖、再注册处理器），
   不得使用 `!` 空断言。
7. 契约按 **UI surface** 划分：`UIHost` 服务对话 webview，`SpinDesign` 服务 Spin 设计器，
   `ConversationManager` 服务对话列表与会话状态。新增面板、窗口或列表类功能时，
   应先确定其所属 surface，而不是向 `UIHost` 追加成员。
8. **不同来源的数据走不同的流**，不得以附加标记的方式合并。磁盘元数据（低频）与运行时状态
   （高频）各自拥有独立的事件与分发方法；`loaded` 这类宿主界面状态由其 owner 单独推送。
   判据：若两个字段的变化频率相差一个数量级，或其 owner 不同，则不应出现在同一条流中。
9. `host/` 与宿主实现可以 **import core 的只读函数与类型**（如 `loadConversationList`、
   `hasSettingsSnapshot`、`ConversationMetadata`），这属于「宿主消费 core 的事实」，
   与「core 不得 import host」共同构成单向依赖：`宿主实现 → host/ → core/`。
   但 host 侧**不得调用 core 的状态变更函数**；改状态的请求一律翻译为 `UiEvent` 走总线。
  全局配置文件 `~/<CONFIG_DIR_NAME>/settings.json` 是宿主资源：**读与写都在宿主**，
  core 不感知它的路径，只消费经 `UiEvent.hostEnvironmentProvided` 下发的配置快照
  （[docs/architecture/core-ui-separation.md 第 4 节](core-ui-separation.md#4-配置归-ui)）。写入口唯一：`SettingsStore.updateSettings`；
  写盘后由 `bootstrapCore` 里的一次订阅重新构造快照并推给 Connection，调用点不手工触发。
  对话目录下的 `<conversations>/<project>/workspace.meta.json`（记录 workspacePath）不同：
  它归 core（在 Core 数据目录内），目录创建与清单读写都在 core，宿主不参与写盘。
  宿主本地偏好（`theme` / `shortcut`）不在这两份文件里：它们只有 Electron 消费，落
  `userData/workspace-state.json`（`electron/workspaceStateStore.ts`，临时文件 + rename 原子落盘、内容未变不落盘），core 不读不写（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)）。

### 2.1 规则 9 的审计结论

对 `src/host/**` 与宿主实现层的 core import 逐项归类：

| 类别 | 判据 | 落点 |
| --- | --- | --- |
| 纯函数 / 类型 / 常量 | 无副作用、不读进程内状态 | `conversationPayload` / `llmConfigSave` / `settingsRead` / `webviewMessageHandler` 的解析与拼装函数、各模块的类型与常量 |
| 受控事实入口 | 按 `CORE_KIND` 分派：Embedded 直读、Standalone 走 `UiRequest` | `src/host/coreFacts.ts`（对话列表 / 智能命名 / 余额 / 归档展开 / MCP 列表 / 对话空间 / 会话加载 / 技能列表 / 挂起持久化） |
| Embedded-only 装配 | `CORE_KIND === 'embedded'` 分支内；Standalone 下 core 在进程外自行完成 | `bootstrapCore` 的 `initializeCoreEvents` / `ensureConfigDirs` / `getMCPHost().prune`；`webviewMessageHandler` 的 `restoreConversationEngine` |
| UI 侧共享队列 | 状态归 UI，不属于 core 事实 | `src/core/UserChoiceQueue.ts`（宿主侧待答队列；Standalone 下同样由 UI 使用） |

仍保留的直接读取（Standalone 下与本机 Core 共用同一份磁盘，远程工作区需要迁到
`UiRequest`，见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)的例外表）：

- 会话工作目录索引：宿主侧另存一份 `sessionId → workspacePath`
  （`history/Config.ts` 的 `getSessionWorkspace` / `setSessionWorkspace`）。Standalone 的
  权威表在 Core 进程内、由 `sessionWorkspaceAssigned` 同步；宿主侧这份只用于
  「发事件前取会话自己的目录」，不参与 core 的目录解析；
- 工具 `_meta` 的 before/after：`ToolHandler` 在权限确认时经 `updateToolUseMeta`
  追加写入会话 JSONL（与 Core 的写入共用同一份磁盘，本机成立）。
