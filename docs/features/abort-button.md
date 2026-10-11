---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：abort 按钮

本规格界定 abort（终止）按钮的状态判定与两阶段中止语义：会话运行态如何映射为按钮的
颜色与可用性，以及一次点击中止哪些工作。范围只覆盖「按钮状态」与「中止范围」两件事；
流水灯、托盘状态点读同一份 core 事实但表现不同，不在本规格内。

交叉引用：`sessionRuntime` 深潜见 [docs/core/session-runtime.md](../core/session-runtime.md)；
webview 侧投影见 [docs/hosts/webview-ui.md 第 8 节](../hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定)；
「core 描述事实，UI 决定表现」见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)、
「派生字段从根字段推导」见 [principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)；
配置归 UI 见 [core-ui-separation.md](../architecture/core-ui-separation.md)。

## 1. 用户场景与验收标准

- 场景 1：运行中终止前台
  - **AC-1**（FR-001）：GIVEN 会话 `queryRunning` 或 `compacting` 为真 WHEN 渲染按钮 THEN 红色且可点
  - **AC-2**（FR-002）：GIVEN 前台有工作 WHEN 点击 abort THEN 只中止前台，该会话的后台 Bash 任务与子代理保持运行
- 场景 2：收尾中收尾后台
  - **AC-3**（FR-001）：GIVEN 前台无工作且仍有后台 Bash 任务或非 idle 子代理 WHEN 渲染按钮 THEN 黄色且可点
  - **AC-4**（FR-002）：GIVEN 前台空闲 WHEN 点击 abort THEN 后台 Bash 任务全部终止（结果不再通知 LLM）、已登记子代理递归中止
- 场景 3：空闲
  - **AC-5**（FR-001）：GIVEN 全部运行时来源为假 WHEN 渲染按钮 THEN 灰色且不可点，点击无操作（幂等）
- 场景 4：事实与表现分离
  - **AC-6**（FR-003）：GIVEN 同一份根事实快照 WHEN 调 `resolveAbortButtonState` THEN 三态结果唯一，且该纯函数只有一份实现
  - **AC-7**（FR-003）：GIVEN 用户点击 abort WHEN webview 上行消息 THEN 载荷只有 `sessionId`，UI 不携带中止范围字段

## 2. 功能需求

### FR-001：三态判定

abort 按钮常驻输入区。它的可用性与颜色由**当前会话**的运行时事实决定：

| 状态 | 判据 | 颜色 | 可点 |
| --- | --- | --- | --- |
| 运行中 | 前台有工作：查询在跑或正在压缩 | 红色 | 是 |
| 收尾中 | 前台无工作，但仍有后台 Bash 任务或非 idle 子代理 | 黄色 | 是 |
| 空闲 | 前台无工作，且无后台任务、无子代理 | 灰色 | 否 |

- 「前台工作」＝ `sessionRuntime` 的 `query` 或 `compacting` 来源为真。压缩会整体替换
  消息数组，与查询同属前台工作，因此同样计入「运行中」。
- 「后台任务」＝ 该会话有运行中的后台 Bash 任务（`background` 来源）。
- 「子代理」＝ 该会话已登记的子代理中存在非 idle 者；判定递归到子代理自身的查询 /
  压缩 / 后台任务 / 下层子代理（与 `idle` 的递归口径一致）。

### FR-002：两阶段中止

点击 abort 后，宿主向 core 发 `abort` 消息（携带会话 ID），core 翻译为
`UiEvent.abortRequested`。**中止范围由 core 依据该会话的运行时事实决定**，UI 只表达
「用户点了 abort」这一事实，不指定范围：

1. **前台有工作**（`query` 或 `compacting`）→ 只中止前台：
   - 置该会话的中止标记，使正在消费的查询与后续新建的 LLM 请求立即失效；
   - 丢弃尚未消费的排队用户消息、后台任务完成通知与过期 reminder；
   - 中止当前活动的 LLM 请求。
   - 该会话的后台 Bash 任务与子代理**保持运行**。
