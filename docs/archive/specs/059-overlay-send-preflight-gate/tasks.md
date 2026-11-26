# 任务分解：Overlay 对话的部署检测先于消费输入

spec 见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。执行顺序：先立契约与宿主裁决（T001–T004），
再改 webview 两段式（T005–T008），然后模态锁（T009–T011），最后文档同步与收敛（T012–T014）。
勾选状态即进度。

## 契约与宿主裁决

- [x] **T001**（FR-002、FR-004）：`src/host/webviewMessages.ts` 新增上行 `submitMessage`（承载完整 `SendMessageWire` + `submitId`）、下行 `userMessageAccepted` / `userMessageRejected`（判别联合，`rejected` 带 `reason`）与上行 `conversationSwitchLockChanged`；删除 `userMessageDraftRestored`；依赖：—；完成判据：`npm run check-types` 绿，且 `rg 'userMessageDraftRestored' src/` 零命中。
- [x] **T002**（FR-002、FR-005）：`src/host/mountProxyGate.ts` 的 `BlockedAction.message` 改为携带完整 wire 载荷（不再只带 `content`）；`src/host/ui/webviewMessageHandler.ts` 的 `submitMessage` 分发表项按三态裁决：可发送 → 推 `userMessageAccepted` 并走既有 `handleUserMessage`；需要部署 → `blockMessageForMountProxyAsync` 存原载荷；`deployable === false` → 推 `userMessageRejected` 带 Core 的 `reason`；依赖：T001；完成判据：`src/test/userMessageSubmitAck.test.ts` 的三态裁决用例绿。
- [x] **T003**（FR-003）：`handleMountProxyCancel` 去掉 `userMessageDraftRestored` 回填，改为推 `userMessageRejected`（`kind: 'message'` 时带 `submitId`，`kind: 'openConversation'` 时只清闸门）；确认取消路径不消费、不建会话、不写归属；依赖：T002；完成判据：`src/test/userMessageSubmitAck.test.ts` 的「取消后 Core 从未收到该条 `userMessageSubmitted`」与「无 `userMessageDraftRestored`」用例绿。
- [x] **T004**（FR-007）：`UIHost` 新增 `setConversationSwitchLock(sender, locked, reason)`，VS Code 空实现、Electron 落到纯模块 `ConversationSwitchLock`；`src/host/UIHost.ts` 契约成员与两份实现同步；依赖：T002；完成判据：`npm run check-types` 绿，`src/test/conversationSwitchLock.test.ts` 与 `userMessageSubmitAck.test.ts` 的锁上报用例绿。（实施偏差：计划里的 `WebviewMessageHandler.isMountProxyLocked()` 没有落地——锁由 webview 按「确认框开着 / 提交未决」上报，宿主只做落点，理由是 `docs/archive/specs/059-overlay-send-preflight-gate/plan.md` 第 5 条被否决方案。）

## webview 两段式

- [x] **T005**（FR-001、FR-004）：`src/webview/hooks/useAppHandlers.ts` 拆 `buildUserMessageFromInput`：只读输入与前置守卫，不再清空 / 不建会话 id 写入 / 不写列表与历史；新增未决提交 ref（`submitId` + wire + carrier）与 `requestSubmit`/`commitMessage`/`rejectSubmit` 三个收尾；依赖：T002；完成判据：`src/test/userMessageSubmitAck.test.ts` 的「裁决到达前输入区逐项不变」「受理时消费与上送各一次」用例绿。
- [x] **T006**（FR-003、FR-004）：未决提交进入「一次只有一条」守卫；未决期间输入区只读；空闲发送把挂起项保留到受理之后（取消时仍登记在横幅上）；依赖：T005；完成判据：`src/test/userMessageSubmitAck.test.ts` 的 AC-8（取消后挂起项仍在）、AC-10（未决只读）、AC-11（无乐观气泡 / 排队项）用例绿。
- [x] **T007**（FR-004）：`src/webview/hooks/useMessageHandler.ts` 处理 `userMessageAccepted` / `userMessageRejected`，删除 `userMessageDraftRestored` 分支；依赖：T005；完成判据：`npm run check-types` 绿，`rg 'userMessageDraftRestored' src/` 零命中。
- [x] **T008**（FR-003、FR-005）：`src/webview/App.tsx` 接线未决提交态到 `InputArea` 的只读判定，并让会话跳转入口（`navigateToSession` / `handleNewConversation` / `toggleSubSession`）在未决或锁定时早返回；依赖：T005、T006；完成判据：`src/test/userMessageSubmitAck.test.ts` 的 AC-21（未决期间入口不生效）用例绿。

## 模态锁

- [x] **T009**（FR-007）：新增 `src/webview/components/focusTrap.ts` 的焦点循环纯函数（`nextFocusIndex`）；`MountProxyDialog` 用它实现 `Tab` / `Shift+Tab` 圈定与背景惰性，补滚轮穿透到消息区；依赖：—；完成判据：`src/test/focusTrap.test.ts` 绿，`e2e/webview/overlayMountProxy.spec.ts` 的模态用例绿。
- [x] **T010**（FR-007）：webview 在确认框打开与提交未决时上报 `conversationSwitchLockChanged`，Electron 主进程按来源视图落实锁，`openConversation` / `openNewConversation` / `sidebar:open-conversation` / `sidebar:new-conversation` / `sidebar:close-conversation` / `sidebar:delete-conversation` / 标签页切换与 `Ctrl+Tab` 动作在锁期间早返回；依赖：T004、T009；完成判据：`e2e/electron/overlayMountProxyLocal.spec.ts` 的标签页与侧栏锁用例绿。
- [x] **T011**（FR-007）：`e2e/helpers/fakeHost.ts` 补 `submitMessage` 应答编排（默认受理；能力不可部署时按归属回 blocked）与锁事实回显；依赖：T001、T005；完成判据：`npm run test:e2e:webview -- overlayMountProxy` 绿。

## 文档与收敛

- [x] **T012**（FR-001、FR-006）：按 spec 的影响基线并入 delta：[docs/core/mount-proxy.md 第 2.0 节](../../docs/core/mount-proxy.md#20-部署触发时机)、[docs/core/conversation-work-view.md 第 1 节](../../docs/core/conversation-work-view.md#1-能力)、[docs/features/user-message-pipeline.md FR-001](../../docs/features/user-message-pipeline.md#fr-001唯一入口)、[docs/architecture/host-ui-modules.md 第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler)（消息类型数）；依赖：T001–T007；完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T013**（FR-007）：并入模态锁与宿主差异的 delta：[docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)、[docs/hosts/electron-multi-workspace.md 第 5 节](../../docs/hosts/electron-multi-workspace.md#5-标签页) / [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)、[docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)、[docs/hosts/webview-facts.md 第 3 节](../../docs/hosts/webview-facts.md#3-事实清单)（新增「本次提交的裁决」事实）；依赖：T009、T010；完成判据：`npm run test:unit -- docs-lint` 绿。
- [x] **T014**（FR-001～FR-007）：收敛与归档：逐条核对 AC-1～AC-21 与实现 / 测试证据并写入 spec 的「收敛记录」；把 status 改「已收敛」后 `npm run check-types && npm run lint && npm run test:unit -- docs-lint` 全绿；`git mv specs/059-overlay-send-preflight-gate docs/archive/specs/`；依赖：T012、T013；完成判据：三件套归档到位且全部闸门绿。
