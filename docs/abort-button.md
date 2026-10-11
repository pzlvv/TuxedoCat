---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：abort 按钮

本规格界定 abort（终止）按钮的状态判定与两阶段中止语义：会话运行态如何映射为按钮的
颜色与可用性，以及一次点击中止哪些工作。范围只覆盖「按钮状态」与「中止范围」两件事；
流水灯、托盘状态点读同一份 core 事实但表现不同，不在本规格内。

相关规格与章节：

- [DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)（sessionRuntimeChanged 的生产者：sessionRuntime）
- [docs/webview-ui.md 第 8 节](webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定)（abort 按钮：读 core 的 sessionRuntime，不由这里判定）
- [DEVELOPMENT.md 第 5.6 节](../DEVELOPMENT.md#56-core-描述事实ui-决定表现)（core 描述事实，UI 决定表现）
- [DEVELOPMENT.md 第 5.8 节](../DEVELOPMENT.md#58-契约只写现状派生字段从根字段推导)（契约只写现状，派生字段从根字段推导）
- `docs/core-ui-separation.md`
- `docs/user-stories.md` 的 US-2 / US-3

## 1. 能力

### 1.1 三态

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

### 1.2 两阶段中止

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

会话关闭 / 删除的清理路径不走这条两阶段判定：它调 `Integration.abortSessionTree`，
一次停掉整棵工作树（前台查询 + 后台任务 + 递归子代理），因为目标是不留下任何在跑的工作。

### 1.3 事实与表现的边界

- 事实 owner 是 core `sessionRuntime`（[DEVELOPMENT.md 第 4.5 节](../DEVELOPMENT.md#45-sessionruntimechanged-的生产者sessionruntime)）：按来源分列
  `query` / `waiting` / `compacting` / `background` / `subagent`，变化时推**全量**
  `sessionRuntimeChanged` 快照。
- 快照只暴露**根事实**：`sessionId` / `idle` / `waiting` / `queryRunning` /
  `compacting` / `backgroundRunning` / `subAgentRunning`。颜色是表现，不进契约。
- 按钮状态由纯函数 `resolveAbortButtonState`（`src/host/abortButtonState.ts`）从根事实
  推导，只有一份实现，webview 与测试共用它（[DEVELOPMENT.md 第 5.8 节](../DEVELOPMENT.md#58-契约只写现状派生字段从根字段推导)）。
- 中止范围的判定在 core（`Integration.abortCurrentQuery`），不在 UI：UI 不发送范围
  字段，避免「按钮颜色」与「实际中止范围」各写一份判据而分叉。

## 2. 数据流

```
core sessionRuntime ──sessionRuntimeChanged（全量根事实）──▶ 宿主 ConversationManager
        ▲                                                          │
        │ UiEvent.abortRequested                                   │ sessionRuntimeStates
        │                                                          ▼
   Integration.abortCurrentQuery ◀── abort 消息 ── webview InputArea（三态按钮）
```

- 上行：`abort` 消息只有 `sessionId`（[DEVELOPMENT.md 第 4.3 节](../DEVELOPMENT.md#43-uieventui--core单向)）。
- 下行：`sessionRuntimeStates` 携带全量 `SessionRuntimeState` 快照
  （[docs/contracts.md 第 4 节](contracts.md#4-对话相关数据conversationmanager)）。
- core 的中止范围判定读 `sessionRuntime` 的同一份事实；两处判据同源，因此按钮显示
  「收尾中」时点击必定命中后台任务 / 子代理阶段。

## 3. 测试

- core 单测：`src/test/sessionRuntime.test.ts`（快照字段）与
  `src/test/abortPhaseParity.test.ts`（两阶段范围），Rust 侧对应用例在
  `core-rs/src/engine_tests.rs`。
- webview 纯函数：`src/test/abortButtonState.test.ts`。
- UI 级 e2e：`e2e/webview/conversation.spec.ts` 的「abort 按钮三态」用例，
  以假宿主注入 `sessionRuntimeStates` 驱动按钮颜色与可点性。
- 整应用 e2e：`e2e/electron/assistant.spec.ts` 的「两阶段中止」用例，经 Standalone
  Core 真实跑一个后台 Bash 任务，验证前台结束后按钮转黄、再次点击才停后台任务；
  同文件的「网关不回响应头时中止」用例以 mock LLM 的 `无响应` 脚本模拟静默挂住的
  网关（不回响应头），验证请求停在等待响应头阶段时点击中止仍立即回到空闲态。
