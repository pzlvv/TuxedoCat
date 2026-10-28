# 任务分解：远程任务后台运行与认领重连

执行顺序：daemon 协议与孤儿化内核（T001–T006）先落地并以 `daemon_tests.rs` 锁定，
宿主协议镜像与 detach 分叉（T007–T009）随后，Electron 退出链与对话框（T010–T012）
再上，e2e 与文档收尾（T013–T016）。全程 `npm run check-types && npm run lint` 绿，
涉及 daemon 的任务以 `cargo test` 绿为完成判据的一部分。方案见
[plan.md](plan.md)，验收见 [spec.md](spec.md)。

## 任务清单

- [x] **T001**（FR-005、FR-006）：`daemon_protocol.rs` 新增 `detachWorkspace { channel }` 帧，`WorkspaceCloseReason` 增加 `Detached`；`daemonProtocol.ts` 同步两个成员并用例锁定；依赖：—；完成判据：`daemon_protocol_tests.rs` 与 TS 帧编解码用例绿，`isDaemonToHostFrame` 接受 `detached`
- [x] **T002**（FR-005）：daemon 增加跨连接共享孤儿表（`OrphanKey` = 工作区路径 + 原连接标识；登记冲突落诊断并拒绝插入）与 `RoutableEventSink` 帧出口路由（连接 ↔ 孤儿收集器切换）；依赖：T001；完成判据：`daemon_tests.rs`——孤儿化后 Core 帧持续被排水（不阻塞）、同 path 两次孤儿化不互相覆盖
- [x] **T003**（FR-005）：内层帧窥探点——识别 `sessionRuntimeChanged` 快照（维护每 channel `last_runtime`，解析失败按忙 fail-safe 落诊断）与 `request` 帧（暂存，1 小时 TTL）；依赖：T002；完成判据：`daemon_tests.rs`——快照更新忙闲表、坏帧按忙、请求帧入缓冲、超 TTL 的请求不再重放
- [x] **T004**（FR-005）：连接断开收尾分叉——非 idle channel 孤儿化、全 idle 照旧终止；孤儿 Core 退出标记死亡、移出孤儿表、不重启；依赖：T003；完成判据：`daemon_tests.rs`——断开时忙 Core 存活、idle Core 终止、孤儿崩溃后 openWorkspace 按无孤儿处理
- [x] **T005**（FR-006）：`detachWorkspace` 处理——单 channel 移入孤儿表、回 `workspaceClosed { reason: 'detached' }`，连接继续服务其余 channel；依赖：T002；完成判据：`daemon_tests.rs`——detach 后同连接其余 channel 帧照常转发、被 detach 的 Core 进程不退出
- [x] **T006**（FR-006、FR-007）：认领（`openWorkspace` 命中孤儿：摘表与句柄移交同锁原子、重放缓冲按原序、缓冲为空补放最新快照）与空闲判定（无连接且无非 idle 孤儿持续 30s 才退出；全 idle 孤儿持续 30s 收尾；孤儿变化唤醒判定）；依赖：T004、T005；完成判据：`daemon_tests.rs`——认领不 spawn 新进程、并发认领至多一胜、空闲判定按新口径起算与取消
- [x] **T007**（FR-003、FR-004）：`CoreDaemon.ts` 增加 detach 发送入口与 `workspaceClosed('detached')` 消费（`expected` 口径：detached 不算 fatal）；依赖：T001；完成判据：TS 单测——detach 帧出站、`detached` 关闭不触发 `onFatal`
- [x] **T008**（FR-003、FR-004）：`Client.ts` 关闭分叉——`closeAll` / `closeWorkspace` 接受决策表，`detach` 的远程 Connection 摘路由不发 `closeWorkspace`，`close` 与本地走现行路径；`bootstrapCore.ts` 的 `shutdownCore` 传递决策表；依赖：T007；完成判据：TS 单测——detach 路径无 closeWorkspace 帧出站、路由表摘除、daemon.disconnect 照旧
- [x] **T009**（FR-006）：`completionAttention` / `trayAttention` 消费重放快照的行为锁定——认领重放的 running → idle 按既有差分武装绿灯（`src/test/completionAttention.test.ts` 既有差分用例全绿，重放帧即普通快照流）；启动恢复窗口内抑制托盘提醒音落在 `electron/main.ts`（`startupTraySuppressionDeadline` 标志，硬上限 30s + 首个窗口聚焦解除），main 进程无单测挂点、由 e2e 主链路覆盖；依赖：T008；完成判据：`src/test/completionAttention.test.ts` 绿
- [x] **T010**（FR-001）：`styledMessageBox` 三按钮形态 + 忙碌 SSH 工作区标签页关闭的三选对话框（默认焦点取消；本地工作区与全 idle SSH 不弹）；依赖：T008；完成判据：e2e 用例覆盖三选与两态不变
- [x] **T011**（FR-002）：应用退出确认链——逐个 SSH 忙碌工作区弹三选、任一取消中止退出、决策表进 `will-quit`；弹不出对话框的出口只断链；依赖：T010；完成判据：e2e 用例——逐区弹框、取消中止、detach/立即关闭混合退出
- [x] **T012**（FR-001、FR-002）：i18n 文案（`tt()` 双语）与决策表类型收口；依赖：T010；完成判据：`npm run check-types` 绿、e2e 断言对话框文案
- [x] **T013**（FR-001 ～ FR-007）：e2e 新用例 `e2e/electron/remoteTaskSurvival.spec.ts`（electron-ssh 车道）——detach 后远端 Core 存活、重开认领恢复消息流、孤儿期间消息可见、立即关闭终止 Core、崩溃后孤儿化存活；依赖：T011；完成判据：`npm run test:e2e:ssh` 绿（需真实远端）
- [x] **T014**（FR-005 ～ FR-007）：`e2e/playwright.config.ts` 的 `electron-ssh` `testMatch` 与 `electron-app` `testIgnore` 纳入新用例文件；依赖：T013；完成判据：`npm run test:e2e:local` 不拾取新文件、`test:e2e:ssh` 拾取
- [x] **T015**（FR-005）：ADR 落「daemon 对内层帧的两类只读窥探」（`docs/adr/`，背景 + 被否决的替代方案）；依赖：T003；完成判据：ADR 编号递增、docs/README.md 地图更新
- [x] **T016**（FR-001 ～ FR-007）：docs 基线并入（spec「影响基线」清单：core-daemon / core-remote / client-connection / electron-multi-workspace / user-stories 与 e2e 映射附录）+ `npm run test:unit -- docs-lint` 绿；依赖：T015；完成判据：docsLint 全绿、`docs/README.md` 地图一致
