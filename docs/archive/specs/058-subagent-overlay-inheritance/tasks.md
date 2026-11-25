# 任务分解：本地子代理继承 Overlay 归属

执行顺序：先把「归属继承 + 落盘」做实（T001–T002），再做「视图所有权解析」这条主干
（T003–T005），然后收生命周期与请求分支（T006–T007），最后补既有语义回归、文档与验证。
需求与验收见同目录 [`spec.md`](spec.md)，技术路线见 [`plan.md`](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`Core::create_sub_agent` 取 `session_storage(&creator)` 作为子会话归属写进 `SessionState.storage`；依赖：—；完成判据：`core-rs/src/engine_tests.rs` 的 `sub_agent_inherits_isolated_storage`（父 `Isolated` → 子 `Isolated`、父 `Workspace` → 子 `Workspace`，两侧都断言 meta 落盘）与 `explorer_sub_agent_inherits_isolated_storage`
- [x] **T002**（FR-001、FR-005）：`history::create_sub_agent_metadata` 增加归属参数并写入 `meta.json` 的 `storage`；`create_remote_sub_agent_metadata` 显式写 `workspace`；依赖：T001；完成判据：`core-rs/src/history_tests.rs` 的 `local_sub_agent_metadata_persists_inherited_storage` / `remote_sub_agent_metadata_is_always_workspace`
- [x] **T003**（FR-001）：`start_remote_sub_agent` 的 `SessionState` 写显式 `storage = Workspace`；依赖：T001；完成判据：`core-rs/src/engine_tests.rs` 的 `start_remote_sub_agent_records_creator` 增加 `state.storage == Workspace` 与 meta `storage == "workspace"` 断言
- [x] **T004**（FR-002、FR-003）：新增 `Core::work_view_owner` 与 `Core::parent_session_of`（内存 → `meta.json`、深度上限 64、非子代理不读盘）；依赖：T002；完成判据：`core-rs/src/engine_tests.rs` 的 `work_view_owner_follows_parent_chain` 覆盖本地子代理→父、跨工作区会话自持、父为 `workspace` 报错、父链缺失报错、成环报错
- [x] **T005**（FR-002）：`Core::ensure_work_view` 先解析 owner，再按 owner 登记 / `reopen` / 挂载 / 取句柄；依赖：T004；完成判据：`core-rs/src/work_view_tests.rs` 的 `work_view_is_shared_by_parent_and_sub_agent`（父登记者与子代理取到的句柄指向同一视图根、`views()` 只有一份登记）与 `core-rs/src/engine_tests.rs` 的 `sub_agent_view_owner_resolution_fails_closed`
- [x] **T006**（FR-002、FR-004）：`main.rs` 的 `ensure_view_ready` 返回 owner，四个 `workView*` 分支改用 owner 取数；`work_view_linux.rs` / `work_view_unsupported.rs` 的视图层参数改名为所有者会话 id 并补注释；依赖：T005；完成判据：`core-rs/src/main_tests.rs` 的 `work_view_requests_use_owner_session`（子代理会话 id 请求时落到父会话视图）与 `cargo test` 全绿
- [x] **T007**（FR-003）：`main.rs` 的 `conversationClosed` / `conversationDeleted` 按 owner 判定——只有所有者才 `release` / `remove`，使用者只记日志；依赖：T006；完成判据：`core-rs/src/main_tests.rs` 的 `closing_sub_agent_keeps_shared_view` 与 `deleting_sub_agent_keeps_shared_view`（父视图目录仍在、所有者关闭 / 删除仍然释放与回收）
- [x] **T008**（FR-002、FR-003）：父子上层互见的命名空间内用例；依赖：T005；完成判据：`core-rs/src/work_view_tests.rs` 的 `work_view_child_writes_are_visible_to_parent`（子代理写的新文件父对话可读、磁盘不存在）与 `work_view_owner_delete_removes_shared_upper`
- [x] **T009**（FR-004）：既有语义回归——`Transfer` 视图端、`viewUnavailable` fail-closed、注入 `Agent` 嵌套拒绝在继承后不变；依赖：T006；完成判据：`core-rs/src/tools_tests.rs` 与 `core-rs/src/permission_tests.rs` 的相关用例全绿，并新增 `core-rs/src/engine_tests.rs` 的 `isolated_sub_agent_tool_chain_uses_shared_view`
- [x] **T010**（FR-005）：存量不追溯的回归；依赖：T002；完成判据：`core-rs/src/history_tests.rs` 的 `legacy_sub_agent_metadata_keeps_workspace`（既有 `storage: workspace` 的档案经 `storage_of_session` 仍为 `Workspace`，`touch_metadata` 不覆盖）
- [x] **T011**（FR-001–FR-005）：文档 delta——[归属 / 生命周期 / 失败路径](../../docs/core/conversation-work-view.md#2-归属)、[传输非目标](../../docs/features/cross-workspace-transfer.md#5-非目标)、[跨工作区代理 FR-003](../../docs/features/cross-workspace-agent.md#fr-003跨工作区子代理会话顶层普通对话)、[侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏)、`docs/features/user-stories/dialog-core.md` 新增 US-79、`docs/features/user-stories.md` 收录与豁免段；依赖：T001–T010；完成判据：`npm run test:unit -- docs-lint` 全绿
- [x] **T012**（FR-001–FR-005）：整体验证、收敛记录与归档；依赖：T011；完成判据：`npm run check-types`、`npm run lint`、`npm run test:unit -- docs-lint`、`npm run build:core:host && npm run test:core` 全绿；`spec.md` 的 status 改「已收敛」后再跑一次 docs-lint 绿，`git mv specs/058-subagent-overlay-inheritance docs/archive/specs/058-subagent-overlay-inheritance`
