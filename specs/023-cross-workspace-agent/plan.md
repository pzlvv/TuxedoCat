# 实施方案：跨工作区多 Agent 通信

技术路线：身份在宿主侧派生（`机器名 + 路径`），跨工作区派发走「Core A → 宿主 → Core B」的
三段路由——Core A 用 `CoreRequest` 请求宿主在目标工作区建会话，宿主按身份找到目标 Connection
直接下发 `UiEvent`；回复、中止、结束三条反向链路各自走一条 `CoreEvent`，由宿主按会话归属
转发。占位父对话不落独立文件，由子代理 meta 的 `crossWorkspaceOrigin` 在列表读取时派生。

## 技术方案

### 1. 身份（宿主）

`src/host/workspaceIdentity.ts`（新增，纯函数、无宿主 API）：

- `resolveMachineName(platform, env, osHostname)`：`win32` 取 `COMPUTERNAME`、`linux` 取
  `HOSTNAME`，缺失回退 `osHostname()`；
- `workspaceAgentId(ref, machineName)`：本地 `"<机器名>:<规范化路径>"`；远程
  `"<endpoint.host>:<原样路径>"`（不含端口与用户）；
- `resolveWorkspaceByIdentity(refs, id)`：按身份精确匹配，命中多项返回歧义。

Electron 主进程在打开集合变化时重算身份表；身份不进 Core 的配置快照，只作为 `@` 候选与
`Agent.target` 的匹配键。

### 2. 跨工作区派发（Core A → 宿主 → Core B）

Core A：

- `tools::run_agent` 读 `target`；缺省走既有 `spawn`，非空走新增的 `spawn_remote` 钩子；
- `Core::spawn_remote_agent` 组装 `CoreRequest.crossWorkspaceAgentRequested`
  （`sessionId` / `targetWorkspaceId` / `role` / `prompt` / `description`），经
  `plain_request` 阻塞等宿主应答；
- 成功后在 `subagent` 注册表登记「远程子代理」（id / creator / 目标工作区），使
  `subAgentRunning`、`abort_session_scope`、槽位释放覆盖它；失败直接返回工具错误并归还槽位。

宿主：

- `WebViewUI` 的 `CoreRequestHandlers` 新增 `crossWorkspaceAgentRequested`：
  按请求里的 `sessionId` 找到来源 Connection（`Client.connectionForSession`）→ 取来源工作区
  身份 → 按身份解析目标 `WorkspaceRef`（未打开 / 歧义 → 返回 `{error}`）→ 目标 Connection
  未就绪 → 返回 `{error}`；
- 生成子会话 id（`sub_<millis>_<suffix>`，与 Core 同格式）与占位 id（`ph_<originSessionId>`），
  向目标 Connection 直接 `emitToCore` 一条 `UiEvent.remoteSubAgentStarted`
  （携带 `workspacePath` / `role` / `prompt` / `description` / `parentSessionId` /
  `originWorkspaceId` / `originSessionId` / `originTitle`）；
- 登记 `crossWorkspaceLinks`：`subSessionId → { originSessionId, targetRef }`，供回复 / 中止 /
  结束三条反向链路路由；
- 返回 `{ sessionId }`。

Core B（`UiEvent.remoteSubAgentStarted`）：

- 登记会话工作目录、创建 `SessionState`（目标工作区默认模型 / agentMode / 提示词预设，
  `parent_session_id` = 发起方会话 id 供 `Reply` 默认目标，`cross_workspace_origin` 记来源）；
- 写子代理 `meta.json`（`parentSessionId` = 占位 id、`role`、`title`、`crossWorkspaceOrigin`）；
- `subagent::register` 后起 `run_sub_agent` 线程，语义与本地子代理一致。

### 3. 反向链路（Core B → 宿主 → Core A）

| 链路 | Core B 产出 | 宿主 | Core A 消费 |
| --- | --- | --- | --- |
| Reply | `CoreEvent.crossWorkspaceAgentReplyRequested`（`sessionId` = 发起方会话） | 按 `sessionId` 路由到来源 Connection | `UiEvent.agentReplyReceived` → `enqueue_agent_message` |
| 中止 | —（宿主发 `UiEvent.abortRequested` 给 Core B） | 收到 `CoreEvent.crossWorkspaceAgentAbortRequested` 后查 link 发中止 | `abort_session_scope` 对远程子代理发中止事件，不递归本地 |
| 结束 | `CoreEvent.crossWorkspaceAgentEnded` | 按 link 找来源 Connection | `UiEvent.crossWorkspaceAgentCompleted` → 注销远程登记 + 释放槽位 + 刷新运行时 |

### 4. 占位父对话（派生，不落独立文件）

子代理 `meta.json` 增加 `crossWorkspaceOrigin: { workspaceId, sessionId, title }`，`parentSessionId`
写 `ph_<originSessionId>`。列表读取（Rust `history::load_conversation_list` 与
TS `loadConversationList`）在遇到带 `crossWorkspaceOrigin` 的条目时补一条同 id 的占位条目：

```json
{ "sessionId": "ph_...", "project": "...", "title": "<发起方标题>", "placeholder": { ... } }
```

