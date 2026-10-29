---
status: 已修
---

# 缺陷：孤儿（后台运行）会话卡死在权限往返上——工具执行以宿主回包为前置

后台运行（detach / 孤儿化，[specs/031](../../docs/archive/specs/031-remote-detached-tasks/spec.md)）的 SSH
工作区里，代理循环推进到下一个工具调用即冻结：没有任何待决的用户请求，会话保持 `running`
却不再产生新的 LLM 轮次，已派发的工具与后台 Bash 任务照常跑完；直到重开工作区认领孤儿、
daemon 重放缓存的请求帧、宿主自动应答后，会话才继续往下走。根因是每次工具执行前的
`toolPermissionRequested` 往返被引擎当作执行前置阻塞等待，而应答在宿主离场期间无人给出。
「allow / deny 等宿主回包」这一模式历史上已引发过多次缺陷（如
[tool-card-roundtrip-marks-waiting](tool-card-roundtrip-marks-waiting.md)），本次一并根除。

## 现状

- `resolve_permission`（`core-rs/src/engine.rs`）无论本地策略算出 allow / deny / ask，
  都先发 `CoreRequest.toolPermissionRequested` 并经 `plain_request`
  → `await_response`（上限 1 小时）**阻塞等待宿主回包**，
  以回包的 behavior 决定执行 / 拒绝 / 弹框；工具批的每个工具都在执行前过这道闸。
- 宿主侧对该请求的应答是**纯回显**：`ToolHandler.requestToolPermission` 原样返回
  `permResult`（`src/host/ui/toolHandler.ts`，不弹框、不改写）。决策信息（behavior /
  `updatedInput` / message / choices）全部由 core 的 PermissionPolicy 本地算出
  （`core-rs/src/permission.rs` 的 `resolve_tool_permission`）——回包不携带任何 core
  不知道的信息，实际作用只有「卡片上架 / diff 展示 / `_meta` 写入」的展示同步。
- 孤儿期间（detach / 宿主断开，specs/031 FR-005）daemon 对孤儿 Core 的帧只排水，并把
  request 帧一律缓存待重放（`core-rs/src/daemon.rs` 的 `peek_frame` / `drain_replay`），
  不代答 → 引擎线程停在 `recv_timeout(3600s)`，消费循环冻结在
  「LLM 已回 tool_use、工具未执行」。后台任务完成通知虽能拉起新一轮消费
  （`enqueue_agent_message`），但该轮只要再调工具就再次冻结。
- 认领时 daemon 重放缓存的请求帧，宿主自动应答（不需要用户交互、不需要会话视图打开，
  `src/host/WebViewUI.ts` 的 CoreRequest 映射表）→ 循环恢复。与用户观察一致：
  「过程中没有用户请求，后台没有进展，重连后才继续往下走」。
- 同一阻塞模式还在 unknown tool 卡片与执行报错卡片的上架路径复用
  （`core-rs/src/engine.rs` 里 `request_tool_permission` 的两个调用点，`let _ =` 只丢弃
  返回值，阻塞等待照旧发生）。
- 与 as-built 的冲突：specs/031（已收敛归档）FR-003「该工作区的 Core 继续运行：会话执行、
  后台 Bash 任务照常」、FR-005 只允许「用户请求（权限确认 / AskUserQuestion）无人应答时
  挂起」——非用户类的权限往返把**整个会话执行**变成了挂起，超出规格允许的挂起范围。
- 复现路径：SSH 工作区发起会跑工具的任务 → 标签页关闭选「后台运行」（或宿主退出）→
  孤儿期间对话不再推进（远端 Core 无新 LLM 请求），重开工作区认领后立即继续。

## 期望

- **工具执行的决策完全以 core 本地 PermissionPolicy 的结果为准**：behavior 为 allow / deny
  时，core 不等待宿主对 `toolPermissionRequested` 的回包即执行 / 拒绝；宿主回包只承担展示
  同步（卡片上架、diff、`_meta`），迟到 / 缺失不影响执行时序与决策。unknown tool /
  执行报错卡片的上架路径同样不再阻塞。
- `toolPermissionRequested` 仍照发（展示职责保留；孤儿期间由 daemon 缓存、认领后重放补上架）。
- behavior 为 ask 时仍走 `userChoice` 阻塞等待并标 `waiting`（specs/031 FR-005 的既有语义，
  不在本次根除范围）。
