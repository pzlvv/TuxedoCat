---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：Bash 后台任务

本规格界定 Bash 任务后台化的两块语义：**手工转后台**（FR-001 / FR-002——用户把正在
前台运行的命令转入后台继续执行时，工具结果如何进入上下文、本轮 agent 循环如何暂停、
暂停后由谁接续）与**后台任务提醒**（FR-003 / FR-004——查询结束兜底提醒与周期性进度
提醒的调度与文案）。后台任务的注册 / 完成通知 / 中止不在本规格内；运行时事实
（`backgroundRunning`）的归属见 [docs/core/session-runtime.md](../core/session-runtime.md)。

交叉引用：UiEvent 词汇表见 [events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)；
「core 描述事实，UI 决定表现」见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)、
「一份事实只有一个写入点」见 [principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)；
转换后按钮转黄见 [abort-button.md](abort-button.md)（黄色 = 前台无工作、但仍有后台任务或子代理）；
引擎消费循环见 [user-message-pipeline.md FR-002](user-message-pipeline.md#fr-002命令在轮次边界解析)。

## 1. 用户场景与验收标准

- 场景 1：手工转后台
  - **AC-1**（FR-001）：GIVEN Bash 卡片处于前台执行中 WHEN 点击「转后台」 THEN 发 `backgroundBashTool` 消息并触发转换；卡片进入完成态后按钮消失，重复点击不产生额外效果
  - **AC-2**（FR-001）：GIVEN 命令已收尾或从未登记 WHEN 点击「转后台」 THEN core 幂等忽略，不补兜底
  - **AC-3**（FR-002）：GIVEN 转换成功 WHEN 本批工具结果收尾 THEN 工具结果照常进上下文（`auto_backgrounded` 为真）但**不发起下一轮 LLM 请求**
  - **AC-4**（FR-002）：GIVEN 暂停中且队列为空 WHEN 收尾 THEN 会话回到「等待用户输入」，abort 按钮因仍有后台任务而为黄
  - **AC-5**（FR-002）：GIVEN 暂停中 WHEN 新用户消息或后台完成通知入队 THEN 立刻拉起新一轮查询（接续与转后台结果无关）
- 场景 2：查询结束兜底提醒
  - **AC-6**（FR-003）：GIVEN 后台任务距上次访问满 3 分钟（或命令含 `sleep` 且未兜底过） WHEN 查询结束 THEN 投递列出 `taskId` / `pid` / 命令与 kill 命令的兜底 reminder
  - **AC-7**（FR-003）：GIVEN 任务刚注册 WHEN 查询结束 THEN 不兜底（短命任务不为它打断一轮 LLM）
  - **AC-8**（FR-003）：GIVEN 本轮由 reminder 拉起 WHEN 该轮结束 THEN 直接跳过兜底提醒（提醒不接力）
- 场景 3：周期性进度提醒
  - **AC-9**（FR-004）：GIVEN 会话前台空闲且任务时钟累计到档 WHEN tick THEN 投递该任务的进度提醒；query engine 运行时（无论谁启动）时钟暂停不累计
  - **AC-10**（FR-004）：GIVEN 同一 tick 多个任务同时到点 WHEN 投递 THEN 追加到 `pendingReminder`（空行分隔）而不是覆盖
  - **AC-11**（FR-004）：GIVEN 压缩进行中 WHEN 时钟到点 THEN 不投递，调度线程下一轮再发

## 2. 功能需求

### FR-001：手工转后台的入口与转换

Bash 卡片在 `status === 'running'`（前台执行中）时，于「复制命令」按钮**左侧**渲染
「转后台」按钮（时钟图标，`title` 取 i18n 的 `tool.bash.moveBackground`）。卡片进入任何
完成态后按钮消失——执行状态是卡片自己的事实，按钮只是它的投影。

点击后 webview 发 `backgroundBashTool` 消息（`sessionId` + `toolUseId`），宿主翻译为
`UiEvent.bashBackgroundRequested`（[events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)）。重复点击不产生额外效果。

core 按 `toolUseId` 查「前台执行注册表」（`tools.rs` 的 `MANUAL_BG`，`tool_use_id` →
请求标记）：

- 命中 → 触发该次前台执行的转换，与自动转后台（前台超时 / 通知驱动）走同一条
  `auto_background_command` 路径：子进程 detach、输出改由 file mode 继续收集、任务以
  `bg-auto-` 前缀注册；
- 未命中（命令已收尾 / 从未登记）→ 什么都不做。按钮与实际状态之间的竞态由注册表兜住，
  调用方不补兜底（[principles.md 第 1 节](../architecture/principles.md#1-不过度-fallback)）。

转换的结果**照常作为 tool_result 进入上下文**：状态成功、自动转后台为真
（`auto_backgrounded`）、`backgroundTaskId` 为 `bg-auto-*`，输出文案为「Command moved to
the background after <已运行时长> (task ID: …) …」（`tools.rs` 的结果组装）。转换失败
（打不开输出文件等）不置暂停标记，按前台结果收尾。

注册表生命周期归前台执行（`tools.rs` 的执行路径）：spawn 后登记触发器，全部收尾路径
（完成 / 中止 / 已转后台 / 出错）注销。

### FR-002：循环暂停与接续

转换成功时回写引擎的循环暂停标记（`SessionState.pause_loop`，`tools.rs` 的
`LoopPauseSignal`）。消费出口在查询循环的工具批收尾、下一轮 LLM 请求发起之前：
本批工具结果已进上下文，但**不再发起下一轮 LLM 请求**（`aiEnd` 已发）。消费循环随后按
队列状态收尾：

- 队列为空 → 结束本次消费，会话回到「等待用户输入」；abort 按钮因仍有后台任务而为黄
  （[abort-button.md 第 2 节](abort-button.md#2-功能需求)）；
- 队列有消息（用户消息 / 后台任务完成通知 / reminder）→ 由既有入队路径立刻拉起新一轮，
  性质与用户触发的查询一致——**接续由队列消息触发，与转后台结果无关**。

暂停标记一次性（取走即清除）。新用户消息（`Core::on_user_message`）与中止
（`abort_foreground`）都清掉残留标记——暂停只对「当时那轮查询」有意义。

触发暂停的后台任务在转换成功时即登记为「已兜底」（暂停出口消费
`LoopPauseSignal.source_task` 后写 `ReminderEntry.fallback_reminded`），3 分钟门槛与
sleep 豁免都不再命中，因此查询收尾的兜底提醒（FR-003）不会为它补一条 reminder 并拉起新
查询——否则转后台结果自己就触发了接续循环，违背本条的暂停语义。周期性提醒不受影响。

### FR-003：查询结束兜底提醒

一轮查询结束时（`finalizeIdle` / 消费循环即将空转），若该会话仍有满足门槛的运行中后台
任务，投递一条 reminder 列出 `taskId` / `pid` / 命令与按当前 OS 生成的 kill 命令，让 LLM
二选一：不再需要的执行 kill，都还需要就直接结束本轮等完成通知（不要 sleep / 轮询）。

- 兜底门槛（`bash_task.rs` 的 `qualifies_fallback_reminder`）取两条的**或**：
  - 距上次访问满 3 分钟（`BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS`）。「上次访问
    时刻」（`ReminderEntry.last_accessed_ms`）
    是该任务上次被「访问」的时刻，任务注册时取开始时间：刚注册的任务不进列表（短命任务
    很快自己完成，为它打断一轮 LLM 只是噪音），刚被周期提醒报告过的任务也不会紧接着再被
    兜底提醒一次；
  - 命令含 `sleep` 子命令、且本任务**还没兜底过**（`fallback_reminded`）。
    sleep 类任务在等一个定时事件，最需要被提醒「别去轮询，等通知」，因此刚注册也兜底一次。
    `sleep` 判定与超时策略同一口径（`tools.rs` 的 `contains_sleep_command`）。
  全部不满足时本次不投递；门槛按**当时的**距上次访问时长判定，不满足的任务留着，后续
  查询结束再判。
- 一次「访问」＝投递周期提醒，或一轮查询结束（无论本次是否兜底）。查询结束时由
  `engine.rs` 的 `background_reminder` 把本会话运行中任务的上次访问时刻刷成当前时刻
  （`ReminderEntry.last_accessed_ms`），本次投递的任务同时登记为「已兜底」
  （`ReminderEntry.fallback_reminded`）：sleep 豁免每个任务只走一次，否则查询结束会每轮命中。
- 由 reminder 拉起的那一轮结束时**直接跳过**兜底提醒（`SessionState.reminder_driven_run`）：
  提醒不接力，模型不会刚被提醒过又被追问「要不要 kill」。标记取走即清除，只对刚结束的
  那一轮有意义；下一轮照常按门槛判定。
- 手工转后台（FR-001）的任务在转换成功时即登记为「已兜底」：3 分钟
  门槛与 sleep 豁免都不再命中，查询收尾的兜底提醒不会为它拉起新查询，暂停语义不失效。
- 兜底提醒的调用点是 `engine.rs` 的 `background_reminder`（在消费循环的「队列排空」判定里调用）。
- 本条与周期提醒互相独立：兜底提醒只是「启动一次查询」的众多原因之一，对周期时钟没有
  特殊影响（见 FR-004 的暂停口径）；反过来周期提醒投递时会刷新「上次访问时刻」，这正是
  定时提醒不会紧接着触发兜底提醒的原因。

### FR-004：周期性进度提醒

每个后台任务有**自己的**提醒时钟。时钟只在会话「前台空闲」时前进；到达下列累计
空闲时长时投递一次提醒：

| 轮次 | 距上次提醒 | 累计空闲时长 |
| --- | --- | --- |
| 0 | 5min | 5min |
| 1 | 10min | 15min |
| 2 | 20min | 35min |
| 3 | 30min | 65min |
| 4+ | 30min | 每 30min 一次 |

- 「前台空闲」＝运行时状态的 `queryRunning` 与 `compacting` 均为假
  （[abort-button.md](abort-button.md) 的黄色）。引擎有任务时**暂停计时**：暂停期间的
  时长不计入累计，恢复后从剩余量继续。
- 暂停只看引擎的**状态**，不看查询由什么触发：用户消息、子代理回复、
  后台任务完成通知、兜底提醒、手动压缩——任何原因启动的查询都同样让时钟暂停。
- 时钟按任务独立推进：A 到点提醒不会重置 B 的时钟；只要引擎在跑（不管是
  谁启动的），同一会话里 A、B 的时钟就一起暂停。
- 提醒只报告触发它的那个任务（任务描述 / 命令 / 当前输出 / 已执行时间 / 下次间隔）；
  投递时把该任务的「上次访问时刻」（`ReminderEntry.last_accessed_ms`）刷成当前时刻，
  查询结束的兜底提醒据此冷却（FR-003）。
- 「已执行时间」是任务自注册起的 wall clock 时长（子进程在暂停期间照常运行）。

投递口径：

- 提醒是 silent 的 `pendingReminder`（LLM 可见、UI 不可见），与「回复未完成」追问
  同一条通道；投递时主动启动消费循环，让 LLM 立即看到。
- 同一 tick 多个任务同时到点时**追加**到 `pendingReminder`（空行分隔）而不是覆盖，
  否则先到点的提醒会被后到点的顶掉。
- 压缩进行中不投递（压缩会整体替换消息数组）；调度线程下一轮再发。
- 用户中止后丢弃投递（投递前检查中止标记），中止后台任务时注销对应时钟。
- 任务完成 / 会话关闭后注销时钟，不再提醒。
- `run_in_background` 与自动转后台两种路径返回给 LLM 的 `tool_result` 都带上首次提醒
  间隔（`5min`）：任务仍在运行时，模型会收到进度提醒。

## 3. 行为规格

### 3.1 实现对照

| 环节 | 落点 |
| --- | --- |
| 按钮 | `src/webview/tools/Bash.tsx`（webview 两宿主共用） |
| 协议消息 | `backgroundBashTool`（`src/host/webviewMessages.ts`） |
| UiEvent | `bashBackgroundRequested`（`src/shared/AssistantEventBus.ts`） |
| core 分发 | `main.rs` 的 `dispatch_ui_event` → `Core::on_bash_background_requested` |
| 注册表 | `tools.rs` 的 `MANUAL_BG`（`tool_use_id` → 请求标记） |
| 暂停信号 | `tools.rs` 的 `LoopPauseSignal`（`paused` + `source_task`）挂在 `SessionState.pause_loop` |
| 兜底抑制 | 暂停出口消费 `source_task` → `ReminderEntry.fallback_reminded` |
| 消费点 | `core-rs/src/engine.rs` 的 `run_query_loop`（工具批收尾、下一轮请求前） |

### 3.2 提醒实现

| 环节 | 落点 |
| --- | --- |
| 调度 | `core-rs/src/engine.rs` 的 `tick_background_reminders`（进程级调度线程；`ReminderEntry.last_accessed_ms`） |
| 纯函数 | `core-rs/src/bash_task.rs` 的 `advance_reminder_clock` / `build_background_reminder_text` / `qualifies_fallback_reminder` |

- 时钟登记 / 注销挂在后台任务生命周期上：调度线程按
  `bash_task.rs` 的 `running_tasks_for_session` 对账（任务结束即清理）。
- 投递入口：`Core::deliver_background_reminder`。
- 事实来源只有一处：会话是否空闲读 `SessionState` 的 `running` + `compacting`，不另建状态表。
- 「上次访问时刻」挂在提醒调度项上（`ReminderEntry.last_accessed_ms`），写入点只有两处：
  周期提醒投递（同一调度项）与查询结束（对本会话运行中的全部任务）。
- 「已兜底」同样挂在提醒调度项上（`ReminderEntry.fallback_reminded`），写入点只有两处：
  查询结束兜底投递（对本批投递的任务）与手工转后台转换成功（暂停出口消费
  `LoopPauseSignal.source_task`）。
- 「本轮由 reminder 拉起」是消费循环级事实：`SessionState.reminder_driven_run`。置位方是
  两类提醒的投递点（周期提醒入口 `deliver_background_reminder`，以及兜底提醒本身），
  消费循环收尾取走；取消分支额外清一次（reminder 已被丢弃）。

## 4. 边界与错误路径

- **注册表未命中**：按钮与实际状态竞态 → 幂等忽略，调用方不补兜底（AC-2）。
- **转换失败**（打不开输出文件等）：不置暂停标记，按前台结果收尾。
- **压缩进行中**：周期提醒不投递，下一轮再发（AC-11）。
- **用户中止**：投递前检查中止标记丢弃投递；中止后台任务时注销对应时钟。
- **任务完成 / 会话关闭**：注销时钟，不再提醒。
- **同一 tick 多任务到点**：追加不覆盖（AC-10）。

## 5. 非目标

- 后台任务的注册 / 完成通知 / 中止语义不在本规格内。
- 运行时事实（`backgroundRunning`）的归属见 [docs/core/session-runtime.md](../core/session-runtime.md)。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-45（命令转入后台）；无新增 US。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `MANUAL_BG`（`auto_background_command(manual = true)`） | `core-rs/src/tools_tests.rs` 的 `bash_manual_background_converts_and_requests_loop_pause`；e2e `e2e/webview/bashBackgroundButton.spec.ts` | 自动 |
| FR-002 | `core-rs/src/engine.rs` 的 `run_query_loop` | `core-rs/src/engine_tests.rs` 的 `manual_background_pauses_the_loop_until_a_queued_message_arrives`；e2e `e2e/electron/backgroundBash.spec.ts` | 自动 |
| FR-003 | `core-rs/src/engine.rs` 的 `background_reminder`（门槛与刷新，`core-rs/src/bash_task.rs` 的 `qualifies_fallback_reminder`） | `core-rs/src/engine_tests.rs` 的 `fallback_reminder_gate`；`core-rs/src/tools_tests.rs` 的 `contains_sleep_command_splits_on_separators` | 自动 |
| FR-004 | `core-rs/src/engine.rs` 的 `tick_background_reminders`（纯函数 `core-rs/src/bash_task.rs` 的 `advance_reminder_clock` / `build_background_reminder_text`） | `core-rs/src/bash_task_tests.rs` 的 `background_reminder_parity`；事件序列对照表 `core-rs/fixtures/eventTypes.json` | 自动 |
