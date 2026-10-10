# 规格：后台任务提醒

本规格界定后台 Bash 任务发给 LLM 的两类提醒：

- **查询结束兜底提醒**：一轮查询刚结束时若仍有运行中的后台任务、且距上次访问该任务
  已满最小间隔，投递一条 reminder，让 LLM 决定是否 kill 掉不再需要的任务；
- **周期性提醒**：会话前台空闲（abort 按钮为黄）时，每个仍在运行的后台任务按
  5 / 10 / 20 / 30 分钟（此后固定 30 分钟）的间隔投递 reminder，报告任务当前输出、
  已执行时间与下次提醒间隔。

范围只覆盖提醒的调度与文案；后台任务的注册 / 完成通知 / 中止不在本规格内。

相关规格与章节：

- `DEVELOPMENT.md 第 4.5 节（sessionRuntimeChanged 的生产者：sessionRuntime）`
- `docs/abort-button.md`（黄色 = 前台无工作、但仍有后台任务或子代理）
- `DEVELOPMENT.md 第 12.6 节（core 描述事实，UI 决定表现）`
- `DEVELOPMENT.md 第 12.7 节（一份事实只有一个写入点）`

## 1. 能力

### 1.0 查询结束兜底提醒

一轮查询结束时（`finalizeIdle` / 消费循环即将空转），若该会话仍有运行中的后台任务、
且距上次访问该任务已满最小间隔，投递一条 reminder 列出 `taskId` / `pid` / 命令与
按当前 OS 生成的 kill 命令，让 LLM 二选一：不再需要的执行 kill，都还需要就直接结束
本轮等完成通知（不要 sleep / 轮询）。

- 兜底门槛（`qualifiesBackgroundFallbackReminder` / `bash_task::qualifies_fallback_reminder`）：
  任务距上次访问满 3 分钟（`BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS`）才进提醒
  列表。`lastAccessedAt` 是该任务上次被「访问」的时刻，任务注册时取开始时间：刚注册的
  任务不进列表（短命任务很快自己完成，为它打断一轮 LLM 只是噪音），刚被周期提醒报告过
  的任务也不会紧接着再被兜底提醒一次。全部不满足时本次不投递；门槛按**当时的**距上次
  访问时长判定，不满足的任务留着，后续查询结束再判。
- 一次「访问」＝投递周期提醒，或一轮查询结束（无论本次是否兜底）。查询结束时由
  `QueryEngine.maybeRemindBackgroundTasks` / `engine.rs` 的 `background_reminder` 把
  本会话运行中任务的上次访问时刻刷成当前时刻（`markBackgroundTasksAccessed` /
  `ReminderEntry.last_accessed_ms`）。因此兜底提醒自己触发的那轮查询结束时，同一批任务
  距上次访问不足最小间隔，不会被再次兜底，不存在「提醒 → 查询 → 提醒」递归。
- 手工转后台（`docs/manual-background.md`）的任务同样受这条门槛保护：任务在转换成功
  时才注册，查询收尾的兜底提醒不会立刻为它拉起新查询，暂停语义不失效。
- Embedded：`QueryEngine.maybeRemindBackgroundTasks`；Standalone：
  `engine.rs` 的 `background_reminder`（在消费循环的「队列排空」判定里调用）。
- 本条与周期提醒互相独立：兜底提醒只是「启动一次查询」的众多原因之一，对周期时钟没有
  特殊影响（见 1.1 的暂停口径）；反过来周期提醒投递时会刷新 `lastAccessedAt`，这正是
  定时提醒不会紧接着触发兜底提醒的原因。

### 1.1 间隔档位

每个后台任务有**自己的**提醒时钟。时钟只在会话「前台空闲」时前进；到达下列累计
空闲时长时投递一次提醒：

| 轮次 | 距上次提醒 | 累计空闲时长 |
| --- | --- | --- |
| 0 | 5min | 5min |
| 1 | 10min | 15min |
| 2 | 20min | 35min |
| 3 | 30min | 65min |
| 4+ | 30min | 每 30min 一次 |

- 「前台空闲」＝ `sessionRuntime` 的 `queryRunning` 与 `compacting` 均为假
  （`docs/abort-button.md` 的黄色）。query engine 有任务时**暂停计时**：暂停期间的
  时长不计入累计，恢复后从剩余量继续。
