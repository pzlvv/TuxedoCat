# 任务分解：`Transfer` 支持 Overlay 对话的视图端

执行顺序：Core 侧入口（T001–T005）→ 代理 op（T006–T008）→ 宿主端点（T009–T011）→
两侧测试与文档（T012–T017）。判据全部可验证；勾选状态即进度。规格见同目录
[spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`core-rs/src/tools.rs` 的 `TransferRequest` 加 `origin_in_view` /
  `origin_source_relative` / `origin_dest_relative`，`run_transfer` 按 `ctx.work_view`
  三态判定并在发送前算相对路径；`ViewUnavailable` 直接返回工具错误。依赖：—；
  完成判据：`cargo test` 新增的三态用例改名可查（`transfer_view_*`）。
- [x] **T002**（FR-001）：`core-rs/src/engine.rs` 的 `transfer_hook` 把三个字段透传到
  `crossWorkspaceTransferRequested`。依赖：T001；完成判据：`engine_tests` 的
  `transfer_hook_roundtrip_and_cancel` 断言新字段。
- [x] **T003**（FR-002～FR-005）：`core-rs/src/work_view.rs` 导出七个平台无关入口
  （`view_stat` / `view_list` / `view_mkdir_all` / `view_rename` / `view_unlink` /
  `view_read_chunk` / `view_write_chunk`），`work_view_linux.rs` 经代理实现，
  `work_view_unsupported.rs` 同签名回错误。依赖：T001；完成判据：`cargo test` 编译通过且
  `work_view_tests` 的 `view_io_*` 用例绿。
- [x] **T004**（FR-002、FR-003）：`core-rs/src/main.rs` 的 `dispatch_ui_request` 增
  `workViewFileIoRequested` 分支（按 `op` 分派、参数缺失报错、业务失败回 `ok: false`）。依赖：T003；
  完成判据：`main_tests` 的 `work_view_file_io_*` 用例绿。
- [x] **T005**（FR-002、FR-003）：`core-rs/src/mount_proxy/linux/client.rs` 增
  `rename_path` / `unlink_path` / `read_range` / `write_range`，`unsupported.rs` 同签名占位。依赖：— ；
  完成判据：`client_tests` 的新帧形态用例绿。
- [x] **T006**（FR-002、FR-003）：`mount-proxy-rs/src/serve.rs` 增 `renamePath` /
  `unlinkPath` op，`writeFile` 支持 `offset` / `append`；`IPC_PROTOCOL_VERSION` 改 2。依赖：— ；
  完成判据：`cargo test -p mount-proxy-rs` 绿且 `serve.rs` 的 op 覆盖用例含新 op。
- [x] **T007**（FR-002、FR-003）：`mount-proxy-rs/fixtures/mountProxyProtocol.json` 与
  `mount-proxy-rs/src/serve.rs` 的版本断言同步 ipcVersion = 2；`core-rs/src/mount_proxy/linux/client.rs`
  的 `IPC_PROTOCOL_VERSION` 同步。依赖：T006；完成判据：`npm run test:core` 里
  `mount_proxy_protocol_fixture` / `ipc_version` 相关用例绿。
- [x] **T008**（FR-002、FR-003）：`core-rs/src/work_view_linux.rs` 的 `view_rename` /
  `view_write_chunk` 保证暂存 / 改名 / 截断语义（rename 覆盖、append 语义、父目录自动创建）。依赖：T005、T006；
  完成判据：`work_view_tests` 的 `work_view_file_io_writes_reads_and_renames_in_the_view` 用例绿。
- [x] **T009**（FR-001～FR-005）：`src/shared/AssistantEventBus.ts` 加
  `crossWorkspaceTransferRequested` 的三个字段与 `UiRequest.workViewFileIoRequested` /
  `WorkViewFileIoResult`。依赖：— ；完成判据：`npm run check-types` 绿且
  `npm run test:unit -- docs-lint` 的契约成员组能报出需要补文档（本任务先不绿，T014 收口）。
- [x] **T010**（FR-002、FR-003）：`src/host/coreFacts.ts` 新增 `requestWorkViewFileIo`；
  `src/host/workspaceTransfer.ts` 新增 `viewEndpoint`（分块读写流，块大小 1 MiB）。依赖：T009；
  完成判据：`src/test/workspaceTransfer.test.ts` 的 `viewEndpoint*` 用例绿。
- [x] **T011**（FR-001、FR-006）：`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceTransfer`
  按 `originInView` + 「该端是发起工作区」选端点。依赖：T010；完成判据：
  `src/test/crossWorkspaceTransfer.test.ts` 的端点选择矩阵绿。
- [x] **T012**（FR-002、FR-003）：`src/test/workspaceTransfer.test.ts` 覆盖视图端点上的递归 /
  覆盖合并 / 符号链接跳过 / 类型冲突 / 中止后无暂存残留 / 大文件分块。依赖：T010；
  完成判据：`npm run test:unit -- workspaceTransfer` 绿。
- [x] **T013**（FR-004、FR-007）：`core-rs/src/tools_tests.rs` 补视图端越界拒绝、非 Overlay
  会话行为不变、`isolated` 但视图不可用即拒绝（继承兼容性的回归锚点）。依赖：T001；
  完成判据：`cargo test tools_tests` 的 `transfer_view_*` 全绿。
- [x] **T014**（FR-001～FR-007）：文档同步——`docs/features/cross-workspace-transfer.md`
  （FR-003 / 2.4 / 边界 / 追溯矩阵）、[docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md#5-工具语义)、
  `docs/architecture/events.md` 2.2 载荷列、[docs/core/standalone-core.md](../../docs/core/standalone-core.md#4-契约) 成员名单、
  [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)、`docs/features/user-stories/desktop.md`
  US-60。依赖：T009；完成判据：`npm run test:unit -- docs-lint` 全绿。
- [ ] **T015**（FR-002、FR-003）：`e2e/electron/overlayMountProxyRemote.spec.ts` 增用例：
  Overlay 对话里 `Transfer` 把视图内新建文件搬到另一工作区、把文件搬进视图。依赖：T011、T014；
  完成判据：该文件 `npx playwright test --project=electron-ssh overlayMountProxyRemote` 绿
  （无远端环境时按既有口径 skip 并留原因）。
  **未勾选**：用例已写（`US-60 FR-009 Overlay 会话的 Transfer 按视图取放`）且
  `check-types:e2e` / `e2eCiLane` 绿，但 `electron-ssh` 车道本机没有真实远端与已装代理，
  未实跑；留给该车道执行。
- [x] **T016**（FR-001～FR-007）：全量验证——`npm run check-types`、`npm run lint`、
  `npm run test:unit`、`npm run test:core`、`npm run fmt:rust:check`。依赖：T012、T013、T014；
  完成判据：五条命令全绿。
- [ ] **T017**（FR-006）：`docs/freshness` 报告看一眼并归档 spec。依赖：T016；
  完成判据：`git mv specs/056-transfer-overlay docs/archive/specs/056-transfer-overlay` 完成，
  归档后 `npm run test:unit -- docs-lint` 仍绿。
