---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：abort 按钮

本规格界定 abort（终止）按钮的状态判定与中止范围：会话运行态如何映射为按钮的
颜色与可用性，以及一次点击中止哪些工作。范围只覆盖「按钮状态」与「中止范围」两件事；
流水灯、托盘状态点读同一份 core 事实但表现不同，不在本规格内。

交叉引用：`sessionRuntime` 深潜见 [docs/core/session-runtime.md](../core/session-runtime.md)；
webview 侧投影见 [docs/hosts/webview-ui.md 第 8 节](../hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定)；
「core 描述事实，UI 决定表现」见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)、
「派生字段从根字段推导」见 [principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)；
配置归 UI 见 [core-ui-separation.md](../architecture/core-ui-separation.md)。

## 1. 用户场景与验收标准

- 场景 1：运行中终止前台
  - **AC-1**（FR-001）：GIVEN 会话非 spin 且 `queryRunning` 或 `compacting` 为真 WHEN 渲染按钮 THEN 红色且可点
  - **AC-2**（FR-002）：GIVEN 前台有工作 WHEN 点击 abort THEN 只中止前台，该会话的后台 Bash 任务与子代理保持运行
- 场景 2：收尾中收尾后台
  - **AC-3**（FR-001）：GIVEN 前台无工作且仍有后台 Bash 任务或非 idle 子代理 WHEN 渲染按钮 THEN 黄色且可点
  - **AC-4**（FR-002）：GIVEN 前台空闲 WHEN 点击 abort THEN 后台 Bash 任务全部终止（结果不再通知 LLM）、已登记子代理递归中止
- 场景 3：spin 模式
  - **AC-5**（FR-001）：GIVEN 会话工作模式为 spin WHEN 渲染按钮 THEN 黄色且可点（即使 `queryRunning` 为真也不显示红色）
  - **AC-6**（FR-002）：GIVEN spin 运行中且有运行中的子代理 WHEN 点击 abort THEN 子代理递归中止，SpinLoop 在下一个检查点停下，会话保持 spin
  - **AC-7**（FR-002）：GIVEN 恢复态 spin（没有运行中的 SpinLoop）WHEN 点击 abort THEN 不做任何事（spin 单向，不退出、输入框保持禁用）
- 场景 4：空闲
  - **AC-8**（FR-001）：GIVEN 全部运行时来源为假 WHEN 渲染按钮 THEN 灰色且不可点，点击无操作（幂等）
- 场景 5：事实与表现分离
  - **AC-9**（FR-003）：GIVEN 同一份根事实快照 WHEN 调 `resolveAbortButtonState` THEN 三态结果唯一，且该纯函数只有一份实现
  - **AC-10**（FR-003）：GIVEN 用户点击 abort WHEN webview 上行消息 THEN 载荷只有 `sessionId`，UI 不携带中止范围字段
- 场景 6：黄色态悬停运行明细（specs/019，US-52）
  - **AC-11**（FR-004）：GIVEN 黄色态且有运行中的后台任务 / 子代理 WHEN 悬停按钮满 1 秒 THEN 只读浮层逐项列出任务（描述，与命令不同时附命令）与子代理（创建时描述，递归含下层非空闲者）
  - **AC-12**（FR-004）：GIVEN 悬停未满 1 秒即移出 WHEN 计时到期 THEN 浮层不出现；GIVEN 浮层已显示 WHEN 指针移出或离开黄色态 THEN 浮层立即隐藏
  - **AC-13**（FR-004）：GIVEN 红色 / 灰色态或恢复态 spin（两组明细皆空） WHEN 悬停超过 1 秒 THEN 无浮层
  - **AC-14**（FR-004）：GIVEN 浮层显示中 WHEN 点击浮层条目 THEN 不产生任何上行消息；GIVEN 快照更新到达 THEN 浮层内容跟随刷新、两组皆空即关闭

## 2. 功能需求

### FR-001：三态判定

abort 按钮常驻输入区。它的可用性与颜色由**当前会话**的运行时事实决定：

| 状态 | 判据 | 颜色 | 可点 |
| --- | --- | --- | --- |
| 运行中 | 前台有工作：查询在跑或正在压缩（spin 模式除外） | 红色 | 是 |
| 收尾中 | 处于 spin 模式，或前台无工作但仍有后台 Bash 任务或非 idle 子代理 | 黄色 | 是 |
| 空闲 | 前台无工作，且无后台任务、无子代理 | 灰色 | 否 |

- 「前台工作」＝ `sessionRuntime` 的 `query` 或 `compacting` 来源为真。压缩会整体替换
  消息数组，与查询同属前台工作，因此同样计入「运行中」。
- 「spin 模式」＝ 会话工作模式为 `spin`（`workMode` 事实单独注入
  `resolveAbortButtonState`，runtime 快照不携带），判定**优先于** `queryRunning`。
  spin 期间父会话的消费循环被 SpinLoop 占用，快照里的 `queryRunning` 为真，但跑的
  不是 query engine——按钮因此归入黄色档：它只用于中止 spin 的子代理，不表达
  「中止查询」。spin 是**单向**模式：循环结束（完成 / 中止 / 失败）与应用重启后从
  `meta.json` 恢复出的 spin 会话都保持黄色，点击不退出 spin（空闲时为空操作）。
