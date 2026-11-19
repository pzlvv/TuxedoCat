# 任务分解：打开 Overlay 对话时的部署闸门

按「底层载荷 → 契约 → 判据接线 → 两个入口 → 测试 → 文档」的顺序推进：先让闸门能装下
「打开对话」这个动作，再把归属查询接进 `UIHost`，然后改两个入口并在最后统一补测试与文档。
需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

T001–T003 是不改变现有行为的重构（现有用例必须保持绿）；T004 起才引入新入口。

## 任务清单

- [x] **T001**（FR-001）：`src/host/mountProxyGate.ts` 把 `BlockedMessage { sessionId, content }` 换成判别联合 `BlockedAction`（`kind: 'message' | 'openConversation'`），`block` / `takeBlocked` / `peekBlocked` 仅换类型不改语义；依赖：—；完成判据：`npm run check-types` 绿，`npm run test:unit -- mount-proxy-gate` 全绿（既有断言改用 `kind: 'message'` 形态）。

- [x] **T002**（FR-002）：`src/host/ui/webviewMessageHandler.ts` 抽出 `continueBlockedAction(action)`，把 `applyDeployOutcome` 与 `handleMountProxyManualCommand` 轮询回调里两处硬编码的「重发 `sendMessage`」收敛到它；`kind: 'message'` 分支行为与现状逐字一致；依赖：T001；完成判据：`npm run test:unit -- mount-proxy-gate storage-capabilities-routing` 全绿（既有部署成功后重发消息的用例不改断言即通过）。

- [x] **T003**（FR-003）：`handleMountProxyCancel` 的回填只在 `kind === 'message'` 时发 `userMessageDraftRestored`；`kind: 'openConversation'` 只清闸门状态；依赖：T001；完成判据：`npm run test:unit -- mount-proxy-gate` 绿，且新增断言「openConversation 取消不发回填」（用例名含 `openConversation 取消不回填`）。

- [x] **T004**（FR-001）：`src/host/UIHost.ts` 新增只读契约成员 `sessionStorageOf(sessionId: string): 'workspace' | 'isolated'`；`src/VSCodeUIHost.ts` 恒回 `'workspace'`（VS Code 无 Overlay 能力，永不进闸门）；`electron/ElectronUIHost.ts` 投影 `sessionStorages`，`electron/main.ts` 接上既有索引；依赖：—；完成判据：`npm run check-types` 与 `npm run lint` 绿。

- [x] **T005**（FR-001、FR-004）：`handleLoadConversation` 在 `noteSessionActivity` 之后、`ensureSessionWorkspace` 之前插入闸门：`isolated` 且「不可用且可部署」→ `resolveMountProxyTarget` 后 `gate.block({ kind: 'openConversation', sessionId })` 并 return（不加载内容）；`deployable === false` → 抛错并带上 Core 的 `reason`（不弹框、不降级）；依赖：T001、T002、T004；完成判据：新增单测覆盖 AC-1（弹框且不加载）与 AC-6（拒绝并带 reason）。

- [x] **T006**（FR-002）：`continueBlockedAction` 的 `kind: 'openConversation'` 分支调 `handleLoadConversation` 继续加载；依赖：T005；完成判据：新增单测「部署成功后自动加载原对话」通过（AC-3）。

- [x] **T007**（FR-005）：确认 `workspace` 归属与 `isolatedWorkView: true` 两种情况不进闸门、不多发能力查询；依赖：T005；完成判据：新增单测 AC-7 / AC-8 通过，并断言能力查询次数为 1（打开路径本身那一次）或 0（`workspace` 不查）。

- [x] **T008**（FR-003）：补齐失败路径用例：部署失败不加载内容、界面状态不变（AC-4）；再次打开重新走流程（AC-5）；并发打开以最后一次为准；能力查询失败按打开失败处理且不弹框；依赖：T005、T006；完成判据：上述用例全部通过，`npm run test:unit` 全绿。

- [x] **T009**（FR-001）：更新 as-built 文档：[docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md#1-能力) 的部署入口从一处扩为两处、[docs/core/mount-proxy.md](../../docs/core/mount-proxy.md#2-分发落点与安装判据) 的触发时机与「失败即放弃打开」、`docs/hosts/host-matrix.md` 的打开历史 Overlay 对话失败语义；依赖：T005；完成判据：`npm run test:unit -- docs-lint` 绿（含契约成员数与名单比对）。

- [x] **T010**（FR-001、FR-002、FR-003、FR-004、FR-005）：收尾回归；依赖：T009；完成判据：`npm run check-types && npm run lint && npm run test:unit` 全绿。
