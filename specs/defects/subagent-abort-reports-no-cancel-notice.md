---
status: 已修
---

# 缺陷：子代理 / 跨会话 Agent 被 abort 后不回报，创建者永远等不到结果

`Agent` 工具的成功结果与系统提示词都向模型承诺「子代理完成后会自己回报」
（`The sub-agent will reply directly when done.`、核心原则里的「子代理会自行报告结果」）。
但子代理被用户 abort 后直接收尾，创建者会话收不到任何消息：它既没有 `Reply`，也没有
「已被取消」的回执，于是创建者的上下文停在「等它回复」，模型可能继续串行等待一个
已经死掉的子代理（跨工作区子代理还会一直占着并发槽位到结束事件到达）。影响面：所有
`Agent` 派发场景（本地子代理、跨工作区子代理），本地子代理在子会话视图点 abort、
在创建者会话黄灯态 abort、以及跨工作区两侧各自 abort 都能触发。

## 现状

- `core-rs/src/engine.rs` 的 `abort_foreground` 只置 `cancel` 与清 `pause_loop`；子代理
  驱动 `run_sub_agent` 在循环顶看到 `cancel` 后 `break`，然后清队、发 `queryEnd`、
  释放槽位（`engine.rs` 的 `run_sub_agent` 收尾段）。全程没有任何「投递回创建者」的动作。
- `abort_session_scope` 对本地子代理递归调用自身，对跨工作区子代理只发
  `crossWorkspaceAgentAbortRequested`（`engine.rs` 的 `abort_session_scope`）；后者经宿主
  变成目标 Core 的 `UiEvent.abortRequested`，目标 Core 同样只置 `cancel`。
- 创建者侧的既有自动消息通道只有两条：`enqueue_agent_message`（子代理 `Reply` 与后台
  Bash 完成通知，空闲时立刻拉起一轮）与失败带外播报（`spawn_sub_agent_queued` 里
  `⚠ Agent queued spawn failed` 的裸 `message` 事件，不落盘、不进上下文）。取消走的是
  第一条通道的反面——什么也不发。
- 复现：任一对话 `Agent` 派发一个长任务子代理 → 打开子代理会话点 abort（或在创建者
  会话黄灯态再点一次 abort）→ 子代理会话出现 `*User Interrupted*`，创建者会话没有任何
  新消息；`Reply` 该子代理则报「目标会话不存在 / 已结束」。
