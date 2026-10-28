---
status: 已收敛
---

# 改动规格：远程任务后台运行与认领重连

SSH 远程工作区的在跑任务，在宿主退出或工作区标签页关闭后继续留在远端 Core 进程里执行；
关闭动作经过三选对话框（后台运行 / 立即关闭 / 取消），其中「后台运行」只断开控制连接、
不终止 Core。daemon 的生命周期默认策略随之调整为：连接断开时非 idle 的 Core 孤儿化存活、
idle 的 Core 照旧终止；下次连接 `openWorkspace` 命中孤儿时认领既有 Core，走既有的连接态
重放路径恢复消息流与运行时状态，孤儿期间挂起的用户请求重新弹出，孤儿期间任务的完成
照常以未读提醒呈现。本地工作区不受影响（本地没有 daemon，没有「后台」可去）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/core-daemon.md](../../docs/core/core-daemon.md) | [第 5 节 生命周期与计数](../../docs/core/core-daemon.md#5-生命周期与计数) | 修改 | 「连接断开即关闭该连接的全部 Core」改为：非 idle 的 Core 孤儿化存活、idle 的 Core 照旧终止；daemon 空闲判定纳入孤儿忙闲 |
| [docs/core/core-daemon.md](../../docs/core/core-daemon.md) | [第 6 节 重启](../../docs/core/core-daemon.md#6-重启) | 修改 | 孤儿（未认领）Core 崩溃不重启，移出孤儿表 |
| [docs/core/core-daemon.md](../../docs/core/core-daemon.md) | [第 9 节 不覆盖范围](../../docs/core/core-daemon.md#9-不覆盖范围) | 修改 | 移除「Host 断开后 Core 的存活与重连」豁免；断线重连（宿主侧自动重试）保留豁免 |
| [docs/core/core-daemon.md](../../docs/core/core-daemon.md) | [第 10 节 验收要点](../../docs/core/core-daemon.md#10-验收要点) | 修改 | 新增孤儿化 / 认领 / 空闲新语义的验收项 |
| [docs/core/core-daemon.md](../../docs/core/core-daemon.md) | [第 7.2 节 帧类型](../../docs/core/core-daemon.md#72-帧类型) | 修改 | 新增 `detachWorkspace` 帧；`workspaceClosed` 的 reason 增加 `detached`；「不解读内层帧」修正为两类只读窥探例外 |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 2.2 节 选项](../../docs/core/core-remote.md#22-选项) | 修改 | `--idle-exit` 的空闲判定口径改为「无控制连接且无非 idle 孤儿会话」 |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 2.5 节 连接与生命周期](../../docs/core/core-remote.md#25-连接与生命周期) | 修改 | 连接断开行为、孤儿期间的会话等待与挂起请求 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 5 节 Connection 生命周期](../../docs/core/client-connection.md#5-connection-生命周期) | 修改 | 远程 Connection 的销毁分叉：用户关闭（现行）与宿主退出 detach |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 9 节 落盘与恢复（宿主侧）](../../docs/core/client-connection.md#9-落盘与恢复宿主侧) | 修改 | 启动恢复对后台运行工作区的认领行为 |
| [docs/core/client-connection.md](../../docs/core/client-connection.md) | [第 10 节 不覆盖范围](../../docs/core/client-connection.md#10-不覆盖范围) | 修改 | 移除「断线重连（重启后重新接入）」豁免 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 8.2 节 关闭](../../docs/hosts/electron-multi-workspace.md#82-关闭) | 修改 | SSH 工作区关闭的三选对话框；本地工作区维持现有两态确认 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 未读完成呼吸补一条武装来源：孤儿期间的完成在恢复认领后照常武装（当前已只认相邻两次快照的差分） |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [EP-9 多工作区](../../docs/features/user-stories/desktop.md#ep-9-多工作区桌面端) | 新增 | US-64 关闭时的后台运行选择、US-65 后台任务的重连与恢复 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | US-64 / US-65 登记 `electron-ssh` 车道用例 |

## 用户场景与验收标准

- 场景 1：关闭有在跑任务的 SSH 工作区标签页
  - **AC-1**（FR-001）：GIVEN SSH 工作区有非 idle 会话 WHEN 关闭该标签页 THEN 弹三选对话框（后台运行 / 立即关闭 / 取消），默认焦点落在取消
  - **AC-2**（FR-001）：GIVEN SSH 工作区全部会话 idle WHEN 关闭该标签页 THEN 直接关闭，不弹对话框
  - **AC-3**（FR-001）：GIVEN 本地工作区有非 idle 会话 WHEN 关闭该标签页 THEN 弹现有两态确认，不出现「后台运行」项
- 场景 2：后台运行（detach）
  - **AC-4**（FR-003）：GIVEN AC-1 的对话框 WHEN 选「后台运行」THEN 标签页关闭、宿主不向 daemon 发关闭工作区请求，远端 Core 进程仍在且会话继续执行
  - **AC-5**（FR-005）：GIVEN 宿主崩溃 / 被强杀（无对话框）WHEN 工作区有非 idle 会话 THEN daemon 侧孤儿化该 Core，任务继续执行
  - **AC-6**（FR-005）：GIVEN SSH 工作区全部会话 idle WHEN 宿主退出 THEN 该 Core 照旧终止（不孤儿化）
- 场景 3：重开认领
  - **AC-7**（FR-006）：GIVEN 工作区已后台运行 WHEN 从最近列表重开 THEN 打开的是原 Core 进程（远端不出现第二个 Core），消息流与会话运行时状态恢复，在跑任务继续可见
  - **AC-8**（FR-006）：GIVEN 孤儿期间会话有新落盘内容 WHEN 重开该工作区并打开会话 THEN 孤儿期间产生的消息可见
  - **AC-9**（FR-006）：GIVEN 孤儿期间会话弹出了权限确认或提问（无人应答）WHEN 重开认领 THEN 该请求重新弹出，应答后会话继续执行
  - **AC-10**（FR-006）：GIVEN 客户端 A 在线打开工作区 W WHEN 客户端 B 打开 W THEN B 得到独立的新 Core，不认领 A 的
- 场景 4：退出整个 Electron
  - **AC-11**（FR-002）：GIVEN 两个 SSH 工作区均有非 idle 会话 WHEN 触发应用退出 THEN 按标签页顺序逐个工作区弹三选对话框
  - **AC-12**（FR-002）：GIVEN 退出确认链进行中 WHEN 任一工作区选「取消」THEN 退出中止，应用继续运行
  - **AC-13**（FR-002）：GIVEN 工作区 A 选「立即关闭」、工作区 B 选「后台运行」WHEN 退出完成 THEN A 的 Core 已终止，B 的 Core 仍在远端运行，daemon 不退出
  - **AC-14**（FR-002）：GIVEN SSH 工作区空闲、本地工作区忙碌 WHEN 触发应用退出 THEN SSH 工作区不弹框（断链走默认策略），本地工作区维持现有确认
- 场景 5：立即关闭
  - **AC-15**（FR-004）：GIVEN AC-1 或 AC-11 的对话框 WHEN 选「立即关闭」THEN daemon 收到关闭工作区请求，Core 进程终止（与现行关闭路径一致）
- 场景 6：daemon 空闲与孤儿上限
  - **AC-16**（FR-007）：GIVEN daemon 无控制连接且孤儿会话全部 idle WHEN 持续 30 秒 THEN daemon 自行退出并清状态文件
  - **AC-17**（FR-007）：GIVEN 孤儿会话非 idle WHEN 距最后一条连接断开已超过 30 秒 THEN daemon 不退出，Core 继续执行
- 场景 7：边界
  - **AC-18**（FR-005）：GIVEN 孤儿 Core 崩溃 WHEN 之后对同一工作区发起 openWorkspace THEN 按无孤儿处理（新起 Core），daemon 不重启崩溃的孤儿
  - **AC-19**（FR-005）：GIVEN 退出口径弹不出对话框（窗口已销毁）WHEN 应用退出 THEN 直接断链，由 daemon 默认策略接管（与 AC-5 同语义）
- 场景 8：离场期间完成的未读
  - **AC-20**（FR-006）：GIVEN 任务在孤儿期间完成 WHEN 重开认领该工作区 THEN 该会话在对话列表项与未激活的标签页上亮「任务完成」绿色呼吸灯，与本地任务完成同一表现，阅读后清除
  - **AC-21**（FR-006）：GIVEN 重开认领的标签页是当前激活项、用户正看着该对话 WHEN 认领完成、孤儿期间的完成事实送达 THEN 该完成当场按已读处理，呼吸灯实际不可见（与「正看着 = 已读」的既有语义一致），会话内容可见

## 功能需求

### FR-001：SSH 工作区关闭的三选对话框

关闭「有非 idle 会话」的 SSH 工作区标签页时，弹出三选对话框：后台运行 / 立即关闭 / 取消，
默认焦点落在取消（防误关）。忙碌判据与现有关闭确认同一份事实：宿主缓存的会话运行时快照
（`sessionBusyLevel` 非 idle，含 waiting）按工作区聚合。本地工作区维持现有两态确认；
SSH 工作区全部会话 idle 时不弹框直接关闭。

### FR-002：退出整个应用时逐工作区确认

所有触发应用退出的出口统一经过同一条确认链：对每个有非 idle 会话的 SSH 工作区，按标签页
顺序逐个弹 FR-001 的三选对话框（文案带工作区标识与任务状态）；任一「取消」中止整个退出。
本地忙碌工作区维持现有总确认，与 SSH 工作区的逐区确认在同一链条上先后执行。各工作区的
选择记入一张决策表，退出继续时在清理阶段应用。

### FR-003：后台运行的 detach 语义

选「后台运行」时：宿主不向 daemon 发关闭工作区请求。关标签页场景（daemon 连接仍存活）
对该 channel 发 detach 请求，Core 移入孤儿表、连接继续服务其余工作区；应用退出场景仅
断开自己的控制连接。两种路径 daemon 侧效果一致。该工作区的 Core 继续运行：会话执行、
后台 Bash 任务（含完成通知注入会话）照常。关标签页场景下该工作区从打开集合移除（最近
列表保留）；应用退出场景下打开集合不动，下次启动照常恢复。弹不出对话框的退出口径
（窗口已销毁）同样只断链。

### FR-004：立即关闭语义

选「立即关闭」时走现行关闭路径：宿主向 daemon 发关闭工作区请求，daemon 关闭该 Core，
等待有超时上限，不阻塞退出流程的其余部分。

### FR-005：daemon 的孤儿化默认策略

控制连接断开（正常退出、崩溃、心跳超时，一律同口径）时：该连接上有非 idle 会话的 Core
孤儿化存活，继续执行会话工作；全部会话 idle 的 Core 照旧终止。孤儿期间：daemon 持续
消费孤儿 Core 的帧通道（Core 不因无宿主而阻塞）；Core 发出的用户请求（权限确认 /
AskUserQuestion）无人应答时挂起，会话处于 waiting；孤儿 Core 崩溃不重启，移出孤儿表。

孤儿表按「工作区路径 + 原连接标识」登记，同一 endpoint 上两个客户端各自的孤儿互不覆盖；
登记冲突（同键已存在）落诊断并拒绝插入，不静默覆盖——被覆盖的孤儿 Core 会泄漏成无主
进程，它持有的会话锁（`specs/032-session-exclusive-open`）也不会释放。认领的摘表与句柄
移交是原子的一步，同一孤儿并发认领至多一胜，败者按无孤儿处理。

### FR-006：认领与恢复

对存在孤儿 Core 的工作区发起 `openWorkspace` 时，daemon 不开新进程，把新 channel 指向
该孤儿 Core 并从孤儿表摘除；宿主随后走既有的连接态重放路径（握手、宿主环境重放、逐会话
打开），Core 在重放完成后推送全量会话运行时快照，并把孤儿期间挂起的用户请求重新发给
宿主。三条重开入口（启动恢复的打开集合、最近列表、不可用工作区的重新连接按钮）行为一致。
活跃连接的 Core 不参与认领：两个客户端并发打开同一工作区仍是两个互相独立的 Core，各自
装载的会话的互斥由 `specs/032-session-exclusive-open` 的会话锁承担（后装载者收到占用
错误，不因工作区可并发打开而放宽）。

孤儿期间完成的会话不因宿主离场而被吞：恢复认领后按既有「任务完成」未读语义武装——
对话列表项与未激活的标签页亮绿色呼吸灯，与本地任务完成同一表现，阅读（激活标签页 /
打开对话）后清除；用户正看着的完成（激活标签页内的当前对话）按既有可见性判定当场转
已读，呼吸灯实际不可见。恢复后仍在执行的任务，完成时刻按当时的画面事实正常武装，
与本地任务无差别。

### FR-007：daemon 空闲判定与孤儿上限

SSH daemon 的空闲退出判定从「无控制连接持续 30 秒」改为「无控制连接且无非 idle 孤儿会话
持续 30 秒」；孤儿全部收尾后照旧退出并清状态文件。孤儿 Core 不设 detached 存续上限：
任务跑多久 daemon 就陪多久，结束后随空闲判定正常退出。

## 边界与错误路径

- 「立即关闭」的关闭请求发送失败（链路已断）：不阻塞退出，daemon 侧按断开孤儿化接管，
  任务可能继续运行——以 daemon 侧日志为准，宿主不重试。
- 孤儿期间后台 Bash 任务完成：完成通知照常注入会话并可能唤醒新一轮查询，无宿主参与，
  结果随会话落盘；不承诺任何离场提醒（见非目标）。
- 重开时 SSH 建链失败（凭证失效 / 主机不可达）：现行「无法连接远程主机」占位页与重连
  按钮语义不变；孤儿在远端不受影响，不会因此被清。
- 挂起用户请求的应答等待沿用 Core 既有上限（1 小时）：孤儿超过 1 小时无人应答，该轮按
  既有超时失败路径收尾；之后的认领不再弹出该请求（Core 已无此待决 id）。
- 两个 Electron 实例连同一 endpoint：各自连接独立，「立即关闭」只终止自己连接上的 Core
  （daemon 的按连接隔离语义既有）；两边的孤儿在孤儿表里按连接标识各占一条，互不覆盖、
  各自被自己的客户端认领。
- 后台运行 / 孤儿化的 Core 连同其中的会话实例继续存活，其装载的会话锁不释放：其他实例
  此时装载、变更这些会话会被拒（`specs/032-session-exclusive-open` 的占用错误，键 + 参数，
  能指认持有者 pid 则带上）。任务结束 Core 转全 idle 后还有 30 秒宽限期（FR-007），期间
  会话仍不可装载；之后 Core 退出、锁随内核释放。
- 宿主对孤儿 Core 的退出收尾：客户端重开即认领，或等空闲判定 / `kill` 收场；宿主侧不
  主动向 daemon 查询孤儿清单（非目标的清单管理 UI 延续）。
- 孤儿 Core 全部收尾后，daemon 的状态文件随空闲退出清理；此前的 `kill` / 状态文件语义
  （[docs/core/core-remote.md 第 2.1 / 2.3 节](../../docs/core/core-remote.md#21-动作)）不变。
- macOS 关闭窗口而应用不退出：与现有窗口关闭确认同挂点，同样走本规格的确认链。

## 非目标

- VS Code 宿主的远程工作区（远程工作区当前只在 Electron 实现，daemon 侧改动天然宿主无关）。
- SSH 密钥 / agent 认证、远程凭证加密存储（既有不覆盖范围延续）。
- 宿主离场期间的任务完成推送（系统通知 / 邮件 / 第三方通道）。
- 宿主进程内对断网的自动重连：重连仍由启动恢复、最近列表、重连按钮三类用户动作触发。
- 远端孤儿的清单管理与手动清理 UI（需要时用该指纹二进制 `kill`，既有口径）。
- 跨设备协同：两个客户端共享同一孤儿视图、同时认领同一孤儿——多窗口独立语义保留。

## 对需求基线的影响

新增两个 US，登记进 `docs/features/user-stories/desktop.md` 的 EP-9 多工作区：

- **US-64 关闭时的后台运行选择**：关标签页与退应用时的三选对话框、决策落点（detach /
  立即关闭 / 取消）与本地工作区的口径不变。e2e：`electron-ssh` 车道（真实 SSH 远端，
  新增用例文件；`e2e/playwright.config.ts` 的 `electron-ssh` project `testMatch` 与
  `electron-app` 的 `testIgnore` 同步扩展，见 [e2e/README.md](../../e2e/README.md)）。
- **US-65 后台任务的重连与恢复**：重开认领、孤儿期间消息可见、挂起请求重弹、离场
  期间完成的未读提醒、daemon 空闲新语义。e2e：同上；daemon 侧语义另由 core-rs 单测
  锁定，离场完成的武装判定由 `src/test/completionAttention.test.ts` 锁定。

daemon 侧单测不替代 e2e：`electron-ssh` 车道不进 CI（真实远端依赖），与
`remoteSshExecution.spec.ts` 同口径。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/main.ts`（标签页关闭确认链）、`electron/styledMessageBox.ts`（三选对话框） | `e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-002 | `electron/main.ts`（退出确认链与决策表） | `e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-003 | `src/host/Client.ts`、`src/host/bootstrapCore.ts`（`shutdownCore` 决策表入参） | `e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-004 | `src/host/Client.ts`（现行关闭路径复用） | `e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-005 | `core-rs/src/daemon.rs`（孤儿表、断开收尾分叉） | `core-rs/src/daemon_tests.rs`（含：同 path 两次孤儿化不互相覆盖、并发认领至多一胜）、`e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-006 | `core-rs/src/daemon.rs`（认领）、`src/host/standalone/`（重放路径复用）、`electron/completionAttention.ts`（离场完成的武装来源） | `core-rs/src/daemon_tests.rs`、`src/test/completionAttention.test.ts`、`e2e/electron/remoteTaskSurvival.spec.ts` | 自动 |
| FR-007 | `core-rs/src/daemon.rs`（空闲判定、孤儿上限） | `core-rs/src/daemon_tests.rs` | 自动 |

## 待澄清

（无——四个设计决策已随本 spec 定稿：孤儿存活为 daemon 默认策略、只认领孤儿不认领
活跃 Core、daemon 控制协议仅新增 `detachWorkspace` 一帧与 `detached` 枚举值（总线协议
零变化）、范围限 Electron 宿主；孤儿不设 detached 存续上限。等待用户输入而用户不再
回来的孤儿会让 daemon 一直陪跑，是接受的语义。修订补记：孤儿表键带原连接标识、认领
摘表与移交原子化，是与 `specs/032-session-exclusive-open` 互斥锁对齐后的修订——纯 path
键会让第二次孤儿化覆盖第一条，泄漏的孤儿 Core 不退则它持有的会话锁不释放。）

## 收敛记录

（2026-10-29 /converge，逐 AC 核对 + 实现反向对照。）

### 已满足

- **FR-005 / AC-5 / AC-6** → `daemon_tests::host_disconnect_orphans_busy_cores_and_closes_idle_ones`（忙 Core 存活、idle 终止）；快照缺 states 按忙 fail-safe 由 `malformed_snapshot_counts_as_busy_for_orphaning` 锁定。
- **FR-005 / AC-18** → `daemon_tests::crashed_orphan_is_not_restarted_and_reopen_spawns_fresh`（孤儿崩溃不重启、重开新起 Core）。
- **FR-005（登记冲突）** → `daemon_tests::second_orphan_for_the_same_key_falls_back_to_close`；双客户端孤儿互不覆盖、认领取最早 → `remote_tests::two_clients_orphans_register_separately_and_claim_earliest_first`（并发认领至多一胜由摘表原子性 + 同用例两次认领不 spawn 锁定）。
- **FR-005（空闲判定）/ AC-16 / AC-17** → `remote_tests::busy_orphan_holds_the_daemon_and_idle_orphan_closes_after_grace`（非 idle 孤儿不空退、全 idle 满宽限收尾后空闲退出触发）；e2e `remoteTaskSurvival.spec.ts` US-64 后台存活用例在宿主强杀后 +35s 复核 daemon 存活。
- **FR-006 / AC-7** → `remote_tests::orphaned_core_is_claimed_by_the_next_open_with_replay` + `daemon_tests::claim_replays_orphan_frames_in_arrival_order_without_spawning`（认领不 spawn、重放按到达序）；缓冲安静时补放最新快照 → `claim_with_quiet_orphan_replays_the_last_runtime_snapshot`；认领后帧直达原进程 → `claimed_core_receives_new_connection_frames`。
- **FR-006 / AC-8** → e2e US-65：重开认领同 pid、打开会话可见孤儿期间内容、在跑任务续跑完成（真实远端）。孤儿期间落盘由 Core 既有持久化承担（零新代码）。
- **FR-006 / AC-9（挂起请求重弹）** → daemon 侧重放与 1 小时 TTL 由 `claim_replays_…` + `replay_drain_drops_requests_beyond_the_reply_ttl` 锁定；宿主侧弹出零新代码（走既有请求通道）。**无端到端自动覆盖**：需真实远端 + 无人应答的权限会话构造成本高，登记豁免。
- **FR-006 / AC-10** → 既有 `remote_tests::two_connections_get_independent_channels_and_cores`（活跃 Core 不参与认领）+ `two_clients_orphans_register_separately_…`。
- **FR-006 / AC-20 / AC-21（完成未读 / 正看着已读）** → 重放帧即普通快照流，差分语义由 `src/test/completionAttention.test.ts` 既有套件锁定（running→idle 武装、可见即已读、新会话只登记）；e2e 未断言绿灯，登记为既有单元套件覆盖。
- **FR-003 / AC-4** → `daemon_tests::detach_workspace_orphans_the_core_and_keeps_serving_the_connection`（Core 不退、同连接其余 channel 照常）+ e2e US-64 后台存活用例（detach 后 Core 跨宿主死亡存活）；`detached` 不算 fatal → `src/test/remoteCoreDaemon.test.ts` detach 用例。
- **FR-004 / AC-15** → e2e US-64 立即关闭用例（Core 终止，与现行关闭路径一致）。
- **FR-001 / AC-1** → e2e US-64 三选弹框（三按钮齐备、取消可中止）；默认焦点取消由 `styledMessageBox` 的 `defaultId/cancelId`（键盘 Enter/Esc 绑定）承担。
- **FR-002 / AC-12** → e2e US-64 退出确认链用例（取消中止、应用与任务继续）。
- **FR-005 / AC-19** → `remoteCoreDaemon.test.ts` disconnectOnly（不发帧、不 fatal）+ `clientConnection.test.ts` 空决策表远程 disconnect / 本地 close；daemon 断开收尾分叉即默认策略（AC-5/AC-6 同语义）。
- **FR-001 / AC-3** → 本地忙碌两态确认由既有 `workspace.spec.ts` US-35 覆盖（最近一次全量本地车道在新代码上通过，按钮清单不含「后台运行」）。

### 偏差（已改代码，留痕）

- **AC-19**：实现初版把「弹不出确认链的出口」的未登记远程工作区按 `close` 释放（发 `closeWorkspace` 杀 Core），与「直接断链、由 daemon 默认策略接管」不符——反向对照发现。修复：`CoreChannelCloseMode` 增加 `disconnect`（不发任何控制帧，控制链随 `daemon.disconnect()` 断开），`Client.closeAll` 兜底改为远程 `disconnect`、本地 `close`（提交 9ec0731）。[docs/core/client-connection.md 第 5 节](../../docs/core/client-connection.md#5-connection-生命周期)宿主退出行同步。

### 无自动覆盖登记（实现存在，测试未覆盖，理由）

- **AC-2**（SSH 全 idle 关标签页直关不弹框）：实现是忙碌判定的 else 分支（`closeWorkspace` 的 `workspaceHasBusySession` 门）；已有「忙碌必弹框」正向覆盖，直关分支需要真实远端空闲工作区用例，覆盖密度低。
- **AC-11 / AC-13 / AC-14**（退出链的逐区多工作区弹框、混合决策、SSH 空闲 + 本地忙碌组合）：实现为同一 `confirmQuitWorkspaces` 循环 + 决策表；多远端并发忙碌的构造需真实远端双工作区同跑，e2e 只覆盖单工作区取消分支；决策表透传由 `clientConnection.test.ts` 6a 锁定。
- **detach 后同连接其余 channel 转发**、**daemon 侧孤儿帧排水不阻塞**：`detach_workspace_…` / `claim_…` 系列单测的观察面已覆盖主要分支。
