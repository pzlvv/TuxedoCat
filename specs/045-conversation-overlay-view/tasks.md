# 任务分解：对话级 overlay 工作视图

执行顺序：先在 Core 侧把命名空间与 overlay 挂载做出来并测通（T001–T006），再接工具与 Bash
（T007–T009），然后扩契约与宿主（T010–T014），最后同步文档并跑守卫（T015–T016）。
需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：命名空间进入 —— `core-rs/src/work_view.rs` 新增 `enter()`
      （`unshare(CLONE_NEWUSER)` + 写 id 映射 + `unshare(CLONE_NEWNS)` + `/` 设为私有传播），
      在 `run_core()` 最早处调用（单线程时）。依赖：—；完成判据：
      `cargo test --bin standalone-core work_view_enters_namespace` 通过
      （进入后 `mount` 一个 tmpfs 成功）。

- [x] **T002**（FR-001、FR-007）：能力探测 —— `capabilities()` 回
      `{ isolated_work_view: bool, reason: String }`：依次判平台、用户命名空间、overlayfs
      是否可挂（用一次性 tmpfs + overlay 试探），失败写明是哪一项。
      依赖：T001；完成判据：`cargo test --bin standalone-core work_view_capability_reports_reason`。

- [x] **T003**（FR-002、FR-003）：视图建立 —— `WorkView::open(workspace, session_id)`
      建 `upper` / `work` / `mount` 三目录并按
      `lowerdir=<workspace>,upperdir=...,workdir=...,userxattr` 挂 overlay。
      依赖：T002；完成判据：`cargo test --bin standalone-core work_view_mounts_overlay_over_workspace`
      （挂载后能列出工作区已有文件）。

- [x] **T004**（FR-004）：每对话独立上层 —— `WorkView` 按 `sessionKey` 派生目录，两个会话
      各自 `open` 后互不可见。依赖：T003；完成判据：
      `cargo test --bin standalone-core work_view_isolates_two_sessions`
      （A 写的文件 B 看不到，磁盘上都没有）。

- [x] **T005**（FR-005）：删除语义 —— 用 `userxattr` 挂载；删除文件与目录后视图内不可见、
      基线不变。依赖：T003；完成判据：
      `cargo test --bin standalone-core work_view_delete_keeps_baseline`
      （含目录删除，不用 `userxattr` 时会 `EIO`）。

- [x] **T006**（FR-006、FR-007）：回收与降级 —— `release(session_id)` 卸载（上层保留）；
      `remove(session_id)` 卸载并删目录。建立失败时返回结构化原因由调用方记日志。
      依赖：T003；完成判据：`cargo test --bin standalone-core work_view_release_and_remove`。

- [x] **T007**（FR-002）：工具路径映射 —— `ToolContext` 增 `work_view: Option<WorkViewHandle>`；
      新增 `WorkViewHandle::to_view_path` / `to_real_path`（双向映射，路径字符串对外仍是真实
      工作区路径）。依赖：T003；完成判据：
      `cargo test --bin standalone-core work_view_handle_maps_paths`。

- [x] **T008**（FR-002、FR-003）：文件工具落视图 —— `run_read` / `run_write` / `run_edit` /
      `grep` / `glob` 在解析路径前经 `WorkViewHandle` 映射。依赖：T007；完成判据：
      `cargo test --bin standalone-core work_view_file_tools_write_to_upper`
      （Write 后 Read 可见、磁盘不变、输出里的路径仍是真实路径）。

- [x] **T009**（FR-002、FR-004）：Bash 在私有命名空间执行 —— `run_bash` 的子进程先
      `unshare(CLONE_NEWNS)`、把视图挂载点 `bind` 到真实工作区路径、再 `exec`；
      `pwd` / 脚本内绝对路径照常。依赖：T007；完成判据：
      `cargo test --bin standalone-core work_view_bash_sees_overlay`
      （`pwd` 等于真实工作区、能读 `node_modules`、写后落 upper）。

- [x] **T010**（FR-001）：契约扩展 —— `src/shared/AssistantEventBus.ts` 的
      `CoreEvent.conversationStarted` 增必选 `storage: 'workspace' | 'isolated'`；
      `UiRequest` 增 `storageCapabilitiesRequested` 与应答
      `{ isolatedWorkView: boolean; reason: string }`。依赖：T002；完成判据：
      `npm run check-types` 通过（漏写任一侧联合类型不完整）。

- [x] **T011**（FR-001）：Core 侧归属与能力应答 —— `engine` 记录会话归属、`main.rs` 新增
      `storageCapabilitiesRequested` 分支、`start_conversation` 读 `storage`。依赖：T010；
      完成判据：`cargo test --bin standalone-core storage_capabilities_and_started_storage`。

- [x] **T012**（FR-001）：宿主转发 —— `src/host/coreFacts.ts` 增
      `requestStorageCapabilities`；`electron/main.ts` 转发给侧栏与 webview。依赖：T011；
      完成判据：`npm run test:unit -- hostCoreFacts` 通过。

- [x] **T013**（FR-001）：新建对话勾选框 —— webview 空状态在 logo 下方按能力渲染
      「Overlay 对话」勾选框，`conversationStarted` 带上选择。依赖：T012；完成判据：
      `npm run check-types` 与 `npm run build:webview` 通过。

- [x] **T014**（FR-006）：生命周期接线 —— `conversationClosed` 释放视图、
      `conversationDeleted` 回收目录（失败只记日志）。依赖：T006、T011；完成判据：
      `cargo test --bin standalone-core work_view_lifecycle_on_conversation_events`。

- [x] **T015**（FR-001–FR-007）：文档同步 —— 新增 `docs/core/conversation-work-view.md`；
      更新 [standalone-core.md 第 3 节](../../docs/core/standalone-core.md#3-core-形态)与[第 4 节](../../docs/core/standalone-core.md#4-契约)、`docs/architecture/contracts.md`
      的能力成员、`docs/core/session-runtime.md` 的释放路径；`docs/README.md` 地图补新文档。
      依赖：T001–T014；完成判据：`npm run test:unit -- docs-lint` 通过。

- [x] **T016**（FR-001–FR-007）：宿主侧标记与回归 —— 侧栏会话列表显示 Overlay 视图标记
      （与既有分支图标同一渲染口径）；`npm run test:unit` 全绿。依赖：T012–T014；
      完成判据：`npm run test:unit` 通过。