- 与规格的冲突：`core-rs/src/prompt.rs` 的核心原则与 `Agent` 工具说明承诺创建者「等子代理
  自己回报即可」，`core-rs/src/tools.rs` 的成功结果文案也逐字写着 `The sub-agent will reply
  directly when done.`——被取消的子代理不会回，承诺与真实能力不一致；
  [docs/features/abort-button.md FR-002](../../docs/features/abort-button.md#fr-002中止范围)
  只写了「递归中止」，没有写取消之后创建者如何得知。

## 期望

1. 子代理（本地或跨工作区）被用户 abort 后，向创建者会话主动投递一条取消回报，文案说明
   该子代理已被取消、不会再有 `Reply`（英文常量，与其它落盘上下文文本同口径）。
2. 投递口径与 `Reply` 一致：作为 `origin='agent'` 的自动消息进创建者上下文与消息流
   （带 From 头）；创建者空闲时立刻拉起一轮，让模型当场知道不必再等；创建者忙碌时进
   自动消息队列，由下一轮边界消费。
3. 创建者自身也在这次中止范围内（黄灯态 abort 整个工作树）时不拉起新一轮：取消回报只落
   进上下文与消息流，`cancel` 保持置位、`running` 保持假——中止不许被自身的回报复活。
4. 跨工作区子代理沿用既有 `CoreEvent.crossWorkspaceAgentReplyRequested` → 宿主 →
   `UiEvent.agentReplyReceived` 回投通道，由运行子代理的那一侧 Core 发出：发起方 abort
   （宿主转发中止）与目标工作区侧 abort 都覆盖，不新增事件与载荷字段。
5. 幂等：同一子代理只回报一次；已经 `Reply` 过（`sub_agent_reply_called`）或驱动已收尾
   （`sub_agent_driver_done`）的子代理不再回报——它们有各自的结束路径，取消回报只是噪声。
6. 会话关闭 / 删除 / 静默中止（spin 子代理首次 `Reply` 后停自身）不是「用户取消」，
   不发取消回报；spin 模式下的创建者不收自动消息（既有 FR-007 语义）。

## 不变量

- 中止范围不变：两阶段判定、spin 单向、跨工作区子代理经宿主转发、目标不可达按已结束
  收敛，全部沿用 [docs/features/abort-button.md FR-002](../../docs/features/abort-button.md#fr-002中止范围)。
- 事件词汇表与载荷不变：不新增事件、不给 `crossWorkspaceAgentReplyRequested` /
  `agentReplyReceived` 加字段，取消回报复用既有 `content`。
- `Reply` 的投递路径与语义不变（`deliver_agent_reply`、spin 首条 Reply 只响应一次、
  静默中止自身）。
- 并发槽位仍由子代理收尾释放（`run_sub_agent` 唯一退出点），取消回报不参与槽位。
- 非用户创建会话的输入关闭口径（`docs/features/user-message-pipeline.md` FR-008）不变：
  取消回报是创建者会话的自动消息，不打开子代理的输入。
- 消费者只读 `sessionRuntimeChanged`：取消回报不新增运行时字段，`idle` /
  `subAgentRunning` 仍由既有根事实推导。
- 落盘格式不变：取消回报是一条既有形态的 user 消息（`origin=agent` + `_meta` From 头）。

## 回归测试

- **RT-1**：本地子代理在子会话视图被 abort（创建者忙碌）→ 创建者的自动消息队列新增一条
  `origin='agent'`、`from_session_id` 为子代理 id、文案含「canceled」的消息；重复 abort 不
  重复投递。（落点：`core-rs/src/engine_tests.rs` 的
  `aborted_sub_agent_reports_cancel_notice_to_its_creator`）
- **RT-2**：创建者黄灯态 abort 整棵树（创建者 + 运行中的本地子代理）→ 取消回报落进创建者
  上下文与消息流（`origin=agent`、非 `silent`）、上报 UI，但创建者 `cancel` 仍置位、
  `running` 仍为假、自动消息队列为空——不复活刚被中止的会话。（落点：
  `core-rs/src/engine_tests.rs` 的
  `whole_tree_abort_reports_cancel_without_resurrecting_the_creator`）
- **RT-3**：目标工作区的跨工作区子代理被 abort（creator 为 agent 形态且 `workspaceId` 有值）
  → 发 `crossWorkspaceAgentReplyRequested`，`sessionId` 为发起方会话、
  `fromSessionId` 为子代理 id、`content` 含「canceled」。（落点：
  `core-rs/src/engine_tests.rs` 的
  `aborted_cross_workspace_sub_agent_reports_cancel_to_the_origin_workspace`）
- **RT-4**：发起方刚被中止时收到另一工作区的取消回报（`agentReplyReceived` →
  `on_agent_reply_received`）→ 回报落进发起方上下文与消息流，但 `cancel` 保持置位、
  `running` 为假、自动消息队列为空。（落点：`core-rs/src/engine_tests.rs` 的
  `cancel_notice_from_another_workspace_does_not_restart_an_aborted_creator`）
- **RT-5**：已调用过 `Reply` / 驱动已收尾的子代理被 abort 时不回报取消（创建者既无排队
  自动消息也无取消消息）。（落点：`core-rs/src/engine_tests.rs` 的
  `finished_sub_agent_does_not_report_cancel`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core -- cancel_notice aborted_sub_agent aborted_cross_workspace whole_tree_abort` | 红 | 4 失败 / 0 通过（RT-5 是修复段的补充用例，在修复前同样取不到回报），四条各自失败在本条要锁的断言上：RT-1「取消回报只投一次 left: 0 right: 1」、RT-2「上下文应有一条取消回报：[]（left: 0 right: 1）」、RT-3「跨工作区取消回报事件」（`expect` 取不到 `crossWorkspaceAgentReplyRequested`）、RT-4「迟到回报不得拉起新一轮」（回报被 `deliver_agent_reply` 当普通回复入队并置 `running=true`、清掉 `cancel`） |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core -- cancel_notice aborted_sub_agent aborted_cross_workspace whole_tree_abort` | 绿 | 6 通过 / 0 失败（含 RT-5；同名字面量还会带出既有的 `finished_sub_agent_rejects_user_message`）。修复方式：`on_abort` 的每条中止路径收集被中止的子代理 id（`abort_session_scope` 的 `canceled` 出参 + 前台分支直接判本会话），递归结束后由 `Core::notify_creator_of_cancel` 统一投递：本地创建者经 `enqueue_agent_message`（空闲即拉起一轮），创建者自己 `cancel` 已置位时只走 `persist_auto_message`（落上下文与消息流、不排队），跨工作区创建者发 `crossWorkspaceAgentReplyRequested`；`deliver_agent_reply` 对已中止的目标同样只落上下文，迟到回投不复活会话 |
| 既有回归（rust 全套） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core -- --test-threads=1` | 绿 | 1193 通过 / 0 失败（含 RT-1～RT-5） |
| 文档守卫（docsLint） | `npm run test:unit -- docs-lint` | 绿 | 49 项全通过（本文件补上修复前红行之前曾红 1 项：「验证记录必须含修复前的红与修复后的绿各一行」） |
| 文档守卫（本机专属路径） | `npm run test:unit -- docsLintLocalOnlyPaths` | 红 | `EXDEV: cross-device link not permitted, rename 'resources/core' -> 'resources/core.docs-lint-bak'`：本机 `resources/core` 与暂存路径不在同一文件系统。stash 到干净基线后同样红，与本改动无关 |
| 类型与静态检查（TS） | `npm run check-types && npm run lint` | 绿 | 全部通过，本次改动只在 Rust 侧与文档，TS 与改动前同状态 |
| 格式（Rust） | `rustfmt --edition 2021 --check core-rs/src/engine.rs core-rs/src/engine_tests.rs` | 绿 | `npm run fmt:rust` 在本机不可用（rustup 的 `cargo-fmt` 未安装），按同口径直接调 rustfmt；三个 crate 的其余文件未改 |
