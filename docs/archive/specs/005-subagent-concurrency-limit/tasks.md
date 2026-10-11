# 任务分解：子代理并发上限（同父会话最多 4 个并行，超出排队）

执行顺序：先两侧 Core 的槽位模块与接线（T001–T004，可并行推进、两侧互不依赖），
再单测锁行为（T005–T007），随后 E2E 基建与用例（T008–T009），最后文档同步与
全量验证（T010–T011）。需求与验收见 [spec.md](spec.md)，技术方案见
[plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002、FR-003）：新增 `src/core/tools/agent/SubagentSlots.ts`——按创建者会话分桶的 `{ active, FIFO waiters }` 状态、`SUBAGENT_CONCURRENCY_LIMIT = 4`、`acquireSlot(creatorSessionId, signal): Promise<boolean>`（与取消信号竞速，false = 已取消）、`releaseSlot`（释放并唤醒队头）、`resetForTest`；依赖：—；完成判据：`npm run check-types` 0 错；T005 的 `acquireSlot` 直测组全绿
- [x] **T002**（FR-001、FR-002、FR-003、FR-004）：改造 `src/core/tools/agent/AgentTool.ts`——`call` 输入校验后前置 `acquireSlot`（取消路径返回 `is_canceled` + 文案 `Tool was canceled due to abort`、不建会话），建引擎 / 登记包进 try / catch（catch 内释放后重抛），后台 IIFE 的 `finally`（现 AgentTool.ts:484）追加 `releaseSlot`；依赖：T001；完成判据：T005 用例组（排队 / FIFO / 取消 / ≤4 回归）全绿
- [x] **T003**（FR-001、FR-002、FR-003）：`core-rs/src/subagent.rs` 扩展槽位状态——`SLOTS: Mutex<HashMap<String, SlotState>>`、`acquire_slot(creator, cancel: &AtomicBool) -> bool`（`Condvar::wait_timeout` 约 100ms 轮询取消标记，false = 已取消）、`release_slot`（释放并唤醒队头）、`reset_for_test` 清空；依赖：—；完成判据：`cargo test`（`test:core`）中 `subagent_tests` 全绿
- [x] **T004**（FR-001、FR-002、FR-003、FR-004）：接线 Rust 两侧——`tools.rs` `run_agent`（现 tools.rs:1540）在 `hooks.spawn` 前取槽位（取消路径 `ToolOutcome` 文案与 TS 逐字一致；`spawn` Err 时释放），`engine.rs` `run_sub_agent` 末尾追加 `release_slot`；依赖：T003；完成判据：`npm run test:core` 全绿（含 T007 的 engine 用例）
- [x] **T005**（FR-001、FR-002、FR-003、FR-004）：新增 `src/test/agentConcurrency.test.ts`（脚本化 LLM 手法同 `src/test/helpers/scenario.ts`，`ScriptedRound` 构造多 tool_use 轮）——①`acquireSlot` 直测：FIFO 顺序、取消竞速（signal 先到返回 false）、异常释放、`resetForTest`；②6 个 Agent 轮：同刻注册表活跃 ≤ 4 且按序补位；③4 运行 + 2 排队时 abort：排队调用收 `Tool was canceled due to abort`、注册表无新增、运行中子代理不受影响；④≤4 全部立即启动且结果为「已创建」形态；依赖：T002；完成判据：`npm run test:all -- agentConcurrency` 全绿
- [x] **T006**（FR-001、FR-002、FR-003）：新增 `core-rs/src/subagent_tests.rs`——`acquire_slot` / `release_slot` 桶语义（FIFO、取消轮询返回 false、上限 4）、`reset_for_test`；模块在 `main.rs` 注册；依赖：T003；完成判据：`npm run test:core` 全绿
- [x] **T007**（FR-001、FR-002）：`core-rs/src/engine_tests.rs` 补端内用例——脚本 LLM 驱动父会话单轮 6 个 Agent 调用，断言同时活跃子代理 ≤ 4、全部最终完成；依赖：T004；完成判据：`npm run test:core` 全绿
- [x] **T008**（FR-001、FR-002）：扩展 `e2e/helpers/mockLlmServer.ts`——`ScriptDecision` 新增 `{ kind: 'tools'; calls: [...] }` 多工具轮（SSE 按 index 递增分帧）、`RecordedRequest` 增加 `startedAt` / `finishedAt`；依赖：—；完成判据：既有 e2e 无回归（`npm run test:e2e -- --project=electron-app` 基线用例全绿）
- [x] **T009**（FR-001、FR-002、FR-003）：新增 `e2e/electron/subagentConcurrency.spec.ts`（US-49）——①6 个 Agent 调用：子代理请求并发峰值 ≤ 4、任务 5 首请求晚于前 4 最早完成、任务 5 早于任务 6（AC-9 / AC-10）；②等 4 个在途后点终止：侧栏子会话恰 4、按钮仍可点、子代理首请求数维持 4（AC-11）；依赖：T004、T008；完成判据：`npm run test:e2e -- --project=electron-app --grep 子代理` 全绿
- [x] **T010**（FR-001、FR-003、FR-004）：文档同步——`docs/features/user-stories.md` 新增 US-49（验收 3 条 + e2e 登记）、`docs/features/abort-button.md` 补排队调用随前台中止取消的边界、`docs/core/core-parity.md` §3.18 子代理条目补并发上限一句；依赖：T002、T004；完成判据：`npm run test:all -- docs-lint` 全绿
- [x] **T011**（FR-001、FR-002、FR-003、FR-004）：全量验证——`npm run check-types` 0 错、`npm run lint` 干净、`npm run test:all` 全过（含真实双端 parity，先 `npm run build:core:host`）、`npm run test:e2e` 四 project 全绿（无回归）；依赖：T005–T010；完成判据：四项命令退出码 0，提交信息按仓库口径留痕
