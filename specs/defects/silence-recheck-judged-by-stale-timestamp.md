---
status: 已修
---

# 缺陷：探针宽限按「陈旧时间戳」判死，进程卡顿超过宽限即误杀活链路

Host 侧沉默看门狗在探针宽限期结束后，用 `Date.now() - lastInboundAt` 判断这期间有没有
入站字节。可是 `lastInboundAt` 只有在事件循环跑到 `link.onData` 回调时才会前移——本进程
被调度出去（CI 上 2 核 runner 同时跑 4 个测试文件、GC、内核把 socket 数据排在内核缓冲里）
时，宽限定时器到期、甚至超期很久才被执行，此时内核缓冲里早就有 pong 了，但回调还没轮到。
判据于是看到「陈旧的 lastInboundAt」，把活链路判死。

这是 [`docs/core/core-remote.md` 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)
明确要求宽限吸收的一种情形（「本进程卡顿（定时器迟到、入站帧积压在内核缓冲）」），即代码与
该节基线不一致。

## 现状

- 判据位置：`src/host/standalone/CoreDaemon.ts` 的 `finishSilenceRecheck`。它拿「现在到
  上次入站的时间差」跟宽限的名义时长比：

  ```text 示意（缺陷形态，修复后已改为入站序号比对）
  silentFor = Date.now() - lastInboundAt
  if (silentFor < recheckMs) { 回到常规检查 }
  否则判死
  ```

  `recheckMs` 是宽限的名义时长，但这里拿它跟**实际流逝时间**比。`silenceTimer` /
  `recheckTimer` 都是普通 `setTimeout`：事件循环被占住时它只保证「不早于」，不保证
  「不晚于」，迟到量可以是任意长。
- 反例形态（probe 实测，见验证记录）：注入 `heartbeatIntervalMs=20` /
  `silenceDeadlineMs=80` / `silenceRecheckMs=40`，业务链路被大帧占住不再写字节、心跳链路
  完全健康。空闲时 0/6 判死；每 30ms 同步卡住事件循环 50ms 后 **6/6 判死**，文案正是
  「silent for 120ms ... declaring it dead」——被杀的链路其实一直在回 pong。
- CI 现场：`smoke.yml` 的 tests job 只有 2 核，`npm run test:unit` 默认 4 路并发
  （`scripts/run-tests.mjs` 的 `min(4, cpus)`）。run `45292322374` 的 tests job 里
  `remoteCoreDaemon` 红在这一条：

  ```
  FAIL RT-1 大帧停顿期间心跳独立通路保活（不判死）
  => remoteCoreDaemon 失败（2781ms）
  ```

  同一文件在本地单跑稳定通过（本机 6 核、无并发），属负载相关的偶发。
- 判死文案本身不可区分：把时间差当成「链路静默了多久」之后，日志说的「silent for
  120ms」并不代表链路真的静默了 120ms。

## 期望

- 宽限期收口只回答一个问题：**从探针发出到收口之间，有没有新的入站证据**。判据用计数器
  而不是时间戳——`noteInbound` 每次前移时间基准时同时递增一个入站序号，探针发出时记下
  当时的值，收口时比较它是否变了。事件循环迟到多久都不影响结论：迟到期间到达的 pong
  已经被 `link.onData` 记过，序号必然不同。
- 迟到的收口不再重排常规检查来「重新等一遍」：`scheduleSilenceCheck` 会按
  `lastInboundAt + deadline` 算剩余时间，剩余为负时立刻进入下一轮探针——在真实断连
  场景下这正是想要的（继续探、到最后按存量判死），不会因为卡顿把判死无限推迟。
- 真实断连仍必须在死线 + 宽限的量级内判死：注入 60ms / 40ms 时，
  「沉默超过死线 + 宽限后判死 fatal」与「判死在死线 + 宽限的量级内完成」两条既有用例
  必须继续绿。
- 判死文案里的数字仍是死线 + 宽限的名义值（对外指标，见
  [`docs/core/core-remote.md` 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)），
  不写成实际流逝时间。

