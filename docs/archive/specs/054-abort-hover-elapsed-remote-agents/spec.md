---
status: 已收敛
---

# 改动规格：abort 悬停明细显示已执行时间与远程子代理

abort 按钮黄色态的悬停浮层目前逐项列出运行中的后台 Bash 任务与子代理，但每条只有
身份（描述 / 命令），看不出「跑了多久」，也看不到派发到其它工作区的远程子代理——
发起方侧只有布尔位与本地会话状态，远程子代理没有本地会话条目，因此
`collectRunningSubAgents` 的纯派生聚合不到它们。本次改动把悬停明细补成
「谁 + 在执行什么 + 已执行多久」：后台任务与子代理条目都带上开始时刻并由 UI 推算
已执行时间（浮层可见期间每秒刷新），子代理组同时纳入远程（跨工作区）子代理并标注
目标工作区身份。按钮三态、点击语义与中止范围一律不变。

定档：L3——新增 `SessionRuntimeState` / `BackgroundTaskBrief` 契约成员与新类型
（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）。其中「远程子代理不出现在悬停明细」
在 as-built 里已有承诺（[cross-workspace-agent.md FR-006](../../docs/features/cross-workspace-agent.md#fr-006跨工作区中止)），
本次与时长一并落地。

交叉引用：按钮三态与中止范围见 [docs/features/abort-button.md](../../docs/features/abort-button.md)；
运行时快照的 owner 与分发见 [docs/core/session-runtime.md](../../docs/core/session-runtime.md)；
跨工作区子代理的登记、结束与中止见
[docs/features/cross-workspace-agent.md](../../docs/features/cross-workspace-agent.md)；
「core 描述事实，UI 决定表现」见
[principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)、
「派生字段从根字段推导」见
[principles.md 第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)、
「webview 不持有事实默认值」见
[principles.md 第 10 节](../../docs/architecture/principles.md#10-webview-不持有事实的默认值)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [第 2 节 对外快照](../../docs/core/session-runtime.md#2-对外快照) | 修改 | `backgroundTasks` 元素补开始时刻；新增 `subAgentStartedAt` 与 `remoteSubAgents` 两个成员的语义与推送口径 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [FR-003 事实与表现的边界](../../docs/features/abort-button.md#fr-003事实与表现的边界) | 修改 | 悬停明细的事实面扩到开始时刻与远程子代理清单 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [FR-004 黄色态悬停运行明细](../../docs/features/abort-button.md#fr-004黄色态悬停运行明细specs019specs054) | 修改 | 每项显示已执行时间、子代理组含远程条目并标目标工作区身份、可见期间每秒刷新 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [第 4 节 边界与错误路径](../../docs/features/abort-button.md#4-边界与错误路径) | 修改 | 补「开始时刻缺失 / 时钟偏差 / 计时随浮层可见性启停」的口径 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [第 5 节 非目标](../../docs/features/abort-button.md#5-非目标) | 修改 | 删除「已运行时长不进契约或浮层」，保留 pid / 输出预览 / 逐项中止 |
| [docs/features/cross-workspace-agent.md](../../docs/features/cross-workspace-agent.md) | [FR-006 跨工作区中止](../../docs/features/cross-workspace-agent.md#fr-006跨工作区中止) | 修改 | 发起方悬停明细的来源从「本地会话状态」扩到远程登记清单，并补目标工作区身份与时长 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 8 节](../../docs/hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定) | 修改 | 链路表 webview 行补「秒级刷新 + 远程子代理合并」 |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | [US-52](../../docs/features/user-stories/dialog-core.md#us-52-abort-黄灯悬停预览后台任务与子代理) | 修改 | US-52 验收标准追加「每项显示已执行时间」「子代理组含远程并标目标工作区身份」（不新增 US） |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager) | 不涉及 | 该节只指向快照规格、不列成员表，成员语义单点在 session-runtime.md（同一事实只写一处） |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 不涉及 | 不新增事件、`sessionRuntimeChanged` 载荷仍是 `states`，元素结构属 session-runtime.md；events.md 行数棘轮不允许加注 |

## 用户场景与验收标准

- 场景 1：收尾中看清「跑了多久」
  - **AC-1**（FR-001）：GIVEN 该会话有运行中的后台 Bash 任务 WHEN 黄色态悬停满 1 秒 THEN 「后台任务」组每条在描述（及不同的命令）之后显示该任务已执行时间
  - **AC-2**（FR-005）：GIVEN 悬停浮层已显示 WHEN 停留 3 秒 THEN 各条目的已执行时间每秒递增一次，不停留在打开时的读数
- 场景 2：子代理组的时长
  - **AC-3**（FR-002）：GIVEN 该会话有非 idle 的本地子代理 WHEN 悬停浮层显示 THEN 「子代理」组该条显示其已执行时间
  - **AC-4**（FR-002）：GIVEN 子代理条目取不到创建时刻（`subAgentStartedAt` 为 `null`） WHEN 悬停浮层显示 THEN 该条只显示描述、不显示时长、不显示占位文案
- 场景 3：远程子代理出现在发起方明细里
  - **AC-5**（FR-003）：GIVEN 发起方会话派发过一个仍在运行的跨工作区子代理 WHEN 查看发起方快照 THEN 该会话条目的 `remoteSubAgents` 含该子代理的 `sessionId` / `description` / `workspaceId` / `startedAt`
  - **AC-6**（FR-004）：GIVEN 发起方只有远程子代理在跑 WHEN 黄色态悬停满 1 秒 THEN 「子代理」组列出它，行内显示描述、目标工作区身份与已执行时间
  - **AC-7**（FR-003）：GIVEN 远程子代理结束事件到达或目标工作区不可用 WHEN 快照重算 THEN `remoteSubAgents` 不再含该条目，浮层若已无任何条目则关闭
- 场景 4：格式与计时边界
  - **AC-8**（FR-005）：GIVEN 已执行时长分别为 5 秒 / 65 秒 / 3725 秒 / 93784 秒 WHEN 渲染 THEN 文本分别为 `5秒` / `1分5秒` / `1小时2分5秒` / `1天2小时3分4秒`（为零的时间单位连同其数值一起省略）
  - **AC-9**（FR-005）：GIVEN 开始时刻晚于当前时刻（时钟偏差） WHEN 渲染 THEN 已执行时间按 `0秒` 显示，不出现负值
  - **AC-10**（FR-005）：GIVEN 浮层因移出 / 离开黄色态 / 切换会话而隐藏 WHEN 再等待数秒 THEN 不再有每秒刷新（计时随可见性启停）
- 场景 5：旧宿主与既有行为不回归
  - **AC-11**（FR-001、FR-003）：GIVEN 快照缺 `startedAt` / `subAgentStartedAt` / `remoteSubAgents`（旧宿主或假宿主） WHEN 悬停浮层显示 THEN 该条不显示时长、远程组为空，条目本身仍按既有口径列出，不抛错
  - **AC-12**（FR-004）：GIVEN 红色 / 灰色态或两组明细皆空（恢复态 spin） WHEN 悬停超过 1 秒 THEN 仍无浮层；点击浮层条目仍不产生任何上行消息

## 功能需求

### FR-001：后台任务条目携带开始时刻

运行中后台 Bash 任务清单的元素（`BackgroundTaskBrief`）除 `taskId` / `description` /
`command` 外携带 `startedAt`：该任务的开始时刻，wall clock 毫秒，与后台任务注册表
记录的开始时刻同源。它与 `backgroundRunning` / 清单成员同一次快照产出，参与快照
diff——任务开始时刻不变，因此不会因时间流逝触发推送。

### FR-002：本地子代理条目携带创建时刻

会话快照新增 `subAgentStartedAt: number | null`：本地子代理会话为其登记时刻（wall
clock 毫秒，与服务端登记表记录一致）；普通会话、跨工作区对话与恢复路径取不到时为
`null`。取不到不是错误——悬停明细据此决定是否显示时长（FR-005）。

### FR-003：发起方快照携带远程子代理清单

会话快照新增 `remoteSubAgents: readonly RemoteSubAgentBrief[]`，元素字段全部必选：

| 字段 | 取值 |
| --- | --- |
| `sessionId` | 远程子代理会话 id |
| `description` | 派发时 `Agent` 工具调用的 description；取不到为 `null` |
| `workspaceId` | 目标工作区身份（`<机器名>:<工作区路径>`） |
| `startedAt` | 发起方登记该远程子代理成功的时刻，wall clock 毫秒 |

- 该清单只出现在发起方会话（创建者）的条目里，普通会话为空数组。
- 写入点是派发成功时的远程登记，移除点是结束事件到达与目标工作区不可用（按已结束
  收敛）；两处都已在同一次 `emit_runtime` 之前完成，清单与 `subAgentRunning` 同源同发。
- 清单参与快照 diff：登记 / 移除即使布尔位不变也触发推送。

### FR-004：悬停明细的子代理组纳入远程子代理

「子代理」组的聚合口径统一为一个纯函数：以当前会话为根，深先序展开本地非 idle 子代理
（既有口径：只经非空闲节点下钻），并在每一层的本地子代理之后追加该节点的
`remoteSubAgents`（按登记序）。远程子代理不继续下钻——跨工作区子代理不能继续派生。

- 远程条目与本地条目同为只读行：展示描述（`null` 显示既有回退文案）、目标工作区身份
  （`→ <workspaceId>`）与已执行时间。
- 明细仍随快照刷新；两组皆空即关闭浮层。

### FR-005：已执行时间由 UI 推算并秒级刷新

- 开始时刻来自快照（后台任务 `startedAt` / 本地子代理 `subAgentStartedAt` / 远程子代理
  `startedAt`）；webview 用本机时钟推算已执行时长，core 不推送随时变化的时长字段。
- 文本按时间单位逐级拼接，从「天」到「秒」：`<天>天<小时>小时<分>分<秒>秒`；数值为零的
  单位连同其单位一起省略（`0` 本身也不省略——全部为零时显示 `0秒`）；不满 1 分钟只显示
  秒数（`45秒`），不满 1 小时显示分与秒（`1分5秒`），依此类推。数值与单位之间不留空格，
  中间不显示标点；只看整秒，不显示毫秒。
- 单位文案走 i18n：`zh` 为「天 / 小时 / 分 / 秒」，`en` 为 `d / h / m / s`（同一拼接规则，
  同样省略零单位），不在组件里写死字面量。
- 每次浮层渲染时把三项拼成一行：后台任务为「描述 +（`command` 与描述不同时附命令）+
  已执行时间」；子代理为「描述（`null` 用回退文案）+（远程才有目标工作区身份标签）+
  已执行时间」。
- 计时随浮层可见性启停：浮层可见时每秒刷新一次读数，隐藏（移出 / 离开黄色态 / 切换
  会话）后不再刷新。浮层不可见时 webview 不维护常驻定时器。
- 取不到开始时刻的条目只显示身份，不显示时长，也不显示占位文案（不为缺失值猜默认值）。

## 边界与错误路径

- **开始时刻缺失**（旧宿主 / 假宿主 / 恢复路径）：对应条目省略时长文本，条目与其余
  字段照常显示；`remoteSubAgents` 缺失按空数组处理——与既有悬停明细的缺字段口径一致。
  这是「设计允许的瞬时状态」，不抛错。
- **时钟偏差**：已执行时长 = 本机当前时刻 − 快照开始时刻，负值钳到 0（显示 `0秒`）。
  跨机器（SSH 远程 Core）时钟偏差会让读数偏大或偏小，属已知限制；core 不推送时长字段，
  以保持快照稳定与 diff 不抖动。
- **首帧读数**：浮层刚出现时即显示一次读数（不等到下一个整秒），此后每秒递增。
- **计时启停**：浮层隐藏后停止刷新；同一会话再次悬停时按当时的开始时刻重新推算
  （读数不会因隐藏期间未刷新而滞后）。
- **远程子代理期间**：登记存在期间恒出现在明细里（与 `subAgentRunning` 的口径一致），
  即使目标侧已实际结束而结束事件尚未到达；事件到达后移除。
- **远程子代理时长起点**：从发起方派发成功（登记）起算，不含派发是否排队等待并发槽位；
  排队中的派发从未创建会话，不出现在明细里。
- **重复 / 迟到结束事件**：移除是幂等的，重复事件不产生第二个移除。
- **既有行为不回归**：三态判定、悬停 1 秒延迟、移出即隐、点击穿透不产生上行、两组皆空
  不显示浮层都与现状一致。

## 非目标

- 后台任务的 pid、输出预览仍不进契约与浮层。
- 浮层内逐项中止单个任务 / 子代理——abort 保持整体范围语义（specs/019 已明确不做）。
- TUI 宿主的 abort 按钮不提供悬停明细（TUI 没有悬停交互）。
- 跨机器时钟同步 / 由 core 推送随时变化的时长字段——推迟到出现真实需求时单独立项
  （见 [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。
- 子代理按运行时长排序或按状态分组，明细顺序沿用 FR-004 的层内本地先、远程后。

## 对需求基线的影响

修改 US-52（[dialog-core.md](../../docs/features/user-stories/dialog-core.md#us-52-abort-黄灯悬停预览后台任务与子代理)）
的验收标准：追加「每条明细显示已执行时间」「子代理组含远程子代理并标注目标工作区
身份」。不新增 US——这是同一条用户故事（黄灯悬停下能看到什么）的范围扩展；
US-56 的跨工作区中止口径不变，只在其对应特性规格里补悬停明细的来源。

e2e 用例沿用 `e2e/webview/conversation.spec.ts` 的 US-52 用例（扩展断言，不新开文件）；
`docs/features/user-stories.md` 的附录映射表因此不涉及。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `BackgroundTaskBrief.startedAt`（`src/shared/AssistantEventBus.ts`）、`emit_runtime` 的 `backgroundTasks` 映射（`core-rs/src/engine.rs`）、`core-rs/fixtures/runtimeState.json` | `core-rs/src/engine_tests.rs` 的 `runtime_snapshot_background_task_carries_started_at` | 自动 |
| FR-002 | `SessionRuntimeState.subAgentStartedAt`（`src/shared/AssistantEventBus.ts`）、子代理登记时刻（`core-rs/src/subagent.rs` 的 `created_at`）、`emit_runtime` | `core-rs/src/engine_tests.rs` 的 `runtime_snapshot_carries_sub_agent_started_at` | 自动 |
| FR-003 | `RemoteSubAgentBrief` / `SessionRuntimeState.remoteSubAgents`、`core-rs/src/subagent.rs` 的远程登记（含 description / workspace / 登记时刻）、`emit_runtime` 投影 | `core-rs/src/engine_tests.rs` 的 `runtime_snapshot_lists_remote_sub_agents_until_ended` | 自动 |
| FR-004 | `src/shared/sessionRuntime.ts` 的 `collectRunningSubAgents`（合并远程清单）、`src/webview/App.tsx` 的 `abortHoverDetail`、`src/webview/InputArea.tsx` 浮层 | `src/test/sessionBusyLevel.test.ts`（远程条目合并与层内顺序）；e2e `e2e/webview/conversation.spec.ts`（US-52 用例扩展：远程行文本） | 自动 |
| FR-005 | `src/webview/elapsedTime.ts` 的 `formatElapsedTime`、`src/webview/InputArea.tsx` 的秒级刷新与行渲染、`src/webview/i18n/zh.ts` 与 `src/webview/i18n/en.ts` 文案 | `src/test/elapsedTime.test.ts`（`5秒` / `1分5秒` / `1小时2分5秒` / `1天2小时3分4秒` / `0秒` / 负值与非法值钳零 / 单位文案注入）；e2e `e2e/webview/conversation.spec.ts`（秒级刷新、隐藏后 1s 定时器清零） | 自动 |

## 待澄清

（无——开始时刻的来源、远程清单形态、格式与计时启停在评审前已定；评审提出的新问题
回填本节。）

## 收敛记录

收敛时由 /implement 填写，结论只分三类。

- 已满足：
  - FR-001 / AC-1、AC-11 → `backgroundTasks` 元素由 `emit_runtime` 投影注册表的
    `start_time`（`core-rs/src/engine.rs`）；`runtime_snapshot_background_task_carries_started_at`
    锁定「与注册表同源 + 时间流逝不触发推送」；e2e US-52 用例断言任务行带时长、缺
    `startedAt` 的条目仍列出但无 `[data-elapsed]`。
  - FR-002 / AC-3、AC-4 → `subAgentStartedAt` 取 `subagent::created_at`
    （`runtime_snapshot_carries_sub_agent_started_at`：已登记为数字、普通会话为 `null`）；
    缺值省略时长的渲染分支见 e2e 的旧宿主条目断言。
  - FR-003 / AC-5、AC-7 → `RemoteRecord` 补 description / 登记时刻，
    `remote_sub_agents_for_session` 按创建者聚合（`remote_registry_carries_description_and_created_at`）；
    `runtime_snapshot_lists_remote_sub_agents_until_ended` 锁定快照清单与
    `subAgentRunning` 同源同发、结束事件后一起收敛。
  - FR-004 / AC-6、AC-12 → `collectRunningSubAgents` 在每层本地子树之后追加该节点的
    `remoteSubAgents` 且不下钻（`src/test/sessionBusyLevel.test.ts` 两条新用例：层内顺序、
    远程条目无下层）；e2e 断言远程行 `→ HOST:/b`、只读点击零上行。
  - FR-005 / AC-2、AC-8 ~ AC-10 → `formatElapsedTime` 的九个单测覆盖单位拼接、零单位
    省略、`0秒`、负值 / NaN / Infinity 钳零、整秒截断与单位文案注入；e2e 断言浮层可见期间
    读数递增、移出后 1s 定时器集合清空。
  - AC-11 的缺字段归一口径 → `conversationHandlers.ts` 把缺失的 `startedAt` /
    `subAgentStartedAt` 归一成 `null`、缺 `remoteSubAgents` 归一成空数组；e2e 用一条无
    `startedAt` 的后台任务覆盖。
- 偏差：
  - `RemoteSubAgentBrief.startedAt` 说明写的是「发起方派发成功（登记）时刻」，实现取
    `register_remote` 内的 `util::now_millis()`；两者在 `spawn_remote_agent` 里紧邻（先
    `register` 后 `register_remote`），语义一致，无行为差异。
  - webview 镜像里 `backgroundTasks[].startedAt` 的类型是 `number | null`（shared 契约是
    `number`）：多出的 `null` 只承载「旧宿主没带这个字段」，与 `subAgentStartedAt` 的缺值
    口径统一；shared 侧仍是必选 `number`，不影响 core 契约。
  - `docs/features/abort-button.md` 的 FR-004 标题与验收标准随本次改动扩写（新增 AC-18 ~
    AC-21 与场景 8 而非重排既有 AC 编号），既有 AC-1 ~ AC-17 的编号与含义未变。
- 未做：（无——tasks.md 全部勾选。）
- 反向对照：实现 diff 逐分支对回 spec——缺字段归一 ↔ AC-11；负值 / 非有限值钳零与
  全部为零 `0秒` ↔ 边界「时钟偏差」；浮层隐藏即清 `setInterval` ↔ 边界「计时启停」；
  远程条目不下钻 ↔ FR-004 与跨工作区「不能继续派生」；失联归零同清两个清单 ↔
  spec 未单列 AC 的一致性处理（属 FR-001 / FR-003 的「同源同发」推论，已在
  `bootstrapCore.ts` 注释点名
  [principles.md 第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。追溯矩阵五个落点均已打开确认覆盖
  所声称内容；影响基线七行逐条核对，`contracts.md` / `events.md` 两行维持「不涉及」
  （无新增事件、成员语义单点在 session-runtime.md）。
