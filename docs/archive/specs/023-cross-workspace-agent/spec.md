---
status: 已收敛
---

# 改动规格：跨工作区多 Agent 通信

本规格界定 Electron 宿主上的跨工作区多 Agent 通信：每个已打开工作区有一个「机器名 + 工作区路径」的
代理身份；`Agent` 工具新增 `target` 入参，把子代理派发到目标工作区并沿用角色语义；跨工作区子代理
在目标工作区以「占位父对话 + 子代理对话」的形态出现，发起方与目标工作区两侧都提供跳转；跨工作区
子代理纳入既有中止与并发语义；输入框的 `@` 补全列出除当前工作区之外的已打开工作区，发送后向模型注入
一条 `target` 提示。VS Code 宿主与 TUI 不参与本能力（见 FR-009 与「非目标」）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [2. 术语与事实来源](../../docs/hosts/electron-multi-workspace.md#2-术语与事实来源) | 修改 | 新增「工作区代理身份」「占位对话」「跨工作区子代理」三个术语与各自 owner |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [4.1 对话的工作目录](../../docs/hosts/electron-multi-workspace.md#41-对话的工作目录) | 修改 | 「子对话归属父对话的工作目录」增加例外：跨工作区子代理归属目标工作区 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [9. 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 对话树呈现占位父节点；占位节点不作为普通对话打开 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [12. 不变量](../../docs/hosts/electron-multi-workspace.md#12-不变量) | 修改 | 新增身份唯一、占位节点生命周期、跨工作区链接可解析三条不变量 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [13. 验收要点](../../docs/hosts/electron-multi-workspace.md#13-验收要点) | 修改 | 补跨工作区代理与占位对话的验收条目 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [15. 落点对照](../../docs/hosts/electron-multi-workspace.md#15-落点对照) | 修改 | 补身份计算、占位对话、跨工作区跳转的落点 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [FR-002：中止范围](../../docs/features/abort-button.md#fr-002中止范围) | 修改 | 「已登记子代理递归中止」覆盖跨工作区子代理；目标不可达时按已结束收敛 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [FR-003：事实与表现的边界](../../docs/features/abort-button.md#fr-003事实与表现的边界) | 修改 | `subAgentRunning` 与悬停明细的来源扩展到跨工作区子代理 |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [2. 对外快照](../../docs/core/session-runtime.md#2-对外快照) | 修改 | `subAgentRunning` / `parentSessionId` 的口径补跨工作区子代理 |
| [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) | [FR-002：命令在轮次边界解析](../../docs/features/user-message-pipeline.md#fr-002命令在轮次边界解析) | 修改 | `@` 命令与 `/` 命令同口径在轮次边界解析 |
| [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) | [FR-006：斜杠补全](../../docs/features/user-message-pipeline.md#fr-006斜杠补全) | 修改 | 补全区间与替换规则扩展到 `@` 工作区补全（引号形态） |
| [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) | [3.1 术语与事实来源](../../docs/features/user-message-pipeline.md#31-术语与事实来源) | 修改 | 新增「`@` 命令」「工作区代理身份」两个术语 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2. 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 修改 | 新增跨工作区代理的 `CoreEvent` / `CoreRequest` / `UiEvent` 成员与触发点 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [4. 对话相关数据：ConversationManager](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager) | 修改 | 对话列表载荷新增占位对话标记与来源字段 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [5. 宿主侧入口：动作翻译为 UiEvent](../../docs/architecture/contracts.md#5-宿主侧入口动作翻译为-uievent) | 修改 | 新增跨工作区跳转动作 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [5. ConversationManager 实现对照表](../../docs/hosts/host-matrix.md#5-conversationmanager-实现对照表) | 修改 | 两个宿主的占位对话分发差异（VS Code 无此能力） |
| `docs/features/cross-workspace-agent.md` | — | 新增 | 跨 Core / 宿主 / webview 的能力，含身份、占位对话、远程生命周期三套状态，独立成篇 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [EP-9 多工作区（桌面端）](../../docs/features/user-stories/desktop.md#ep-9-多工作区桌面端) | 修改 | 新增 US-56 / US-57 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [目录](../../docs/features/user-stories.md#目录) | 修改 | 桌面端分册收录范围补 US-56 / US-57 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | 登记两条新 US 的 e2e 落点 |

## 用户场景与验收标准

- 场景 1：同一台机器上两个本地工作区互相代理
  - **AC-1**（FR-001）：GIVEN Electron 打开两个本地工作区 WHEN 在任一聊天视图的输入框输入 `@` THEN 候选里两项身份分别等于「本机机器名:该工作区绝对路径」，且机器名不是 `local` 之类占位值。
  - **AC-2**（FR-002）：GIVEN 会话属于工作区 A WHEN 模型调用 `Agent` 且 `target` 为工作区 B 的身份 THEN 工作区 B 的对话列表新增该子代理对话，工作区 A 的对话列表不新增该对话。
  - **AC-3**（FR-002）：GIVEN 同一会话 WHEN 调用 `Agent` 不传 `target` THEN 子代理对话归属工作区 A 且 `parentSessionId` 为该会话，与现状逐项一致。
  - **AC-4**（FR-002）：GIVEN 同一会话 WHEN `target` 传当前会话所属工作区的身份 THEN 按不传 `target` 的当前策略创建本机子代理。
- 场景 2：跨机器代理（SSH 远程工作区）
  - **AC-5**（FR-001）：GIVEN 打开 SSH 远程工作区且 SSH 目标主机为 `192.168.1.10`、目录为 `/srv/app` WHEN 打开 `@` 候选 THEN 该项身份为 `192.168.1.10:/srv/app`。
  - **AC-6**（FR-002）：GIVEN 本机会话 WHEN `target` 指向已打开的远程工作区 THEN 远程 Core 创建子代理对话并开始执行 prompt，发起方工具结果成功且包含该会话 id。
- 场景 3：占位父对话
  - **AC-7**（FR-003）：GIVEN 跨工作区子代理对话已创建 WHEN 读取其元数据 THEN `role` 等于传入的 `agentRole`、`title` 等于 `description`（缺省为 `Agent: <role>`）、`project` 等于目标工作区路径、`parentSessionId` 指向占位对话。
  - **AC-8**（FR-004）：GIVEN 目标工作区侧栏 WHEN 渲染对话树 THEN 跨工作区子代理嵌套在占位父节点下，占位节点不提供重命名 / 删除 / 智能命名入口。
  - **AC-9**（FR-004）：GIVEN 占位对话 WHEN 用户点击打开 THEN 聊天区显示占位页（含发起方身份与会话 id），不加载任何消息、不建立会话运行时。
  - **AC-10**（FR-004）：GIVEN 占位对话与子代理对话 WHEN 应用重启后重新打开目标工作区 THEN 两者仍在列表中且父子关系不变。
- 场景 4：跨工作区跳转
  - **AC-11**（FR-005）：GIVEN 占位页 WHEN 点击跳转链接 THEN 活动标签切到发起方工作区并打开发起方对话。
  - **AC-12**（FR-005）：GIVEN 发起方对话中的 `Agent` 工具卡片 WHEN 点击会话 id 链接 THEN 活动标签切到目标工作区并打开该子代理对话。
  - **AC-13**（FR-005）：GIVEN 发起方工作区已关闭 WHEN 点击指向它的跳转链接 THEN 链接不可用并显示原因，不自动打开该工作区。
- 场景 5：中止
  - **AC-14**（FR-006）：GIVEN 跨工作区子代理正在运行且发起方前台空闲 WHEN 在发起方点击 abort THEN 目标工作区该子代理停止，发起方 `subAgentRunning` 归假。
  - **AC-15**（FR-006）：GIVEN 跨工作区子代理正在运行 WHEN 查看发起方的 abort 按钮 THEN 按钮为黄色，悬停明细包含该子代理的 description。
  - **AC-16**（FR-006）：GIVEN 跨工作区子代理正在运行 WHEN 在目标工作区的子代理对话点击 abort THEN 该会话停止运行，发起方 `subAgentRunning` 归假。
  - **AC-17**（FR-006）：GIVEN 发起方会话被关闭 WHEN 关闭完成 THEN 其跨工作区子代理一并中止。
- 场景 6：`@` 补全
  - **AC-18**（FR-007）：GIVEN 已打开多个工作区 WHEN 在某个会话的输入框输入 `@` THEN 候选菜单列出全部已打开工作区中除该会话所属工作区之外的项。
  - **AC-19**（FR-007）：GIVEN 只打开了当前会话所属工作区 WHEN 输入 `@` THEN 不显示候选菜单。
  - **AC-20**（FR-007）：GIVEN 候选菜单已打开 WHEN 输入查询词 THEN 菜单按身份 ID 与目录名过滤，ID 命中排在目录名命中之前。
  - **AC-21**（FR-007）：GIVEN 目标身份含空格 WHEN 从菜单选中 THEN 插入 `@"<身份>" `，保留光标之后的原文，光标置于输入末尾。
  - **AC-22**（FR-007）：GIVEN 输入首字符不是 `@` WHEN 在正文任意位置输入 `@` THEN 不弹出候选菜单。
  - **AC-23**（FR-007）：GIVEN 首行已输入 `@<身份>` WHEN 继续输入多行正文 THEN 菜单关闭且正文可继续换行。
- 场景 7：提醒注入与宿主能力
  - **AC-24**（FR-008）：GIVEN 宿主声明支持跨工作区代理 WHEN 发送以 `@<身份>` 开头的消息 THEN 上下文里用户消息之后紧跟一条 reminder，点名 `target=<身份>` 与 `Agent` 工具。
  - **AC-25**（FR-008）：GIVEN 用户消息不以 `@` 开头 WHEN 该消息进入轮次边界 THEN 不注入 `@` 命令的 reminder。
  - **AC-26**（FR-009）：GIVEN 宿主声明不支持跨工作区代理 WHEN 发送以 `@<身份>` 开头的消息 THEN 不注入 reminder、按普通文本处理，且 `Agent` 传 `target` 返回「当前宿主不支持」的工具错误。
- 场景 8：错误路径与生命周期
  - **AC-27**（FR-002）：GIVEN `target` 指向未打开的身份 WHEN 调用 `Agent` THEN 返回工具错误、不创建任何对话、不占用并发槽位。
  - **AC-28**（FR-002）：GIVEN `target` 为空字符串 WHEN 调用 `Agent` THEN 入参校验失败并返回工具错误。
  - **AC-29**（FR-010）：GIVEN 同一父会话的并发槽位已占满 WHEN 发起新的跨工作区代理 THEN 该调用在工具调用内排队，目标工作区不出现新对话。
  - **AC-30**（FR-010）：GIVEN 目标工作区 Core 不可达 WHEN 发起跨工作区代理 THEN 工具返回错误，发起方不残留 `subAgentRunning` 为真的状态。

## 功能需求

### FR-001：工作区代理身份

- 每个已打开工作区有一个代理身份，字符串为 `<机器名>:<工作区绝对路径>`，逐字用于 `@` 候选、
  `Agent` 的 `target` 与 reminder。
- 本地工作区：机器名取运行宿主的机器名。Windows 取 `COMPUTERNAME`，Linux 取 `HOSTNAME`，
  两者缺失时回退操作系统主机名；两种平台的取法各有独立实现与单测（即使宿主暂不支持 Linux）。
- 远程（SSH）工作区：机器名取该工作区的 SSH 目标主机字符串（`WorkspaceRef.endpoint.host`），
  不含端口与登录用户。
- 路径口径：本地按宿主的规范化口径；远程按目标机器上的原样路径字符串。
- 身份是打开集合的派生事实，owner 是 Electron 主进程；工作区打开 / 关闭 / 激活时随之更新。
- 身份不写进会话元数据的 `project`（`project` 仍是路径）。
- 打开集合按工作区引用去重；不同引用可能派生出相同身份（同 host + 同路径、不同 SSH 用户或端口）：
  候选列表如实展示每一项，`Agent` 的 `target` 解析遇到重复身份报错，不猜。

### FR-002：`Agent` 工具的 `target` 参数

- `Agent` 新增可选入参 `target`（字符串，工作区代理身份）。
- 不传 `target`：沿用当前策略——在当前会话所属工作区创建子代理会话。
- 传 `target`：在目标工作区创建一个对话，角色取 `agentRole`；不在当前工作区创建子代理会话。
- `target` 等于当前会话所属工作区的身份：按不传 `target` 处理。
- `target` 指向未打开或未匹配任何打开工作区的身份：工具返回错误，不创建任何对话、不占用并发槽位。
- `target` 传空字符串：入参校验失败（不静默当作未传）。
- 成功结果文本包含子代理会话 id 与目标身份；工具入参里的 `target` 同时供 UI 渲染跳转。
- 角色校验、并发上限、FIFO 排队与 `Reply` 回报语义与本地子代理一致（见 FR-010）。

### FR-003：跨工作区子代理会话

- 目标工作区创建的对话是子代理会话：`role` = `agentRole`、`title` = `description`
  （缺省 `Agent: <role>`）、`parentSessionId` = 占位对话、`project` = 目标工作区路径。
- 对话创建后立即出现在目标工作区对话列表；发起方工作区的对话列表不出现该对话。
- prompt 作为该会话的第一条用户消息，子代理消费循环在目标工作区 Core 内运行，`Reply` 与
  Reminder 重试沿用既有子代理语义。
- 子代理的 `Reply` 投递回发起方会话，作为 agent 消息出现；From 头展示目标工作区身份。
- 会话级配置取目标工作区自身的默认值（模型 / provider / agentMode / 提示词预设 / 联网 / MCP），
  不继承发起方会话；`Explorer` 等非 Master 角色仍按既有规则固定 normal 预设、不联网、无 MCP。
- 沿用既有「子代理内禁止再调 `Agent`」规则：跨工作区子代理不能继续派生（含跨工作区）。

### FR-004：占位父对话

- 目标工作区为每个跨工作区子代理创建一个占位父对话，作为对话树的容器节点。
- 占位对话不是真实会话：没有消息文件、不建立会话运行时、不参与空闲回收、不参与压缩与智能命名。
- 占位对话的标题取发起方对话标题，来源标注取发起方工作区身份与会话 id。
- 打开占位对话时不创建聊天会话，聊天区显示占位页：说明这是跨工作区子代理的容器，并给出跳转到
  发起方对话的链接。
- 占位对话由子代理 meta 的 `crossWorkspaceOrigin` 在列表读取时派生，重启后仍在；
  其子对话全部消失时占位对话一并消失。
- 占位对话不提供重命名 / 删除 / 智能命名入口；生命周期随子对话。

### FR-005：跨工作区跳转

- 发起方：`Agent` 工具卡片展示目标身份与会话 id，点击切到目标工作区并打开该子代理对话。
- 目标工作区：占位页的跳转链接切到发起方工作区并打开发起方对话。
- 目标工作区：子代理对话的 From 头与「返回父对话」入口沿用既有口径，落到占位对话。
- 跳转由宿主执行（切活动标签 + 打开对话）；webview 只上报跳转意图，不自己切换工作区。
- 跳转前目标工作区未打开时，链接不可用并显示原因，不自动打开该工作区。
- 目标对话已不存在时链接不可用并显示原因，不静默跳到空视图。

### FR-006：跨工作区中止

- 发起方会话的 `subAgentRunning` 必须包含跨工作区子代理：运行期间发起方 abort 按钮为黄色，
  悬停明细包含该子代理的 description。
- abort 范围沿用 [docs/features/abort-button.md](../../docs/features/abort-button.md#fr-002中止范围)
  的既有三段判定；其中「中止已登记子代理」必须覆盖跨工作区子代理。
- 跨工作区子代理的中止传播到目标工作区 Core；目标不可达时按已结束收敛，发起方不永久停在黄色态。
- 目标工作区一侧可独立中止该子代理（既有 abort 语义不变），中止后发起方 `subAgentRunning` 归假。
- 发起方会话关闭时，其跨工作区子代理一并中止。

### FR-007：`@` 工作区补全

- 输入框首字符为 `@` 时展示候选菜单；候选 = 全部已打开工作区中**除当前会话所属工作区之外**的项，
  按打开集合（标签页）顺序排列。
- 当前工作区的判据是发起补全请求的视图所属的工作区引用（不是活动标签页、不是身份字符串），
  同一身份的另一工作区仍可出现在候选里。
- 当前工作区解析不出时返回空候选（不显示菜单），不猜、不用活动标签页顶替。
- 命令名区间：
  - 引号形态 `@"..."`：从 `@"` 起，到下一个 `"` 或输入末尾止；
  - 非引号形态：从 `@` 起，到第一个空白（空格 / 制表 / 换行）或输入末尾止。
- 光标位于区间内（含区间起点）时展示菜单；查询词 = 区间内、光标之前的文本。
- 过滤按身份 ID 与目录名（不区分大小写）匹配，ID 命中排在目录名命中之前；无候选时不显示菜单。
- 选中替换：替换 `@` 到光标之间的文本；插入 `@<身份> `，身份含空白时插入 `@"<身份>" `；
  光标之后的原文保持不变；选中后光标置于输入末尾。
- 键盘操作与 `/` 补全一致：↑ / ↓（含 Ctrl+P / Ctrl+N）、Enter / Tab 确认、Esc 关闭。
- 只支持首字符开头：`@` 出现在其它位置不触发菜单。
- 支持多行：`@<身份>` 之后的内容可以是多行正文。

### FR-008：`@` 命令的提醒注入

- Core 在轮次边界识别 `@` 命令：用户消息去首尾空白后以 `@` 开头，且宿主声明支持跨工作区代理。
- 身份解析按 FR-007 的区间规则；身份 ID 之后的内容（可多行）是任务正文。
- 在用户消息之后注入一条 reminder：模型可见、UI 消息流不可见，内容点名目标身份、`target` 参数名
  与 `Agent` 工具，并要求把该事项代理给目标工作区而不是在本工作区直接执行。
- 注入顺序：用户消息 → reminder → LLM 请求；同一轮内与 `/` 命令的 Skill 注入互不干扰。
- reminder 不校验身份是否存在；身份不匹配时错误在 `Agent` 执行时暴露（见 FR-002）。
- 用户消息原文（含 `@` 前缀）保持不变，不被剥离。

### FR-009：宿主能力边界

- 宿主在连接建立时声明是否支持跨工作区代理；Electron 为支持，VS Code 与 TUI 为不支持。
- 不支持时：`@` 按普通文本处理、不注入 reminder；`Agent` 传 `target` 返回「当前宿主不支持跨工作区代理」
  的工具错误。
- Core 不按宿主类型嗅探，只读能力声明。

### FR-010：生命周期与并发

- 跨工作区子代理占用发起方父会话的一个并发槽位，直到它结束、被中止或目标不可达。
- 槽位在目标工作区报告子代理结束时释放；目标不可达时按已结束释放，不永久占用。
- 子代理结束时目标工作区刷新对话列表；发起方 `subAgentRunning` 同步归假。
- 目标工作区被关闭时，其上的跨工作区子代理随工作区清理链中止；发起方按子代理结束收敛。
- 并发上限、FIFO 排队与「排队中调用属前台查询」的既有语义不变。

## 边界与错误路径

- `target` 为空串：入参校验失败，文案点名 `target` 不接受空字符串。
- `target` 未匹配任何打开工作区：工具错误，点名目标身份；不创建对话、不占用槽位。
- 同一身份对应多个打开项（同 host + 同路径、不同 SSH 用户或端口）：`target` 解析报错，不取第一项。
- 路径含空格：`@` 必须用引号形态；手写无引号时按第一个空白截断，身份不匹配 → 工具错误。
- 身份含 `"`：无法用 `@` 引号形态寻址（`@` 语法不支持转义）；仍可手写 `target`。
- 非 Electron 宿主：`@` 是普通文本；`Agent` 的 `target` 报错。
- 只打开当前会话所属工作区：`@` 无候选、不显示菜单（不是错误）；手写 `@<本工作区身份>` 仍按 FR-002 的
  「等于当前工作区」处理。
- 发起方会话在子代理运行期间被删除：`Reply` 投递返回失败（与本地同口径），子代理按既有 Reminder
  重试后结束。
- 目标工作区 Core 断线 / 崩溃：发起方 `subAgentRunning` 收敛为假，已返回的会话 id 变为不可达，
  跳转链接显示不可用。
- 目标工作区被关闭：该工作区上的子代理中止，发起方按结束收敛；占位对话与子代理对话随磁盘数据保留。
- 机器名在重启后变化：旧身份不再匹配任何打开工作区，旧链接不可用并显示原因。
- 占位对话的子对话被删除：占位对话一并消失，不残留空容器节点。

## 非目标

- VS Code 宿主与 TUI 的跨工作区代理（FR-009 明确不支持）。
- 自动打开未打开的工作区（跳转与 `target` 都只认已打开集合）。
- 跨实例发现：两个 Electron 实例、两台宿主之间不互相注册身份（现状是单实例锁 + 各自打开集合）。
- 新增跨机器传输与认证：远程沿用既有 SSH 接入，不引入新的网络通道。
- `@` 文件引用补全（本次只做工作区）。
- 在 system prompt 里列出全部工作区身份：模型只能从 `@` 命令或用户文本得到身份。
- 跨工作区子代理继承发起方会话级配置（按 FR-003 取目标工作区默认值）。
- 占位对话的重命名 / 删除 / 归档入口。

## 对需求基线的影响

- 新增 **US-56 跨工作区代理**（`Agent` 的 `target`、占位父对话、双向跳转、跨工作区中止）与
  **US-57 `@` 工作区补全与提醒注入**，登记在
  [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md#ep-9-多工作区桌面端)
  的 EP-9 多工作区。
- e2e 落点：`e2e/electron/crossWorkspaceAgent.spec.ts`（US-56）、
  `e2e/webview/workspaceMention.spec.ts`（US-57）；同步更新
  [docs/features/user-stories.md](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射)
  的映射表与目录收录范围。
- 既有 US 的验收标准不改：US-35 / US-36 的打开与切换语义不变，新能力只追加身份与代理两条故事。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/workspaceIdentity.ts` 的 `resolveMachineName` / `workspaceAgentId`；`electron/main.ts` 打开集合派生身份 | `src/test/workspaceIdentity.test.ts`；`e2e/electron/crossWorkspaceAgent.spec.ts`（身份派生参与派发） | 自动 |
| FR-002 | `core-rs/src/tools.rs` 的 `run_agent`；`core-rs/src/tool_input.rs` 的 `agent_fields`；`core-rs/src/main.rs` 的跨工作区派发 | `core-rs/src/tools_tests.rs`、`core-rs/src/engine_tests.rs`、`src/test/crossWorkspaceRouting.test.ts`；`e2e/electron/crossWorkspaceAgent.spec.ts` | 自动 |
| FR-003 | `core-rs/src/engine.rs` 的跨工作区建会话分支；`core-rs/src/history.rs` 的子代理元数据 | `core-rs/src/engine_tests.rs`（建会话 / Reply 回投 / From 头） | 自动 |
| FR-004 | `src/shared/history/Conversation.ts` 的占位元数据；`electron/sidebar/main.ts` 对话树；`electron/chatPlaceholderHtml.ts` 占位页 | `core-rs/src/engine_tests.rs`（列表派生占位）、`src/test/chatPlaceholderReason.test.ts`（占位页）、`e2e/electron/crossWorkspaceAgent.spec.ts`（树嵌套）；「不建立会话运行时」由 `electron/main.ts` 分支保证 | 无自动覆盖 + 「不建立会话运行时」属多视图宿主胶水，US-38 口径真机核验 |
| FR-005 | `electron/main.ts` 的跨工作区跳转动作；`src/webview/tools/Agent.tsx` 的链接 | `e2e/electron/crossWorkspaceAgent.spec.ts`（派发与占位树）、`src/test/chatPlaceholderReason.test.ts`（跳转按钮有无） | 无自动覆盖 + 实际跳转（切标签 + 开视图）属多 BrowserWindow 跳转，US-38 口径真机核验 |
| FR-006 | `core-rs/src/engine.rs` 的 `abort_session_scope`；`src/host/ui/webviewMessageHandler.ts` 的中止转发 | `core-rs/src/engine_tests.rs`（中止事件 / 结束收敛 / 槽位）、`src/test/abortButtonState.test.ts`（黄灯三态） | 无自动覆盖 + 宿主跨 Core 转发（目标侧独立中止 / 发起方归假）需双 Core 链路，真机核验 |
| FR-007 | `src/webview/mentionState.ts` 的区间 / 过滤 / 替换纯函数；`src/webview/InputArea.tsx` 的候选菜单 | `src/test/mentionState.test.ts`、`e2e/webview/workspaceMention.spec.ts` | 自动 |
| FR-008 | `core-rs/src/engine.rs` 轮次边界的 `@` 解析与 reminder 注入 | `core-rs/src/engine_tests.rs`（`@` 解析 / reminder 注入 / 能力位门控） | 自动 |
| FR-009 | `src/shared/AssistantEventBus.ts` 的 `hostEnvironmentProvided` 能力字段；三个宿主发送点 | `core-rs/src/tools_tests.rs`（不支持时 `target` 报错）、`core-rs/src/engine_tests.rs`（不支持时不注入 reminder） | 无自动覆盖 + 三个宿主的发送点属接线胶水，由共享骨架与类型保证 |
| FR-010 | `core-rs/src/subagent.rs` 的槽位与登记；`core-rs/src/engine.rs` 的结束 / 中止收敛 | `core-rs/src/subagent_tests.rs`、`core-rs/src/engine_tests.rs`（槽位 / 结束 / 中止收敛） | 无自动覆盖 + 宿主跨工作区结束转发需双 Core 链路，真机核验 |

## 待澄清

无。三个产品决策已在起草前定档：`@` 身份支持引号形态、远程机器名取 SSH 目标主机字符串、
`target` 指向未打开工作区时报错。

## 收敛记录

（2026-10-23 /converge 填写。闸门：`npm run check-types`、`npm run lint`、
`npm run test:all -- docs-lint` 绿；`npm run test:core` 928 通过 / 0 失败。
e2e 未在本机执行：`crossWorkspaceAgent.spec.ts` / `workspaceMention.spec.ts` 需要
构建 Electron 产物与图形环境，按仓库既有口径由本地 `npm run test:e2e:*` / 真机核验。）

- 已满足：
  - FR-001 / AC-1、AC-5：`src/test/workspaceIdentity.test.ts`（COMPUTERNAME / HOSTNAME /
    回退 / 空串抛错、本地规范化路径、远程取 SSH 主机且不含端口与用户、歧义不取第一项）；
    `e2e/electron/crossWorkspaceAgent.spec.ts` 用同一 `机器名:path.resolve` 口径构造
    `target` 并派发成功。
  - FR-002 / AC-2、AC-3、AC-4、AC-27、AC-28：`core-rs/src/tools_tests.rs` 的
    `agent_empty_target_is_rejected`、`agent_target_rejected_when_host_does_not_support_it`、
    `agent_target_selects_remote_spawn_hook`；`core-rs/src/engine_tests.rs` 的
    `cross_workspace_spawn_registers_remote_child`、`cross_workspace_spawn_error_propagates`；
    `src/test/crossWorkspaceRouting.test.ts`（等于本工作区 → local / 未打开 → missing /
    歧义 → ambiguous / 远程命中）；`e2e/electron/crossWorkspaceAgent.spec.ts`
    （B 列表新增、A 列表不新增）。
  - FR-003 / AC-6、AC-7：`core-rs/src/engine_tests.rs` 的
    `start_remote_sub_agent_records_origin_and_placeholder`（role / parentSessionId /
    meta 的 `crossWorkspaceOrigin` / title）、`cross_workspace_reply_routes_to_origin`
    （Reply 回投发起方）、`cross_workspace_spawn_registers_remote_child`（远程派发登记）。
    AC-6 的真实 SSH 远端 Core 链路无自动覆盖（需真实远端），由本机双工作区 e2e +
    远程身份单测组合覆盖。
  - FR-004 / AC-8、AC-9、AC-10：`e2e/electron/crossWorkspaceAgent.spec.ts`（占位父节点 +
    子代理嵌套、A 侧不出现）；`src/test/chatPlaceholderReason.test.ts`（有来源 → 跳转按钮 /
    无来源 → 不可用提示）；`core-rs/src/engine_tests.rs` 的
    `start_remote_sub_agent_records_origin_and_placeholder`（meta 落盘后
    `load_conversation_list` 派生占位，重启读取同口径）；`electron/sidebar/main.ts` 的
    占位节点 `actionsHtml = ''` 与 `electron/main.ts` 的 `showCrossWorkspacePlaceholder`
    （不加载会话、不建运行时）为代码路径核验，无自动覆盖。
  - FR-005 / AC-11、AC-12、AC-13：`src/test/chatPlaceholderReason.test.ts`（占位页跳转
    按钮有无）；`electron/main.ts` 的 `jumpToCrossWorkspaceConversation` /
    `openConversation.targetWorkspaceId` / `showCrossWorkspacePlaceholder` 为代码路径核验；
    实际切标签与开视图无自动覆盖（多 BrowserWindow 跳转，US-38 口径），真机核验。
  - FR-006 / AC-14、AC-15、AC-16、AC-17：`core-rs/src/engine_tests.rs` 的
    `cross_workspace_abort_emits_event`（发起方中止发事件）、
    `cross_workspace_spawn_registers_remote_child`（`subAgentRunning` 计入远程子代理）、
    `runtime_snapshot_carries_sub_agent_description`（悬停明细来源）；
    `src/test/abortButtonState.test.ts`（`subAgentRunning` → 黄灯）；AC-17 走
    `abort_session_scope` 的会话关闭路径（与 abort 同一实现）。宿主跨 Core 转发与
    目标侧独立中止无自动覆盖，真机核验。
  - FR-007 / AC-18、AC-19、AC-20、AC-21、AC-22、AC-23：`src/test/mentionState.test.ts`
    （首字符 / 区间 / 引号形态 / 过滤排序 / 插入与光标）；`src/test/workspaceIdentity.test.ts`
    （候选排除来源工作区、来源解析不出返回空候选）；`e2e/webview/workspaceMention.spec.ts`
    （候选、引号形态插入、正文中的 `@` 不弹菜单）；AC-23 的多行正文由区间在首个空白 /
    换行结束 + e2e 断言覆盖。
  - FR-008 / AC-24、AC-25：`core-rs/src/engine_tests.rs` 的
    `mention_reminder_names_target_and_agent_tool`、
    `mention_identity_parsing_covers_quoted_and_plain_forms`、
    `resolve_pending_mention_sets_reminder_only_when_capable`。
  - FR-009 / AC-26：`core-rs/src/tools_tests.rs` 的
    `agent_target_rejected_when_host_does_not_support_it`；`core-rs/src/engine_tests.rs` 的
    `resolve_pending_mention_sets_reminder_only_when_capable`（不支持时不注入）；
    `src/test/bootstrapWiring.test.ts` 透传能力位。三个宿主发送点为接线代码，无自动覆盖。
  - FR-010 / AC-29、AC-30：`core-rs/src/tools_tests.rs` 的
    `agent_tool_caps_concurrent_sub_agents_and_queues_the_rest`（同一父会话 FIFO 排队，
    跨工作区走同一取槽位路径）；`core-rs/src/engine_tests.rs` 的
    `cross_workspace_spawn_error_propagates`（目标不可达 → 工具错误、不登记远程子代理；
    槽位归还由 `run_agent` 的 Err 分支保证）、`cross_workspace_spawn_registers_remote_child`
    （`subAgentRunning` 计入）。
- 偏差：
  - 追溯矩阵 FR-004 / FR-005 / FR-006 / FR-009 / FR-010 原先的「自动」写得过宽（例如
    FR-005 的 e2e 只覆盖派发与占位树，不覆盖实际跳转）。已按实际测试落点改写
    「测试落点 / 覆盖」列，缺口登记为「无自动覆盖 + 理由」。
  - 代码注释里的规格编号误写为 022（远程终端），已统一改为 023；终端专属引用保留 022。
- 未做：无。`tasks.md` T001–T015 全部勾选。