## 不变量

- 对外指标不变：默认死线 9s + 宽限 900ms ≤ 10s（`LINK_SILENCE_DEADLINE_BUDGET_MS` 与
  该节一致）。
- 武装时机不变：见到首个 `pong` 才武装，对端不回 `pong` 时永不武装（不误杀）。
- 探针仍同时走两条通路：业务链路 `enqueue(ping)` + 心跳链路 `sendHeartbeatPing()`。
- 存活判据仍是字节级：两条链路上任何入站字节都算活，不要求完整帧。
- 链路退出 / 主动关闭 / 重建链路的收尾路径不变：`stopLinkWatchdog` 仍清空全部看门狗状态，
  下次建链后由首个 pong 重新武装。
- 默认取值不变（1s 心跳 / 9s 死线 / 900ms 宽限）。

## 回归测试

- **RT-1**：探针宽限期间事件循环被卡住、但 pong 已经到达并被记过时，不判死
  （落点：`src/test/remoteCoreDaemon.test.ts` 的
  「探针宽限期间事件循环停顿超过宽限，回来的 pong 仍算活（不判死）」）。
- **RT-2**：真实断连下判死时间不因卡顿判据而失效：注入 60ms / 40ms、对端停止回 pong
  后仍在量级内落成 fatal（落点：同文件既有的「沉默超过死线 + 宽限后判死 fatal」与
  「判死在死线 + 宽限的量级内完成」，本修复后必须仍绿）。
- **RT-3**：RT-1 的被测机制仍在（大帧停住、心跳链路保活）——既有「RT-1 大帧停顿期间
  心跳独立通路保活（不判死）」继续绿（落点：同文件）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| CI 实证（修复前） | run `45292322374` 的 `tests` job | 红 | `FAIL RT-1 大帧停顿期间心跳独立通路保活（不判死）`；同 run 的 docs-lint / rust-tests / 其余单测全绿 |
| 根因探针（修复前） | 临时脚本复刻注入窗口 + 反复同步卡顿 | 红 | 空闲时 0/5 判死；每 50ms 卡住事件循环 50ms 后 **5/5 判死**，文案 `silent for 100ms ... declaring it dead`——心跳链路的 pong 一直在回 |
| 回归用例（修复前，RT-1） | `npm run test:unit -- remoteCoreDaemon` | 红 | `FAIL 探针宽限期间事件循环停顿超过宽限，回来的 pong 仍算活（不判死）`；同批 62 通过。紧随其后的「卡顿结束后请求仍可用」是绿的，证明被判死的是活链路 |
| 回归用例（修复后，RT-1 / RT-3） | `npm run test:unit -- remoteCoreDaemon` | 绿 | 63 通过 / 0 失败；新增用例转绿，既有「RT-1 大帧停顿期间心跳独立通路保活（不判死）」「RT-1 心跳链路的 pong 独立往返」不受影响 |
| 反向性质：真实断连仍按时判死 | 临时脚本（对端停止回 pong，socket 不断） | 绿 | 5/5 判死，80–114ms（死线 + 宽限 = 100ms），未因序号判据被推迟 |
| 根因探针（修复后） | 同一条临时脚本 | 绿 | 三种卡顿形态（50ms / 80ms，3–4 轮）判死 0/3，与修复前 5/5 对照 |
| 稳定性 | `node out/src/test/remoteCoreDaemon.test.js` × 5 | 绿 | 每轮 63 通过 / 0 失败 |
| 单测全量 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（跳过的是环境前置不满足的 `sidebarDocViewGit` / `sidebarFiles`，与本缺陷无关） |
| 静态检查 | `npm run check-types` / `npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | docsLint 与 docsLintLocalOnlyPaths 全通过 |
| 真实 CI 复跑 | 推送后 smoke 的 `tests` job | not-run | 需推送后由 PR 冒烟车道验证；本机 6 核无法复现 CI 的调度压力，改用确定性的卡顿复现（见上两行） |