- 孤儿期间会话执行照常推进（specs/031 FR-003），只有真正的用户阻塞请求才挂起会话。
- 文档同步：[docs/architecture/events.md 第 6 节](../../docs/architecture/events.md#6-边界语义)的
  请求超时约定改写（该往返不再被引擎等待，超时口径只属于 `userChoice` 一族）；
  `resolve_permission` 处「按回传的 behavior 决定」的注释同步。

## 不变量

- `toolPermissionRequested` 的载荷与应答类型（`PermissionResult`）不变——契约面零变化
  （`src/shared/AssistantEventBus.ts` 联合类型、[events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)载荷列不动）。
- ask → `userChoice` → 应答的问答回环行为不变（载体：既有用例
  `permission_denied_turns_the_tool_result_into_an_error`）。
- `updatedInput` 仍来自本地策略（`core-rs/src/permission.rs` 的 normalize / checkPermissions
  规范化），工具入参改写路径不变。
- 宿主在线时工具卡片的上架时序不回退：帧通道有序，request 先于后续 `toolCall` 事件被宿主
  处理，卡片仍先于执行开始呈现。
- 1 小时 `await_response` 上限对 `userChoice` 等真正的用户阻塞请求保持不变。
- 前台（宿主在线）可观察行为不变：allow 工具照常执行、卡片照常上架、结果落盘一致。

## 回归测试

- **RT-1**：无宿主应答（模拟孤儿）时，本地 allow 的工具照常执行并推进到下一轮 LLM——
  FakeLlm 首轮回 tool_use（Bash `echo`，auto 模式本地策略 allow），应答器对
  `toolPermissionRequested` 不应答（其余照答），断言 `toolResult` success、第二轮到达、
  `queryEnd`、且 `toolPermissionRequested` 仍被发出（落点：
  `core-rs/src/engine_tests.rs` `allowed_tool_executes_without_permission_response`）
- **RT-2**：CoreRequest waiting 登记表在真实 Core 二进制上对照——`userChoice` 在途窗口内
  waiting=true 快照 ≥ 1，且 userChoice 到达前全程无 waiting=true（waiting 的唯一来源是
  userChoice；发后不等后 `tool-card-roundtrip-marks-waiting` 的「卡片上架不标 waiting」
  语义依旧成立）（落点：`src/test/coreRequestWaiting.test.ts`；先红于 CI smoke 首轮——
  旧断言把窗口锚在权限应答上，改锚 userChoice 到达序后转绿）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test allowed_tool_executes_without_permission_response`（core-rs） | 红 | `allow 工具未在无宿主应答时执行：会话卡死在权限往返上`（RT-1 用例）；诊断行显示本地策略已判 `behavior=allow`，工具仍未执行 |
| 回归用例（修复后） | `cargo test allowed_tool_executes_without_permission_response`（core-rs） | 绿 | RT-1 通过：无宿主应答时 allow 工具照常执行、第二轮 LLM 到达、`toolPermissionRequested` 仍发出 |
| 既有回归 | `cargo test`（core-rs 全量） | 绿 | 1028 通过 / 0 失败。8 个锁旧「宿主应答驱动决策」语义的用例按新契约改写：`permission_layer_can_rewrite_the_tool_input` → `permission_response_cannot_rewrite_the_tool_input`、`permission_deny_short_circuits_the_tool` → `permission_response_cannot_deny_a_locally_allowed_tool`、`permission_result_that_is_neither_allow_nor_deny_is_rejected` → `malformed_permission_response_cannot_affect_execution`、`permission_request_failure_is_reported` → `permission_request_failure_does_not_block_execution`（四条改为锁「应答无决策权」）；`abort_during_the_tool_loop_skips_the_next_llm_round` 的中止窗口从权限往返移到 userChoice（现存的唯一用户阻塞点）；`permission_deny_cancels_the_remaining_tools_in_the_batch` 的拒绝来源改为用户拒答；`manual_tool_permission_marks_waiting_only_while_the_choice_is_pending` 改用本地策略为 ask 的命令；`permission_denied_turns_the_tool_result_into_an_error` 的确认框选项断言改为本地 `ask_choices` 的「允许执行」（与生产回显一致） |
| 既有回归（test:unit，真实 Core 二进制） | `npm run build:core:host` + `npm run test:unit` | 绿 | 首轮 CI smoke 的 tests job 抓到 `coreRequestWaiting` 红（RT-2 的旧窗口锚点把 userChoice 的 waiting 快照误判进权限窗口）；改锚 userChoice 到达序后本地全绿（89 通过 / 1 跳过，skip 为环境前置无关项），随本 PR 复跑 smoke 确认 |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | [events.md 第 6 节](../../docs/architecture/events.md#6-边界语义)改写在行数棘轮内（419 ≤ 421）；缺陷规格结构与验证记录完整性通过 |
| e2e `electron-ssh` 车道（后台运行存续 / 认领续跑） | — | not-run | 依赖可连的真实 SSH 远端，本机无环境；引擎与 daemon 侧语义由 core-rs 单测承担，宿主侧用例为既有 `e2e/electron/remoteTaskSurvival.spec.ts` |

备注：修复段更正了不变量一节的评估笔误——载荷列的章节指向更正为
[events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)（事件词汇表，评估时
指到了相邻章节），lint 要求跨文档引用链接化时一并更正，引用的事实内容未变。
