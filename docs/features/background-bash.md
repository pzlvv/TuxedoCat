---
owner: pzlvv
last_reviewed: 2026-11-27
---

# 规格：Bash 后台任务

本规格界定 Bash 任务后台化的四组语义：**手工转后台**（FR-001 / FR-002——用户把正在
前台运行的命令转入后台继续执行时，工具结果如何进入上下文、本轮 agent 循环如何暂停、
暂停后由谁接续）、**后台任务提醒**（FR-003 / FR-004——查询结束兜底提醒与周期性进度
提醒的调度与文案）、**`restricted` 闸门**（FR-005 ～ FR-007——缺省为真时拒绝 `sleep`
轮询，说明该字段的默认值，并给出误拦截的逃生口）、**读文件口径**（FR-008 提示词里的
`Read` / `Grep` / `Glob` 优先规则与 FR-009 的 `sed` 结果提醒——把 `sed` 当读 / 改文件器
用时，在工具结果里追加改用 `Read` / `Edit` 的提醒）。后台任务的注册 /
完成通知 / 中止不在本规格内；运行时事实（`backgroundRunning`）的归属见
[docs/core/session-runtime.md](../core/session-runtime.md)。

交叉引用：UiEvent 词汇表见 [events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)；
「core 描述事实，UI 决定表现」见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)、
「一份事实只有一个写入点」见 [principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)；
转换后按钮转黄见 [abort-button.md](abort-button.md)（黄色 = 前台无工作、但仍有后台任务或子代理）；
引擎消费循环见 [user-message-pipeline.md FR-002](user-message-pipeline.md#fr-002消息的处置在入队时确定与出队时机无关)；
压缩把运行中任务清单带进摘要消息见 [compaction.md FR-006](compaction.md#fr-006运行中后台任务随压缩携带)。

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
- 场景 4：`restricted` 闸门
  - **AC-12**（FR-005）：GIVEN Bash 调用（前台 / `run_in_background` / `detach` 任一形态，`restricted` 缺省或为真）WHEN 命令按 `;` / `&&` / `||` / `|` / 换行切分后任一段命令名是 `sleep`（含单条 `sleep 5`）THEN 工具结果失败，命令不执行
  - **AC-13**（FR-005）：GIVEN 调用被拦 WHEN 观察本轮 THEN 不弹权限确认框、不产生后台任务与 taskId、不发完成通知与提醒，且 `manual` / `risk` / `auto` 三档的文案与行为完全相同
  - **AC-14**（FR-005）：GIVEN `restricted: true` WHEN 命令是 `echo 'sleep 10 && cat a.txt'`、`cat > a.sh <<'EOF'` 的 heredoc 正文里出现 `sleep`、`/usr/bin/sleep 10 && x`、`timeout 30 sleep 5 && x` THEN 都不被拦
  - **AC-15**（FR-005）：GIVEN 命令是 `sleep 10 && nohup x &`（后台化构造与本闸门都命中） WHEN 调用 THEN 报本闸门的文案
  - **AC-16**（FR-005）：GIVEN `detach: true` WHEN 命令命中本闸门 THEN 同样失败（豁免只覆盖后台化构造）
  - **AC-17**（FR-005）：GIVEN `restricted: true` WHEN 命令去掉所有 `cd` 段后只剩 `sed`（`cd src && sed -n 1p a.ts`、`sed -i 's/a/b/' f`）THEN 命令照常执行，按既有权限路径判定（`sed` 不在只读白名单）
  - **AC-18**（FR-005）：GIVEN 任意 `restricted` 取值 WHEN 命令是 `sed -n 1p f | head`、`rg x src | sed 's/a/b/'`、`git diff | sed -n '1,20p'` THEN 不被闸门拒绝，按既有权限路径处理
  - **AC-19**（FR-005）：GIVEN `restricted: false` WHEN 命令含 `sleep` THEN 该限制不生效，按既有权限判定与前台超时路径执行；`sed` 的判定与 `restricted` 取值无关
  - **AC-20**（FR-006）：GIVEN 工具的 LLM 可见定义与系统提示词 WHEN 读 Bash 段 THEN `restricted` 字段类型是 `boolean`、显式带 `default: true`，说明是英文且只声明「默认 `true`、通常传 `true`」，不复述判据、不提前点明它限制哪类写法
  - **AC-21**（FR-007）：GIVEN 命令被闸门拦下 WHEN 读失败文案 THEN 末尾是 `- If you are certain this is a false positive, re-run the same command with restricted: false.`
  - **AC-22**（FR-007）：GIVEN 模型判断是误拦截 WHEN 把原命令带上 `restricted: false` 重跑 THEN 闸门不再拦（回到既有权限路径）
  - **AC-23**（FR-008）：GIVEN 系统提示词的 Bash 段 WHEN 检索全文 THEN 含「用 `Read` 代替 `cat` / `sed` 看文件内容」的规则与两条对照（`cat a.txt` → `Read` 的 `file_path`；`sed -n '1,40p' f` → `Read` 的 `offset` / `limit`），保留「内容要流进另一条命令时照常用 `cat` / `sed`」的例外，并含 `**Prefer the Grep and Glob tools**` 块（单个搜索用 `Grep` / `Glob`，结果要喂给另一条命令时才用 Bash `rg` / `fd`）
  - **AC-24**（FR-008）：GIVEN `restricted: true` WHEN 命令是 `cat a.txt`、`cat > f <<'EOF' … EOF` THEN 都不被闸门拦下（`cat` 不是拦截判据，只受提示词规则引导）
  - **AC-25**（FR-009）：GIVEN 命令去掉所有 `cd` 段后只剩 `sed`（含 `sed -i` 写形态）WHEN 命令执行完成 THEN 工具结果末尾追加一条 `[reminder]`，点名用 `Read` 读文件、`Edit` 改文件，并保留「内容要流进另一条命令时照常用 `sed`」的例外
  - **AC-26**（FR-009）：GIVEN 命令是 `sed -n 1p f | head`、`rg x src | sed 's/a/b/'`、`git diff | sed -n '1,20p'`、`/usr/bin/sed -n 1p f` WHEN 执行完成 THEN 结果不追加本条提醒，命令与结果都与不加提醒时逐字相同

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
    `sleep` 判定与前台超时的 sleep 识别共用同一套切分与首词判定
    （`tools.rs` 的 `contains_sleep_command` / `sleep_duration_ms`）。
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

### FR-005：`restricted` 闸门（`sleep`）

Bash 的每次调用在执行前过一道闸门：`restricted` 参数（布尔、缺省 `true`）为真时，
命令里出现 `sleep` 命令，工具直接失败、命令不执行——用计时器等结果时，完成时 core 会
注入通知并接续消费循环，模型不必自己轮询。`restricted: false` 时这条限制不生效，这是
唯一的开关。闸门只覆盖 `sleep` 一类：`cat` 是只读命令、还有 `cat > f <<EOF` 这类写形态，
「优先用 `Read` / `Grep` 代替 `cat` / `sed` / `rg` 看内容」是系统提示词的规则（FR-008）；
`sed` 读 / 改文件走工具结果里的提醒（FR-009），不产生工具失败
（[US-78](user-stories/tools.md#us-78-读文件优先用-read-工具)）。

判定口径：

- 命令切分：heredoc 正文先在屏蔽副本上去掉（正文对 shell 是字面文本），换行与
  `;` / `&&` / `||` / `|` 一样是分隔，以 `#` 开头的纯注释段不构成命令。换行只在闸门内部
  切开——`permission::split_by_separators` 是只读 / 破坏性 / 后台化构造共用的口径，
  不为闸门改它。
- 段首词判定复用 `extract_command_name`（剥环境变量前缀、剥首尾各至多一个引号后取首词），
  与 `contains_sleep_command` / `sleep_duration_ms` 同一口径；`/usr/bin/sleep 10` 与
  `timeout 30 sleep 5` 这类绝对路径 / 包裹写法不命中，是既有已知边界。
- `sleep`：任一段命令名是 `sleep` 即命中，不区分首段还是后续段，单条 `sleep 5` 同样失败。
- 判定只看命令文本，不看 `run_in_background` / `detach` / `timeout`：三种调用形态一视同仁。
  不读文件系统、不识别 sleep 时长、不解析后续命令是否引用了某个后台任务的输出路径。

闸门落点：`permission.rs` 的 `base_check` Bash 分支在只读判定之前返回
`Decision::Deny`（`check` 的 `deny` 分支，不是 `ask`）——`ask` 在 auto 模式会被放行，
三档模式的一致性就没了。因此被拦的调用**不弹权限确认框**、不产生后台任务与 taskId、
不发完成通知或提醒。`detach: true` 的豁免只覆盖后台化构造，不解除本闸门；
`restricted: false` 也不豁免后台化构造闸门——两个字段互不豁免。两条闸门都命中时先报
本闸门的文案。

LLM 面失败文案（逐字锁定，不插值）：

| 常量 | 文案 |
| --- | --- |
| `BASH_RESTRICTED_SLEEP_MESSAGE` | `Bash: do not use \`sleep\` to poll for results — poll on a condition (e.g. until the output exists) or simply stop and wait: you are notified when the background task completes and the turn continues.` + 换行 + `- If you are certain this is a false positive, re-run the same command with restricted: false.` |

文案以逃生口收尾：模型确认这是误拦截时，把同一个命令带上 `restricted: false` 重跑即可
（FR-007），不必改写命令、也不必向用户提问。

放行范围：`restricted: false` 的任意命令、引号内 / 注释里的 `sleep` 字样、heredoc 正文、
首词不是 `sleep` 的写法（绝对路径、`timeout` 包裹、`nosleep`）。
说明面的最小披露口径（schema 与系统提示词各一句、不展开用法与案例）见
[FR-006](#fr-006restricted-的说明面)。

### FR-006：`restricted` 的说明面

`restricted` 的 schema 成员显式带 `default: true`（与 `bash_restricted` 的读取口径同值），
说明文字是英文的一句「默认 `true`、通常传 `true`」——只声明默认值与常规取值，不复述判据、
不提前点明它限制哪一类写法；系统提示词只有一句
`The restricted parameter is normally true.`。判据细节与逃生口都在失败文案里给，提示词与
schema 不复述（最小披露口径，与 `detach` 同款）。`default` 属于模型可见契约，
`schema_parity_tests` 逐字对照 `core-rs/fixtures/toolSchema.json`。

### FR-007：误拦截的逃生口写在失败文案里

被闸门拦下的命令在文案末尾给逃生口：确认是误拦截时，把同一个命令带上 `restricted: false`
重跑。模型无需改写命令、无需向用户提问，也不必从别处推断这个参数的存在——这与 `detach`
的「失败文案给三条出路」是同一种教学方式。

### FR-008：提示词里的读文件 / 搜索口径

系统提示词 Bash 段的 `**Prefer the Read tool**` 块写明看文件内容时的入口是 `Read`：
`cat a.txt` 对应 `Read` 的 `file_path`，`sed -n '1,40p' f` 对应 `Read` 的
`offset` / `limit`；内容要流进另一条命令（管道、重定向）时照常用 `cat` / `sed`。

紧随其后的 `**Prefer the Grep and Glob tools**` 块写明单个搜索用专用工具而不是 Bash
命令：找文件内容用 `Grep`、找文件名用 `Glob`，不写 Bash 的 `rg` / `fd`；结果要喂给另一条
命令（管道、重定向、`xargs`）或需要工具不暴露的旗标时才用 Bash 的 `rg` / `fd`。其后才是
`**Prefer ripgrep and fd**` 块（`rg` 代替 `grep`、`fd` 代替 `find` 及三条易踩规则）——
先给工具，再给 Bash 里的退路。

`cat` 不进闸门判据（FR-005 只管 `sleep`）：`cat` 是只读命令、在只读
白名单里，而且 `cat > f <<'EOF'` 这类写形态同样依赖它。因此这条规则只约束模型的选择，
不产生工具失败；`sed` 读 / 改文件由工具结果里的提醒兜底（FR-009），两者口径不重叠。

### FR-009：`sed` 读 / 改文件的结果提醒

去掉所有 `cd` 段后只剩 `sed` 的命令（`sed -n '1,40p' f`、`cd src && sed -n 1p a.ts`、
`sed -i 's/a/b/' f`）**照常执行**：它是有用的文本加工手段，失败会挡住正当用法。
执行完成后在 Bash 工具结果末尾追加一条提醒（`BASH_SED_READ_REMINDER`），点名读文件用
`Read`（行号、`offset` / `limit` 窗口、xlsx / 图片分支）、改文件用 `Edit`，并保留
「内容要流进另一条命令时照常用 `sed`」的例外。

判据与闸门同源（`tools.rs` 的 `is_cd_sed_only_command`，共用 `gate_segments`）：去掉
命令名为 `cd` 的段后，剩余段非空且全部是 `sed` 才追加；有别的段（`sed -n 1p f | head`、
`rg x src | sed 's/a/b/'`、`git diff | sed -n '1,20p'`）就是有上下游的文本加工，不追加。
生成函数只有一处（`tools.rs` 的 `with_sed_read_reminder`），`run_in_background`、前台本地
执行、隔离视图的代理代执行与自动转后台四条返回路径共用它——同一事实只写一处。

提醒只影响工具结果文本，不改变执行、权限判定与 `restricted` 的取值语义：
`sed` 不在只读白名单，`manual` 询问、`risk` / `auto` 放行。

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
| `restricted` 闸门 | `permission.rs` 的 `base_check` Bash 分支（只读判定之前 deny）；纯函数 `tools.rs` 的 `has_sleep_command`（共用 `gate_segments`），文案 `BASH_RESTRICTED_SLEEP_MESSAGE` |
| 读文件 / 搜索口径（FR-008） | `core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` Bash 段 `**Prefer the Read tool**` / `**Prefer the Grep and Glob tools**` 块；对照表 `core-rs/fixtures/systemPrompt.json` |
| `sed` 读 / 改文件提醒（FR-009） | `tools.rs` 的 `with_sed_read_reminder`（判据 `is_cd_sed_only_command`），文案 `BASH_SED_READ_REMINDER` |
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

### 3.3 输出解码

子进程输出按**字节**收集，交给模型与 UI 前经 `core-rs/src/text_decode.rs` 解码：

| 环节 | 落点 |
| --- | --- |
| 判定顺序 | `text_decode::decode_bytes`：显式 BOM（UTF-8 / UTF-16 LE / BE）→ 严格 UTF-8 → GBK 系（`encoding_rs` 的 GBK 解码器即 GB18030 超集，同时覆盖 GBK / GB2312）→ 宽松 UTF-8 |
| 前台管道 | `tools.rs` 的 `read_pipe` 用 `OutputDecoder` 逐块解码：`read` 的 8 KiB 边界劈开的多字节字符留到下一块，只有流结束才按整条流判定码页 |
| 前台结果 | `tools.rs` 的 `run_bash` 对 stdout / stderr 的完整字节调 `decode_bytes` |
| 后台任务完成通知 | `bash_task.rs` 的 `handle_finish` 读字节后解码（严格 `read_to_string` 会让 GBK 输出整份读失败、预览变空） |
| 后台提醒预览 | `bash_task.rs` 的 `read_output_tail` 同上 |
| 转后台落盘 | `PipeSink.raw` 保留原始字节，转入后台时写输出文件——解码只发生在提交给模型 / UI 那一侧 |

为什么按内容判定而不是按平台猜码页：输出可能来自 Git Bash（UTF-8）、`chcp 65001`
（UTF-8）或 cmd / 老工具（控制台代码页），同一台机器上两种都有；而合法 UTF-8 的字节流
几乎不可能同时是合法 GBK，因此「先试 UTF-8、再试 GBK」是可靠的判别，不需要按字节猜窄码表。

## 4. 边界与错误路径

- **注册表未命中**：按钮与实际状态竞态 → 幂等忽略，调用方不补兜底（AC-2）。
- **转换失败**（打不开输出文件等）：不置暂停标记，按前台结果收尾。
- **压缩进行中**：周期提醒不投递，下一轮再发（AC-11）。
- **用户中止**：投递前检查中止标记丢弃投递；中止后台任务时注销对应时钟。
- **任务完成 / 会话关闭**：注销时钟，不再提醒。
- **同一 tick 多任务到点**：追加不覆盖（AC-10）。
- **detach 豁免的进程**：`detach: true` 的命令进程不属于后台任务事实（无注册、无
  完成通知、abort 不杀）——见 [bash-detach.md](bash-detach.md)。
- **`restricted` 闸门的边界**：
  - `sleep 10 && cat <某后台任务的输出路径>` 仍然拦——完成时会通知并接续，工具结果里
    已给出输出路径与通知承诺，不需要再 poll。
  - `sleep` 写成绝对路径（`/usr/bin/sleep 10`）或被其它命令包裹
    （`timeout 30 sleep 5`、`bash -c 'sleep 5'`）：命令名不是 `sleep`，不拦——既有首词
    口径的已知边界，不为此扩判定。
  - 引号内的字样（`echo 'sleep 5'`）、`#` 注释段、heredoc 正文：对 shell 是字面文本，
    不拦。尾随注释不改变命令行本身的判定（`sleep 10 # wait` 仍拦）。
  - `restricted: false` 是唯一开关：命令回到既有权限路径（`sleep` 不在只读白名单，
    `manual` 询问、`risk` / `auto` 放行）。
  - 被拦后换写法重试：`restricted: false` 或改用条件 poll / `Read` 工具；重复命中只会
    重复同一条失败文案，不升级为权限询问或会话中止。
- **`sed` 提醒的边界**：
  - 绝对路径与包裹写法（`/usr/bin/sed -n 1p f`、`cat f | /usr/bin/sed -n 1p`）的首词
    不是 `sed`，不追加提醒——与判据首词口径一致的已知边界。
  - 引号内 / `#` 注释里的 `sed` 字样不是子命令，不追加提醒。
  - 提醒只在工具结果文本末尾追加一行，不改变退出码、`is_error` 与权限判定；命令被中断
    时同样追加（模型看到的是同一条命令的结果）。
- **两种解码都不干净**（混合编码 / 被截断的流）：回到宽松 UTF-8，至少不丢可读部分。
- **BOM 声明的编码与内容不符**：按宽松 UTF-8 收尾，不抛错——输出只能尽力而为，失败不
  值得让工具报错。

## 5. 非目标

- 后台任务的注册 / 完成通知 / 中止语义不在本规格内。
- 运行时事实（`backgroundRunning`）的归属见 [docs/core/session-runtime.md](../core/session-runtime.md)。
- `restricted` 闸门不识别「在等某个后台任务」的语义——判定只看命令文本形态，不解析
  输出路径、不做跨任务关联；也不识别绝对路径 / 包裹写法的 `sleep`（已知边界）。
- `sed` 提醒不改变工具结果的结构与退出码，也不改写用户命令；它只追加一行引导，
  不做权限拦截、不阻断执行。
- 不改 `sleep` 的前台超时死线后移：`restricted: false` 时该行为原样保留。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-45（命令转入后台）、US-76
（后台等待不靠 sleep 轮询）、US-77（单个搜索优先用 `Grep` / `Glob` 工具）与 US-78（读文件优先用
Read 工具），见 [user-stories/tools.md](user-stories/tools.md#us-76-后台等待不靠-sleep-轮询)。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `MANUAL_BG`（`auto_background_command(manual = true)`） | `core-rs/src/tools_tests.rs` 的 `bash_manual_background_converts_and_requests_loop_pause`；e2e `e2e/webview/bashBackgroundButton.spec.ts` | 自动 |
| FR-002 | `core-rs/src/engine.rs` 的 `run_query_loop` | `core-rs/src/engine_tests.rs` 的 `manual_background_pauses_the_loop_until_a_queued_message_arrives`；e2e `e2e/electron/backgroundBash.spec.ts` | 自动 |
| FR-003 | `core-rs/src/engine.rs` 的 `background_reminder`（门槛与刷新，`core-rs/src/bash_task.rs` 的 `qualifies_fallback_reminder`） | `core-rs/src/engine_tests.rs` 的 `fallback_reminder_gate`；`core-rs/src/tools_tests.rs` 的 `contains_sleep_command_splits_on_separators` | 自动 |
| FR-004 | `core-rs/src/engine.rs` 的 `tick_background_reminders`（纯函数 `core-rs/src/bash_task.rs` 的 `advance_reminder_clock` / `build_background_reminder_text`） | `core-rs/src/bash_task_tests.rs` 的 `background_reminder_parity`；事件序列对照表 `core-rs/fixtures/eventTypes.json` | 自动 |
| FR-005 | `core-rs/src/permission.rs` 的 `base_check` Bash 分支；纯函数 `core-rs/src/tools.rs` 的 `has_sleep_command`（共用 `gate_segments`）与 `bash_restricted`，文案 `BASH_RESTRICTED_SLEEP_MESSAGE` | `core-rs/src/tools_tests.rs` 的 `restricted_gate_rejects_sleep_anywhere`；`core-rs/src/permission_tests.rs` 的 `restricted_sleep_gate_denies_in_every_agent_mode` / `restricted_gate_ignores_quoted_comment_and_heredoc_sleep` / `sed_read_commands_follow_the_existing_permission_path` / `restricted_false_lifts_the_sleep_gate_only` / `restricted_false_keeps_detach_gate` / `restricted_gate_is_not_lifted_by_detach` / `restricted_gate_wins_over_detach_gate` / `restricted_defaults_to_true`；对照表 `core-rs/fixtures/permission.json` | 自动 |
| FR-006 | `core-rs/src/tools.rs` 的 `BASH_RESTRICTED_FIELD`；`core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` Bash 段 | `core-rs/src/prompt_tests.rs` 的 `system_prompt_static_text_matches_the_shared_table`；`core-rs/src/tools_tests.rs` 的 `schema_parity_tests`；对照表 `core-rs/fixtures/toolSchema.json` / `systemPrompt.json` | 自动 |
| FR-007 | `core-rs/src/tools.rs` 的 `BASH_RESTRICTED_SLEEP_MESSAGE` 末行 | `core-rs/src/permission_tests.rs` 的 `restricted_messages_name_the_escape_hatch` / `restricted_false_lifts_the_sleep_gate_only` | 自动 |
| FR-008 | `core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` Bash 段 `**Prefer the Read tool**` / `**Prefer the Grep and Glob tools**` 块 | `core-rs/src/prompt_tests.rs` 的 `tool_details_prefer_read_over_cat_and_sed` / `tool_details_prefer_grep_and_glob_tools` / `system_prompt_static_text_matches_the_shared_table`；对照表 `core-rs/fixtures/systemPrompt.json`（`cat` 不进闸门的口径由 `permission_tests` 的既有 `restricted_*` 放行用例覆盖） | 自动 |
| FR-009 | `core-rs/src/tools.rs` 的 `with_sed_read_reminder`（判据 `is_cd_sed_only_command`），文案 `BASH_SED_READ_REMINDER` | `core-rs/src/tools_tests.rs` 的 `sed_read_reminder_needs_cd_and_sed_only` / `sed_read_command_runs_and_carries_the_read_reminder`；`core-rs/src/permission_tests.rs` 的 `sed_read_commands_follow_the_existing_permission_path` | 自动 |
| 输出解码（第 3.3 节） | `core-rs/src/text_decode.rs`；`core-rs/src/tools.rs` 的 `read_pipe` / `run_bash`；`core-rs/src/bash_task.rs` 的 `handle_finish` / `read_output_tail` | `core-rs/src/text_decode_tests.rs`（码页判定与增量不劈字）；`core-rs/src/tools_tests.rs` 的 `bash_decodes_gbk_output_to_readable_chinese` / `bash_decodes_utf8_output_unchanged` / `bash_does_not_split_multibyte_chars_across_pipe_chunks` | 自动 |
