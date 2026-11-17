# 任务分解：用户选择请求的作废与收回

执行顺序：先契约（标识 + 事件字段）→ Core 侧作废与超时 → 宿主侧收敛 → webview 收框与
取消 → 三宿主对齐 → 文档。每一步都先红后绿：Core 侧与宿主侧的回归用例在对应任务内
落地，不留到最后补。需求见同目录 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

依赖链的主干是 T001 → T003 → T006 → T009，其余可以并行；文档同步（T018–T020）必须与
代码在同一提交内完成。

## 任务清单

- [x] **T001**（FR-001、FR-005）：总线契约加标识与作废事件——`CoreEvent` 新增
      `userChoiceCanceled { sessionId, choiceRequestId, reason: 'timedOut' | 'aborted' }`，
      `CoreRequest.userChoice` 载荷加必选 `choiceRequestId`；`UserChoiceOptions` 同步加字段；
      `WebViewUI` 的 `onCoreEvents` 映射表补该事件（先给空实现占位，T009 填空）；
      依赖：—；完成判据：`npm run check-types` 绿（映射表穷尽检查通过），
      `npm run test:unit -- docs-lint` 的 CoreEvent 数量与成员名断言暂红为预期（T018 修）。
- [x] **T002**（FR-006）：配置字段与默认值单源——`src/shared/settingsSnapshot.ts` 加
      `SettingsSnapshot.llm.userChoiceTimeoutSeconds: number`，正整数才接受（非数值 / ≤ 0 /
      缺失取默认值 1800 秒），默认值只在默认值区声明一次；依赖：—；
      完成判据：`src/test/settingsSnapshot.test.ts` 新增「非法值回落默认」「正整数透传」
      两例全绿。
- [x] **T003**（FR-001、FR-006）：Core 侧等待超时参数化——`core-rs/src/settings.rs` 加
      `userChoiceTimeoutSeconds` 反序列化字段，`core-rs/src/config.rs` 加
      `user_choice_timeout()`（与 `default_web_search()` 同型，快照未就绪回落默认值），
      `engine.rs` 的 `await_response` 参数化超时并从 `waiting_request` 传入；
      依赖：T002；完成判据：`core-rs/src/engine_tests.rs` 新增「超时取配置值而非硬编码」
      一例绿（用小超时值驱动，不真等）。
- [x] **T004**（FR-001）：总线支持主动打断——`core-rs/src/bus.rs` 把 `pending` 的 value 从
      `(String, Sender<Value>)` 改为 `(PendingRequest, Sender<Value>)`
      （`PendingRequest { request_type, session_id, choice_request_id }`），新增
      `abort_pending(filter) -> Vec<u64>`：命中条目移除并 drop sender；
      依赖：—；完成判据：`core-rs/src/bus_tests.rs` 新增「`abort_pending` 命中后接收端立即
      收到 `Disconnected`」与「不命中条目不被动」两例绿。
- [x] **T005**（FR-001）：Core 侧作废出口——`engine.rs` 新增 `cancel_user_choice(request,
      reason)` 发 `userChoiceCanceled`；`waiting_request` 在等待失败时按来源传
      `UserChoiceEnd::TimedOut`；`abort_session_scope` 调 `bus.abort_pending` 打断该会话在途
      `userChoice` 并传 `Aborted`；依赖：T001、T003、T004；
      完成判据：`core-rs/src/engine_tests.rs` 新增三例绿——超时发作废事件且载荷含
      `choiceRequestId` / `reason=timedOut`；abort 在作废事件发出前不返回；abort 后等待线程
      不再挂起（原 3600s 等待被打断）。
- [x] **T006**（FR-006）：超时后的工具与对话收敛——`core-rs/src/tools.rs` 的 `UserChoiceFn`
      改为返回 `Result<Value, UserChoiceFailure>`，`run_ask_user_question` 在 `TimedOut` 时
      产出「等待用户回复超时」错误；`request_user_choice` 在 `TimedOut` 时返回
      `PermissionOutcome::Denied { terminate: false }`（拒绝但不终止本轮）；
      依赖：T005；完成判据：`core-rs/src/engine_tests.rs` 新增「超时后本轮仍继续、有下一轮
      LLM 请求」与「AskUserQuestion 超时文案含超时字样、无部分答案」两例绿。