- 「后台任务」＝ 该会话有运行中的后台 Bash 任务（`background` 来源）。
- 「子代理」＝ 该会话已登记的子代理中存在非 idle 者；判定递归到子代理自身的查询 /
  压缩 / 后台任务 / 下层子代理（与 `idle` 的递归口径一致）。

### FR-002：中止范围

点击 abort 后，宿主向 core 发 `abort` 消息（携带会话 ID），core 翻译为
`UiEvent.abortRequested`。**中止范围由 core 依据该会话的运行时事实决定**，UI 只表达
「用户点了 abort」这一事实，不指定范围：

1. **spin 模式**（父会话没有 query engine）→ 中止运行中的子代理：
   - 已登记子代理递归中止：每个子代理的前台查询、后台任务与下层子代理一并停止；
   - 该会话的后台 Bash 任务同样终止；
   - 该会话的 `cancel` 一并置位，SpinLoop 在下一个检查点停下；`workMode` 保持
     `spin`（单向模式，不写回 `normal`、不广播退出事件）；
   - 恢复态 spin（没有运行中的 SpinLoop 且完全空闲）不做任何事（幂等）。
2. **前台有工作**（`query` 或 `compacting`）→ 只中止前台：
   - 置该会话的中止标记，使正在消费的查询与后续新建的 LLM 请求立即失效；
   - 丢弃尚未消费的排队用户消息、后台任务完成通知与过期 reminder；
   - 中止当前活动的 LLM 请求。
   - 该会话的后台 Bash 任务与子代理**保持运行**。
3. **前台无工作，但仍有后台 Bash 任务或子代理** → 中止它们：
   - 该会话的后台 Bash 任务全部终止，被中止任务的结果不再通知 LLM；
   - 已登记子代理递归中止：每个子代理的前台查询、后台任务与下层子代理一并停止；
   - **跨工作区子代理**（[cross-workspace-agent.md](cross-workspace-agent.md) FR-006）不在本进程：
     发 `CoreEvent.crossWorkspaceAgentAbortRequested` 由宿主转发到目标工作区 Core；
     目标不可达时按已结束收敛，不永久停在黄色态。
4. **都为空** → 不做任何事（幂等）。

常规会话的两阶段都幂等：重复点击不会误伤已经结束的工作。前台工作自然结束（LLM 返回或用户
中止）而仍有后台任务或子代理时，`sessionRuntimeChanged` 快照描述为
`idle=false`、`queryRunning=false`、`backgroundRunning=true` 等，按钮随之为黄色。

