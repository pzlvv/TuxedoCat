---
owner: pzlvv
last_reviewed: 2026-10-23
---

# 规格：跨工作区多 Agent 通信

本规格界定 Electron 多工作区宿主上的跨工作区代理：工作区代理身份（`机器名 + 工作区路径`）、
`Agent` 工具的 `target` 入参、跨工作区子代理会话与占位父对话、双向跳转、跨工作区中止，
以及输入框的 `@` 工作区补全与 reminder 注入。VS Code 宿主与 TUI 不提供本能力。

交叉引用：多工作区模型见 [docs/hosts/electron-multi-workspace.md 第 2 节](../hosts/electron-multi-workspace.md#2-术语与事实来源)；
事件与载荷见 [docs/architecture/events.md 第 2 节](../architecture/events.md#2-事件词汇表)；
中止范围见 [docs/features/abort-button.md](../features/abort-button.md)；
用户消息管线与命令解析见 [docs/features/user-message-pipeline.md](../features/user-message-pipeline.md)；
会话运行时快照见 [docs/core/session-runtime.md 第 2 节](../core/session-runtime.md#2-对外快照)。

## 1. 用户场景与验收标准

- 场景 1：同机两个工作区互相代理
  - **AC-1**（FR-001）：GIVEN Electron 打开两个本地工作区 WHEN 在任一聊天视图输入 `@` THEN 候选里两项身份分别等于「本机机器名:该工作区绝对路径」。
  - **AC-2**（FR-002）：GIVEN 会话属于工作区 A WHEN 模型调用 `Agent` 且 `target` 为工作区 B 的身份 THEN 工作区 B 的对话列表新增该子代理对话，工作区 A 不新增。
  - **AC-3**（FR-002）：GIVEN 同一会话 WHEN 调用 `Agent` 不传 `target` THEN 子代理对话归属工作区 A 且 `parentSessionId` 为该会话。
  - **AC-4**（FR-002）：GIVEN 同一会话 WHEN `target` 等于当前会话所属工作区的身份 THEN 按不传 `target` 的策略创建本机子代理。
- 场景 2：跨机器代理（SSH 远程工作区）
  - **AC-5**（FR-001）：GIVEN 打开 SSH 远程工作区且目标主机为 `192.168.1.10`、目录为 `/srv/app` WHEN 打开 `@` 候选 THEN 该项身份为 `192.168.1.10:/srv/app`。
  - **AC-6**（FR-002）：GIVEN 本机会话 WHEN `target` 指向已打开的远程工作区 THEN 远程 Core 创建子代理对话并开始执行 prompt。
- 场景 3：占位父对话与跳转
  - **AC-7**（FR-003）：GIVEN 跨工作区子代理对话已创建 WHEN 读取其元数据 THEN `role` 等于 `agentRole`、`title` 等于 `description`、`project` 等于目标工作区路径、`parentSessionId` 指向占位对话。
  - **AC-8**（FR-004）：GIVEN 目标工作区侧栏 WHEN 渲染对话树 THEN 跨工作区子代理嵌套在占位父节点下，占位节点不提供重命名 / 删除 / 智能命名入口。
  - **AC-9**（FR-004）：GIVEN 占位对话 WHEN 用户点击打开 THEN 聊天区显示占位页，不加载任何消息、不建立会话运行时。
  - **AC-10**（FR-004）：GIVEN 占位对话与子代理对话 WHEN 应用重启后重新打开目标工作区 THEN 两者仍在列表中且父子关系不变。
  - **AC-11**（FR-005）：GIVEN 占位页 WHEN 点击跳转链接 THEN 活动标签切到发起方工作区并打开发起方对话。
  - **AC-12**（FR-005）：GIVEN 发起方对话中的 `Agent` 工具卡片 WHEN 点击会话 id 链接 THEN 活动标签切到目标工作区并打开该子代理对话。
  - **AC-13**（FR-005）：GIVEN 发起方工作区已关闭 WHEN 点击指向它的跳转链接 THEN 链接不可用并显示原因，不自动打开该工作区。
- 场景 4：跨工作区中止
  - **AC-14**（FR-006）：GIVEN 跨工作区子代理正在运行且发起方前台空闲 WHEN 在发起方点击 abort THEN 目标工作区该子代理停止，发起方 `subAgentRunning` 归假。
  - **AC-15**（FR-006）：GIVEN 跨工作区子代理正在运行 WHEN 查看发起方的 abort 按钮 THEN 按钮为黄色，悬停明细包含该子代理的 description。
  - **AC-16**（FR-006）：GIVEN 跨工作区子代理正在运行 WHEN 在目标工作区的子代理对话点击 abort THEN 该会话停止运行，发起方 `subAgentRunning` 归假。
  - **AC-17**（FR-006）：GIVEN 发起方会话被关闭 WHEN 关闭完成 THEN 其跨工作区子代理一并中止。
- 场景 5：`@` 补全与 reminder
  - **AC-18**（FR-007）：GIVEN 已打开多个工作区 WHEN 在某个会话输入 `@` THEN 候选只包含除该会话所属工作区之外的项。
  - **AC-19**（FR-007）：GIVEN 只打开了当前会话所属工作区 WHEN 输入 `@` THEN 不显示候选菜单。
  - **AC-20**（FR-007）：GIVEN 目标身份含空格 WHEN 从菜单选中 THEN 插入 `@"<身份>" `，保留光标之后的原文，光标置于输入末尾。
  - **AC-21**（FR-007）：GIVEN 输入首字符不是 `@` WHEN 在正文任意位置输入 `@` THEN 不弹出候选菜单。
  - **AC-22**（FR-007）：GIVEN 首行已输入 `@<身份>` WHEN 继续输入多行正文 THEN 菜单关闭且正文可继续换行。
  - **AC-23**（FR-008）：GIVEN 宿主声明支持跨工作区代理 WHEN 发送以 `@<身份>` 开头的消息 THEN 上下文里用户消息之后紧跟一条 reminder，点名 `target=<身份>` 与 `Agent` 工具。
  - **AC-24**（FR-008）：GIVEN 用户消息不以 `@` 开头 WHEN 该消息进入轮次边界 THEN 不注入 `@` 命令的 reminder。
  - **AC-25**（FR-009）：GIVEN 宿主声明不支持跨工作区代理 WHEN 发送以 `@<身份>` 开头的消息 THEN 不注入 reminder、按普通文本处理，`Agent` 传 `target` 返回「当前宿主不支持」的工具错误。
- 场景 6：错误路径与生命周期
  - **AC-26**（FR-002）：GIVEN `target` 指向未打开的身份 WHEN 调用 `Agent` THEN 返回工具错误、不创建任何对话、不占用并发槽位。
  - **AC-27**（FR-002）：GIVEN `target` 为空字符串 WHEN 调用 `Agent` THEN 入参校验失败并返回工具错误。
  - **AC-28**（FR-010）：GIVEN 同一父会话的并发槽位已占满 WHEN 发起新的跨工作区代理 THEN 该调用在工具调用内排队，目标工作区不出现新对话。
  - **AC-29**（FR-010）：GIVEN 目标工作区 Core 不可达 WHEN 发起跨工作区代理 THEN 工具返回错误，发起方不残留 `subAgentRunning` 为真的状态。

## 2. 功能需求

### FR-001：工作区代理身份

- 身份字符串为 `<机器名>:<工作区绝对路径>`，逐字用于 `@` 候选、`Agent.target` 与 reminder。
- 本地工作区：机器名取宿主机器的机器名（Windows `COMPUTERNAME` / Linux `HOSTNAME`，
  缺失回退操作系统主机名）；远程（SSH）工作区：机器名取 SSH 目标主机字符串
  （`WorkspaceRef.endpoint.host`），不含端口与登录用户。
- 身份是打开集合的派生事实，owner 是 Electron 主进程；实现见
  `src/host/workspaceIdentity.ts` 的 `resolveMachineName` / `workspaceAgentId`。
- 身份不进会话元数据的 `project`（`project` 仍是路径）。

### FR-002：`Agent` 的 `target` 入参

- `target` 缺省：沿用当前策略，在当前会话所属工作区创建子代理会话。
- `target` 传入：宿主按身份解析打开集合，在目标工作区创建对话，角色取 `agentRole`；
  等于来源工作区时返回 `{ local: true }`，Core 按缺省策略建本机子代理。
- 未打开 / 身份歧义 / 目标 Core 未就绪：工具错误，不创建任何对话、不占用并发槽位。
- 空字符串：入参校验失败，不静默当缺省。
- 成功结果文本包含子代理会话 id 与目标身份；工具入参的 `target` 供 UI 渲染跳转。

### FR-003：跨工作区子代理会话

- 目标工作区创建的对话是子代理会话：`role` = `agentRole`、`title` = `description`
  （缺省 `Agent: <role>`）、`parentSessionId` = 占位对话、`project` = 目标工作区路径，
  并在 `meta.json` 写 `crossWorkspaceOrigin`（发起方工作区身份 / 会话 id / 标题）。
- prompt 作为该会话的第一条用户消息，子代理消费循环在目标工作区 Core 内运行；
  `Reply` 与 Reminder 重试沿用既有子代理语义。
- `Reply` 经 `CoreEvent.crossWorkspaceAgentReplyRequested` → 宿主 → `UiEvent.agentReplyReceived`
  回投发起方会话，作为 agent 消息出现；From 头展示目标工作区身份。
- 会话级配置取目标工作区自身默认值，不继承发起方；非 Master 角色按既有规则固定
  normal 预设、不联网、无 MCP。
- 沿用「子代理内禁止再调 `Agent`」的既有规则：跨工作区子代理不能继续派生。

### FR-004：占位父对话

- 占位父对话由子代理 meta 的 `crossWorkspaceOrigin` 在列表读取时派生（Rust 与 TS 两侧
  同口径），不落独立文件；子对话删除后派生条目自然消失。
- 占位对话不是真实会话：没有消息文件、不建立会话运行时、不参与空闲回收与压缩。
- 打开占位对话时聊天区显示占位页（`chatPlaceholderHtml` 的 `crossWorkspaceAgent` kind），
  不创建聊天会话。
- 占位对话不提供重命名 / 删除 / 智能命名入口。

### FR-005：跨工作区跳转

- 发起方：`Agent` 工具卡片展示目标身份与会话 id，点击切到目标工作区并打开该对话。
- 目标工作区：占位页的跳转链接切到发起方工作区并打开发起方对话。
- 目标工作区：子代理对话的「返回父对话」按 `crossWorkspaceOrigin` 直接跳发起方会话。
- 跳转由宿主执行（切活动标签 + 开对话）；目标工作区未打开或会话不存在时链接不可用，
  不自动打开工作区。

### FR-006：跨工作区中止

- 发起方 `subAgentRunning` 包含跨工作区子代理：运行期间 abort 按钮为黄色，悬停明细
  包含该子代理的 description。
- abort 范围沿用 [docs/features/abort-button.md](../features/abort-button.md) 的三段判定；
  「中止已登记子代理」对远程子代理发 `CoreEvent.crossWorkspaceAgentAbortRequested`，
  由宿主转发 `UiEvent.abortRequested` 到目标 Core。
- 目标不可达时按已结束收敛；目标工作区一侧可独立中止（既有语义不变）。

### FR-007：`@` 工作区补全

- 输入框首字符为 `@` 时展示候选菜单；候选 = 已打开工作区中**除当前会话所属工作区之外**的项，
  按打开集合顺序排列；过滤按工作区引用判等，不是身份字符串。
- 区间：引号形态 `@"..."` 到下一个 `"` 或输入末尾；非引号形态到第一个空白或输入末尾。
  光标在区间内时展示菜单，查询词 = 区间内、光标之前的文本。
- 过滤按身份 ID 与目录名（不区分大小写），ID 命中优先；无候选时不显示菜单。
- 选中替换：替换 `@` 到光标之间的文本（引号形态替换到闭合引号），插入 `@<身份> `
  或 `@"<身份>" `，保留其后原文，光标置于输入末尾。
- 键盘与 `/` 补全一致（↑ / ↓ / Ctrl+P / Ctrl+N / Enter / Tab / Esc）；只认首字符；
  身份之后的内容可多行。实现见 `src/webview/mentionState.ts` 与 `InputArea` 的候选菜单。

### FR-008：`@` 命令的 reminder 注入

- Core 在轮次边界识别 `@` 命令：用户消息去首尾空白后以 `@` 开头，且宿主声明支持
  跨工作区代理。
- 在用户消息之后注入一条 silent reminder（模型可见、UI 消息流不可见），点名目标身份、
  `target` 参数名与 `Agent` 工具，要求把事项代理给目标工作区。
- 用户消息原文（含 `@` 前缀）保持不变；身份是否存在不在这里校验，错误在 `Agent`
  执行时暴露。

### FR-009：宿主能力边界

- 宿主在 `hostEnvironmentProvided` 声明 `crossWorkspaceAgent`；Electron 为 true，
  VS Code 与 TUI 为 false。
- 不支持时：`@` 按普通文本处理、不注入 reminder；`Agent` 传 `target` 返回
  「current host does not support cross-workspace agents」的工具错误。
- Core 不按宿主类型嗅探，只读能力位。

### FR-010：生命周期与并发

- 跨工作区子代理占用发起方父会话的一个并发槽位，直到结束 / 被中止 / 目标不可达。
- 结束经 `CoreEvent.crossWorkspaceAgentEnded` → 宿主 → `UiEvent.crossWorkspaceAgentCompleted`
  回到发起方 Core：注销远程登记、释放槽位、刷新运行时快照。
- 目标工作区被关闭时其上的子代理随清理链中止；发起方按子代理结束收敛。

## 3. 行为规格

### 3.1 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 工作区代理身份 | `<机器名>:<工作区路径>`，`@` 与 `target` 的寻址键 | Electron 主进程（`workspaceIdentity.ts` 是唯一算法） |
| 跨工作区子代理 | 运行时在目标工作区 Core、创建者在发起方 Core 的子代理会话 | 目标工作区 Core（会话事实）/ 发起方 Core（登记与槽位） |
| 占位父对话 | 目标工作区列表里代表发起方会话的容器节点 | 列表读取方（由子代理 meta 派生） |
| `@` 命令 | 去首尾空白后以 `@` 开头的用户消息 | Core（轮次边界解析） |
| 跨工作区 link | 子代理会话 id → 目标工作区引用 | 宿主 `WebViewUI`（中止路由用） |

### 3.2 契约成员

- `CoreRequest.crossWorkspaceAgentRequested` → `{ sessionId } / { local: true } / { error }`；
- `CoreEvent.crossWorkspaceAgentReplyRequested` / `crossWorkspaceAgentAbortRequested` /
  `crossWorkspaceAgentEnded`；
- `UiEvent.remoteSubAgentStarted` / `agentReplyReceived` / `crossWorkspaceAgentCompleted`；
- `UiEvent.hostEnvironmentProvided.crossWorkspaceAgent`；
- webview wire：`requestWorkspaces` / `setWorkspaces`、`openConversation.targetWorkspaceId`。

### 3.3 不变量

- 身份由唯一纯函数计算；同一身份对应多个打开项时 `target` 报错，不取第一项。
- 占位对话没有消息文件、没有会话运行时；列表里的占位条目只能由子代理 meta 派生。
- 跨工作区子代理的结束事件是槽位释放的唯一信号；重复 / 迟到事件幂等（`release_slot_if_held`）。
- 跳转不自动打开工作区；目标不在打开集合时只提示不可用。

## 4. 边界与错误路径

- `target` 空串：入参校验失败（`target must not be empty`）。
- `target` 未匹配：工具错误 `target workspace is not open: <身份>`，不建会话、不占槽位。
- 同一身份多个打开项：`target workspace identity is ambiguous: <身份>`。
- 目标 Core 未就绪：`target workspace is not ready: <身份>`。
- 路径含空格：`@` 必须用引号形态；手写无引号时按第一个空白截断，身份不匹配 → 工具错误。
- 身份含 `"`：无法用 `@` 引号形态寻址（语法不支持转义），仍可手写 `target`。
- 非 Electron 宿主：`@` 是普通文本；`target` 报「当前宿主不支持」。
- 发起方会话在子代理运行期间被删除：`Reply` 投递失败（与本地同口径），子代理按既有
  Reminder 重试后结束。
- 目标工作区 Core 断线 / 崩溃：发起方 `subAgentRunning` 收敛为假，跳转链接不可用。
- 机器名在重启后变化：旧身份不再匹配，旧链接不可用并显示原因。

## 5. 非目标

- VS Code 宿主与 TUI 的跨工作区代理。
- 自动打开未打开的工作区（跳转与 `target` 都只认已打开集合）。
- 跨实例发现（两个 Electron 实例、两台宿主之间不互相注册身份）。
- 新增跨机器传输与认证（远程沿用既有 SSH 接入）。
- `@` 文件引用补全。
- 在 system prompt 里列出全部工作区身份。
- 跨工作区子代理继承发起方会话级配置（取目标工作区默认值）。

## 6. 对需求基线的影响

- 新增 [US-56](user-stories/desktop.md#us-56-跨工作区代理) 与
  [US-57](user-stories/desktop.md#us-57--工作区补全与提醒注入)，落在 EP-9 多工作区。
- e2e 落点：`e2e/electron/crossWorkspaceAgent.spec.ts`（US-56）、
  `e2e/webview/workspaceMention.spec.ts`（US-57）。
- 多工作区基线的子对话归属增加例外（跨工作区子代理归属目标工作区）；中止范围、
  会话运行时快照、用户消息管线的补全与命令解析同步扩界。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/workspaceIdentity.ts` 的 `resolveMachineName` / `workspaceAgentId`；`electron/main.ts` 打开集合派生 | `src/test/workspaceIdentity.test.ts` | 自动 |
| FR-002 | `core-rs/src/tools.rs` 的 `run_agent`；`core-rs/src/engine.rs` 的 `spawn_remote_agent`；`src/host/crossWorkspaceRouting.ts` | `core-rs/src/tools_tests.rs`、`src/test/crossWorkspaceRouting.test.ts` | 自动 |
| FR-003 | `core-rs/src/engine.rs` 的 `start_remote_sub_agent` / `deliver_agent_reply`；`core-rs/src/history.rs` | `core-rs/src/engine_tests.rs` | 自动 |
| FR-004 | `core-rs/src/history.rs` 的 `load_conversation_list`；`src/shared/history/Conversation.ts`；`electron/sidebar/main.ts`；`electron/chatPlaceholderHtml.ts` | `core-rs/src/engine_tests.rs`、`src/test/chatPlaceholderReason.test.ts` | 自动 |
| FR-005 | `electron/main.ts` 的 `showCrossWorkspacePlaceholder` / `jumpToCrossWorkspaceConversation`；`src/webview/tools/Agent.tsx` | `e2e/electron/crossWorkspaceAgent.spec.ts` | 自动 |
| FR-006 | `core-rs/src/engine.rs` 的 `abort_session_scope`；`src/host/WebViewUI.ts` 的中止转发 | `core-rs/src/engine_tests.rs`、`src/test/abortButtonState.test.ts` | 自动 |
| FR-007 | `src/webview/mentionState.ts`；`src/host/workspaceIdentity.ts` 的 `workspaceMentionCandidates`；`src/webview/InputArea.tsx` | `src/test/mentionState.test.ts`、`src/test/workspaceIdentity.test.ts`、`e2e/webview/workspaceMention.spec.ts` | 自动 |
| FR-008 | `core-rs/src/engine.rs` 的 `parse_mention_identity` / `build_mention_reminder` / `resolve_pending_mention` | `core-rs/src/engine_tests.rs` | 自动 |
| FR-009 | `src/shared/AssistantEventBus.ts` 的 `hostEnvironmentProvided.crossWorkspaceAgent`；三个宿主发送点；`core-rs/src/config.rs` | `core-rs/src/tools_tests.rs`、`src/test/bootstrapWiring.test.ts` | 自动 |
| FR-010 | `core-rs/src/subagent.rs` 的远程登记与 `release_slot_if_held`；`core-rs/src/engine.rs` 的结束收敛 | `core-rs/src/engine_tests.rs` | 自动 |
