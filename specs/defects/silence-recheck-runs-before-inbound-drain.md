---
status: 已修
---

# 缺陷：宽限收口先于入站字节入账，进程卡顿后仍误杀活链路

`CoreDaemon` 的沉默看门狗在探针宽限到期时判活，判据是「探针发出到收口之间入站序号有没有
前移」。但收口是一个 `setTimeout` 回调，跑在事件循环的 **timers 阶段**；而 `noteInbound`
是在 socket `data` 回调里跑，属于 **poll 阶段**。宿主进程被调度出去（CI 的 2 核 runner
同时跑 4 个测试文件、GC、内核把 socket 数据排在内核缓冲里）超过宽限时，恢复后 Node 先跑
timers 阶段——宽限收口看到序号没变就判死，紧接着 poll 阶段才把早已到达的 pong 读进来。
链路其实是活的。

这是 [docs/core/core-remote.md 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)
要求宽限吸收的一类情形（「本进程卡顿（定时器迟到、入站帧积压在内核缓冲）」），即代码与该节
基线不一致。也是
[`silence-recheck-judged-by-stale-timestamp`](silence-recheck-judged-by-stale-timestamp.md)
换成序号判据之后仍然剩下的那一半：序号解决了「时间戳陈旧」，没解决「收口跑在入站入账之前」。

## 现状

- 相关代码（`src/host/standalone/CoreDaemon.ts`）：

  ```text 示意（收口只比序号，入账仍只发生在 link.onData）
  finishSilenceRecheck() {
    if (this.inboundSeq !== this.recheckBaselineSeq) return 回到常规检查
    判死
  }
  ```

  `finishSilenceRecheck` 只比 `inboundSeq` 与 `recheckBaselineSeq`，两者相等即判死。
  `noteInbound` 只能由 `link.onData` / `link.onClose` 触发，即必须等事件循环进到 poll 阶段。
- 时序（同一轮事件循环迭代内完成）：

  ```text 示意
  timers 阶段   silenceTimer 到期 → beginSilenceRecheck：发探针、记 baselineSeq、武装 recheckTimer
  poll 阶段     socket 读到 pong 或大帧字节 → noteInbound：inboundSeq += 1
  ...           （进程被调度出去，越过整个宽限窗口；期间对端仍在写字节，落进内核缓冲）
  timers 阶段   recheckTimer 到期 → finishSilenceRecheck：inboundSeq 仍等于 baselineSeq → 判死
  poll 阶段     socket 读到宽限期内到达的 pong → 太晚了，链路已被 kill
  ```

  关键在于**一轮迭代里 timers 阶段恒先于 poll 阶段**：只要「宽限到期」与「内核缓冲里的
  字节被读出」两条事实在同一轮迭代里先后到齐，收口就一定先看到「没变」。
- 观测到的形态（probe 实测，见验证记录）：注入 `heartbeatIntervalMs=20` /
  `silenceDeadlineMs=80` / `silenceRecheckMs=40`，对端在收到探针的那一刻**先写出 pong**、
  然后宿主被同步占住 150ms。恢复后稳定 3/3 判死，文案
  `silent for 120ms (no pong on the heartbeat link, no inbound bytes on the business link)`，
  而被杀的链路在宽限到期之前就已经收到了 pong。
- CI 现场：`smoke.yml` 的 `tests` job（2 核，`npm run test:unit` 默认 4 路并发）在
  run `45404765315` 上 `remoteCoreDaemon` 红在这一条：

  ```
  FAIL RT-1 大帧停顿期间心跳独立通路保活（不判死）
  => remoteCoreDaemon 失败（3172ms）
  ```

  RT-1 的假远端与本文件共用一条事件循环：宿主被调度出去时假远端一起停摆，恢复后
  「探针的 pong」与「宽限收口」正好撞在同一轮迭代里，于是整份用例偶发红。本地 16 核
  空闲时单跑 / 并发跑都复现不出来（8 轮 × 6 并发、16 个忙循环线程压 4 轮全绿）。
- 判死文案里的「silent for 120ms」因此不可作为证据：它把「宽限的名义时长」当成了实际
  静默时长，而真实情况是对端在宽限内一直在写。

## 期望

- 宽限收口在判死之前必须**先把已经到达的入站字节收进来**，再问「序号变没变」：收口这一步
  先排空两条链路上已完成读取的字节（或等价地让收口跑在 poll 阶段之后），使同一轮迭代里
  迟到的入站证据也参与判定。
- 判定语义不变：只回答「探针发出到收口之间有没有新的入站证据」，不看时间差、不看入站
  发生在宽限的哪一刻；宽限期内到达的字节（心跳 pong、业务帧、半个大帧）一律算活。
- 真实断连仍在死线 + 宽限的量级内判死：对端真的不回 `pong`、socket 也不断时，收口之后
  依然没有入站证据，必须落成 fatal（既有「沉默超过死线 + 宽限后判死 fatal」与「判死在
  死线 + 宽限的量级内完成」两条用例继续绿）。
- 判死的 kill 仍是唯一出口，`silenceFatal` 的文案与上报路径不变。

