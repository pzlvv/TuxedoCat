---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：分层与依赖规则

本文描述模块间的依赖方向与逐条依赖规则（as-built），是代码评审的检查清单。
分层结构见 [overview.md](overview.md)。

## 1. 依赖方向

依赖方向（代码评审必须检查）：

```
src/shared/（TS 共享叶子层：总线契约 / 类型 / 会话落盘格式 / 纯工具）
   ←  src/host/  ←  宿主实现（VSCode* / Electron*）
   ←  src/webview/（WebView UI）
core-rs/（Core，Rust 独立进程）⟷ host/webview 只经 AssistantEventBus 帧通道
```

`AssistantEventBus`（`src/shared/AssistantEventBus.ts`）是 Core 与 UI 之间唯一的边：
Core 在独立进程内实现 core 侧契约，帧通道把它映射为宿主进程内的总线对象。

## 2. 规则清单

1. `src/shared/` 是共享叶子层：不得 import `host/` 的实现与任何宿主 API
   （`vscode` / `electron`），webview 与 host 都可以依赖它。事件契约（`CoreEvent` /
   `CoreRequest` / `UiEvent`）与处理器映射类型（`CoreEventHandlers` 等）只在这一层定义。
2. Core（`core-rs/`）不 import TS 侧任何代码；两侧只经帧通道上的事件词汇表通信，
   载荷字段名逐项一致（`camelCase` 原样）。
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
9. `host/` 与宿主实现可以 **import `src/shared/` 的只读函数与类型**（如
   `loadConversationList`、`ConversationMetadata`），这属于「宿主消费 core 侧事实的
   读取库」。但 host 侧**不得绕过总线改 Core 拥有的状态**；改状态的请求一律翻译为
   `UiEvent` 走总线。
  全局配置文件 `~/<CONFIG_DIR_NAME>/settings.json` 是宿主资源：**读与写都在宿主**，
  core 不感知它的路径，只消费经 `UiEvent.hostEnvironmentProvided` 下发的配置快照
  （[docs/architecture/core-ui-separation.md 第 4 节](core-ui-separation.md#4-配置归-ui)）。写入口唯一：`SettingsStore.updateSettings`；
  写盘后由 `bootstrapCore` 里的一次订阅重新构造快照并推给 Connection，调用点不手工触发。
  对话目录下的 `<conversations>/<project>/workspace.meta.json`（记录 workspacePath）不同：
  它归 core（在 Core 数据目录内），目录创建与清单读写都在 core，宿主不参与写盘。
  宿主本地偏好（`theme` / `shortcut`）不在这两份文件里：它们只有 Electron 消费，落
  `userData/workspace-state.json`（`electron/workspaceStateStore.ts`，临时文件 + rename 原子落盘、内容未变不落盘），core 不读不写（[docs/hosts/host-matrix.md 第 6 节](../hosts/host-matrix.md#6-宿主固有差异有意保留)）。

### 2.1 规则 9 的审计结论

对 `src/host/**` 与宿主实现层的 `src/shared/` import 逐项归类：

| 类别 | 判据 | 落点 |
| --- | --- | --- |
| 纯函数 / 类型 / 常量 | 无副作用、不读进程内状态 | `conversationPayload` / `llmConfigSave` / `settingsRead` / `webviewMessageHandler` 的解析与拼装函数、各模块的类型与常量 |
| 受控事实入口 | 一律走 `UiRequest`（事实在 Core 进程内） | `src/host/coreFacts.ts`（对话列表 / 智能命名 / 余额 / 归档展开 / MCP 列表 / 对话空间 / 会话加载 / 技能列表 / 挂起持久化） |
| UI 侧共享队列 | 状态归 UI，不属于 core 事实 | `src/shared/UserChoiceQueue.ts`（宿主侧待答队列） |

仍保留的直接读取（与本机 Core 共用同一份磁盘，远程工作区需要迁到
`UiRequest`，见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)的例外表）：

- 会话工作目录索引：宿主侧另存一份 `sessionId → workspacePath`
  （`history/Config.ts` 的 `getSessionWorkspace` / `setSessionWorkspace`）。Standalone 的
  权威表在 Core 进程内、由 `sessionWorkspaceAssigned` 同步；宿主侧这份只用于
  「发事件前取会话自己的目录」，不参与 core 的目录解析；
- 工具 `_meta` 的 before/after：`ToolHandler` 在权限确认时经 `updateToolUseMeta`
  追加写入会话 JSONL（与 Core 的写入共用同一份磁盘，本机成立）。
