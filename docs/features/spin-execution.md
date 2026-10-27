---
owner: pzlvv
last_reviewed: 2026-10-27
---

# 规格：Spin 模式执行循环（SpinLoop）

本规格界定 Spin 模式执行循环中「一个节点的一轮执行如何收尾、成功与失败如何判定、失败如何
重试」：子对话的完成信号只有「`Reply` 投递」与「子对话收尾（Idle）」两个，无 `Reply` 的
收尾按无 `Reply` 失败处理——直接判失败并重试，且不占用验收失败的重试上限。执行循环的其余
环节（节点选取、拓扑序、rollout 迭代、变量替换、prompt 组装、验收评审的 LLM 解析）不在本
规格内，实现见 `core-rs/src/spin.rs` 与宿主回调边界 `core-rs/src/spin_host.rs`；spin 的进入
与单向语义见 [desktop.md US-39](user-stories/desktop.md#us-39-spin-设计器)，`Reply` 的投递
路径与只响应一次语义见 [user-message-pipeline.md FR-007](user-message-pipeline.md#fr-007spin-模式下的用户输入与-reply-投递)，
父会话 abort 的中止范围见 [abort-button.md FR-002](abort-button.md#fr-002中止范围)。

## 1. 用户场景与验收标准

- 场景 1：节点一轮正常完成
  - **AC-1**（FR-001）：GIVEN 子对话在收尾前投递 `Reply` WHEN SpinLoop 的等待结束 THEN 以 `Reply` 内容走验收判定（有验收条件）或直接通过（无验收条件）
- 场景 2：子对话无 `Reply` 收尾
  - **AC-2**（FR-001）：GIVEN 子对话未投递 `Reply` 即收尾（用户中止该子对话 / 子对话 LLM 请求异常 / Reminder 催办耗尽仍未调用 `Reply`）WHEN SpinLoop 的等待结束 THEN 该轮按无 `Reply` 失败结束，不无限等待
  - **AC-3**（FR-002）：GIVEN 无验收条件的节点 WHEN 第一轮发生无 `Reply` 失败 THEN 该轮不判通过、立即重试，重试轮 `Reply` 到达后节点通过（子代理共调用两次）
  - **AC-4**（FR-002）：GIVEN 验收失败上限为 1 的节点 WHEN 先发生一次无 `Reply` 失败、再发生一次验收失败 THEN 只有验收失败计入上限（共两次子代理调用后循环以 Stopped 收尾）
- 场景 3：中止
  - **AC-5**（FR-002）：GIVEN 父会话 abort WHEN SpinLoop 到达检查点 THEN 以 `Aborted` 收尾且不重试（[abort-button.md](abort-button.md) AC-6 的 spin 语义，不是无 `Reply` 失败）

## 2. 功能需求

### FR-001：子对话完成判定

SpinLoop 为节点的一轮执行经 Agent 工具起一个子对话（Master 角色），并阻塞等待该轮结束。
等待的结束信号只有两个：

- **`Reply` 投递**：子对话经 Reply 工具把执行反馈投递回父会话（[user-message-pipeline.md FR-007](user-message-pipeline.md#fr-007spin-模式下的用户输入与-reply-投递)）。
  SpinLoop 立刻拿到反馈，进入 FR-002 的验收判定；这是正常路径。
- **子对话收尾**：引擎的子代理后台驱动结束（不再跑消费循环、不再注入 Reminder），且该子
  对话自身的运行时来源全空（进入 Idle）。此后 `Reply` 不可能再到达（同一子对话只响应一次），
  SpinLoop 不再等待，按 FR-002 的无 `Reply` 失败处理。

两个事实都由 Core 持有：驱动收尾由子代理后台驱动在退出前写入会话状态，Idle 读
`SessionState` 自身的运行时来源（不含下层子代理——驱动已收尾的子对话不会再生出影响本轮
判定的 `Reply`）。用户中止整个 spin（父会话 abort）不是完成信号：SpinLoop 在检查点以
`Aborted` 收尾，见 [abort-button.md FR-002](abort-button.md#fr-002中止范围)。

### FR-002：失败分类与重试

一轮执行只有两类失败，重试语义互相独立：

- **验收失败**：有验收条件、`Reply` 已到达、LLM 评审不通过。`Reply` 内容写入节点 note 作
  为下一轮的反馈，重试并计入该节点的连续验收失败上限（`MAX_ATTEMPTS`，`core-rs/src/spin.rs`）；
  连续验收失败达到上限，整个 spin 以 `Stopped` 收尾。没有验收条件的节点不发生验收失败
  （`Reply` 即通过）。
- **无 `Reply` 失败**：子对话按 FR-001 收尾但没有 `Reply`——用户中止了该子对话、子对话的
  LLM 请求异常、或 Reminder 催办耗尽仍未调用 Reply 工具（Agent 工具未能起会话同属此类）。
  该轮**直接判定失败**：不进入验收判定、不写节点 note、立即重试。这类失败与验收无关，
  **不占用**验收失败上限；没有验收条件的节点同样重试。它也没有独立上限（持续故障时由用户
  abort 兜底，见第 4 节）。

## 3. 行为规格

### 3.1 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 子对话 | SpinLoop 经 Agent 工具起的子代理会话（Master 角色，登记在父会话的 spin 子代理表） | Core |
| `Reply` | 子对话经 Reply 工具投递回父会话的执行反馈 | `Core::deliver_agent_reply` |
| 驱动收尾 | 引擎子代理后台驱动退出（消费循环不再运行、Reminder 不再注入） | `engine.rs` 的子代理后台驱动 |
| Idle | 子对话自身 `query` / `waiting` / `compacting` / `background` 全空且无排队用户消息 | `SessionState` 的自身 idle 判定 |

### 3.2 判定与重试时序

一轮节点执行的收尾判定按序读两个信号：等待循环先取 `Reply` 通道（`Reply` 到达即本轮执行
结束，进入验收判定），通道超时后检查「驱动收尾 + Idle」——两者同时成立（或子对话已不存在）
即本轮以无 `Reply` 失败结束。无 `Reply` 失败不写节点 meta、不进验收判定，发一条进度消息后
重试本轮；验收失败写入 note 并计一次上限。重试都重新起一个新子对话（新会话 id），上一轮的
登记、`Reply` 通道与监听一并清理。

## 4. 边界与错误路径

- **父会话 abort**：中止范围见 [abort-button.md FR-002](abort-button.md#fr-002中止范围)——
  子对话递归中止、父会话 `cancel` 置位，SpinLoop 在检查点以 `Aborted` 收尾，不重试。
- **迟到 `Reply`**：无 `Reply` 失败判定后到达的 `Reply` 按 spin 语义只落 silent 上下文
  （[user-message-pipeline.md FR-007](user-message-pipeline.md#fr-007spin-模式下的用户输入与-reply-投递)），
  不改写已判定的失败，也不触发新一轮判定。
- **子对话被删除**：会话状态已释放时按收尾处理（无 `Reply` 失败），不等待。
- **无上限重试**：无 `Reply` 失败的重试不计任何上限是有意设计——它与验收无关，持续故障
  （如 LLM 服务不可用）时每轮都会失败并重试，退出手段是 abort 整个 spin；进度消息每轮
  落盘，用户能看到重试在发生。
- **`Reply` 与收尾的先后**：`Reply` 投递先于驱动收尾（投递成功后引擎才静默中止子对话），
  等待循环先读 `Reply` 通道再查收尾事实，两者不会颠倒。

## 5. 非目标

- 节点选取、拓扑序、rollout 迭代、For Each 变量替换与 prompt 组装（`core-rs/src/spin.rs` 现状，未单独立规）。
- 验收评审的 LLM 解析与 provider 选择（`judge_with_provider`）。
- spin 设计器的数据面与写锁（[contracts.md 第 2 节](../architecture/contracts.md#2-spin-设计器契约spindesign)）。
- 子代理并发槽位（[dialog-core.md US-49](user-stories/dialog-core.md#us-49-子代理并发上限)）。

## 6. 对需求基线的影响

- [desktop.md US-39](user-stories/desktop.md#us-39-spin-设计器)：AC-4 的「`Reply` 只用于
  节点结果更新与验收判定」补充失败面语义——无 `Reply` 收尾不再无限等待，而是判失败并重试。
- [user-message-pipeline.md FR-007](user-message-pipeline.md#fr-007spin-模式下的用户输入与-reply-投递)：
  `Reply` 投递路径不变；完成判定与重试语义收拢到本规格。
- 不新增事件、契约成员与落盘字段。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `CoreSpinHost::run_sub_agent` 等待循环（`core-rs/src/spin_host.rs`）＋会话状态上的子代理驱动收尾标记（`core-rs/src/engine.rs`） | `core-rs/src/spin_host_tests.rs` 的 `spin_run_retries_when_sub_agent_ends_without_reply` | 自动 |
| FR-002 | `SpinLoop::run` 的无 `Reply` 失败分支（`core-rs/src/spin.rs`） | `core-rs/src/spin_tests.rs` 的 `spin_loop_retries_without_reply_failure_without_counting_attempts` / `spin_loop_stops_only_on_acceptance_failures` | 自动 |
