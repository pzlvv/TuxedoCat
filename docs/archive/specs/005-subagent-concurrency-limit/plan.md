# 实施方案：子代理并发上限（同父会话最多 4 个并行，超出排队）

技术路线：在两套 Core 的 `Agent` 工具执行路径上加「按创建者会话分桶的槽位 + FIFO
等待队列」——工具调用先取槽位再建子代理，取不到就在调用内等待；槽位在子代理后台
任务的唯一退出点释放。TS 侧新增独立小模块 `SubagentSlots`，Rust 侧在既有
`subagent.rs` 内扩展同等状态；中止取消走既有 abort 信号（排队等待与取消信号竞速），
不新增事件与 UI 状态。E2E 扩展 mock LLM 的多工具轮脚本能力，以「子代理 LLM 请求
并发峰值」为主断言。需求与验收见同目录 [spec.md](spec.md)。

**方案先于实施的一个发现**：spec FR-002 括号里写的槽位释放点「注册表注销」在现状
代码里不存在——TS `SubAgentRegistry.unregister` 与 Rust `subagent::unregister` 在
生产代码中**均从未被调用**（只有测试调），注册表只增不减是潜伏泄漏。本方案不改
注册表生命周期（接线 unregister 会改变「父会话递归中止可达性」与 `subagent` 变更
信号语义，超出本 spec 范围，见「被否决的替代方案」），槽位释放挂在**子代理后台任务
的唯一退出点**：TS 是 `AgentTool.call` 内后台 IIFE 的 `finally`（AgentTool.ts:484，
完成 / 中止 / 异常三路都汇聚于此）；Rust 是 `run_sub_agent` 的函数末尾（engine.rs，
循环内各 `break` 都落到同一出口）。spec 的 FR-002 括号随本 plan 就地同步修订
（「注册表注销」→「子代理后台任务的唯一退出点」），行为语义不变。

## 技术方案

### 槽位与队列（两侧同构）

每个创建者会话一个桶：`{ active: number, waiters: FIFO队列 }`，上限常量
`SUBAGENT_CONCURRENCY_LIMIT = 4`（TS / Rust 各一份、值与语义一致，parity 测试锁定）。

- **取槽位**：`Agent` 工具执行的最前置步骤。桶空闲槽位 > 0 → `active += 1` 立即返回
  成功；否则把「唤醒句柄」追加进 waiters 队尾并挂起等待。
- **释放槽位**：子代理后台任务退出点 `active -= 1`，并从 waiters 队头唤醒一个
  （FIFO）；被唤醒者 `active += 1` 后继续走建会话流程。释放必须放在
  `try / finally` 保护下（异常路径不泄露）。
- **取消竞速**：等待期间同时监听父会话的取消信号（TS `context.abortController.signal`；
  Rust `ctx.cancel` 的 `AtomicBool`，以 `Condvar::wait_timeout` 约 100ms 轮询）。
  信号先到 → 从 waiters 摘除自身 → 取槽位返回「已取消」，工具返回取消结果，
  **不创建会话**。取消与唤醒并发时取消优先（被唤醒后先复查信号）。
- **失败清理**：取槽位成功后、后台任务启动前若抛错（建引擎 / 落盘失败），由
  同一 `try / catch` 释放槽位；`spawn` 已成功但线程未及运行不存在（线程随 spawn 即起）。

### TS 侧落点

新增 `src/core/tools/agent/SubagentSlots.ts`（单例模块，与 `SubAgentRegistry` 平级）：
`acquireSlot(creatorSessionId, signal): Promise<boolean>`（false = 已取消）、
`releaseSlot(creatorSessionId)`、`resetForTest()`。状态自持（Map），不读注册表、
不读 sessionRuntime——活跃数的事实 owner 就是本模块，避免双记账
（铁律 4.4）。

