# 任务分解：跨工作区多 Agent 通信

执行顺序：契约与身份（T001–T002）→ Core 派发与反向链路（T003–T006）→ 宿主路由与占位（T007–T009）
→ webview 补全与跳转（T010–T012）→ 文档与验收（T013–T015）。每条完成判据即勾选证据。

## 任务清单

- [x] **T001**（FR-001）：新增 `src/host/workspaceIdentity.ts`（`resolveMachineName` / `workspaceAgentId` / `resolveWorkspaceByIdentity`）与单测；依赖：—；完成判据：`src/test/workspaceIdentity.test.ts` 覆盖 win32 / linux / 回退 / 本地与远程身份 / 歧义
- [x] **T002**（FR-002、FR-009）：扩展契约层：`Agent` 入参 `target`、`CoreRequest.crossWorkspaceAgentRequested`、三条 `CoreEvent`、三条 `UiEvent`、`hostEnvironmentProvided.crossWorkspaceAgent`；依赖：—；完成判据：`npm run check-types` 通过、`docs-lint` 事件表对齐
- [x] **T003**（FR-002、FR-010）：Core `run_agent` 的 `target` 分支、`spawn_remote` 钩子与并发槽位；依赖：T002；完成判据：`core-rs/src/tools_tests.rs` 的 target 用例绿
- [x] **T004**（FR-003、FR-004）：Core B 的 `remoteSubAgentStarted` 建会话 + 占位派生 + 元数据；依赖：T002；完成判据：`core-rs/src/engine_tests.rs` / `history_tests.rs` 对应用例绿
- [x] **T005**（FR-003、FR-006）：Core B 的 Reply / 结束事件与 Core A 的回复注入、远程登记、中止传播；依赖：T004；完成判据：`core-rs/src/engine_tests.rs` 的跨工作区回复 / 中止用例绿
- [x] **T006**（FR-006）：`subAgentRunning` / `abort_session_scope` / 槽位释放覆盖远程子代理；依赖：T005；完成判据：`core-rs/src/subagent_tests.rs`、`engine_tests.rs` 绿
- [x] **T007**（FR-002、FR-005）：宿主 `crossWorkspaceAgentRequested` 处理器与 link 表、目标 Connection 路由；依赖：T002；完成判据：`src/test/crossWorkspaceRouting.test.ts` 覆盖未打开 / 歧义 / 正常派发
- [x] **T008**（FR-004、FR-005）：占位条目派生（Rust + TS 两侧）、侧栏渲染、占位页与跳转动作；依赖：T004、T007；完成判据：`src/test/conversationListWorkspace.test.ts`、`src/test/chatPlaceholderReason.test.ts`
- [x] **T009**（FR-005、FR-006）：Electron 主进程跳转动作（`openConversation.workspaceId`）与占位页 IPC；依赖：T008；完成判据：`npm run check-types:electron` 通过
- [x] **T010**（FR-007）：webview `@` 检测 / 过滤 / 插入纯函数与 `InputArea` 菜单；依赖：T002；完成判据：`src/test/mentionState.test.ts` 绿
- [x] **T011**（FR-007、FR-009）：`requestWorkspaces` / `setWorkspaces` 链路与按视图过滤本工作区；依赖：T010；完成判据：`src/test/webviewFacts.test.ts` 或新增用例绿
- [x] **T012**（FR-008）：Core 轮次边界 `@` 解析与 reminder 注入（能力位门控）；依赖：T002；完成判据：`core-rs/src/engine_tests.rs` 的 `@` reminder 用例绿
- [x] **T013**（FR-001–FR-010）：同步 as-built 文档（events / contracts / electron-multi-workspace / abort-button / session-runtime / user-message-pipeline / host-matrix / 用户故事 / 新增 cross-workspace-agent）；依赖：T001–T012；完成判据：`npm run test:all -- docs-lint` 全绿
- [x] **T014**（FR-001–FR-010）：跑 `npm run check-types && npm run lint && npm run test:core && npm run test:all`；依赖：T013；完成判据：四条命令全绿
- [x] **T015**（FR-005）：登记 e2e 用例落点（`e2e/electron/crossWorkspaceAgent.spec.ts`、`e2e/webview/workspaceMention.spec.ts`）与 US-56 / US-57 映射；依赖：T014；完成判据：`docs/features/user-stories.md` 映射双向一致（docs-lint 组）