- 暂停只看 query engine 的**状态**，不看查询由什么触发：用户消息、子代理回复、
  后台任务完成通知、兜底提醒、手动压缩——任何原因启动的查询都同样让时钟暂停。
- 时钟按任务独立推进：A 到点提醒不会重置 B 的时钟；只要 query engine 在跑（不管是
  谁启动的），同一会话里 A、B 的时钟就一起暂停。
- 提醒只报告触发它的那个任务（任务描述 / 命令 / 当前输出 / 已执行时间 / 下次间隔）；
  投递时把该任务的 `lastAccessedAt` 刷成当前时刻，查询结束的兜底提醒据此冷却（1.0）。
- 「已执行时间」是任务自注册起的 wall clock 时长（子进程在暂停期间照常运行）。

### 1.2 投递

- 提醒是 silent 的 `pendingReminder`（LLM 可见、UI 不可见），与「回复未完成」追问
  同一条通道；投递时主动启动消费循环，让 LLM 立即看到。
- 同一 tick 多个任务同时到点时**追加**到 `pendingReminder`（空行分隔）而不是覆盖，
  否则先到点的提醒会被后到点的顶掉。
- 压缩进行中不投递（压缩会整体替换消息数组）；调度线程下一轮再发。
- 用户中止后丢弃投递（投递前检查中止标记），中止后台任务时注销对应时钟。
- 任务完成 / 会话关闭后注销时钟，不再提醒。

### 1.3 工具结果里的下次间隔

`run_in_background` 与自动转后台两种路径返回给 LLM 的 `tool_result` 都带上首次提醒
间隔（`5min`）：任务仍在运行时，模型会收到进度提醒。

## 2. 实现

| 侧 | 调度 | 纯函数 |
| --- | --- | --- |
| Embedded（TS） | `src/core/tools/bash/BackgroundReminder.ts`（1s ticker，读 `sessionRuntime`；每个任务记 `lastAccessedAt`） | `advanceReminderClock` / `buildBackgroundReminderText` / `qualifiesBackgroundFallbackReminder` |
| Standalone（Rust） | `core-rs/src/engine.rs` 的 `tick_background_reminders`（进程级调度线程；`ReminderEntry.last_accessed_ms`） | `core-rs/src/bash_task.rs` 的 `advance_reminder_clock` / `build_background_reminder_text` / `qualifies_fallback_reminder` |

- 时钟登记 / 注销挂在后台任务生命周期上：Embedded 在 `LocalShellTask` 的注册 /
  完成 / 中止点；Standalone 由调度线程按 `bash_task::running_tasks_for_session`
  对账（任务结束即清理）。
- 投递入口：Embedded `QueryEngine.deliverBackgroundReminder`；Standalone
  `Core::deliver_background_reminder`。
- 事实来源只有一处：会话是否空闲读 `sessionRuntime`（Embedded）/
  `SessionState.running` + `compacting`（Standalone），不另建状态表。
- 「上次访问时刻」挂在提醒调度项上（Embedded `ReminderSchedule.lastAccessedAt` /
  Standalone `ReminderEntry.last_accessed_ms`），写入点只有两处：周期提醒投递（同一调度项）
  与查询结束（对本会话运行中的全部任务）。

## 3. 测试

- 对等对照表 `src/test/fixtures/backgroundReminderParity.json`（生成脚本
  `scripts/gen-background-reminder-parity.mjs`）：间隔档位、时钟推进、提醒文案、
  兜底门槛（距上次访问满 3 分钟的布尔判定）。
  - Embedded：`src/test/backgroundReminderParity.test.ts`；
  - Standalone：`core-rs/src/bash_task_tests.rs::background_reminder_parity`。
- 调度接线：`src/test/backgroundReminderScheduler.test.ts`（空闲到点、暂停不累计、
  中止注销、周期提醒 / 查询结束刷新 `lastAccessedAt` 后的冷却）。
- 兜底提醒接线：`src/test/backgroundFallbackReminder.test.ts`（刚注册不兜底、满最小间隔
  投递带 kill 命令的 reminder、查询结束刷新后不递归）。
- 工具结果文案：`src/test/bashSleepParity.test.ts` 与
  `core-rs/src/tools_tests.rs` 的自动转后台 / 后台用例断言下次提醒间隔。