占位条目不进 LLM、不进空闲回收；子对话删除后派生条目自然消失。侧栏按 `parentSessionId` 分组
即得到「占位父 + 子代理」的树。

### 5. 跳转

- webview：`navigateToSession(sessionId, workspaceId)` → `openConversation` 载荷新增
  `workspaceId: string | null`；主进程按 `workspaceId` 找到打开集合中的引用、激活标签页、
  登记会话目录并开视图；未打开时忽略并提示。
- `Agent.tsx` 用工具入参的 `target` 作为跳转工作区。
- 占位条目点击：侧栏把 `placeholder` 载荷随 IPC 回传，主进程显示新增的
  `crossWorkspaceAgent` 占位页（`chatPlaceholderHtml` 新 kind），页面按钮经
  `chatPlaceholderPreload` 通知主进程跳到发起方会话。

### 6. `@` 补全与 reminder

- webview：`InputArea` 新增 `@` 检测（引号 / 非引号区间）、候选菜单（复用 `SlashPopup`
  的渲染形态）、插入规则；候选由 `requestWorkspaces` / `setWorkspaces` 提供，宿主按
  **发起视图的工作区引用**过滤掉本工作区。
- Core：轮次边界识别 `@` 命令（引号 / 非引号两种），在用户消息之后注入一条
  `<Reminder>` silent 消息，点名 `target` 与目标身份；仅在
  `hostEnvironmentProvided.crossWorkspaceAgent === true` 时生效。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/workspaceIdentity.ts` | 新增 | 无（纯函数） |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `CoreRequest.crossWorkspaceAgentRequested`、`CoreEvent.crossWorkspaceAgentReplyRequested` / `crossWorkspaceAgentAbortRequested` / `crossWorkspaceAgentEnded`、`UiEvent.remoteSubAgentStarted` / `agentReplyReceived` / `crossWorkspaceAgentCompleted`、`hostEnvironmentProvided.crossWorkspaceAgent` |
| `src/host/webviewMessages.ts` | 修改 | 新增 `requestWorkspaces` / `setWorkspaces`；`openConversation.workspaceId`；`conversationsData` 占位字段 |
| `src/host/ui/webviewMessageHandler.ts` | 修改 | 新增 `requestWorkspaces` 分发 |
| `src/host/WebViewUI.ts` | 修改 | 新增 `crossWorkspaceAgentRequested` 处理器与 link 表 |
| `core-rs/src/tools.rs` / `tool_input.rs` | 修改 | `Agent` 入参新增 `target`；`SubAgentHooks` 新增 `spawn_remote` |
| `core-rs/src/engine.rs` / `subagent.rs` / `history.rs` | 修改 | 远程子代理建会话、回复 / 中止 / 结束、占位条目派生 |
| `core-rs/src/main.rs` | 修改 | 新增三条 `UiEvent` 分发 |
| `electron/main.ts` / `sidebar` / `chatPlaceholderHtml.ts` / `chatPlaceholderPreload.ts` | 修改 | 跳转动作、占位页 |
| `src/webview/InputArea.tsx` / `App.tsx` / `mentionState.ts` | 修改 / 新增 | `@` 补全 |
| `docs/**` | 修改 / 新增 | 事件表、契约表、多工作区规格、用户故事、新特性规格 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：身份与路由在 `src/host/`，不 import `vscode` / `electron`；
      Electron 主进程只做接线；Core 不感知宿主类型，只读 `hostEnvironmentProvided` 的能力位。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：`target` 未命中直接报错不降级；新契约成员全必选
      （`workspaceId: string | null`、`crossWorkspaceAgent: boolean`、`placeholder` 显式 `null`）；
      身份 owner 是 Electron 主进程，Core 只读派生；占位条目由唯一派生函数生成。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：`meta.json` 新增 `crossWorkspaceOrigin`
      由 core-rs 写、`src/shared/history/` 读，两侧同步并有对照测试；Core 行为改动落
      `core-rs/src/*_tests.rs`。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`docs/architecture/events.md` 事件表、`contracts.md`、
      `hosts/electron-multi-workspace.md`、`features/user-message-pipeline.md`、
      `features/abort-button.md`、`core/session-runtime.md`、用户故事与新增
      `docs/features/cross-workspace-agent.md` 同批更新，`docs-lint` 为闸门。

## 被否决的替代方案

- **让 Core 直接连另一台 Core**：需要新的网络通道与认证，与「SSH 是唯一接入方式」冲突；
  且 Core 不感知宿主拓扑。否决。
- **占位对话写独立 meta 文件**：需要额外生命周期（子对话删除后清理孤儿、列表过滤
  `messageCount === 0`），且重启后可能与子对话不一致。改为从子代理 meta 派生。
- **`@` 由宿主在消息文本上追加 reminder**：reminder 属于模型上下文，宿主不拥有上下文；
  与 `/` 命令的 Core 侧轮次边界解析口径不一致。否决。
- **跨工作区子代理继承发起方会话配置**：跨机器时发起方的模型 / 凭证未必在目标机器有效；
  改取目标工作区默认值（spec FR-003）。
- **`target` 未打开时自动打开工作区**：远程需要凭证与建链等待，会让工具调用长时间挂起；
  按 spec 报错。
