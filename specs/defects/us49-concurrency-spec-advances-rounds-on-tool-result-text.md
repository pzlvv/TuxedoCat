---
status: 已修
---

# 缺陷：US-49 并发用例按工具结果文案推进 mock 轮次，单核 runner 上读到逆序

`e2e/electron/subagentConcurrency.spec.ts` 的 US-49 并发用例把「排队结果的回投文案
出现次数」当作轮次推进依据，而回投与下一轮驱动之间没有先后保证：单核 runner 上下一轮
可能先于回投到达，脚本据此重发任务 5，任务 6 反而先发出，断言读到 `[6, 5]`（期望
`[5, 6]`）。CI 的 `e2e-electron` 车道因此长红，而产品侧 FIFO 本身没有问题。

## 现状

- 用例第 92–117 行（修复前）：`const created = context.split('Sub-agent created with ID').length - 1;`
  与 `const queued = context.split('Agent [Master] queued').length - 1;`，按 `created` / `queued`
  决定该发第 1 批（任务 1–4）、任务 5、任务 6 还是收尾。两者都是**工具结果文案**，
  要经过「工具结果回投父会话 → 父会话下一轮请求到达 mock」这条链路才进上下文。
- 回投与下一轮驱动之间是竞态：`core-rs/src/engine.rs` 里工具结果回投是独立的
  `message` 事件，而下一轮驱动由工具批结束触发，两者相对顺序在单核 runner 上不固定。
- 失败断言：`expect(ordered.slice(4).map(taskOf)).toEqual([5, 6])`，实际收到 `[6, 5]`
  （`e2e/electron/subagentConcurrency.spec.ts` 的 `ordered` 按 `startedAt` 排序）。
- 复现：CI run `45027408803`、`45030636920` 的 `e2e-electron` job 均为 `1 failed`，
  失败用例即 `subagentConcurrency.spec.ts:68:5`，耗时 3.9s。
- 既有记录：[e2e/README.md 的已知坑 18](../../e2e/README.md#已知坑实证结论) 已把该现象记为
  「用例侧时序假设」且注明「不是产品缺陷」，但用例**没有改**，所以每轮照红。

## 期望

- 轮次推进只依赖**助手自己已经发出过什么**，不依赖工具结果文案是否已回投。
- FIFO 断言（`ordered.slice(4).map(taskOf)` 为 `[5, 6]`）保持原样——它是 US-49 要锁的语义，
  不改判据也不放宽为集合比较。
- 其余断言（峰值并发恰为 4、排队者不早于前 4 个中最早完成）不变。

## 不变量

- 产品侧槽位 FIFO 的实现与语义不变：`core-rs/src/subagent.rs` 的 `waiters` / `enter_slot_queue`
  / `hand_off_reservation`，以及 `core-rs/src/subagent_tests.rs` 的 `waiters_wake_in_fifo_order`。
- `SUBAGENT_CONCURRENCY_LIMIT = 4`、超上限立即返回排队文案（`core-rs/src/tools.rs` 的
  `Agent [Master] queued`）不变。
- 同文件的「前台中止：排队中的 2 个调用取消」用例（`hang` 分支）行为不变。
- `e2e/README.md` 的已知坑 18 保留（它记录的是同一现象的排查结论）：修复后该条不再
  指向「用例怎么修」的待办，而是说明「为什么不能用文案计数推进轮次」。

## 回归测试

- **RT-1**：排队者按 FIFO 启动——`npm run test:e2e -- --project=electron-app subagentConcurrency`
  （或 CI 的 `e2e-electron` 车道）跑 `US-49 并发上限 4：直取 + 跨轮排队均受限，排队者按
  发起顺序启动`，断言 `ordered.slice(4).map(taskOf)` 为 `[5, 6]`（落点：
  `e2e/electron/subagentConcurrency.spec.ts` 的同名用例）。
- **RT-2**：单核压力下同样成立——在 runner 上以 `taskset -c 0` 固定单核（或 CI 的
  `e2e-electron` 车道本身）重复跑 RT-1 三次，三次全绿。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | CI run `45030636920` 的 `e2e-electron` | 红 | `subagentConcurrency.spec.ts:156` 读到 `[6, 5]`（期望 `[5, 6]`）；同 run 中 122 passed、1 failed |
| 回归用例（修复前，RT-1，本机） | `npm run test:e2e -- --project=electron-app subagentConcurrency` | 部分验证 | 本机多核上稳定绿（与已知坑 18 记录一致），竞态只在单核 runner 上暴露；修复前用 `taskset -c 0` 复现未在本机 Windows 环境完成 |
| 回归用例（修复后，RT-1） | 待 CI `e2e-electron` 车道 | not-run | 待推送后由 CI 复核 |
| 回归用例（修复后，RT-2） | 待 CI 连续两轮 | not-run | 待推送后由 CI 复核 |
| 既有回归（Rust 侧 FIFO） | `npm run test:core` | 绿 | `subagent_tests.rs` 的 `waiters_wake_in_fifo_order` 等用例不受本次改动影响 |
| 类型与静态检查 | `npm run check-types:e2e` / `npm run lint` | 绿 | e2e 的 tsc 与 eslint 无输出 |