`AgentTool.call`（AgentTool.ts:196）改造：校验输入后先
`acquireSlot(creatorSessionId, parentSignal)`；取消路径返回与既有取消口径一致的
ToolResult（`is_canceled` + 文案 `Tool was canceled due to abort`，与
`RunTools.cancelApprovedItems` 的取消文案逐字一致）；成功路径把「建引擎 → 登记 →
后台 IIFE」包进 try / catch（catch 内 `releaseSlot` 后重抛）；后台 IIFE 的
`finally`（AgentTool.ts:484）在既有两个 `emitToUi` 之后追加 `releaseSlot`。
排队等待期间工具结果未返回，UI 呈现为既有「进行中的工具卡片」，无需改动。

### Rust 侧落点

`core-rs/src/subagent.rs` 扩展：`SLOTS: Mutex<HashMap<String, SlotState>>` +
`acquire_slot(creator, cancel: &AtomicBool) -> bool`（false = 已取消）+
`release_slot(creator)`，`reset_for_test()` 一并清空。`tools.rs` 的 `run_agent`
（tools.rs:1540）在 `(hooks.spawn)` 前取槽位——`ctx.cancel` 已携带父会话取消标记
（tools.rs:243，Bash 同款）；取消路径返回与 TS 逐字一致的取消文案（parity 由
`ToolOutcome` 文本对齐锁定）；`spawn` 返回 `Err` 时释放槽位。`engine.rs` 的
`run_sub_agent` 末尾（两个 `emit` 之后）追加 `release_slot(&creator_session_id)`。

### E2E：mock LLM 扩展 + 新 spec

`e2e/helpers/mockLlmServer.ts`：

- `ScriptDecision` 扩展 `{ kind: 'tools'; calls: Array<{ name; args }>; preamble? }`——
  一轮 `tool_calls` 携带多个工具调用（SSE 分帧按 index 递增，覆盖既有 arguments
  累积路径）；既有单工具 `tool` 语义不变。
- `RecordedRequest` 增加 `startedAt` / `finishedAt`（服务器收包与 SSE 写完时刻），
  供并发峰值与 FIFO 时序断言；既有字段不动。

新增 `e2e/electron/subagentConcurrency.spec.ts`（US-49），沿用
`assistant.spec.ts` 的 launchApp / chatPage 装配：

- **AC-9 / AC-10（上限 + FIFO）**：`setHandler` 路由——父会话消息「并发派活」→
  一轮 6 个 `Agent` 调用（任务 prompt 为 `并发任务N`）；子代理首请求按
  `并发任务N` 路由慢速文本（分片间隔拉长，保证 4 个同时占槽）。断言：
  ①子代理请求区间的并发峰值 ≤ 4；②任务 5 的 `startedAt` 晚于任务 1–4 中最早
  `finishedAt`（槽位释放后才启动）；③任务 5 的 `startedAt` 早于任务 6（FIFO）；
  ④6 个子代理最终都完成（各自出现 `并发任务N 完成` 回复 / mock 请求计数齐）。
- **AC-11（中止清理）**：同场景，等恰好 4 个子代理请求在途后点
  `button[title="终止"]`（首击只停前台）。断言：侧栏（`app.sidebarPage()`）新增
  子会话恰 4 个（排队的 2 个未建会话）、终止按钮仍可点（收尾中）、
  mock 服务器子代理首请求数维持 4。

### 单元测试

- TS `src/test/agentConcurrency.test.ts`：用 `src/test/helpers/scenario.ts` 的
  脚本化 LLM（`ScriptedRound` 可直接构造含多个 `tool_use` 的 assistant 消息）驱动
  真实 `QueryEngine`——①6 个 Agent 轮：子代理轮慢速挂起，断言同一时刻
  `SubAgentRegistry.list()` 长度 ≤ 4 且按序补位（FIFO）；②`acquireSlot` 直测桶
  语义（FIFO 顺序、取消竞速、异常释放、`resetForTest`）；③中止用例：4 运行 + 2
  排队时 `abort()`，断言排队调用收到 `Tool was canceled due to abort`、注册表无
  新增条目、运行中子代理不受影响；④≤4 回归：4 个全部立即启动、工具结果为
  「已创建」形态。