## 不变量

- 武装时机不变：见到首个 `pong` 才武装；对端从不回 `pong` 时永不武装（不误杀）。
- 探针仍同时走两条通路：业务链路 `enqueue(ping)` + 心跳链路 `sendHeartbeatPing()`。
- 存活判据仍是字节级：两条链路上任何入站字节都算活，不要求完整帧。
- 常规检查（排死线）仍按 `lastInboundAt + silenceDeadlineMs` 计算，不因本次修复改判据。
- 链路退出 / 主动关闭 / 重建链路的收尾路径不变：`stopLinkWatchdog` 仍清空全部看门狗状态，
  下次建链后由首个 `pong` 重新武装。
- 默认取值不变（1s 心跳 / 9s 死线 / 900ms 宽限），`LINK_SILENCE_DEADLINE_BUDGET_MS`
  仍是死线 + 宽限。

## 回归测试

- **RT-1**：对端在收到探针时**先写出 pong**，随后宿主被同步占住超过宽限（模拟被 OS 调度
  出去、字节积压在内核缓冲）；恢复后不得判死，链路仍可用（落点：
  `src/test/remoteCoreDaemon.test.ts` 的「宽限期内到达的 pong 不因收口早于入站入账被判死」）。
- **RT-2**：同一夹具下真的不回 `pong` 时仍在死线 + 宽限的量级内判死 fatal（落点：同文件
  既有的「沉默超过死线 + 宽限后判死 fatal」与「判死在死线 + 宽限的量级内完成」，本次修复
  后必须仍绿）。
- **RT-3**：大帧停顿期间心跳独立通路保活（落点：同文件既有的「RT-1 大帧停顿期间心跳
  独立通路保活（不判死）」与「RT-1 心跳链路的 pong 独立往返」，CI 上那条偶发红必须消失）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| CI 实证（修复前） | run `45404765315` 的 `tests` job | 红 | `FAIL RT-1 大帧停顿期间心跳独立通路保活（不判死）`；同 run 的 docs-lint / rust-tests 全绿，其余单测绿 |
| 根因探针（修复前） | 临时脚本：对端静默到死线过期后在宽限内写 pong，再同步占住宿主 260ms | 红 | pong 于 171ms 写出（宽限 277ms 到期），收口在 431ms 读到 `seq=4 baseline=4` 即判死，紧接着 poll 阶段才把 pong 读进来（`seq 4 -> 5`）；文案 `silent for 280ms ... declaring it dead` |
| 回归用例（修复前，RT-1） | `npm run test:unit -- remoteCoreDaemon`（等价 `node out/src/test/remoteCoreDaemon.test.js`） | 红 | 67 通过 / 1 失败，`FAIL RT-1 宽限期内到达的 pong 不因收口早于入站入账被判死`；同段的「RT-1 宽限内对端写出的 pong 早于宽限到期」与「RT-1 宽限用例结束后请求仍可用」是绿的，证明被判死的是活链路 |
| 回归用例（修复后，RT-1 / RT-3） | `npm run test:unit -- remoteCoreDaemon` | 绿 | 68 通过 / 0 失败；新增用例转绿，既有「RT-1 大帧停顿期间心跳独立通路保活（不判死）」「RT-1 心跳链路的 pong 独立往返」仍绿 |
| 反向性质（RT-2）：真实断连仍按时判死 | `npm run test:unit -- remoteCoreDaemon` | 绿 | 「沉默超过死线 + 宽限后判死 fatal」「判死在死线 + 宽限的量级内完成」「判死确实断开了链路」三条仍绿，判死未被推迟到量级之外 |
| 反向性质：不回 pong 不误杀 | `npm run test:unit -- remoteCoreDaemon` | 绿 | 「不回 pong：建链后列目录可用」「长静默不误杀：请求仍可用」「沉默期间链路未被斩断」三条仍绿 |
| 稳定性 | `node out/src/test/remoteCoreDaemon.test.js` × 5 + `scripts/run-tests.mjs remoteCoreDaemon --jobs 1` | 绿 | 每轮 68 通过 / 0 失败 |
| 相邻用例 | `node scripts/run-tests.mjs coreDaemon conversationSpaceClearHost` | 绿 | 同样驱动 `CoreDaemon` 的两个文件无回归 |
| 单测全量 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（跳过的是环境前置不满足的 `sidebarFiles` / `sidebarDocViewGit`）；docsLint 与 docsLintLocalOnlyPaths 一并绿 |
| 静态检查 | `npm run check-types` / `npm run lint` | 绿 | 三份 tsconfig 与 eslint 均无输出 |
| 真实 CI 复跑 | smoke run `45494325991`（提交 ce498ae） | 绿 | 六个 job 全绿；`tests` job 里 `remoteCoreDaemon` 68 通过 / 0 失败，原偶发红的「RT-1 大帧停顿期间心跳独立通路保活（不判死）」与新增的「RT-1 宽限期内到达的 pong 不因收口早于入站入账被判死」同时绿；全量 136 通过 / 0 失败 |
