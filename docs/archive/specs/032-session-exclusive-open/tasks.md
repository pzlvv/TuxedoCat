# 任务分解：会话跨实例独占打开

执行顺序：锁原语模块与单测矩阵（T001–T004）先立内核并以 `session_lock_tests.rs`
锁定，Core 接线（T005–T007）随后，错误文案与文档收尾（T008–T010）。全程
`cargo test` 绿为内核任务的完成判据；接线任务以既有 engine / main 测试不回归 +
新增用例绿为判据。方案见 [plan.md](plan.md)，验收见 [spec.md](spec.md)。

## 任务清单

- [x] **T001**（FR-001、FR-003）：新增 `core-rs/src/session_lock.rs`——`acquire` 非阻塞独占（Unix `flock(LOCK_EX|LOCK_NB)` / Windows `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY)`，手写 FFI 零新依赖）、`SessionLockHandle`（Drop 只 unlock + close 不删文件）、锁文件内容 `{version,pid,started}`（版本 ≠1 立即释放并拒、内容损坏照常持有落诊断）、进程启动时刻平台分支（`/proc/<pid>/stat` 第 22 字段 / `GetProcessTimes`）；依赖：—；完成判据：编译绿、原语单测（互斥 / 释放 / 重取）绿
- [x] **T002**（FR-003）：自 spawn 双进程测试 harness（`Command::new(current_exe)` + `--exact` 跑持锁子测试）并落矩阵——崩溃接管（AC-7）、并发至多一胜（AC-9）、版本拒外（AC-8）、内容损坏；依赖：T001；完成判据：`session_lock_tests.rs` 四用例绿
- [x] **T003**（FR-001）：`Core.session_locks` 注册表 + `acquire_for_core`（命中即同 Core 重入放行）；依赖：T001；完成判据：单测——注册表两次 acquire 同 sid 不自锁（AC-10）
- [x] **T004**（FR-002）：`ensure_can_mutate` 变更守卫（注册表命中放行；未命中短持有取锁-写入-释放）；依赖：T001；完成判据：单测——子进程持锁时守卫拒绝、未装载时取锁写入后释放可再获取（AC-6）
- [x] **T005**（FR-001）：装载入口接获取——`ensure_loaded`（拒绝 = notice + 不建状态）、`conversationLoadRequested`（拒绝 = `error_response` + notice，不回内容）、`create_sub_agent` / `start_remote_sub_agent`（失败回 error 给 Agent 工具）；依赖：T003；完成判据：engine/main 单测绿（双 Core 进程争用由 T002 的 harness 形态覆盖）
- [x] **T006**（FR-001）：释放接线——`drop_session` 移除注册表条目（句柄 Drop 释放）；删除自己持有的会话先 Drop 句柄再删目录（Windows 句柄挡删除）；依赖：T003；完成判据：单测——关闭后另一进程立即可获取（AC-3 / AC-13）
- [x] **T007**（FR-002）：六个变更入口 + `conversationSpaceCleared`（remove）接守卫——`on_conversation_renamed` / `on_conversation_deleted` / `on_session_config_changed` / `smartNamingRequested` / `compactArchiveRequested` / `spinDesignSaveRequested`；依赖：T004；完成判据：单测——他持时全部拒绝且数据零改动（AC-4）
- [x] **T008**（FR-001）：错误文案——`core_text.rs` 新增 `notice.session.lockedOpen` / `notice.session.lockedChange`（参数 `{pid}`）；`src/webview/i18n/zh.ts` / `en.ts` 各补两键；`coreTextKeys.json` 对等测试同步；依赖：T005；完成判据：coreText 对等测试绿
- [x] **T009**（FR-001 ～ FR-003）：docs 基线并入——[client-connection.md 第 5 节](../../docs/core/client-connection.md#5-connection-生命周期)（连接独立、会话独占）、[standalone-core.md 第 7 节](../../docs/core/standalone-core.md#7-事实归属)与模块清单（`session.lock` / `session_lock.rs`）、[sessions-and-llm.md EP-5](../../docs/features/user-stories/sessions-and-llm.md#ep-5-会话管理)（US-66）、[user-stories.md 附录](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射)（US-66 豁免登记）、[events.md](../../docs/architecture/events.md) 的 notice 触发点列；依赖：T007；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T010**（FR-003）：锁原语选型进 ADR（内核建议性文件锁 vs 摘除式协议，`docs/adr/` 下一编号）；依赖：T002；完成判据：ADR 编号递增、docs/README.md 地图一致