- Rust `core-rs/src/subagent_tests.rs`（新）：`acquire_slot` / `release_slot` /
  取消轮询 / FIFO / `reset_for_test`；`engine_tests.rs` 补一条 6 调用只起 4 的
  端内断言（脚本 LLM 同款手法，对齐既有 `run_agent` 测试）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/core/tools/agent/SubagentSlots.ts` | 新增 | 无对外契约（core 内部模块，不进事件词汇表） |
| `src/core/tools/agent/AgentTool.ts` | 修改（call 前置取槽位 + finally 释放 + 取消分支） | 无（工具输入输出 schema 不变，取消文案对齐既有口径） |
| `core-rs/src/subagent.rs` | 修改（槽位状态 + acquire / release / reset_for_test） | 无 wire 契约变化 |
| `core-rs/src/tools.rs` | 修改（`run_agent` 前置取槽位 + 取消 / Err 释放） | `ToolOutcome` 新增取消文案分支（文本与 TS 一致） |
| `core-rs/src/engine.rs` | 修改（`run_sub_agent` 末尾释放） | 无 |
| `src/test/agentConcurrency.test.ts` | 新增 | — |
| `core-rs/src/subagent_tests.rs` | 新增；`engine_tests.rs` 补用例 | — |
| `e2e/helpers/mockLlmServer.ts` | 修改（`tools` 多工具轮 + `startedAt` / `finishedAt`） | 测试基建，非产品契约 |
| `e2e/electron/subagentConcurrency.spec.ts` | 新增 | — |
| `docs/features/user-stories.md` | 新增 US-49 小节 | 需求基线 |
| `docs/features/abort-button.md` | 边界补一条 | 需求基线 |
| `docs/core/core-parity.md` | 3.18 子代理条目补并发上限 | parity 基线 |

不新增 / 不修改任何事件类型、wire 帧、UI 契约成员。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 `src/core/` 与 `core-rs/` 内部，
      `SubagentSlots` 只被 `AgentTool` import，不触 host / 宿主实现；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：活跃数单一 owner 是 `SubagentSlots`（Rust 为
      `subagent.rs` 槽位状态），注册表 / sessionRuntime 只读现状不改；上限常量
      4 单处定义、两侧一致；取消路径返回确定结果不静默降级；无新增可选契约成员。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：TS 与 Rust 同步实现上限 / FIFO /
      取消语义，`core-parity.md` §3.18 补记，新增 `subagent_tests.rs` 与
      `agentConcurrency.test.ts` 两侧测试；取消文案逐字一致。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：US-49 进 user-stories.md、abort-button.md
      补边界、core-parity §3.18 补条目，随实施同提交；`npm run test:all -- docs-lint` 绿。

## 被否决的替代方案

1. **接线 `SubAgentRegistry.unregister`（修注册表泄漏）并挂槽位于注销**——否决：
   注销从未发生意味着「父会话递归中止可达性」与 `subagent` 变更信号当前语义依赖
   注册表只增不减；接线会改变用户继续对话后的中止可达范围，超出本 spec 范围。
   注册表泄漏单独立项（候选进 TODO.md），本方案不动注册表。
2. **排队调用立即返回「排队态」结果、子代理稍后启动**——否决：产生「已建会话从未
   运行」的幽灵会话（对话列表 / 落盘 / 清理都要新状态），且模型收到「已创建」却
   实际排队，语义失真；阻塞式等待复用既有 pending 工具卡片与中止路径，改动面最小。
3. **全局（跨会话）信号量**——否决：不同对话的子代理互相挤占，多工作区下饥饿；
   spec 已定作用域为创建者会话。
4. **槽位计数放进 `SubAgentRegistry`**——否决：注册表是「登记 / 递归中止」职责，
   并发准入是工具执行策略；且注册表现状从不注销（见替代方案 1），挂在它上面
   槽位永远不释放。
5. **Rust 侧用事件回调唤醒排队者（取消即时唤醒）**——否决：取消方（引擎线程）
   需要反向感知队列，引入双向耦合；`wait_timeout` 100ms 轮询实现简单、
   中止延迟可忽略（人类操作粒度），parity 测试不锁时延。
