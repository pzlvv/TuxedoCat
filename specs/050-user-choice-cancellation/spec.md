---
status: 已收敛
---

# 改动规格：用户选择请求的作废与收回

Core 侧的 `CoreRequest.userChoice`（权限确认与 `AskUserQuestion` 共用的问答通道）在
两种情况下会自行作废：等待应答满 1 小时超时、会话被 abort。作废时 Core 只是丢掉自己
的 `pending` 条目，宿主不知道；宿主队列里那条 pending 仍在，webview 里的选择框也仍在。
用户之后点选等于对着一个已经结束的请求作答：应答被 Core 丢弃，工具早已以 error 收尾，
而弹框在下一次打开该会话时还会被重新投递出来。

这次改动让作废**从发起方宣告**：Core 在作废时刻发一条撤回事件，宿主据此拒答队列
pending、通知 webview 收框、`waiting` 归零；同时 webview 把选择框与发起它的工具调用
绑定，工具收尾（成功或失败）即收回选择框，并给选择框一个显式的取消入口。不带兜底：
宿主不自己算超时、不猜「大概已经作废了」，只认 Core 的宣告与工具的收尾事实。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.1 CoreEvent](../../docs/architecture/events.md#21-coreeventcore--ui单向) | 修改 | 新增 `userChoiceCanceled` 行（载荷 / 触发点 / 处理方）；聚合数字由 docsLint 对照代码，落地时同步 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.2 CoreRequest](../../docs/architecture/events.md#22-corerequestcore--ui请求-响应) | 修改 | `userChoice` 载荷新增请求标识字段（宿主回显与撤回定位用） |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [6 边界语义](../../docs/architecture/events.md#6-边界语义) | 修改 | 「请求超时约定」的 `userChoice` 条由「core 阻塞等待、不额外加超时」改为「1 小时上限 + 作废时宣告」 |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [1 来源与调用点](../../docs/core/session-runtime.md#1-来源与调用点) | 修改 | `waiting` 的解除来源补上「作废宣告」 |
| [docs/features/ask-user-question.md](../../docs/features/ask-user-question.md) | [边界与错误路径](../../docs/features/ask-user-question.md#边界与错误路径) | 修改 | 补「Core 侧请求已作废」「工具已收尾」两行 |
| [docs/features/ask-user-question.md](../../docs/features/ask-user-question.md) | [FR-003 逐页选择框](../../docs/features/ask-user-question.md#fr-003逐页选择框) | 修改 | 选择框的取消入口 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [3 总线注册](../../docs/hosts/webview-ui.md#3-总线注册) | 修改 | `onCoreEvents` 数量与名单（docsLint 对照 `WebViewUI` 映射表） |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [11 消息区视图行为](../../docs/hosts/webview-ui.md#11-消息区视图行为) | 修改 | 选择框收回时的回底与焦点复位口径 |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [1 UserChoiceManager](../../docs/architecture/host-ui-modules.md#1-userchoicemanager) | 修改 | 新增「按请求标识作废」的方法与语义 |
| [docs/hosts/pycharm-plugin.md](../../docs/hosts/pycharm-plugin.md) | [4 权限确认流](../../docs/hosts/pycharm-plugin.md#4-权限确认流) | 修改 | 作废宣告的宿主落地 |
| [docs/hosts/tui.md](../../docs/hosts/tui.md) | [5.2 CoreRequest → 交互与应答](../../docs/hosts/tui.md#52-corerequest--交互与应答) | 修改 | TUI 的 `UserChoiceManager` 同样按作废宣告收敛 |

## 用户场景与验收标准

- 场景 1：请求在用户作答前作废
  - **AC-1**（FR-001）：GIVEN 一次 `userChoice` 已投递到会话视图、等待用户点选 WHEN Core 端的等待达到上限而放弃 THEN Core 发出一次作废宣告，载荷带该会话与那次请求的标识。
  - **AC-2**（FR-001）：GIVEN Core 发出作废宣告 WHEN 宿主收到 THEN 该会话的队列 pending 被拒答、webview 里的选择框被收回，无需用户任何操作。
  - **AC-3**（FR-001）：GIVEN 作废宣告已到达 WHEN 用户随后仍尝试提交该选择框 THEN 宿主按「请求已不存在」处理，不产生应答，也不残留 pending。
  - **AC-4**（FR-002）：GIVEN `userChoice` 已投递而会话仍 open、尚未作答 WHEN 用户点击 abort THEN Core 发出作废宣告，该轮按已中止收敛。
- 场景 2：工具已收尾，选择框自己让位
  - **AC-5**（FR-003）：GIVEN 选择框正在等用户 WHEN 发起它的工具产出了结果（success 或 fail） THEN webview 立刻收回该选择框并恢复主输入框。
  - **AC-6**（FR-003）：GIVEN 同一会话先后有两次提问 WHEN 前一次的选择框仍在 THEN 后一次投递的选择框替换它，界面上只留最新一次。
  - **AC-7**（FR-003）：GIVEN 选择框已因工具收尾被收回 WHEN 用户切走再切回该会话 THEN 选择框不再出现。
- 场景 3：用户主动放弃
  - **AC-8**（FR-004）：GIVEN 选择框正在等用户 WHEN 用户点击取消 THEN 界面立即收起，宿主把这次请求以「用户取消」回给 Core，Core 侧工具按取消收敛、`waiting` 归零。
  - **AC-9**（FR-004）：GIVEN 用户在逐页提问的中间页点了取消 WHEN 需求量该次调用的结果 THEN 工具结果是错误且不产生部分答案，未提交的草稿不落盘。
- 场景 4：作废之后不清账的老问题不再出现
  - **AC-10**（FR-001）：GIVEN 某会话的请求已被作废 WHEN 用户重新打开该会话 THEN 宿主不再投递该请求（`onSessionLoaded` 找不到 pending，不弹框）。
  - **AC-11**（FR-001）：GIVEN 作废宣告到达 WHEN 会话运行时快照被推给 UI THEN 该会话的 `waiting` 为 false，侧栏与托盘不显示黄色等待态。
- 场景 5：契约与文档同步
  - **AC-12**（FR-005）：GIVEN 作废宣告与取消消息进入契约 WHEN 跑文档守卫 THEN 词汇表成员名、载荷列、`onCoreEvents` 名单与聚合数字与代码一致。
- 场景 6：用户回复超时
  - **AC-13**（FR-006）：GIVEN `settings.json` 的回复超时设为 N 秒 WHEN 一次 `userChoice` 等待满 N 秒 THEN Core 发出一次作废宣告，`AskUserQuestion` 以超时错误收尾。
  - **AC-14**（FR-006）：GIVEN 回复超时缺省 WHEN Core 读取等待上限 THEN 取默认值 1800 秒，不读 `engine.rs` 里的硬编码常量。
  - **AC-15**（FR-006）：GIVEN 回复超时被设为非数值或 ≤ 0 WHEN 宿主生成快照 THEN 取默认值，Core 不因非法值报错。
  - **AC-16**（FR-006）：GIVEN 一次 `userChoice` 已在等待中 WHEN 用户改动回复超时设置 THEN 在途请求仍按发起时的取值，只影响该会话下一次请求。
  - **AC-17**（FR-006）：GIVEN 权限确认因超时收尾 WHEN core 收敛该批工具 THEN 按拒绝处理且本轮不终止，结果交回模型。

## 功能需求

### FR-001：Core 宣告 `userChoice` 作废

Core 在放弃一次 `userChoice` 等待时发出一次作废宣告（`CoreEvent`），载荷包含该请求
所属的 `sessionId` 与请求标识；宣告是这次请求生命周期的终点，Core 侧不再接受它的应答。

作废的唯二来源：

- **用户回复超时**：等待应答超过「用户回复超时」设定而放弃（见 FR-006）；
- 该会话被 abort 中止，前台查询退出。

两个来源都在作废那一刻由 Core 推出宣告，abort 的宣告在 abort 调用返回前发出：宿主不需要
计时、不需要周期检查会话状态，收到的宣告就是事实本身。

宣告与「每次请求都有唯一标识」绑定：宿主据此精确拒答那一条 pending，而不是把该会话
随后新发起的请求一并清掉。不存在「请求已作废但宿主不知道」的静默状态。

请求标识由 Core 在发起时生成并随请求下发：Core 是唯一知道「哪次等待已放弃」的一方，
标识必须与宣告同源；宿主侧的 `choiceId` 是投递时刻的展示句柄（webview 重建会重新生成），
不能承担跨重建的身份。Core 的帧请求 id 也不可——它是总线内部的路由号，不出现在
事件载荷里。

### FR-002：作废宣告的宿主落地

宿主收到作废宣告后，以**同一条请求标识**收敛这三处，且只做这三处：

- 队列 pending：以「请求已作废」拒答，会话重新加载（`onSessionLoaded`）之后不再投递；
- webview 选择框：投递收回消息，界面恢复主输入框，草稿按取消口径丢弃；
- 会话等待状态：`waiting` 归零（不再依赖下一次应答或视图释放来解除）。

这条路径不带兜底：宿主不自行计时、不在心跳 / 保活里推测作废、不因为「很久没动静」
就清 pending。

### FR-003：选择框与发起它的工具绑定

投递到 webview 的选择请求带上发起它的工具调用标识。该工具产出的结果到达时，webview
收回与之对应的选择框——成功与失败一视同仁；同一会话同一时刻至多一个选择框，后到者
替换先到者。

收回是纯粹的界面收敛：它与 FR-002 的作废宣告走同一条收框路径（焦点、草稿、回底
一致），区别只在触发源。

### FR-004：显式取消入口

选择框提供取消操作（逐页提问与权限确认两处一致）。用户点击后：

- 界面立即收起并恢复主输入框；
- 宿主把该请求以「用户取消」回给 Core；
- Core 按「请求得到否定答复」收敛：权限确认视为拒绝；`AskUserQuestion` 视为工具失败，
  不产出部分答案。

取消与作废是两条方向相反的事件：取消是用户对**仍在等待**的请求作答，作废是 Core 宣告
请求**已经不需要**作答。取消之后不应再收到同一请求的作废宣告（除非先作废后取消，
那时取消按 FR-001 的「请求已不存在」处理）。

### FR-005：契约与文档同步

作废宣告、作废标识、选择框的取消消息都进总线契约与 webview wire，词汇表、载荷列、
`onCoreEvents` 名单与各宿主的分发分支同步补齐；`docs/` 的 as-built 规格与代码在同一次
改动内一致。

### FR-006：用户回复超时可配置

「用户回复超时」是可配置项（`settings.json`），缺省取唯一来源的默认值；Core 读取它作为
`waiting_request` 的等待上限，取代现在写死在 `engine.rs` 的 1 小时常量。

- 取值是正整数秒，且必须 > 0：非数值 / ≤ 0 / 缺省一律取默认值 **1800 秒**（规范化在
  `src/shared/settingsSnapshot.ts`，Core 只读已解析的快照，不各自声明默认值）。
- 超时时长对该会话**下一次**发起的 `userChoice` 生效；已在等待中的请求沿用发起时的取值
  （改配置不打断在途提问）。
- 超时后按 FR-001 发作废宣告，并按下面的口径收敛工具与对话：
  - `AskUserQuestion`：工具以失败收尾，错误文案点明是超时而非泛化的「请求失败」，
    不产出部分答案；
  - 权限确认：按**拒绝**收敛，但**不终止本轮**——模型可换一种方式继续（与「不带原因拒绝
    就结束本轮」的既有口径相区分）。
- 对话不因超时结束：作废只是让这一次提问作废，本轮仍把结果交回模型。

## 边界与错误路径

| 输入 / 场景 | 预期行为 |
| --- | --- |
| 作废宣告到达时会话已关闭 / 视图已释放 | 队列与 webview 均已无该请求：宣告是 no-op，不报错、不重开视图 |
| 作废宣告的请求标识在宿主侧不存在 | 视为已收敛，no-op；不把同会话的新请求一起清掉 |
| 同一条作废宣告重复到达 | 幂等，第二次为 no-op |
| 用户在作废宣告到达的同一刻提交作答 | 以先到者为准：先作废则本次作答按「请求已不存在」丢弃；先作答则作废宣告按「请求已不存在」no-op |
| 会话被 abort 而 `userChoice` 仍在等待 | 先发作废宣告，再按中止收尾；不留下挂起的等待 |
| Core 进程退出 / 连接断开 | 不走作废宣告（进程已不在）；连接层既有语义拒绝未决请求，本次不改 |
| 用户在取消入口提交了部分答案 | 取消不产生答案：未提交的草稿丢弃，工具结果是取消而非部分答案 |
| 权限确认框被用户取消 | 按拒绝收敛（与「拒绝」同一语义，带 `terminate` 口径与拒绝一致） |
| 回复超时设为非数值 / 0 / 负数 | 取默认值，不报错、不把等待上限变成 0 或负数 |
| 回复超时设为极大值 | 接受该值，不额外加上限（用户显式选择等很久） |
| 超时与用户作答几乎同时 | 以先到者为准：先超时则本次作答按「请求已不存在」丢弃；先作答则超时作废按 no-op |
| 作废宣告早于 webview 选择框渲染完成 | 收回消息与投递消息按到达顺序生效，最终不显示选择框 |

## 非目标

- 不引入 dsh 的 `timeout` 定时等待与「稍后回复」的 pending 语义（「稍后回复」需要用户
  消息回填通道）。去向：[docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)。
  回复超时（FR-006）只让这次提问作废，不是「稍后还能补答」。
- 不改变「会话未 open 时保留 pending、open 后重投」的投递语义（作废只是新增的终点）。
- 不做宿主侧的作废推测 / 定时清扫（与「不过度 fallback」铁律冲突）。
- 不改变权限确认与 `AskUserQuestion` 共用一个 `userChoice` 通道的结构。

## 对需求基线的影响

无新增 US。这次改动修的是既有 US 的收尾语义：[US-18 工具执行前的权限确认](../../docs/features/user-stories/messages.md#us-18-工具执行前的权限确认)
与 [US-58 一次提问多个问题并支持多选](../../docs/features/user-stories/messages.md#us-58-一次提问多个问题并支持多选)
都隐含「选择框在请求结束时消失」，但都没写请求作废这一支——按 L3 登记实现与测试，
由 spec 的追溯矩阵承载；不新增用户故事，因为用户侧的可观察行为是「弹框该消失时消失」，
没有新增交互场景。取消入口（FR-004）是既有选择框上新增的操作，落在
[US-18 验收标准 1–2](../../docs/features/user-stories/messages.md#us-18-工具执行前的权限确认)
与 [US-58 验收标准 1–5](../../docs/features/user-stories/messages.md#us-58-一次提问多个问题并支持多选)
覆盖的同一 surface 上，同样不新增 US。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `CoreEvent.userChoiceCanceled`；`core-rs/src/engine.rs` 的 `waiting_request` 与 `abort` 路径 | `core-rs/src/engine_tests.rs` | 自动 |
| FR-002 | `src/host/ui/userChoice.ts`（按标识拒答 + 收框）、`src/host/ui/webviewMessageHandler.ts` | `src/test/userChoiceCancellation.test.ts` | 自动 |
| FR-003 | `requestUserChoice` wire 的 `toolUseId`、`src/webview/hooks/handlers/toolHandlers.ts` | `e2e/webview/userChoiceCancellation.spec.ts` | 自动 |
| FR-004 | `src/webview/UserChoiceOverlay.tsx`、`QuestionOverlay.tsx`、`respondUserChoice` wire | `e2e/webview/userChoiceCancellation.spec.ts` | 自动 |
| FR-005 | `src/shared/AssistantEventBus.ts`、`src/host/webviewMessages.ts`、四个宿主的 `CoreEvent` 分发 | `src/test/docsLint.test.ts` | 自动 |
| FR-006 | `src/shared/settingsSnapshot.ts`（字段与默认值单源）、`core-rs/src/settings.rs`（快照字段）、`core-rs/src/config.rs`（访问器）、`core-rs/src/engine.rs` 的 `waiting_request` | `src/test/settingsSnapshot.test.ts`、`core-rs/src/engine_tests.rs` | 自动 |

## 待澄清

无。

## 收敛记录

- **已满足**
  - FR-001（AC-1 / AC-2 / AC-3 / AC-4 / AC-10 / AC-11）：`core-rs/src/engine.rs` 的
    `cancel_user_choice` 唯一出口；`abort_pending_user_choice` 用 drop sender 打断等待
    （不轮询），`abort_session_scope` 与 `on_abort` 的前台分支都调它；
    `core-rs/src/bus.rs` 的 `abort_pending_user_choice` + `PendingRequest` 元数据。
    证据：`engine::tests::abort_during_the_tool_loop_skips_the_next_llm_round`（断言作废
    宣告的 `reason=aborted` 且 `choiceRequestId` 与下发值同源）。
  - FR-002（AC-2 / AC-3）：`src/host/ui/userChoice.ts` 的 `cancelUserChoice`、
    `src/shared/UserChoiceQueue.ts` 的按标识 `cancel`。
    证据：`src/test/userChoiceCancellation.test.ts`（9 条，含「不补发
    userChoicePendingChanged(false)」与「旧标识不误杀同会话新请求」）。
  - FR-003（AC-5 / AC-6 / AC-7）：`requestUserChoice` wire 带 `toolUseId`；webview 的
    `dismissUserChoiceForTool` 在 `updateToolStatus` 收尾时按 `toolUseId` 收框。
    证据：`e2e/webview/userChoiceCancellation.spec.ts` 的 AC-5 / AC-7 用例。
  - FR-004（AC-8 / AC-9）：`UserChoiceOverlay` / `QuestionOverlay` 的取消按钮 + Esc；
    `respondUserChoice.canceled` → 宿主以拒绝收敛。
    证据：`e2e/webview/userChoiceCancellation.spec.ts` 的 AC-8 / AC-9 两条。
  - FR-005（AC-12）：`docs/architecture/events.md` 的 2.1 / 2.2 与 [第 6 节 边界语义](../../docs/architecture/events.md#6-边界语义)、
    `core-rs/fixtures/eventTypes.json`、`docs/hosts/webview-ui.md`、`docs/hosts/pycharm-plugin.md`、`docs/hosts/tui.md`。
    证据：`npm run test:unit -- docs-lint` 全绿；`cargo test` 的
    `rust_type_literals_are_registered_in_the_fixture` 绿。
  - FR-006（AC-13 / AC-14 / AC-15 / AC-16 / AC-17）：默认值 1800 秒单源在
    `src/shared/settingsSnapshot.ts`；`core-rs/src/config.rs` 的 `user_choice_timeout()`
    读快照；`waiting_request` 发起时取一次。
    证据：`config::tests::user_choice_timeout_reads_the_snapshot_and_falls_back_to_1800`、
    `engine::tests::user_choice_timeout_cancels_the_request_and_keeps_the_turn_going`
    （1 秒超时驱动，断言 `reason=timedOut` 且本轮继续）。
- **偏差**（均已就地修正，不影响验收）
  - 作废原因口径：原计划在等待失败后读会话 `cancel` 标志推断「超时 / 中止」，实测该标志
    会被消费循环随查询收尾复位，事后读到的值不可靠。改为打断侧写入
    `ABORTED_CHOICE_REQUESTS`（帧 id 集合）显式留下原因，等待方消费后即删。
  - `CoreBus::request` 改为**先登记 pending 再发帧**：原顺序下自动应答器可能在条目登记前
    应答，导致应答被丢弃、abort 找不到可打断的请求。
  - `on_abort` 的前台忙碌分支原先只置 cancel、不走 `abort_session_scope`，因此不在途
    `userChoice` 打断；已在该分支补 `abort_pending_user_choice`。
- **未做**：无。设置面板的编辑控件按非目标另行排期。
