---
status: 已收敛
---

# 改动规格：跨工作区子代理直建普通对话与会话创建者归属

`Agent` 工具跨工作区派发不再经容器（`ph_` 占位父对话）承载：容器概念整体删除，派发直接在
目标工作区创建一条顶层普通对话（真实会话，正常打开、正常渲染、正常行内操作）。会话新增
`creator` 归属属性——用户创建为 `user`，Agent 创建携带创建方工作区身份与会话 id——非 user
创建的会话按子代理口径安静运行：完成不亮未读绿灯、不触发托盘与提示音；输入框禁用（独立
禁用原因，文案「非用户创建对话无法输入」）。`Agent` 派发的对话继承创建者的会话级
设置（联网 / MCP / 模型 / thinking / agent mode 不按角色裁剪；提示词模式恒 normal），
SystemPrompt 含跨会话身份与 `Reply` 要求（创建方身份随派发载荷
携带，目标 Core 组装）；`Reply` 与 Reminder 机制照常（Reminder 对用户 silent）。
specs/024 落地的容器状态灯与「经容器继承」随容器删除一并
回退。不设存量兼容（产品未发布）：所有会话创建时显式写 `creator`，缺失视为数据异常。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/cross-workspace-agent.md FR-003](../../docs/features/cross-workspace-agent.md#fr-003跨工作区子代理会话顶层普通对话) | FR-003 跨工作区子代理会话（顶层普通对话） | 修改 | 会话形态改为顶层普通对话（无 `parentSessionId`、creator 归属）；会话级配置改全量继承、删除角色裁剪 |
| `docs/features/cross-workspace-agent.md` FR-004 占位父对话 | FR-004 占位父对话 | 删除 | 容器概念删除：列表派生、占位页、点击跳页行为随容器移除（章节随删除消失，故不落链接） |
| [docs/features/cross-workspace-agent.md FR-005](../../docs/features/cross-workspace-agent.md#fr-005跨工作区跳转) | FR-005 跨工作区跳转 | 修改 | 占位页跳转链接随容器删除；子代理对话「返回父对话」改读 creator |
| [docs/features/cross-workspace-agent.md 3.1](../../docs/features/cross-workspace-agent.md#31-术语与事实来源) | 3.1 术语 / 3.2 契约成员 / 3.3 不变量 | 修改 | 术语删「占位父对话」；契约成员删除（`parentSessionId` / originTitle / `crossWorkspaceOrigin`）；不变量改 creator 单源 |
| [docs/core/session-runtime.md 第 2 节](../../docs/core/session-runtime.md#2-对外快照) | 2. 对外快照 | 修改 | 快照条目新增 `creator`；`parentSessionId` 收窄为本地树父会话（跨工作区对话为 `null`），消除 meta 指向 `ph_` 容器而快照指向发起方会话的双值 |
| [docs/architecture/events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表) | 2. 事件词汇表 | 修改 | `crossWorkspaceAgentRequested` / `remoteSubAgentStarted` 载荷列（删 `parentSessionId` / originTitle、增 `systemPrompt`） |
| [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 9. 侧栏 | 修改 | 容器行条目与状态灯表述删除；跨工作区对话按普通顶层行渲染 |
| [docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 6. 宿主固有差异有意保留 | 修改 | 未读完成呼吸与完成提醒口径改按 creator（非 user 创建不武装 / 不提醒） |
| [docs/features/user-stories/desktop.md US-56](../../docs/features/user-stories/desktop.md#us-56-跨工作区代理) | US-56 跨工作区代理 | 修改 | 容器 / 占位页相关验收改为顶层对话；补输入禁用、全量继承与完成静默 |
| [docs/features/user-stories/desktop.md US-33](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒) | US-33 系统托盘与任务提醒 | 修改 | 补「非 user 创建会话完成不提醒」口径 |
| [docs/features/user-stories/dialog-core.md US-51](../../docs/features/user-stories/dialog-core.md#us-51-子代理角色-explorer文件浏览专用) | US-51 子代理角色 Explorer | 修改 | 角色设置固定与选项锁定标注仅适用本地子代理；子代理输入从「警告后可发送」改为禁用 |

## 用户场景与验收标准

- 场景 1：派发直建普通对话
  - **AC-1**（FR-001）：GIVEN 会话调用 `Agent` 且 `target` 指向另一工作区 WHEN 派发完成 THEN 目标工作区侧栏出现一条顶层对话行（无父节点、无占位条目），重命名 / 删除 / 智能命名入口与普通对话一致。
  - **AC-2**（FR-001）：GIVEN 目标工作区存在跨工作区对话 WHEN 用户点击打开 THEN 显示正常对话视图（渲染消息、建立会话运行时），不出现占位页。
  - **AC-3**（FR-001）：GIVEN 跨工作区对话已创建 WHEN 读取其 meta.json THEN `role` 为 `agentRole`、`title` 为 `description`、`project` 为目标工作区路径、`creator` 为 agent 形态（发起方身份 + 会话 id），且无 `parentSessionId`、无 `crossWorkspaceOrigin`。
  - **AC-4**（FR-001）：GIVEN 应用重启后重新打开目标工作区 WHEN 列表加载 THEN 该对话仍在列表中（顶层）且消息完整。
- 场景 2：creator 归属
  - **AC-5**（FR-002）：GIVEN 用户在输入框发起 prompt WHEN 首条消息建档 THEN meta 的 `creator` 为 `user`。
  - **AC-6**（FR-002）：GIVEN 同工作区创建本地子代理 WHEN 读取其 meta THEN `creator` 为 agent 形态且 `workspaceId` 为 `null`、`sessionId` 为父会话 id。
  - **AC-7**（FR-002）：GIVEN 收到运行时快照 WHEN 读取会话条目 THEN 每个条目携带 `creator`，且 `parentSessionId` 与 meta 同源（仅本地子代理非空，跨工作区对话为 `null`）。
  - **AC-8**（FR-002）：GIVEN 跨工作区对话的 `Reply` 回传或「返回发起方」跳转 WHEN 定位创建方 THEN 按 `creator` 的 `workspaceId` 与 `sessionId` 取值。
- 场景 3：完成静默、等待有声
  - **AC-9**（FR-003）：GIVEN 主窗口在后台、非 user 创建的会话从运行转入空闲 WHEN 状态差分 THEN 不进入未读完成集合（侧栏无绿灯）、托盘不闪烁、不播放提示音。
  - **AC-10**（FR-003）：GIVEN 非 user 创建的会话正在运行 WHEN 侧栏渲染 THEN 行照常显示运行流水（蓝），转入等待用户时照常显示等待呼吸（黄）。
  - **AC-11**（FR-003）：GIVEN 非 user 创建的会话从运行转入等待用户 WHEN 状态差分 THEN 照常触发任务结束提醒（托盘闪烁 + 播放一次提示音）。
- 场景 4：输入禁用
  - **AC-12**（FR-004）：GIVEN 打开 `creator` 为 agent 形态的会话 WHEN 输入区渲染 THEN 输入框禁用，placeholder 为「非用户创建对话无法输入」（zh）。
  - **AC-13**（FR-004）：GIVEN 打开本地子代理会话 WHEN 输入区渲染 THEN 输入框禁用，且「红边框 + 警告横幅（确认后可发送）」不再存在。
  - **AC-14**（FR-004）：GIVEN `creator` 为 `user` 的会话 WHEN 输入区渲染 THEN 输入禁用原因只剩「未配置服务商」与「Spin 模式」两种，行为与现状一致。
- 场景 5：全量继承
  - **AC-15**（FR-005）：GIVEN 发起方会话生效设置为模型 M / provider P / agent mode A / thinking T / 联网开 / MCP 名单 N WHEN 以 Explorer 角色派发 THEN 目标会话以上述设置与名单运行，不被角色裁剪为 normal 预设 / 关 / 空名单；提示词模式是唯一例外——不继承发起方（发起方为 mixed 亦然），恒 normal。
  - **AC-16**（FR-005）：GIVEN 继承的 MCP 名单中某 server 在目标 Core 定义集合无同名项 WHEN 目标会话初始化工具 THEN 该 server 不建立连接，名单其余项照常。
  - **AC-17**（FR-005）：GIVEN 以 Explorer 角色派发 WHEN 目标会话初始化工具 THEN 会话工具清单恰为 Read / Glob / Grep / `Reply`。
  - **AC-18**（FR-005）：GIVEN 打开跨工作区对话的选项菜单 WHEN 查看联网搜索 / MCP 两项 THEN 两项不因角色置灰（角色锁定仅适用本地子代理）；提示词模式置灰（恒 normal，不提供切换入口）。
- 场景 6：SystemPrompt 由发起方构造
  - **AC-19**（FR-006）：GIVEN 跨工作区派发完成 WHEN 读取目标会话生效的 SystemPrompt THEN 其中包含创建方工作区身份、创建方会话 id 与「结束前须调用 `Reply` 回传结果」的说明。
- 场景 7：Reply 与 Reminder 照常
  - **AC-20**（FR-007）：GIVEN 非 user 创建的会话结束且最后一轮未调用 `Reply` WHEN 结束检测完成 THEN 注入 Reminder 重跑（累计 3 次封顶），仍无 `Reply` 则结束；Reminder 以 silent 消息注入（模型可见、落盘，UI 消息流与回放不展示）。
  - **AC-21**（FR-007）：GIVEN 跨工作区对话调用 `Reply` WHEN 回传到达发起方 THEN 结果作为 agent 消息出现在发起方会话，From 头显示目标工作区身份。

## 功能需求

### FR-001：跨工作区对话是顶层普通会话

- `Agent` 工具 `target` 派发在目标工作区创建的对话是真实会话：侧栏顶层行（不挂父节点）、
  有消息文件、打开即正常对话视图（渲染消息、建立会话运行时）、行内操作（重命名 / 删除 /
  智能命名）与普通对话一致。`role` 仍取 `agentRole`、`title` 取 `description`、`project`
  取目标工作区路径、prompt 作为第一条用户消息。
- 容器概念整体删除：列表读取不再由子代理 meta 派生占位条目；占位页（`crossWorkspaceAgent`
  kind）与「点击容器跳页」行为移除；宿主不再生成 `ph_` 会话 id；specs/024 落地的容器状态
  灯派生（deriveContainerBusyLevel 及侧栏容器行分支）移除。
- 跨工作区对话不写 `parentSessionId`（meta 与运行时快照均为 `null`）；「子代理内禁止再调
  `Agent`」规则照旧。
- 运行仍走子代理消费循环：`Reply` 检测、Reminder 注入、结束事件、并发槽位、中止传播沿用
  既有子代理语义。

### FR-002：creator 归属属性

- 全部会话在创建时写入 `creator`（判别联合）：用户创建（普通 prompt 发起）为 `user`；
  Agent 创建为 agent 形态，携带创建方工作区身份（`workspaceId`）与创建方会话 id
  （`sessionId`）。
- 本地子代理：`workspaceId` 为 `null`（创建方在本工作区——工作区身份算法唯一落点是宿主
  `workspaceIdentity.ts`，Core 不自行计算机器名），`sessionId` 为父会话 id。跨工作区派发：
  `workspaceId` 为发起方工作区身份（`机器名:路径` 口径）、`sessionId` 为发起方会话 id。
- meta.json 顶层新增 `creator`；`crossWorkspaceOrigin` 与 originTitle 删除（身份对由
  `creator` 承载；originTitle 的消费者是容器标题与跳转页，随容器删除）。落盘格式双侧
  同步（Rust 写入侧与 `src/shared/history/` 读取侧同一格式）。
- 运行时快照（`sessionRuntimeChanged`）每会话条目新增 `creator`；快照的 `parentSessionId`
  与 meta 同源同值（仅本地子代理非空），消除现行「meta 指向 `ph_` 容器、快照指向发起方
  会话」的双值。
- 不设存量兼容：`creator` 缺失视为数据异常，读取侧报错不回退（未发布，无迁移义务）。

### FR-003：非 user 创建会话的完成静默

- `creator` 为 agent 形态的会话从运行转入空闲：不进入未读完成集合（侧栏不亮绿色完成灯）、
  不触发托盘闪烁、不播放提示音——判定按运行时快照的 `creator`，取代现行按
  `parentSessionId` 非空的子对话抑制。`Agent` 工具派发的远程会话即此类。武装源头
  （`completionAttention` 差分）同时跳过标签页未读灯：对话行、标签页、托盘在同一份
  差分上收敛。
- 运行流水（蓝）与等待呼吸（黄）照常；转入等待用户照常触发任务结束提醒（ask user /
  权限确认不受抑制）。
- `creator` 为 `user` 的会话完成提醒与绿灯语义不变。

### FR-004：非 user 创建对话的输入禁用

- `creator` 为 agent 形态的会话在 webview 输入框禁用；禁用原因是判别联合中的独立原因
  （与「未配置服务商」「Spin 模式」区分），placeholder 文案 zh「非用户创建对话无法输入」/
  en 同义英文（i18n `zh` / `en` 各新增一条，命名沿用 `inputArea.placeholderSpinMode` 模式）。
- 本地子代理会话现行「红边框 + 警告横幅（确认后可发送）」被禁用态取代，警告横幅与红边框
  随之删除。
- 禁用是 UI 表现层判定；Core 不新增用户消息拦截——Reminder 注入经同一入队管线，拦截会误伤。
- 禁用原因优先级沿用既有次序并在其后插入：Spin > 非用户创建 > 未配置服务商（引导覆盖层
  仅作用于可输入会话）。

### FR-005：Agent 派发对话全量继承创建者会话级设置

- 派发载荷携带的生效值（agent mode / thinking effort / 模型与 provider 成对 / 联网搜索 /
  MCP 启用名单）在目标会话**全量**应用，不再按角色裁剪——现行「非 Master 角色
  固定 normal 预设 / 不联网 / MCP 恒空」的裁剪对跨工作区派发删除。
- 例外：**提示词模式不继承、恒 normal**——minimal / mixed 的首轮按 minimal 预设把工具
  清单裁成 Bash / Edit，`Reply` 是子代理生命周期设施（`sub_agent_has_reply` / Reminder
  以它为基准），被裁掉后子代理无法主动回传（minimal 更是全程无 Reply）。派发载荷不携带
  promptMode；目标侧选项菜单的提示词模式不提供切换入口，联网 / MCP 不受影响。
- 角色仅决定工具白名单（Explorer 恰为 Read / Glob / Grep / `Reply`）与并发槽位等生命周期
  语义。
- MCP 按名单继承口径不变：名单随会话落盘；名单里的 server 在目标 Core 定义集合无同名项时
  不建立连接（MCP 定义是机器本地资源，不跨机器拷贝）。
- 继承值创建时一次确定并落进 meta（重启重开仍显示）；创建后目标侧修改会话级设置按普通
  会话语义，不受额外限制。
- specs/020 的「非 Master 角色选项锁定」收窄为仅适用本地子代理（其依据是角色设置固定；
  跨工作区派发不再固定——联网 / MCP 两项不锁定）。提示词模式单项对跨工作区对话锁定
  （恒 normal，见上）。creator 尚未到达时按本地口径处理（保守锁定，事实到达后按
  workspaceId 判定豁免）。

### FR-006：派发 SystemPrompt 含创建方身份与 Reply 要求

- 跨工作区派发的会话 SystemPrompt 内容必须包含：跨会话 Agent 身份——创建方工作区身份
  与会话 id；结果回传要求——结束前须调用 `Reply` 把结果发回创建方会话（`targetSessionId`
  指向创建方会话）。
- SystemPrompt 由目标 Core 在创建时按固定模板组装，身份取自派发载荷的 `originWorkspaceId`
  / `originSessionId`（宿主填充，不经模型工具入参）；组装结果经既有 system prompt 前缀
  机制生效。
- 本地子代理的 SystemPrompt 组装（`sub_agent_communication_section`）不变；跨工作区会话
  不再使用仅含会话 id 的该段组装。

### FR-007：Reply 与 Reminder 照常并覆盖全部非 user 会话

- 非 user 创建的会话结束时检测最后一轮是否调用过 `Reply`：没有则注入 Reminder 重跑，重试
  上限沿用既有口径（3 次封顶）。Reminder 以 **silent 消息**注入（`silent` / `origin=agent`：
  模型可见、落盘，UI 消息流与回放不展示）——子代理会话的 UI 输入已禁用（FR-004），系统
  催办不占用户可见的消息流。
- `Reply` 回传路径不变：同工作区入创建方消息队列；跨工作区经
  `crossWorkspaceAgentReplyRequested` → 宿主 → `agentReplyReceived` 回投发起方会话（From
  头显示目标工作区身份）。回传路由的创建方定位改读 `creator`。

## 边界与错误路径

- 运行时快照尚未到达（刚派发 / 刚打开工作区）：行灯按既有无灯口径（等待态不猜值）。
- 目标工作区用户删除运行中的跨工作区对话：按会话结束收敛，发起方槽位经
  `crossWorkspaceAgentEnded` 释放（既有结束语义）。
- 目标工作区关闭 / 连接丢失：发起方按子代理结束收敛（specs/023 FR-010 既有）。
- meta 缺 `creator`：数据异常，列表读取报错不回退（未发布无兼容义务）。TS 侧压缩路径
  的 meta 整体丢失兜底建档属修复值：优先取内存缓存的既有归属，取不到按 user（正常
  会话的 creator 已在盘上，该分支只在异常状态触发）。
- 发起方会话在子代理运行期间被删除：`Reply` 投递失败，按既有 Reminder 重试后结束（不变）。
- `@` / `target` 寻址、身份歧义、目标 Core 未就绪等错误路径不变（specs/023 既有）。

## 非目标

- 不改 `Agent` 工具入参 schema：SystemPrompt 由发起方 Core 构造，不经模型入参。
- 不改本地子代理的 specs/020 角色设置固定与继承规则（Explorer 的设置固定仅对本地子代理
  继续成立）。
- 不改等待提醒口径、运行 / 等待灯语义、中止传播、槽位与 FIFO 排队、`@` 补全与 reminder
  注入。
- webview 浮窗内嵌对话列表不同步本 spec 的任何派生（留待浮窗模式实际需要时另立 spec）。
- 不做存量数据迁移。

## 对需求基线的影响

无新增 US：本规格是 [US-56](../../docs/features/user-stories/desktop.md#us-56-跨工作区代理)
（跨工作区代理）既有场景的重构——验收标准由容器 / 占位页口径改为顶层普通对话口径，补
输入禁用、全量继承与完成静默；[US-33](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒)
补「非 user 创建会话完成不提醒」；[US-51](../../docs/features/user-stories/dialog-core.md#us-51-子代理角色-explorer文件浏览专用)
标注本地口径并改输入禁用。
e2e：`e2e/electron/crossWorkspaceAgent.spec.ts` 改造——容器 / 占位页断言删除，新增顶层行、
输入禁用、creator 落盘与全量继承断言；提示音（AC-9 / AC-11 的音频链路）为 OS 音频路径，
按 US-33 既有口径登记真机核验豁免。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/history.rs` 的 `load_conversation_list`（占位派生删除）与 `create_remote_sub_agent_metadata`（meta 形态）；`electron/main.ts` 占位页 / 跳页删除；`electron/sidebar/main.ts` 容器分支删除 | `core-rs/src/engine_tests.rs`（meta 形态）、`src/test/chatPlaceholderReason.test.ts`（kind 移除）、`e2e/electron/crossWorkspaceAgent.spec.ts`（顶层行断言） | 自动 |
| FR-002 | `core-rs/src/engine.rs` 建档与子代理创建写 `creator`；`core-rs/src/history.rs` meta 字段；`src/shared/history/Conversation.ts` 读取；`src/shared/sessionRuntime.ts` 与 `src/shared/AssistantEventBus.ts` 快照 `creator` | `core-rs/src/engine_tests.rs`（creator 写入 / 恢复 / 缺失报错 / emit_runtime 快照断言 / 快照字段 parity fixture）、`src/test/conversationListManifest.test.ts`（读取与缺失跳过） | 自动 |
| FR-003 | `electron/trayAttention.ts` 判定改按 `creator`；`electron/completionAttention.ts` 武装条件排除 agent 形态 | `src/test/trayAttention.test.ts`（creator 形态的完成静默 / 等待提醒）、completionAttention 单测 | 自动 |
| FR-004 | `src/webview/inputAreaState.ts` 禁用原因判别联合；`src/webview/InputArea.tsx` 与 `App.tsx` 警告横幅移除；`src/webview/i18n/zh.ts` / `en.ts` 新文案 | `src/test/inputAreaState.test.ts`（新增原因分支）、`src/test/hostI18n.test.ts` | 自动 |
| FR-005 | `core-rs/src/engine.rs` 的 `start_remote_sub_agent`（全量应用，删角色裁剪；MCP 名单写入照旧） | `core-rs/src/engine_tests.rs`（全量继承 / Explorer 白名单 / MCP 名单 / 载荷缺字段报错） | 自动 |
| FR-006 | `core-rs/src/prompt.rs` 新增跨工作区 SystemPrompt 模板（身份 + `Reply` 要求）；`core-rs/src/engine.rs` 的 `start_remote_sub_agent` 应用 | `core-rs/src/engine_tests.rs`（生效 SystemPrompt 含身份与 `Reply` 说明） | 自动 |
| FR-007 | `core-rs/src/engine.rs` 的 `run_sub_agent` / `sub_agent_has_reply` / `sub_agent_reminder`（无改动或按 creator 形态扩展）；`deliver_agent_reply` 路由读 `creator` | `core-rs/src/engine_tests.rs`（Reminder 注入与跨工作区回投用例扩展 creator 形态） | 自动 |

## 待澄清

（无——全量继承不按角色裁剪、非 user 会话输入禁用（含本地子代理的警告被取代）已按用户
意见定死；与 specs/020 本地口径的边界写入 FR-005。SystemPrompt 的组装点定在目标 Core
（创建方身份经派发载荷携带，见 FR-006），与初稿「发起方构造」的差异及理由见同目录
plan.md 的被否决方案，随 plan 一并评审。）

## 收敛记录

逐条核对结论（证据落点为实施后的真实文件 / 用例；e2e 为 `e2e/electron/crossWorkspaceAgent.spec.ts`）：

- 已满足：AC-1 / AC-2 / AC-3 → e2e「跨工作区派发：对话落在目标工作区且为顶层普通对话」
  （顶层行、无容器标记与折叠按钮、打开渲染消息且无占位页、A 侧不出现）+
  `core-rs/src/engine_tests.rs` 的 `start_remote_sub_agent_records_creator`（meta 形态）。
- 已满足：AC-4 → 组合证据：落盘形态断言（e2e 读盘 + engine_tests）与重启加载走同一数据
  路径（`ensure_loaded_reads_messages_and_session_metadata` 恢复 + 列表读取单测）；无独立
  重启 e2e（既有 023 同口径）。
- 已满足：AC-5 → `first_user_message_creates_the_conversation_files`（creator=user）。
  AC-6 → 本地子代理 meta creator 断言（`engine_tests.rs` 子会话落盘用例）。
  AC-7 → `emit_runtime_reports_root_facts_and_busy_subagents`（快照 creator：父 user /
  子 agent 形态）+ `start_remote_sub_agent_records_creator`（远程 `parent_session_id` 为
  `None`）。
- 已满足：AC-8 → `cross_workspace_reply_routes_to_origin`（回传按 creator 路由）+ e2e
  「返回发起方按 creator 跳转」。
- 已满足：AC-9 → `src/test/trayAttention.test.ts`（agent 形态完成静默）+
  `src/test/completionAttention.test.ts`（对话行与标签页灯都不武装）；托盘闪烁与提示音的
  OS 音频链路按 US-33 既有口径登记真机核验豁免。
- 已满足：AC-10 → e2e「会话设置全量继承与 creator 落盘」（运行流水灯出现 / 收尾熄灭）；
  等待呼吸沿用同一渲染分支（非 idle 行的黄灯逻辑未改动，普通行既有表现）。
- 已满足：AC-11 → `trayAttention.test.ts`（agent 形态转等待照常 `anyNowWaiting`）。
- 已满足：AC-12 → e2e「跨工作区对话打开后输入禁用」（textarea disabled + placeholder
  「非用户创建对话无法输入」）。
- 已满足：AC-13 → 组合证据：本地子代理 meta 落 agent 形态 creator（engine_tests）→
  webview 同一禁用链路（`inputAreaState` 单测的 notUserCreated 分支）；红边框与
  inputArea.subAgentWarning 横幅随实现删除（i18n 键与组件分支移除，编译期收敛）。
- 已满足：AC-14 → `inputAreaState.test.ts`（user 形态不禁用，原因只剩 provider / spin）。
- 已满足：AC-15 → `start_remote_sub_agent_full_inheritance_and_system_prompt`（Explorer
  全量继承 webSearch=true / MCP 名单，不被裁剪；promptMode 恒 normal 不继承）+ e2e 读盘
  断言。
- 已满足：AC-16 → 组合证据：名单落进子会话（engine_tests + e2e `context.mcpEnabled`）；
  「无同名定义不建立连接」由 `core-rs/src/mcp_tests.rs` 的 `get_tools_for_servers` 交集语义锁定
  （启用名不在已连接集合 → 空工具集）。
- 已满足：AC-17 → 本地 Explorer 工具清单恰四件套用例（`engine_tests.rs`）；远程与本地
  共用 `run_query_loop` 的白名单过滤，无独立远程用例。
- 已满足：AC-18 → `inputAreaState.test.ts`（Explorer + 跨工作区 creator → 联网 / MCP
  不锁定；提示词模式单项锁定，`resolvePromptModeLocked`）。
- 已满足：AC-19 → `start_remote_sub_agent_full_inheritance_and_system_prompt`（SystemPrompt
  含 HOST:/a / origin-2 / targetSessionId）。
- 已满足：AC-20 → `sub_agent_without_reply_gets_reminders`（注入与 3 次封顶，本地 / 远程
  共用 `run_sub_agent`，判定按消息历史、无 `parent_session_id` 依赖——本次收敛专项核实；
  Reminder 带 silent / origin=agent 断言）。
- 已满足：AC-21 → e2e「跨工作区派发」（发起方收到「已经派给 B。」）+
  `cross_workspace_reply_routes_to_origin`。
- 偏差：无。
- 未做：无。
- 反向对照补记（实现里有、spec 初稿未接，已补进 spec 留痕）：FR-003 补「武装源头同时
  跳过标签页未读灯」；FR-005 补「creator 尚未到达时保守锁定」；边界补「TS 压缩路径 meta
  丢失兜底建档的修复值口径」；追溯矩阵 FR-002 测试落点改指 parity fixture 与
  emit_runtime 用例（原「sessionRuntime 快照测试」表述虚指）。
- 收敛后修正（提交前按用户澄清就地修订，spec 各节已是修订后口径）：其一，跨工作区会话
  的提示词模式恒 normal、不随派发继承——原实现的「全量继承 mixed」让首轮按 minimal 预设
  把工具清单裁成 Bash / Edit，`Reply` 工具缺失导致子代理无法主动回传（FR-005 / AC-15 /
  AC-18 已改）；其二，子代理 Reminder 改经 `pending_reminder` 静默通道注入（silent /
  origin=agent，UI 消息流与回放不展示），原实现以普通用户消息入队、在 webview 可见
  （FR-007 / AC-20 已补 silent 口径）。
- 遗留项：`e2e/electron/subagentConcurrency.spec.ts` 的 US-49 e2e 失败为既有问题（023
  时期即失败，见 specs/defects/cross-workspace-placeholder-jump-always-unavailable.md
  验证记录），不属本 spec 范围；specs/024 的容器承载被本 spec 取代，随本目录一并归档。
