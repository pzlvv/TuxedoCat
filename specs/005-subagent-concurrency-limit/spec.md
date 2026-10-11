---
status: 实施中
---

# 改动规格：子代理并发上限（同父会话最多 4 个并行，超出排队）

限制经 `Agent` 工具创建的子代理并发数：同一创建者会话同时运行的子代理最多 4 个，
超出的调用在工具调用内排队（FIFO），槽位随子代理结束释放。改动落在两套 Core
（Embedded `src/core/tools/agent/AgentTool.ts` 与 Standalone `core-rs/src/tools.rs` 的
`run_agent` 路径），子代理其余行为（后台执行、Reply 回投、Reminder、中止语义、
`SubAgentRegistry` 状态同步）不变；排队中的调用不创建会话、以既有「进行中的工具调用」
形态呈现，不新增 UI 状态与事件。验收含新增 electron-app 层 E2E 用例。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 新增 US-49 小节 | 新增 | 登记子代理并发上限的用户故事与验收，含 E2E 用例登记 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | 边界（状态表附近的行为说明） | 修改 | 补一条边界：排队中的 Agent 调用属前台查询，随前台中止取消、不创建会话；三态判定不变 |
| [docs/core/core-parity.md](../../docs/core/core-parity.md#318-子代理后台-bash-与其余已迁入能力) | 3.18 子代理、后台 Bash 与其余已迁入能力 | 修改 | 子代理条目补并发上限一句（两套 Core 同一上限同一语义，parity 锁定） |

## 用户场景与验收标准

- 场景 1：一轮内发起超过 4 个子代理（fan-out），前 4 个并行、其余排队
  - **AC-1**（FR-001）：GIVEN 同一父会话已有 4 个子代理在运行 WHEN 模型再发起 1 个 `Agent` 调用 THEN 该调用在获得空闲槽位前不返回工具结果，且不创建子代理会话（对话列表无新增）
  - **AC-2**（FR-002）：GIVEN 存在排队中的 `Agent` 调用 WHEN 任一运行中的子代理结束 THEN 最早的排队调用立即启动（FIFO），启动后该父会话活跃子代理数不超过 4
  - **AC-3**（FR-001）：GIVEN 一条助手消息含 6 个 `Agent` tool_use WHEN 并行批执行 THEN 任意时刻该父会话活跃子代理数 ≤ 4，且 6 个调用最终全部启动并各自返回「已创建」结果
  - **AC-4**（FR-004）：GIVEN 一轮内并行发起 ≤ 4 个 `Agent` 调用 WHEN 执行 THEN 全部立即启动，工具结果与子代理回投行为同改动前一致
- 场景 2：跨轮次排队
  - **AC-5**（FR-002）：GIVEN 4 个子代理运行中 WHEN 后续助手轮次再发起 `Agent` 调用 THEN 新调用进入同一队列，槽位释放时按发起顺序启动
- 场景 3：中止、关闭与异常路径
  - **AC-6**（FR-003）：GIVEN 存在排队中的 `Agent` 调用 WHEN 用户中止父会话前台查询 THEN 排队调用全部取消（工具结果为取消文案）、不创建子代理会话，已运行的子代理不受影响（首次中止只停前台，子代理继续）
  - **AC-7**（FR-003）：GIVEN 排队调用已随前台中止取消 WHEN 槽位释放 THEN 队列不再启动任何调用（不产生无人认领的启动）
  - **AC-8**（FR-002）：GIVEN 某运行中子代理因异常失败或被单独中止而结束 WHEN 它退出 THEN 其槽位立即释放、排队调用可启动（错误路径不泄露槽位）
- 场景 4：端到端验证（electron-app 层，mock LLM）
  - **AC-9**（FR-001）：GIVEN mock LLM 脚本驱动父会话单轮发出 6 个 `Agent` 调用、子代理任务为慢速文本应答 WHEN 全部执行完 THEN mock LLM 记录的子代理请求并发峰值 ≤ 4，且第 5、6 个子代理的首个 LLM 请求时间晚于前 4 个中某次的完成时间
  - **AC-10**（FR-002）：GIVEN 同上场景 WHEN 观察启动顺序 THEN 第 5 个子代理先于第 6 个发出首个 LLM 请求（FIFO 可观测）
  - **AC-11**（FR-003）：GIVEN 6 个 `Agent` 调用、4 个运行中 WHEN 用户点击终止 THEN 对话列表中子会话数保持 4（排队 2 个未创建会话），按钮转为黄色「收尾中」态

## 功能需求

### FR-001：并发上限

同一创建者会话同时运行的子代理最多 4 个。`Agent` 工具调用在获得空闲槽位前不创建
子代理会话、不返回工具结果；获得槽位后按既有流程创建会话并后台启动，工具结果形态
（「已创建 + subAgentId」）不变。上限以创建者会话为作用域，不同父会话互不挤占；
上限值在两套 Core 中为同一常量、语义一致（parity 锁定）。

### FR-002：FIFO 排队与槽位释放

排队调用按发起顺序（工具调用授权顺序）启动；同轮与跨轮次的调用共用同一队列。
任一子代理结束——正常完成、被中止、异常失败——立即释放槽位并唤醒最早的排队调用。
槽位释放与子代理退出挂接在同一点（子代理后台任务的唯一退出点），不在多条退出路径上各自维护计数。

### FR-003：排队调用的中止与清理

排队中的 `Agent` 调用是父会话前台查询的一部分：前台中止使所有排队调用取消，
工具结果为取消文案，且不创建子代理会话（无幽灵会话残留）；会话关闭同样清理排队
调用。已运行子代理的既有中止语义不变（首次中止只停前台、子代理继续，再次中止递归
中止，见 [docs/features/abort-button.md](../../docs/features/abort-button.md)）。

### FR-004：既有契约不回归

不改变 `Agent` 工具在无排队场景下的任何可观察行为：工具结果文案、子代理后台执行、
Reply 回投、Reminder 重试、模型 / 权限模式继承、`sessionRuntime` 的子代理空闲递归
判定（[第 2 节](../../docs/core/session-runtime.md#2-对外快照)）均保持现状。

## 边界与错误路径

- **槽位泄露防护**：子代理的三类退出（完成 / 中止 / 失败）都必须走到后台任务的唯一退出点释放槽位；
  任一路径遗漏即排队调用永远等待——由单测锁定三类退出各释放一个槽位。
- **权限拒绝不占槽位**：`Agent` 调用在授权阶段被拒绝时未进入执行，不占用也不等待槽位。
- **排队等待无超时**：槽位释放依赖子代理自身结束；运行中子代理挂起时排队调用跟随
  等待，用户以既有中止手段兜底（与任意长时工具调用挂起的口径一致，不新增超时机制）。
- **中止竞态**：排队调用被取消后不得再启动（AC-7）；取消与槽位释放并发时以取消优先。
- **父会话关闭**：关闭父会话时排队调用随会话清理，不产生只有任务消息、从未运行的会话。

## 非目标

- **不做上限配置化**：上限固定为 4，不进 settings.json；若未来需要再立 spec。
- **不做跨会话全局上限**：只限同一创建者会话内的并发，不同对话之间互不影响。
- **不改 Spin 编排路径**：Spin 引擎的子代理执行（`core-rs/src/engine.rs` 的
  `run_sub_agent` 与 `src/core/spin/Loop.ts`）不经 `Agent` 工具，本次不受限、不改。
- **不新增 UI 状态与事件**：排队以既有「进行中的工具调用」呈现，不新增事件类型、
  不改对话列表展示。
- **不改子代理既有行为**：Reminder、Reply、继承链路、空闲判定全部不动。

## 对需求基线的影响

- 新增 **US-49 子代理并发上限**（user-stories.md）：用户故事 + 验收标准 3 条
  （≤4 无感 / 超 4 排队 FIFO / 中止清理排队），登记 E2E 用例于 electron-app 层
  （新增 `e2e/electron/subagentConcurrency.spec.ts`，覆盖 AC-9 / AC-10 / AC-11）。
- **US-2（中止）与 abort-button.md**：边界补充——排队中的 `Agent` 调用属前台查询，
  随前台中止取消；按钮三态判定不变（US-2 验收 1、abort-button 状态表均不动）。
- 其余 US 不受影响。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/core/tools/agent/AgentTool.ts`（槽位获取，或 plan 定的调度模块）+ `core-rs/src/tools.rs`（`run_agent` 路径） | `src/test/agentConcurrency.test.ts`、`core-rs/src/*_tests.rs`（上限与排队）、`e2e/electron/subagentConcurrency.spec.ts`（AC-9） | 自动 |
| FR-002 | 同 FR-001（FIFO 队列与槽位释放） | `src/test/agentConcurrency.test.ts`（FIFO / 三路退出释放）、`core-rs/src/*_tests.rs`、`e2e/electron/subagentConcurrency.spec.ts`（AC-10） | 自动 |
| FR-003 | 同 FR-001（取消与清理路径） | `src/test/agentConcurrency.test.ts`（中止取消 / 不建会话）、`e2e/electron/subagentConcurrency.spec.ts`（AC-11） | 自动 |
| FR-004 | 全局（回归锁） | `src/test/agentConcurrency.test.ts`（≤4 立即启动与结果形态）、既有子代理用例回归 | 自动 |

## 待澄清

（无——作用域按「同一创建者会话」、排队按「工具调用内等待」落定，见 FR-001 / FR-002；
评审若改这两项，直接修订 FR 后再进 plan。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>
