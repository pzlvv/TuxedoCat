# ADR-0006：daemon 对内层帧的两类只读窥探

- 状态：已采纳
- 日期：2026-10
- 规格：[docs/core/core-daemon.md 第 4 节](../core/core-daemon.md#4-通道模型)（通道模型）
  与[第 5 节](../core/core-daemon.md#5-生命周期与计数)（生命周期与计数），随 specs/031 落地

## 背景

daemon 的既有不变量是「不解读内层帧，只按 channel 转发」：daemon 与 Core / Host 之间
只隔着薄薄一层信封，内层契约（[docs/core/standalone-core.md 第 5.2 节](../core/standalone-core.md#52-帧类型)）的任何漂移都与 daemon 无关。这条
不变量让 daemon 对总线协议演进零耦合，是它敢常驻、敢跨版本共存的前提之一。

specs/031（远程任务后台运行与认领重连）要求 daemon 在宿主离场后替 Core 做两件判断：

- **孤儿化还是终止**：连接断开时，「有非 idle 会话」的 Core 要孤儿化存活，全 idle 的
  Core 照旧终止——daemon 必须知道每个 Core 最近是否非 idle；
- **认领时重放什么**：孤儿期间宿主不在场，完成未读与挂起的用户请求都要在新宿主接上
  后补发——daemon 必须缓存孤儿期间的快照序列与请求帧。

这两个事实 Core 都已经在推（全量 `sessionRuntimeChanged` 快照、`request` 信封帧），
问题只在 daemon 从来不看它们。

## 决策

daemon 对 Core → Host 方向的内层帧增加**仅有的两类只读窥探**，其余帧保持不解读：

1. 识别 `sessionRuntimeChanged` 快照信封：维护每 channel 的忙闲缓存（孤儿化判据），
   并把快照原文追加进孤儿重放缓冲（认领重放的原料）；快照形状解不出按忙 fail-safe
   并落诊断（方向是保活，不静默杀任务）。
2. 识别 `request` 信封帧：原文暂存进重放缓冲；超过 Core 应答时效（1 小时）的不再重放。

实现落点：`core-rs/src/daemon.rs`（`peek_frame` / `feed_orphan_line`）、
`core-rs/src/daemon_protocol.rs` 头注释；帧出口路由见同文件 `RoutableSink`。

可行的前提是 **daemon 与 Core 是同一个二进制**（[docs/core/core-daemon.md 第 1 节](../core/core-daemon.md#1-能力)第 8 条）：
版本天然一致，窥探解析与 Core 的发送格式同源，不存在「老 daemon 解新帧」的分叉——
分叉由按指纹的部署隔离兜住。

## 替代方案（被否决）与后果

- **Core 感知 detach / reattach（新增总线内层帧，重连后 Core 重发挂起请求与全量快照）**：
  改动面大（总线协议 + Core + 宿主三层），Core 需要维护 detached 状态机；daemon 侧
  缓冲重放以零总线协议代价达成同样效果。否决。
- **宿主落盘忙闲级别做差分种子（退出前把忙集合写进 workspace-state.json）**：崩溃路径
  没有落盘机会（specs/031 AC-5 覆盖不到），时点也陈旧；daemon 缓存真实快照序列是同一
  事实的无损版本。否决。
- **daemon 合成「完成事件」而非原样重放快照**：伪造总线帧比原样重放耦合更深，且完成
  未读的差分机制本来就要吃快照序列。否决。

后果与代价：

- daemon 与内层契约的两个成员（`sessionRuntimeChanged` 信封形状、`request` 信封形状）
  建立了只读耦合——内层帧信封形状变更必须同步 daemon 的窥探点（`peek_frame`）；
  解析失败按忙 fail-safe，契约漂移的失效方向是「多陪跑」而不是「误杀」。
- daemon 进程内存多了孤儿重放缓冲（有 200 帧上限）与每 channel 忙闲缓存；孤儿清零后
  这些状态一并释放。