- [x] **T007**（FR-001、FR-002）：队列按标识取消——`src/shared/UserChoiceQueue.ts` 的
      `PendingChoiceEntry` 加 `choiceRequestId`，新增 `cancel(choiceRequestId, reason)`
      （按标识而非 `sessionId` 匹配，命中删除并 reject，未命中返回 `false`）；
      依赖：T001；完成判据：`src/test/userChoiceQueue.test.ts` 新增「按标识取消不影响同会话
      新请求」「重复取消为 no-op」两例绿。
- [x] **T008**（FR-002）：宿主收敛三步——`src/host/ui/userChoice.ts` 新增
      `cancelUserChoice(sessionId, choiceRequestId)`：拒答队列 pending、以「请求已作废」
      reject 匹配的 `pendingUserChoices` 条目、投递 wire 收框消息；`showUserChoice` 与
      `restoreUserChoiceIfPending` 保持同一 `choiceRequestId`；不补发
      `userChoicePendingChanged`；依赖：T007；
      完成判据：`src/test/userChoiceCancellation.test.ts` 新增三例绿——队列被拒答、
      Promise 被 reject、投递了收框消息；并断言未发 `userChoicePendingChanged`。
- [x] **T009**（FR-002、FR-005）：宿主接线——`WebViewUI` 的 `userChoiceCanceled` 映射落到
      `cancelUserChoice`；`src/host/webviewMessages.ts` 的 `requestUserChoice` 加
      `toolUseId` / `choiceRequestId`、新增下行 `userChoiceCanceled`、`respondUserChoice`
      加 `canceled: boolean`；`webviewMessageHandler` 的 `handleRespondUserChoice` 分应答 /
      取消两支；依赖：T008；
      完成判据：`npm run check-types` 绿；T008 的用例改为走真实接线后仍绿。
- [x] **T010**（FR-003）：webview 收框钩子——`src/webview/types.ts` 的 `UserChoiceRequest` 加
      `toolUseId` / `choiceRequestId`；`handlers/toolHandlers.ts` 存标识并在
      `updateToolStatus` 收到同 `toolUseId` 的 success / fail 时收框（清 `userChoiceRequest`
      与 `sessionStates` 同名字段）；依赖：T009；
      完成判据：新增用例覆盖「工具 fail 后选择框消失」「不同 toolUseId 不误收」。
- [x] **T011**（FR-002、FR-003）：webview 收框消息——`useMessageHandler` 新增
      `userChoiceCanceled` 分支，按 `choiceRequestId` 匹配当前选择框后收框；与 T010
      复用同一收框路径（焦点复位、草稿丢弃、回底）；依赖：T009、T010；
      完成判据：e2e `userChoiceCancellation.spec.ts` 的「作废后选择框消失且主输入框恢复」
      用例绿。
- [x] **T012**（FR-004）：取消入口——`UserChoiceOverlay` 与 `QuestionOverlay` 各加取消按钮
      与 Esc 键，回调到 `useAppHandlers` 的取消路径（投递
      `respondUserChoice { canceled: true }`、清状态、恢复主输入框）；
      `i18n/{zh,en}.ts` 加文案；依赖：T009；
      完成判据：e2e `userChoiceCancellation.spec.ts` 的「点取消后选择框收起」「逐页提问中间页
      取消不产生部分答案」两例绿。
- [x] **T013**（FR-004）：取消的 Core 收敛——`handleRespondUserChoice` 收到 `canceled` 时
      以「用户取消」reject 而非当作正常应答；确认权限确认按拒绝、`AskUserQuestion` 按工具
      失败且不产出部分答案；依赖：T009、T012；
      完成判据：`src/test/userChoiceCancellation.test.ts` 新增「取消不产生 answers」一例绿。
