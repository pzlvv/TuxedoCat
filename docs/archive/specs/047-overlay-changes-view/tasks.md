# 任务分解：Overlay 对话的变更视图

执行顺序：先落契约与 Core 侧取数（T001–T004），再接宿主与渲染层（T005–T007），然后清掉被
取代的旧请求（T008），补测试（T009）、同步文档（T010）、跑闸门（T011）。需求见
[spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-004）：契约扩展 —— `src/shared/AssistantEventBus.ts` 增
      `WorkViewChangeEntry` / `WorkViewChangesResult`（`ok` 判别联合，失败侧带
      `kind: 'not-a-git-workspace' | 'error'`）/ `WorkViewFileDiffResult`（`ok: true` 时
      `kind: 'git'` 带 `before: string | null`，`kind: 'not-a-git-workspace'` 只带 `after`）；
      `UiRequest` 增 `workViewChangesRequested`（`sessionId` + `scope`）与
      `workViewFileDiffRequested`（`sessionId` + `path`），`UiRequestResultMap` 同步两项；
      `core-rs/fixtures/eventTypes.json` 的 `uiRequests` 补两个名字。依赖：—；
      完成判据：`npm run check-types` 通过（漏写任一侧联合类型不完整），
      `cargo test --bin standalone-core dispatch_ui_request_covers_every_ui_request_type` 通过。

- [x] **T002**（FR-001、FR-005）：Core 取数实现 —— 新增 `core-rs/src/work_view_changes.rs`：
      在子进程 `pre_exec` 里 `bind_view_onto_workspace` 后 exec `git`（每次调用一份私有挂载
      命名空间、`GIT_DISCOVERY_ACROSS_FILESYSTEM=1`、`--no-optional-locks`、PATH 走
      `shell_env::apply_native`）；`GIT_INDEX_FILE` 指向视图外的临时索引（由
      `rev-parse --git-path index` 定位后复制，每次调用一份独立文件名），
      `core.untrackedCache=false` / `core.fsmonitor=false`；空 HEAD 仓按 `ls-files` +
      逐文件计行；`diff` 加 `--relative` 让子目录工作区的路径与 `ls-files --others`
      同口径。依赖：T001；完成判据：模块内纯解析单测
      （`numstat` 普通 / 重命名 / 二进制 / 含空格与中文名、`-z` 分段）在
      `cargo test --bin standalone-core work_view_changes` 下通过。

- [x] **T003**（FR-001、FR-002、FR-004）：Core 入口 —— `work_view_linux.rs` 新增
      `changes(session_id, scope)` / `file_diff(session_id, path)`（取句柄、越界拒绝、转判别
      结果），`work_view_unsupported.rs` 同签名占位，`work_view.rs` 再导出；`main.rs` 的
      `dispatch_ui_request` 补两个分支（缺参数报错）并把这两类慢请求与 `balanceRequested`
      一起移到独立线程应答（git 在单帧循环里跑会卡住后续帧）。依赖：T002；完成判据：
      `cargo test --bin standalone-core dispatch_ui_request_covers_every_ui_request_type` 与
      `work_view_changes_request_reports_missing_arguments_and_unmounted_view` /
      `work_view_file_diff_request_reports_missing_arguments_and_unmounted_view` /
      `slow_ui_requests_run_off_the_frame_loop` 通过。

- [x] **T004**（FR-001、FR-002、FR-005）：Core 命名空间内用例 —— `work_view_tests.rs` 增：
      视图内改磁盘已有文件 / 新建文件 / 仅经 Bash 改动都进清单（磁盘侧行集为空）；
      `scope: 'doc'` 只出 Markdown；非 git 工作区回 `not-a-git-workspace`；未挂载视图回
      `ok: false`；**取数后 `upper/` 无新增条目**（临时索引不污染视图）；`file_diff` 取到
      HEAD 侧与视图内容两侧。依赖：T003；完成判据：
      `cargo test --bin standalone-core work_view_changes` 与 `work_view_file_diff` 通过
      （能力不可用的环境按既有 `markSkipped()` 口径跳过）。

- [x] **T005**（FR-004）：宿主 diff 来源判别联合 —— `electron/fileOpen.ts` 的 `DiffSource`
      改为 `{ kind: 'disk'; root; rel } | { kind: 'overlay'; sessionId; rel }`，
      `openOverlayWorkspaceFile` 改读 `WorkViewReader.readDiff`（同一次请求拿 `after` /
      `before` / `kind`），按 `before === null` 判「新增」决定 `initialView` 与 `diffSource`；
      `ElectronUIHost.registerDiffResponder` 按 `kind` 分流（磁盘走既有 `git show` + 读盘，
      视图走 `coreFacts.requestWorkViewFileDiff`）。依赖：T001；完成判据：
      `npm run check-types` 与 `npm run lint` 通过。

- [x] **T006**（FR-001、FR-002、FR-004）：宿主通道 —— `src/host/coreFacts.ts` 增
      `requestWorkViewChanges` / `requestWorkViewFileDiff`；`electron/main.ts` 增
      `sidebar:files-doc-list-overlay`（`not-a-git-workspace` 转成既有的
      `NOT_A_GIT_WORKSPACE` 判别值、其余失败原样回 `error`），`sidebar:files-open-overlay`
      的读取注入换成 diff 请求；`electron/sidebarPreload.ts` 补 `filesDocListOverlay`。
      依赖：T001、T005；完成判据：`npm run check-types`、`npm run lint` 与
      `npm run test:unit -- ipc-channels` 通过。

- [x] **T007**（FR-002、FR-003）：侧栏分流 —— `electron/sidebar/main.ts` 的 `loadDocList`
      按 `files.overlaySessionId` 分流到两条通道，`syncOverlaySession` 在归属变化时作废变更
      清单（`docGeneration += 1` / `docRequested = false` / 清 `docListing`），文档模式的
      立即重取与既有失效推送保持同一入口。依赖：T006；完成判据：
      `npm run check-types` 通过 + `npm run test:unit -- sidebar-files-mode` 绿
      （分流函数由 T009 的纯函数用例锁定）。

- [x] **T008**（FR-004）：清掉被取代的请求 —— 删 `UiRequest.workViewFileReadRequested`
      与 `WorkViewFileResult`、`coreFacts.requestWorkViewFile`、`core-rs` 的
      `read_view_file` 与 `work_viewFileReadRequested` 分支、`eventTypes.json` 旧名字，
      以及 `src/test/` 四处 `UiRequestHandlers` 桩表的旧成员。依赖：T001–T007；
      完成判据：`npm run check-types` 与 `cargo test --bin standalone-core` 通过，
      `rg 'workViewFileReadRequested'` 只剩文档（T010 收尾）。

- [x] **T009**（FR-001、FR-004、FR-005）：宿主单测 —— `src/test/fileOpen.test.ts` 覆盖
      Overlay 的三种结果分支（有 HEAD 版 → 变更视图 + `diffSource.kind === 'overlay'`、
      新增 → 全文 + `diffSource === null`、非 git → 全文 + `diffSource === null`）；
      `src/test/monacoDiff.test.ts` 覆盖 `buildDiffResult(before: null, after)` 的既有口径；
      `src/test/sidebarDocView.test.ts` 覆盖「Core 回 `not-a-git-workspace` 时的渲染错误
      判别值」。依赖：T005、T006；完成判据：
      `npm run test:unit -- fileOpen`、`npm run test:unit -- monaco-diff`、
      `npm run test:unit -- sidebar-doc-view` 全绿。

- [x] **T010**（FR-001–FR-005）：文档同步 —— 更新
      [docs/core/conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)
      的请求表（两个新请求、删旧请求、临时索引与「取数不写视图」）、
      [docs/core/standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约)
      的 `UiRequest` 名单与数量、
      [docs/core/standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)、
      [docs/architecture/events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)
      的汇总数量、
      [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)
      的分流与打开来源、
      [US-63](../../docs/features/user-stories/desktop.md#us-63-变更视图文档--全部变更)
      与 [US-38](../../docs/features/user-stories/desktop.md#us-38-文件与虚拟文档预览)
      的验收条目（含 e2e 豁免理由）。依赖：T001–T009；完成判据：
      `npm run test:unit -- docs-lint` 通过。

- [x] **T011**（FR-001–FR-005）：全量闸门 —— `npm run check-types`、`npm run lint`、
      `npm run fmt:rust:check`、`npm run test:unit`、`npm run test:core`。依赖：T010；
      完成判据：五条命令退出码 0（跑不了的记原因，不编造结果）。
