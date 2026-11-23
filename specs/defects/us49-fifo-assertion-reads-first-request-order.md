---
status: 已修
---

# 缺陷：US-49 e2e 的 FIFO 断言读「首个 LLM 请求到达顺序」，与产品保证的槽位预留顺序不是同一层

`e2e/electron/subagentConcurrency.spec.ts` 的 US-49 并发用例在 CI 的 `e2e-electron`
车道概率性红，失败断言固定在 `ordered.slice(4).map(taskOf)` 读到 `[6, 5]`（期望
`[5, 6]`）。产品侧槽位队列的 FIFO 没有被破坏——红的是**用例把「首个 LLM 请求到达
mock 的时刻」当成「槽位授予顺序」**，这两层之间有一个没有任何顺序保证的窗口。

## 现状

- 失败点：`e2e/electron/subagentConcurrency.spec.ts` 的
  `expect(ordered.slice(4).map(taskOf)).toEqual([5, 6])`（第 161 行），`ordered` 按
  mock 记录的 `startedAt` 排序（`RecordedRequest.startedAt` =
  `e2e/helpers/mockLlmServer.ts` 里解析完请求体的 `Date.now()`）。
- 概率性：同一份代码在 CI 上红（run `45089008241`、`45082033033` 的
  `e2e-electron` 车道，各 122 passed / 1 failed），本机多核连续三次全绿。失败与该
  用例前一步骤的耗时强相关（红时整条 3.7–4.0s，绿时 3.8s 左右），说明它取决于
  两次「授予后到发出首请求」的相对快慢，不取决于固定的输入。
- 产品的 FIFO 保证点在**槽位预留转移**，不在「子代理发出首个 LLM 请求」：
  - `core-rs/src/subagent.rs` 的 `enter_slot_queue` 在**同一把 `SLOTS` 锁内**完成
    「快路径判断 + 入队」，因此 `waiters` 的顺序等于调用顺序；
  - `hand_off_reservation` 在释放侧遍历 `waiters`，把空位预留给**最早尚未获预留**
    的等待者并 `notify_one`；
  - 也就是说 FIFO 的语义是「谁先拿到预留」（`granted = true`），到此为止。
- 预留之后的链路**逐段释放了顺序**，每一段都没有前后依赖：
  1. `wait_for_grant` 返回后，`request_slot_or_defer` 的 `on_grant` 在一个
     `std::thread::spawn` 出来的线程里执行（`core-rs/src/subagent.rs`）；
  2. `on_grant` 调 `Core::create_sub_agent`，其中要做「建 meta.json / 写 context /
     `register` / `emit_runtime` / `conversationListChanged`」多次落盘与 emit
     （`core-rs/src/engine.rs`）；
  3. `create_sub_agent` 末尾再 `std::thread::spawn(run_sub_agent)`，真正发首请求的
     线程到这里才被创建（`core-rs/src/engine.rs`）；
  4. 首请求还要过 `run_consumer_with_ui` → `build_system_prompt`（首次会并发探测
     26 个命令 / 读 `AGENTS.md` / 探测 git，`core-rs/src/prompt.rs` 的
     `available_commands` / `GIT_CACHE` 带进程级缓存）→ `llm::stream` 才落到 mock。
  预留 5 与预留 6 之间只隔一次 `notify_one`；上面 1–4 的墙钟量级远大于它，且第 4 步
  的探测结果**被进程级缓存命中与否决定**——先被唤醒者的探测还在跑、后被唤醒者直接
  吃缓存，就足以把 `startedAt` 的顺序翻过来。
- 因此红的方向与实际调度有关，不是 `[5, 6]` 之外的固定错序：本机诊断实测同一用例
  里任务 1–4 的**槽位创建顺序**是 `3 → 4 → 2 → 1`、`2 → 4 → 1 → 3` 这类任意顺序
  （首轮 4 个并发直取，本就不承诺彼此顺序），而排队的两个在同一次运行里是 `5 → 6`。
  这正是「槽位层有序、首请求层无保证」两件事共存的样子。
- 断言本身也没有锚定产品可观测的事实：`slice(4)` 假设「先创建的一定先发请求」，
  而 mock 侧只有 `startedAt`，没有槽位授予时刻。产品没有任何 wire 事件或落盘字段
  暴露「排队序号」，所以这条断言无论如何都只能读到 HTTP 层的到达顺序。
- 与既有记录的关系：`specs/defects/us49-concurrency-spec-advances-rounds-on-tool-result-text.md`
  已修过同一断言的**上游**（脚本推进判据从「工具结果文案计数」改成「助手是否发出过
  该任务的 tool_use」），修完后 `[6, 5]` 仍在 CI 出现（run `45089008241` 实证）——
  说明那次改动去掉的是一条竞态，不是这条断言的全部风险面。

## 期望

- 用例断言的必须是**产品真正保证的那一层**：
  - 「同父会话并行子代理峰值恰为 4」保持（由 mock 的 `startedAt` 区间重叠数观测，
    这一层产品确实保证）；
  - 「排队者不早于前 4 个中最早的完成才启动」保持（同上，属槽位释放语义）；
  - 「任务 5 早于任务 6」改为按**槽位预留顺序**判定，不再用「首个 LLM 请求到达
    顺序」代替。
- 槽位预留顺序必须在产品侧可观测，且观测点唯一：
  - 排队者获得预留后由 Core 建会话，`create_sub_agent` 落盘的
    `meta.json` 的 `createdAt` / 子会话 id 里的毫秒时间戳即「授予时刻」的落盘事实；
    用例以它排序比较 5 与 6，就回到槽位层。