- [x] **T014**（FR-002、FR-005）：PyCharm 宿主——`HostUi.onCoreEvent` 分发
      `userChoiceCanceled`，`UserChoiceManager` 加与 TS 同语义的按标识取消方法；
      依赖：T001；完成判据：`npm run package:pycharm` 构建通过，
      且该事件不再落 `unknown core event type` 分支。
- [x] **T015**（FR-002、FR-005）：TUI 宿主——`tui-rs/src/host.rs` 分发 `userChoiceCanceled`，
      `tui-rs/src/choices.rs` 按 `frame_id` 复用既有的错误应答能力取消；
      依赖：T001；完成判据：`npm run test:core` 中 `tui-rs` 相关用例绿，新增
      「收到作废事件后 pending 被拒答」一例。
- [x] **T016**（FR-001、FR-006）：Core 回归收口——`core-rs/src/engine_tests.rs` 补齐
      AC-4 / AC-13 / AC-16 / AC-17 的对照用例（在途请求不受改配置影响、abort 与超时
      原因区分）；依赖：T005、T006；
      完成判据：`npm run test:core` 全绿。
- [x] **T017**（FR-002、FR-003、FR-004）：宿主与 webview 回归收口——e2e
      `e2e/webview/userChoiceCancellation.spec.ts` 覆盖 AC-2 / AC-5 / AC-7 / AC-10；
      依赖：T010、T011、T012；
      完成判据：`npx playwright test -c e2e/playwright.config.ts --project=webview-ui
      userChoiceCancellation` 绿。
- [x] **T018**（FR-005）：事件词汇表同步——`docs/architecture/events.md` 的 2.1 加
      `userChoiceCanceled` 行（触发点列按真实 emit 位点写 `engine.rs`）、2.2 的 `userChoice`
      载荷列加 `choiceRequestId`、[第 6 节 边界语义](../../docs/architecture/events.md#6-边界语义)「请求超时约定」改写为「可配置超时 + 作废宣告」、
      聚合数字按 docsLint 校验值更新；依赖：T001、T005；
      完成判据：`npm run test:unit -- docs-lint` 的事件数量 / 成员名 / 触发点三组断言绿。
- [x] **T019**（FR-005）：其余 as-built 规格同步——`docs/core/session-runtime.md` [第 1 节](../../docs/core/session-runtime.md#1-来源与调用点)
      `waiting` 解除来源加作废宣告；`docs/features/ask-user-question.md` 边界表加「请求已作废」
      「工具已收尾」「回复超时」三行 + FR-003 取消入口；`docs/hosts/webview-ui.md`
      `onCoreEvents` 数量与名单、[第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)收框口径；`docs/architecture/host-ui-modules.md`
      [第 1 节](../../docs/architecture/host-ui-modules.md#1-userchoicemanager)新方法；`docs/hosts/pycharm-plugin.md` [第 4 节](../../docs/hosts/pycharm-plugin.md#4-权限确认流)、
      `docs/hosts/tui.md` [第 5.2 节](../../docs/hosts/tui.md#52-corerequest--交互与应答)；
      依赖：T014、T015；
      完成判据：`npm run test:unit -- docs-lint` 全绿（含 `onCoreEvents` 数量与名单对照）。
- [x] **T020**（FR-006）：配置项文档——`docs/hosts/webview-facts.md` [第 2 节](../../docs/hosts/webview-facts.md#2-术语与事实来源)的默认值清单登记
      `userChoiceTimeoutSeconds`，`docs/core/session-runtime.md` 说明超时是
      `waiting` 的解除来源之一；依赖：T002、T019；
      完成判据：`npm run test:unit -- docs-lint` 的默认值单源与常量存活断言绿。
- [x] **T021**（全部 FR）：全量闸门——`npm run check-types && npm run lint &&
      npm run fmt:rust:check`；涉及 Core 的部分先 `npm run build:core:host` 再跑
      `npm run test:unit`；依赖：T016、T017、T020；
      完成判据：上述命令全绿，`npm run test:core` 全绿。
