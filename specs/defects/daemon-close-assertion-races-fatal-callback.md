---
status: 已修
---

# 缺陷：沉默判死的「断链」断言读同步瞬时值，对端 close 记账晚于 fatal 回调时偶发红

`src/test/remoteCoreDaemon.test.ts` 的「沉默判定」段用 `fake.closed() >= 1` 断言判死
确实断开了链路。`fake.closed()` 读的是**假远端 socket** 的 `'close'` 计数，而 fatal 是在
**宿主侧 socket** 的 `'close'` 回调链里上报的——两者是两条独立的 socket 通知，先后顺序没有
保证。CI（2 核、单元测试 4 路并发）上概率性读到 0，`smoke / tests` 因此整 job 红，
而产品行为本身正确（[core-remote.md 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)
的判死与断链都已发生）。

这条断言是上一个缺陷修复
（[`silence-recheck-runs-before-inbound-drain`](silence-recheck-runs-before-inbound-drain.md)）
的反向性质检查项，该文件的验证记录把它登记为「仍绿」，但它读的是瞬时值，绿是运气而非保证。

## 现状

- 断言位点（`src/test/remoteCoreDaemon.test.ts` 的「沉默判定：pong 武装、沉默判死」段）：

  ```text 示意（读的是对端 socket 的 close 计数，紧跟在 fatal 落地之后）
  const fatalArrived = await waitFor(() => failure.error !== null, 2_000);
  check('沉默超过死线 + 宽限后判死 fatal', fatalArrived && failure.error !== null);
  check('判死在死线 + 宽限的量级内完成', Date.now() - silenceAt < 1_000);
  check('判死确实断开了链路', fake.closed() >= 1);
  ```

- 两条通知互不保序：
  - fatal 侧：`CoreDaemon.judgeSilenceAfterDrain` 调 `this.writer?.kill()`，本端 socket
    收到 `'close'` → `handleExit()` → `fatalAll()` → channel 的 `hooks.onFatal`。
  - `fake.closed()` 侧：对端 socket 的 `'close'` 事件（`startFakeRemote` 里
    `socket.on('close', () => { closedCount += 1 })`）。
- 生产形态里 daemon 是**另一个进程**（远程机上的 `core-rs`），对端观察到 RST 与本端
  `kill()` 返回之间隔着一次网络往返，对端 close 一定晚于本端 fatal；进程内假远端把这两件事
  压进同一个事件循环，短到多数时候同轮派发（本地压测 240 份全绿），但 CI 的调度粒度下
  会跨轮，断言就落在「已 kill、对端尚未记账」的窗口里。
- CI 现场：run `45512523867` 的 `smoke / tests` job（`tests` 轨道，2 核 / 4 路并发）：

  ```
  ok   沉默超过死线 + 宽限后判死 fatal
  ok   fatal 文案指明沉默判死
  ok   判死在死线 + 宽限的量级内完成
  FAIL 判死确实断开了链路
  ```

  同 run 的 `remoteCoreDaemon` 其余 67 条全绿（含 RT-1 / RT-2 两条宽限用例），
  `docs-lint` 与 `rust-tests` 也全绿——失败面恰好是「断链已经发生」这一条。
- 断言与实现要的语义对不上：实现保证「判死即 kill 链路」，用例要断言「链路确实被断开」；
  而对端 close 记账是**异步到账**的观测，不是 kill 的同步结果。

## 期望

- 断链断言读「最终会到账」的事实，不读同步瞬时值：用既有的 `waitFor` 等对端记账，
  与同段其它断言（`waitFor(() => failure.error !== null, 2_000)`）同口径。
- 断言强度不降：仍要证明「判死之后链路真的断了」，不能退化成只证明「有 fatal」。
- 与 fatal 的先后解耦：无论对端 close 早于还是晚于 fatal 回调，用例都绿；只有「kill 没发生 /
  对端始终没看到断开」才红。

## 不变量

- 产品行为不变：`CoreDaemon` 的判死路径、`kill()` 位点、fatal 文案与时限
  （[core-remote.md 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)）都不改；
  本次只动用例的观测方式。
- 同段其它断言的语义与阈值不变：`silenceDeadlineMs=60` / `silenceRecheckMs=40` 的注入、
  「判死在死线 + 宽限的量级内完成」的 `< 1_000ms` 上限、fatal 文案里的 `silent for` 都保留。
- 相邻用例不受影响：`fake.closed() === 0`（「沉默期间链路未被斩断」）仍读瞬时值——
  它断言的是「**没有**断开」，不该等，语义方向相反。

## 回归测试

- **RT-1**：判死之后，对端在合理时限内记账到断开——断言改成等对端 close 到账（落点：
  `src/test/remoteCoreDaemon.test.ts` 的「沉默判定：pong 武装、沉默判死」段的
  `判死确实断开了链路`）。
- **RT-2**：把「对端 close 晚于 fatal」的时序固定下来时该断言仍绿——用假远端把 close 记账
  推迟 50ms（模拟 CI 上跨轮派发与真实远端的一次网络往返），断言仍成立
  （落点：同上，`startFakeRemote` 增加 `deferCloseAccounting` 开关，并在该段用它跑一次判死）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run test:unit -- remoteCoreDaemon` | 部分验证 | 本机 6 核，8 / 16 路并发压测 240 份全绿，未复现该竞态；红证据取 CI run `45512523867` 的 `smoke / tests` job（`FAIL 判死确实断开了链路`，同文件其余 67 条绿、`docs-lint` 与 `rust-tests` 全绿）。偶发率低于本机可复现阈值，因此按 RT-2 把时序固定下来 |
| 回归用例（修复前，RT-2 确定性时序） | `npm run test:unit -- remoteCoreDaemon` | 红 | 假远端把对端 close 记账推迟 50ms（`deferCloseAccounting`）后稳定复现：`FAIL 判死确实断开了链路`，67 通过 / 1 失败；同段「沉默超过死线 + 宽限后判死 fatal」「判死在死线 + 宽限的量级内完成」仍绿，证明红的确实是断链观测而非判死本身 |
| 回归用例（修复后，RT-1 / RT-2） | `npm run test:unit -- remoteCoreDaemon` | 绿 | 68 通过 / 0 失败；同一份「记账推迟 50ms」的夹具下 `判死确实断开了链路` 转绿，断言强度不降（仍要求对端最终记账到断开，只是改成等待到账） |
| 反向性质：kill 没发生时该断言仍能红 | 临时把断言前移到 fatal 落地瞬间 | 部分验证 | 修复前在同一夹具下稳定红（见上两行）；说明断言没有退化成恒真——它读的是对端 close 计数，kill 不发生就不会到账 |
| 相邻用例不受影响 | `npm run test:unit -- remoteCoreDaemon` | 绿 | 「沉默期间链路未被斩断」仍读瞬时值（断言「没有」断开，语义方向相反，不该等），与重连段的 `重开是全新连接` 一并绿 |
| 单测全量 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（跳过的是环境前置不满足的 `sidebarFiles` / `sidebarDocViewGit`）；`docsLint` 与 `docsLintLocalOnlyPaths` 一并绿 |
| 静态检查 | `npm run check-types` / `npm run check-types:e2e` / `npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
