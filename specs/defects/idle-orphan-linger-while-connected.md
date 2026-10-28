---
status: 已修
---

# 缺陷：控制连接存活期间，满宽限的全 idle 孤儿永不被收尾

specs/031（[docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md)
US-65 验收第 5 条 / [docs/core/core-daemon.md 第 5 节](../../docs/core/core-daemon.md#5-生命周期与计数)）：
全 idle 的孤儿满 30s 宽限后由 daemon 终止并移出孤儿表。现状是这条收尾**只在最后一条
控制连接断开之后才可能发生**——只要还有连接在册（用户把工作区切到后台运行后继续用
应用），完成任务转 idle 的孤儿 Core 会一直存活，成为无人管理的常驻进程。

## 现状

- 孤儿清扫（`OrphanRegistry::sweep`）在 daemon 监听循环 `wait_for_stop_or_idle`
  （`core-rs/src/remote.rs`）里执行，循环本身不区分连接数——但**唤醒与等待**有洞：
- 「有连接、无孤儿」时循环阻塞在 `drained.wait()`（无超时）。此后孤儿插入
  （detach / 断链孤儿化）与忙闲翻转（`feed_orphan_line` 更新 `entry.busy`）都发生在
  连接服务线程里，**不唤醒监听循环**——清扫在连接存活期间从未执行。
- `register` 同样不唤醒：首条连接落在循环的初始 wait 窗口内时，循环睡满整个窗口
  （30s）才开始清扫与判定。
- 后台运行的任务完成后（running → idle），孤儿满 30s 宽限也不会被收尾：Core 与
  daemon 一起常驻，直到用户退出应用（连接断开才唤醒循环）。孤儿的空闲退出判定
  （AC-17）同样依赖这条循环——阻塞期间 daemon 不会误退，但该收的尾也收不了。
- 既有 e2e 未覆盖：US-64 的存活观察窗（35s）里任务仍在跑（非 idle，收不了是正确
  语义），US-65 认领前宿主已强杀（连接已断，循环被 `unregister` 唤醒）。

## 期望

- 孤儿清扫独立于连接事件的时序：监听循环在「有连接」分支也按 1s 封顶轮询——与
  「有孤儿在册期间按 1s 轮询」的既有口径一致（孤儿忙闲变化没有事件通道，轮询是
  唯一的回收手段）。满 TTL 的全 idle 孤儿在连接存活期间照常终止并移出孤儿表。
- 空闲退出判定不变：仍以「无连接且无孤儿」持续 30s 为准；非 idle 孤儿在跑时
  daemon 不退出（AC-17）。

## 不变量

- 忙碌孤儿不收尾；全 idle 孤儿满 TTL 才终止（宽限口径不变）。
- 孤儿崩溃不重启，由清扫移出。
- `shutdown` 帧的全局停机、连接断开的逐 channel 分叉（非 idle 孤儿化 / idle 终止）
  语义不变。
- daemon 空退的状态文件清理路径不变。

## 回归测试

- **RT-6**：`wait_for_stop_or_idle` 在有连接在册时插入全 idle 孤儿，TTL 满后被清扫
  终止（`core-rs/src/remote_tests.rs`，stub handle 观察 kill）。
- **RT-7**：e2e SSH 全流程（与 specs/defects/orphan-completion-unread-light.md 的
  RT-5 同一条用例）：后台运行 → 任务在孤儿期完成 → **连接存活期间**孤儿被收尾 →
  daemon 空退 → 重开绿灯。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-6（修复前） | `cargo test idle_orphan_is_swept`（修复后先落的用例，对修复前代码跑） | 红 | detach 后孤儿转 idle，TTL（测试注 200ms）满 2s 仍未被收尾——`wait_killed` 超时；修复前用探针证实孤儿在表、忙闲已翻转，监听循环却停在没有唤醒的等待里 |
| RT-6 / RT-7（修复后） | `cargo test idle_orphan` + 全量 `cargo test` | 绿 | 有连接在册时满 TTL 的全 idle 孤儿被收尾（stub handle 观察 kill）；全量 1025 项无回归 |
| RT-7（修复后） | `npm run test:e2e:ssh -- remoteTaskSurvival -g 离场完成` | 绿 | 4.2m 全流程：连接存活期间孤儿被收尾 → daemon 空退 → 重开绿灯（与 specs/defects/orphan-completion-unread-light.md 的 RT-5 是同一条用例——它同时锁两个缺陷的修复） |
| 诊断副产品 | `register` 补 `notify_all` | 绿 | 修复中顺带补上：首条连接落在监听循环初始 wait 窗口内时，循环原本睡满整个 30s 窗口才开始清扫与空闲判定；`register` 现在唤醒它，随 RT-6 一并验证 |