2. **前台无工作，但仍有后台 Bash 任务或子代理** → 中止它们：
   - 该会话的后台 Bash 任务全部终止，被中止任务的结果不再通知 LLM；
   - 已登记子代理递归中止：每个子代理的前台查询、后台任务与下层子代理一并停止。
3. **都为空** → 不做任何事（幂等）。

两阶段都幂等：重复点击不会误伤已经结束的工作。前台工作自然结束（LLM 返回或用户
中止）而仍有后台任务或子代理时，`sessionRuntimeChanged` 快照描述为
`idle=false`、`queryRunning=false`、`backgroundRunning=true` 等，按钮随之为黄色。

### FR-003：事实与表现的边界

- 事实 owner 是 core `sessionRuntime`（[docs/core/session-runtime.md](../core/session-runtime.md)）：按来源分列
  `query` / `waiting` / `compacting` / `background` / `subagent`，变化时推**全量**
  `sessionRuntimeChanged` 快照。
- 快照只暴露**根事实**：`sessionId` / `idle` / `waiting` / `queryRunning` /
  `compacting` / `backgroundRunning` / `subAgentRunning`。颜色是表现，不进契约。
- 按钮状态由纯函数 `resolveAbortButtonState`（`src/host/abortButtonState.ts`）从根事实
  推导，只有一份实现，webview 与测试共用它（[principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。
- 中止范围的判定在 core（`Integration.abortCurrentQuery`），不在 UI：UI 不发送范围
  字段，避免「按钮颜色」与「实际中止范围」各写一份判据而分叉。

## 3. 行为规格

### 3.1 数据流

```
core sessionRuntime ──sessionRuntimeChanged（全量根事实）──▶ 宿主 ConversationManager
        ▲                                                          │
        │ UiEvent.abortRequested                                   │ sessionRuntimeStates
        │                                                          ▼
   Integration.abortCurrentQuery ◀── abort 消息 ── webview InputArea（三态按钮）
```

- 上行：`abort` 消息只有 `sessionId`（[events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)）。
- 下行：`sessionRuntimeStates` 携带全量 `SessionRuntimeState` 快照
  （[contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)）。
- core 的中止范围判定读 `sessionRuntime` 的同一份事实；两处判据同源，因此按钮显示
  「收尾中」时点击必定命中后台任务 / 子代理阶段。

## 4. 边界与错误路径

- **重复点击**：两阶段判定幂等（FR-002），不会误伤已结束的工作。
- **会话关闭 / 删除不走两阶段**：清理路径调 `Integration.abortSessionTree`，一次停掉
  整棵工作树（前台查询 + 后台任务 + 递归子代理），因为目标是不留下任何在跑的工作。
- **前台自然结束而后台仍在**：`sessionRuntimeChanged` 快照呈现 `idle=false`、
  `queryRunning=false`、`backgroundRunning=true`，按钮转黄（FR-001 判据的组合结果）。
- **假宿主注入异常快照**：e2e 以假宿主注入 `sessionRuntimeStates` 驱动按钮颜色与可点性，
  缺字段即按缺省根事实判定（webview 不猜值，[principles.md 第 10 节](../architecture/principles.md#10-webview-不持有事实的默认值)）。

## 5. 非目标

- 流水灯、托盘状态点读同一份 core 事实但表现不同，不在本规格内。
- 后台任务的提醒调度（兜底 / 周期）见 [background-bash.md](background-bash.md)。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-2（中止进行中的回复）/ US-3（消息排队）；
无新增 US。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/abortButtonState.ts` 的 `resolveAbortButtonState` | `src/test/abortButtonState.test.ts`；e2e `e2e/webview/conversation.spec.ts`（三态） | 自动 |
| FR-002 | `Integration.abortCurrentQuery`（`src/core/Integration.ts`） | `src/test/abortPhaseParity.test.ts`；Rust 对应 `core-rs/src/engine_tests.rs`；整应用 e2e `e2e/electron/assistant.spec.ts`（两阶段中止、网关不回响应头时中止） | 自动 |
| FR-003 | `UiEvent.abortRequested` 载荷（`src/core/AssistantEventBus.ts`） | `src/test/sessionRuntime.test.ts`（快照根事实） | 自动 |
