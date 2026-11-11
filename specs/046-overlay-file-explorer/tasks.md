# 任务分解：Overlay 对话的文件资源管理器视图

执行顺序：先把契约与 Core 侧的目录列举做出来并测通（T001–T004），再接宿主与渲染层
（T005–T009），然后统一措辞（T010），最后同步文档并跑守卫（T011–T012）。
需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-002）：类型下沉 —— `DirectoryEntry` 移到 `src/shared/DirectoryEntry.ts`，
      `src/host/standalone/sshClient.ts` 改为 re-export（既有 import 点不动）；理由：契约
      在 `src/shared/`，不能 import `src/host/`。依赖：—；完成判据：`npm run check-types` 通过。

- [x] **T002**（FR-002）：契约扩展 —— `src/shared/AssistantEventBus.ts` 增
      `UiRequest.workViewFilesRequested`（`sessionId` + `dir`）、`WorkViewFilesResult` 判别
      联合、`UiRequestResultMap` 映射项。依赖：T001；完成判据：`npm run check-types` 通过
      （漏写任一侧联合类型不完整）。

- [x] **T003**（FR-002、FR-004）：Core 列视图目录 —— `core-rs/src/work_view_linux.rs` 新增
      `list_view_dir(session_id, dir)`：取 `WorkViewHandle::of`，未挂载回 `Err`；`dir` 拒绝
      绝对路径与 `..`；逐项归类（符号链接按目标、断链跳过）、不排序；`work_view_unsupported.rs`
      同签名回 `Err`。依赖：—；完成判据：
      `cargo test --bin standalone-core work_view_lists_overlay_directory` 通过
      （对话内新建的文件列出、磁盘上的同目录没有它）。

- [x] **T004**（FR-002、FR-004）：Core 请求分支 —— `core-rs/src/main.rs` 的
      `dispatch_ui_request` 增 `workViewFilesRequested` 分支，缺 `sessionId` / `dir` 时报错
      （不静默取默认值）。依赖：T002、T003；完成判据：
      `cargo test --bin standalone-core work_view_files_request_roundtrip` 通过。

- [x] **T005**（FR-002、FR-006）：宿主取数入口 —— `src/host/coreFacts.ts` 增
      `requestWorkViewFiles(sessionId, dir)`。依赖：T002；完成判据：
      `npm run test:unit -- hostCoreFacts` 通过（桩表含新请求）。

- [x] **T006**（FR-002、FR-003）：宿主 IPC 通道 —— `electron/main.ts` 增
      `sidebar:files-list-overlay` 与 `sidebar:files-open-overlay`（后者读内容经 Core、标签
      仍用真实工作区路径）；`electron/sidebarPreload.ts` 补两个出口。依赖：T005；完成判据：
      `npm run check-types` 与 `npm run lint` 通过。

- [x] **T007**（FR-001、FR-005）：侧栏取数分流 —— `electron/sidebar/main.ts` 的
      `WorkspaceFilesState` 增 `overlaySessionId`，由活动对话的 `storage` 派生
      （收敛到 `syncOverlaySession()` 一个函数）；值变化时清空该工作区的树缓存并
      `generation += 1`；`loadDir` / 打开文件按它分流。依赖：T006；完成判据：
      `npm run check-types` 通过 + 手工核对切换对话时树重读。

- [x] **T008**（FR-001）：标题标注 —— `electron/sidebar/index.html` 的 `.files-title` 加
      `id="filesTitle"`，`renderFiles` 里按 `overlaySessionId` 写
      「文件资源管理器 (overlay)」/「文件资源管理器」。依赖：T007；完成判据：
      `npm run build:sidebar`（或 `npm run compile`）通过 + 手工核对两种对话下的标题。

- [x] **T009**（FR-006）：失败路径 —— 侧栏在 overlay 通道返回 `ok: false` 时显示错误行，
      不回退磁盘。依赖：T007；完成判据：`npm run check-types` 通过 + 手工断 Core 核对文案。

- [x] **T010**（FR-001）：措辞统一 —— `src/webview/i18n/zh.ts` / `en.ts` 的
      `app.workViewOption`、`electron/sidebar/main.ts` 的 `isolated-tag` tooltip 改成
      「Overlay 对话」/ `Overlay conversation`；代码注释里的措辞一并统一。依赖：—；
      完成判据：`npm run test:unit -- docs-lint` 通过（行内标识符存活）。

- [x] **T011**（FR-001–FR-006）：文档同步 —— 更新
      [docs/core/conversation-work-view.md 第 1 节](../../docs/core/conversation-work-view.md#1-能力)
      （新请求）与全文措辞、[docs/core/standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约)
      的 `UiRequest` 清单、[docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)
      侧栏；`docs/README.md` 地图按需。依赖：T001–T010；完成判据：
      `npm run test:unit -- docs-lint` 通过。

- [x] **T012**（FR-001–FR-006）：全量回归 —— `npm run check-types`、`npm run lint`、
      `cargo test --bin standalone-core`、`npm run test:unit` 全绿。依赖：T011；完成判据：
      四条命令均退出码 0。

- [x] **T013**（FR-001–FR-006）：出包 —— `npm run package` 产出安装包 / vsix。依赖：T012；
      完成判据：产物落在预期目录且构建过程无错误。