- 断言不得放宽为「集合比较」（`[5, 6]` 与 `[6, 5]` 都过）：那会让 FIFO 这条 US-49
  验收标准失去自动覆盖（`docs/features/user-stories/dialog-core.md` US-49 验收 2）。
- 断言不得依赖「上一轮一定先落地」这类时序假设（`e2e/README.md` 的已知坑 18 口径）。

## 不变量

- 产品侧槽位 FIFO 的实现与语义不变：`core-rs/src/subagent.rs` 的 `waiters` /
  `enter_slot_queue` / `hand_off_reservation` / `wait_for_grant`，
  以及 `core-rs/src/subagent_tests.rs` 的 `waiters_wake_in_fifo_order` /
  `request_slot_or_defer_queues_instead_of_blocking`。
- `SUBAGENT_CONCURRENCY_LIMIT = 4`、超上限立即返回排队文案、排队不阻塞发起方轮次
  （US-49 验收 1）不变。
- `create_sub_agent` 的落盘与 emit 顺序（meta.json → context → register →
  emit_runtime → conversationListChanged → spawn 驱动线程）不变；本缺陷不涉引擎。
- 同文件第二用例（前台中止：排队中的 2 个调用取消、不创建子会话）行为不变。
- 首轮 4 个并发直取之间的顺序**不做承诺**：用例不得断言任务 1–4 的相互顺序。
- `e2e/README.md` 的已知坑 18 保留，只更新它指向的修复口径。

## 回归测试

- **RT-1**：排队者按槽位预留顺序启动——用例读子会话落盘事实排序，断言获得预留的
  两个子代理是 `5 → 6`；同时保留峰值 4 与「不早于最早完成」两条断言
  （落点：`e2e/electron/subagentConcurrency.spec.ts` 的
  `US-49 并发上限 4：直取 + 跨轮排队均受限，排队者按发起顺序启动`）。
- **RT-2**：判定与「首个 LLM 请求到达顺序」解耦——同一份授予事实，把首请求顺序
  反过来喂给判定，结果不变；同一毫秒授予必须报成问题而不是放过
  （落点：`src/test/subagentGrantOrder.test.ts`）。
- **RT-3**：既有的 Rust 槽位单测保持绿（`core-rs/src/subagent_tests.rs`），
  证明本缺陷不改产品语义（落点：`npm run test:core`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 缺陷现象（CI） | CI run `45089008241` / `45082033033` 的 `e2e-electron` 车道 | 红 | `expect(ordered.slice(4).map(taskOf)).toEqual([5, 6])` 读到 `[6, 5]`；同 run 122 passed / 1 failed |
| 缺陷现象（本机） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 绿 | 多核本机连续跑全绿；缺陷是概率性的，本机不作为反证 |
| 分层证据（只读代码） | 读 `core-rs/src/subagent.rs` 的 `enter_slot_queue` / `hand_off_reservation` / `wait_for_grant` | 绿 | 槽位入队与预留转移在同一把 `SLOTS` 锁内，FIFO 只保证到「预留」为止 |
| 分层证据（只读代码） | 读 `core-rs/src/engine.rs` 的 `spawn_sub_agent_queued` / `create_sub_agent` | 绿 | 预留后经「后台线程 → 建 meta / 写 context / register / emit → 再 spawn 驱动线程」才发首请求，每段都无顺序依赖 |
| 分层证据（只读代码） | 读 `core-rs/src/prompt.rs` 的 `available_commands` / `GIT_CACHE` | 绿 | 首个请求前的提示词组装带进程级缓存，命中与否决定该子代理的首请求快慢 |
| 分层证据（诊断实测） | 临时诊断用例打印「槽位创建顺序」与「首请求顺序」 | 部分验证 | 同一次运行里槽位创建顺序为 `4 → 2 → 3 → 1`、`3 → 4 → 2 → 1` 等任意序，排队两条恒为 `5 → 6`；诊断用例用后即删，未入库 |
| 回归用例（修复前，RT-1） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 部分验证 | 修改判据前本机多核跑绿（缺陷概率性，本机不复现）；红的证据取 CI run `45089008241` / `45082033033` |
| 回归用例（修复后，RT-1） | 同上 | 绿 | 2 passed（22.4s）：首用例改读子会话 id 的授予时刻判定 5 → 6，峰值 4 与「不早于最早完成」原样保留 |
| 回归用例（RT-2，判定解耦） | `node scripts/run-tests.mjs subagentGrantOrder` | 绿 | 12 通过：含「首请求顺序为 6 → 5 时授予判定仍是 5 → 6」「同一授予事实在两种首请求顺序下判定一致」「同一毫秒授予报问题不放宽」「首轮并发直取批次不参与比较」 |
| 判定反向自检（RT-2 补充） | `node -e` 直接调 `queuedGrantViolations` | 绿 | 授予 5→6 判为空（无违规）；把授予反成 6→5 立即报「FIFO 破坏」——证明判据不是恒真空过 |
| 文档同步 | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败；`e2e/README.md` 已知坑 18 已改写为「排队顺序只读槽位授予时刻」 |
| 类型与静态检查 | `npm run check-types` / `npm run check-types:e2e` / `npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
| 既有回归（Rust 槽位） | `npm run test:core` | skipped | 本机 Windows 缺 LLVM（`cc-rs` 找不到 `clang`），Rust 单测跑不起来；CI 的 `tests` job 覆盖 |
| 既有回归（整应用车道） | `npm run test:e2e:electron` | not-run | 本机 Windows 整车道约 13 分钟，由 CI 的 `e2e-electron` 车道复核；本文件改了用例判据，需下一轮 CI 确认 |