排队中的 `Agent` 调用（并发槽位等待，specs/005 的
[US-49](user-stories/dialog-core.md#us-49-子代理并发上限)）属**前台查询的一部分**：前台阶段中止
使所有排队调用取消（工具结果为取消文案，且不创建子代理会话），已运行的子代理照常
保持运行——排队者不参与后台阶段「子代理仍在跑」的黄灯判据（它们从未创建会话，
不影响 `sessionRuntime` 的子代理事实）。

### FR-003：事实与表现的边界

- 事实 owner 是 Core 进程的运行时状态表（[docs/core/session-runtime.md](../core/session-runtime.md)）：按来源分列
  `query` / `waiting` / `compacting` / `background` / `subagent`，变化时推**全量**
  `sessionRuntimeChanged` 快照。
- 快照暴露**根事实**：`sessionId` / `idle` / `waiting` / `queryRunning` /
  `compacting` / `backgroundRunning` / `subAgentRunning`（含跨工作区子代理：结束事件到达前
  一律算运行中），以及悬停明细成员
  `backgroundTasks`（运行中后台任务清单）与 `subAgentDescription`（子代理创建时描述，
  specs/019——语义见 [session-runtime.md 第 2 节](../core/session-runtime.md#2-对外快照)）。
  颜色是表现，不进契约。
- 按钮状态由纯函数 `resolveAbortButtonState`（`src/host/abortButtonState.ts`）从根事实
  推导，只有一份实现，webview 与测试共用它（[principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。
- 悬停明细的子代理清单由唯一纯函数 `collectRunningSubAgents`
  （`src/shared/sessionRuntime.ts`）按 `parentSessionId` 从全量快照纯派生，webview 与
  测试共用（specs/019 FR-001）。
- 中止范围的判定在 Core（`Core::on_abort`），不在 UI：UI 不发送范围
  字段，避免「按钮颜色」与「实际中止范围」各写一份判据而分叉。

### FR-004：黄色态悬停运行明细（specs/019）

- 仅黄色态（`background`，含 spin）响应悬停：指针进入按钮持续满 1 秒显示只读浮层；
  未满 1 秒移出取消，显示中移出立即隐藏，离开黄色态或切换会话一并隐藏。
- 浮层两组：「后台任务」逐项显示 `backgroundTasks` 的 description（`command` 与
  description 不同时附命令）；「子代理」按 `collectRunningSubAgents` 的聚合口径逐项
  显示 description，为 `null` 显示回退文案。两组皆空（恢复态 spin）不显示浮层。
- 浮层只读：`pointer-events` 穿透，点击不产生任何上行；显示期间随快照刷新，
  两组皆空即关闭。黄色态不设 native `title`（浮层取代），红 / 灰维持「终止」文案。
- 明细事实的推送语义：清单 / description 参与快照 diff，布尔位不变也触发推送
  （[session-runtime.md 第 2 节](../core/session-runtime.md#2-对外快照)）。

## 3. 行为规格

### 3.1 数据流

```
Core 运行时状态表 ──sessionRuntimeChanged（全量根事实 + 悬停明细）──▶ 宿主 ConversationManager
        ▲                                                          │
        │ UiEvent.abortRequested                                   │ sessionRuntimeStates
        │                                                          ▼
   Core::on_abort ◀── abort 消息 ── webview InputArea（三态按钮 + 黄色态悬停明细浮层）
```

- 上行：`abort` 消息只有 `sessionId`（[events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)）。
- 下行：`sessionRuntimeStates` 携带全量 `SessionRuntimeState` 快照
  （[contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)），
  含悬停明细成员（FR-004）；浮层是快照的只读投影，不产生额外上行。
- core 的中止范围判定读 Core 运行时状态的同一份事实；两处判据同源，因此按钮显示
  「收尾中」时点击必定命中后台任务 / 子代理阶段；显示 spin 的黄色时点击命中
  子代理 / 后台任务范围，空闲的恢复态 spin 则为空操作。

## 4. 边界与错误路径

- **重复点击**：常规会话的两阶段判定与 spin 的子代理范围都幂等（FR-002），不会误伤已结束的工作。
- **空闲 spin 点击**：spin 单向，循环结束 / 重启恢复后点击 abort 为空操作，输入框保持禁用。
- **会话关闭 / 删除不走 abort 范围**：清理路径调 `Core::abort_session_scope`，一次停掉
  整棵工作树（前台查询 + 后台任务 + 递归子代理），因为目标是不留下任何在跑的工作。
- **前台自然结束而后台仍在**：`sessionRuntimeChanged` 快照呈现 `idle=false`、
  `queryRunning=false`、`backgroundRunning=true`，按钮转黄（FR-001 判据的组合结果）。
- **假宿主注入异常快照**：e2e 以假宿主注入 `sessionRuntimeStates` 驱动按钮颜色与可点性，
  缺字段即按缺省根事实判定（webview 不猜值，[principles.md 第 10 节](../architecture/principles.md#10-webview-不持有事实的默认值)）。

## 5. 非目标

- 流水灯、托盘状态点读同一份 core 事实但表现不同，不在本规格内。
- 后台任务的提醒调度（兜底 / 周期）见 [background-bash.md](background-bash.md)。
- 悬停浮层内逐项中止单个任务 / 子代理——abort 保持整体范围语义（specs/019 明确不做）；
  任务的 pid / 已运行时长 / 输出预览不进契约或浮层。

## 6. 对需求基线的影响

关联既有 US-2（中止进行中的回复，[dialog-core.md](user-stories/dialog-core.md#us-2-中止进行中的回复)）/
US-3（消息排队，[dialog-core.md](user-stories/dialog-core.md#us-3-消息排队)）/
US-39（Spin 设计器，[desktop.md](user-stories/desktop.md#us-39-spin-设计器)）；
US-52（黄灯悬停预览后台任务与子代理，
[user-stories/dialog-core.md](user-stories/dialog-core.md#us-52-abort-黄灯悬停预览后台任务与子代理)）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/abortButtonState.ts` 的 `resolveAbortButtonState` | `src/test/abortButtonState.test.ts`（三态 + spin 黄色）；e2e `e2e/webview/conversation.spec.ts`（三态） | 自动 |
| FR-002 | `Core::on_abort`（`core-rs/src/engine.rs`，spin 子代理范围 + 两阶段判定） | `core-rs/src/engine_tests.rs` 的 `abort_request_stops_foreground_before_background` / `abort_during_running_spin_aborts_sub_agents` / `abort_does_not_exit_restored_spin_mode_of_idle_session`；整应用 e2e `e2e/electron/assistant.spec.ts`（两阶段中止、网关不回响应头时中止） | 自动 |
| FR-003 | `UiEvent.abortRequested` 载荷（`src/shared/AssistantEventBus.ts`） | `src/test/sessionBusyLevel.test.ts`（快照根事实的宿主派生） | 自动 |
| FR-004 | `src/webview/InputArea.tsx` 悬停浮层 + `App.tsx` 明细推导 + 快照成员 `backgroundTasks` / `subAgentDescription`（`src/shared/AssistantEventBus.ts`、`core-rs/src/engine.rs` 的 `emit_runtime`） | `core-rs/src/engine_tests.rs` 的 `runtime_snapshot_*` 三用例；`src/test/sessionBusyLevel.test.ts`（`collectRunningSubAgents`）；e2e `e2e/webview/conversation.spec.ts`（US-52 悬停用例） | 自动 |
