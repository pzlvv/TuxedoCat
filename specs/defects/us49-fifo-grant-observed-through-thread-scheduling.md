---
status: 已修
---

# 缺陷：US-49 的排队授予判据读跨线程取的毫秒，槽位连续放行时被调度顺序翻转

`e2e/electron/subagentConcurrency.spec.ts` 的 US-49 并发用例在 `all` 车道的
`e2e-electron` 上概率性红，失败断言固定在
`expect(queuedGrantViolations(grants, [5, 6])).toEqual([])` 读到
`["任务6 比任务5 更晚发起却先拿到槽位预留（FIFO 破坏）"]`。**产品侧槽位队列的 FIFO
没有被破坏**——红的是判据把「后台线程里取的毫秒」当成「授予预留的顺序」。

## 现状

- 失败现场：run `46099953366`（branch `fix/submit-verdict-lost-on-gate-error`）的
  `e2e-electron（整应用）`车道，`128 passed / 1 failed`，唯一失败是本用例。
- 产品侧的授予顺序由 `core-rs/src/subagent.rs` 保证且正确：
  - `enter_slot_queue` 在**同一把 `SLOTS` 锁内**完成「快路径判断 + 入队」，因此
    `waiters` 的顺序等于调用顺序；
  - `hand_off_reservation` 遍历 `waiters`，把空位预留给**最早尚未获预留**的等待者并
    `notify_one`，随即 `return`（预留转移，`active` 不变）。
- 观测点读的是子会话 id 的 `sub_<millis>_<suffix>` 前缀（`generate_sub_session_id`
  的 `now_millis()`），意图是「授予预留后建会话的时刻」。
- **两者之间隔着一次线程唤醒与调度**：`request_slot_or_defer` 把
  `wait_for_grant → on_grant` 放进 `std::thread::spawn` 出来的线程
  （`core-rs/src/subagent.rs`），`on_grant` 才调 `create_sub_agent`，而
  `generate_sub_session_id()` 是 `create_sub_agent` 的第一行
  （`core-rs/src/engine.rs`）。两个排队者被 `notify_one` 连续唤醒时，**后唤醒者完全
  可能先被调度到 CPU**，它取的毫秒就更小——判据据此报「FIFO 破坏」。
- 触发条件是「两个排队者的授予时刻挨得太近」：本用例此前给两个排队者**同样的
  `delayMs: 900`**，于是任务 5 跑完释放槽位、任务 6 立刻获预留，两次授予挤在毫秒级
  窗口里，线程调度抖动足以翻转载荷极轻的那两次调用。
- 与既有修复的关系：`specs/defects/us49-fifo-assertion-reads-first-request-order.md`
  把观测点从「mock 首请求到达时刻」换成「子会话 id 毫秒」，那一步是对的（前者离授予点
  更远）；本条是同一观测点残留的**第二个无顺序保证环节**——毫秒的**取值**跨线程。
  那个缺陷的修复已经意识到这一层（`queuedGrantViolations` 的「同毫秒不判违规」注释
  点明了「毫秒值在拿到预留之后、经 `on_grant` 后台线程才取」），只是把容差收在
  「同毫秒」这一档，**跨毫秒反序**仍会漏过。

## 期望

- 判据读的仍是子会话 id 的毫秒（产品没有暴露「授予序号」的 wire / 落盘字段，没有更近
  的观测量），但**用例侧必须让两个排队者的授予时刻拉开到远超线程调度抖动的量级**，
  使这个观测点可信。
- `queuedGrantViolations` 的判定语义不变：仍然在**看到反序证据**时报红——真出现
  「后入队者严格更早拿到预留」时用例必须红，不能靠放宽判据换绿。
- 不引入与机器相关的魔数阈值：差值取决于 runner 的负载，写死会把慢机变成常红。
  余量靠用例拉开排队者执行时长来保证。

## 不变量

- 产品侧不因本条改动：`enter_slot_queue` / `hand_off_reservation` / `wait_for_grant` /
  `request_slot_or_defer` 的 FIFO 与后台派生语义、`SUBAGENT_CONCURRENCY_LIMIT = 4`、
  取消优先规则一律不变。
- 本用例要锁的产品语义不变：峰值并发恰为 4（`< 4` = 子代理被串行化，`> 4` = 上限失效）、
  排队者只能在槽位释放后启动、FIFO 不破。
- `queuedGrantViolations` 的返回语义不变：空数组 = 顺序正确；缺席单独报一次；
  同毫秒不构成反序证据；只在严格更早时报「FIFO 破坏」。
- 首轮直取的任务 1–4 之间本就不承诺顺序，仍不参与比较。

## 回归测试

- **RT-1**：`queuedGrantViolations` 的纯函数判据不变——反序证据仍报红、同毫秒不报、
  缺席单独报（落点：`src/test/subagentGrantOrder.test.ts`，既有用例继续锁定）。
- **RT-2**：US-49 并发用例在 CI 上不再概率性红（落点：
  `e2e/electron/subagentConcurrency.spec.ts` 的「US-49 并发上限 4」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | CI run `46099953366` 的 `e2e-electron` 车道 | 红 | `128 passed / 1 failed`；`- Array []` / `+ Array ["任务6 比任务5 更晚发起却先拿到槽位预留（FIFO 破坏）"]`，失败行 `subagentConcurrency.spec.ts:202` |
| 判据纯函数回归 | `npm run test:unit -- subagentGrantOrder` | 绿 | 14 通过 / 0 失败——判据未被放宽：反序证据仍报红、同毫秒仍不报、缺席单独报、首请求顺序翻转不影响判定 |
| 用例本体（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 绿 | 2 passed（22.7s）：`US-49 并发上限 4` 11.0s、`US-49 前台中止` 10.1s |
| 等待预算复核 | — | 绿 | 任务 5 的 `delayMs` 900 → 2500 使该用例多约 1.6s，实测 11.0s 远在 `ELECTRON_APP_TEST_TIMEOUT_MS = 60s` 内 |
| CI 实证 | 下一轮 `all` 的 `e2e-electron` 车道 | not-run | 需推送后由整点车道或手动 dispatch 验证；概率性红的收敛要以多轮绿为准 |
