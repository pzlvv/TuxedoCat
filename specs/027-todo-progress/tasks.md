# 任务分解：按对话维护的 Todo 与输入区任务进度

执行顺序：Core 侧（表 / 重建 / 推送）→ 契约 → 宿主接线 → webview → Explorer → e2e →
文档 → 整体验证。压缩与多次压缩的用例集中在 T004，是本次的重点验收面：**表在进程内存活，
压缩不影响；重启后按会话文件重建，能重建到什么取决于最后一条成功调用是否还在保留区**。
需求见 [spec.md](spec.md)，方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`core-rs/src/tools.rs` 把 `static TODOS` 从 `Mutex<Option<HashMap<String, Value>>>` 改为类型化的 `Mutex<HashMap<String, Vec<TodoEntry>>>`（`TodoEntry { content, status, active_form }`，serde 输出 `activeForm`）；新增 `pub fn ensure_session_todos(session_id: &str) -> Value`（`history::project_of_session` + `load_messages` 反扫、只认 `exit_code == 0`、`todos` 为字符串时按 JSON 解析、文件不存在返回空数组）；`clear_session_todos` 保留；依赖：—；完成判据：`npm run test:core` 编译通过且 `tools_tests.rs::todo_rebuild_*` 可运行。

- [x] **T002**（FR-001）：`run_todo_write` 校验通过后写表并返回新的 `ToolOutcome::SuccessWithTodos { text, todos }`（`is_status_error` / `exit_code` / `text` / `cap_tool_result` 各补一个分支）；删除旧的 `all_done` 清空分支（清空语义由 `todos: []` 表达）；依赖：T001；完成判据：`tools_tests.rs` 新增 `todo_write_updates_the_session_table`、`todo_write_empty_list_clears_the_table`、`todo_write_failure_keeps_the_previous_table` 三条绿，`todo_write_renders_the_checklist` 不回归。

- [x] **T003**（FR-001）：重建用例组——`todo_rebuild_picks_last_successful_write`（两次成功取后者）、`todo_rebuild_skips_failed_call_and_keeps_earlier_success`（末尾一次 `exit_code != 0`）、`todo_rebuild_parses_double_encoded_todos`（字段级 double-encode）、`todo_rebuild_returns_empty_when_file_missing`；依赖：T001；完成判据：`cargo test --manifest-path core-rs/Cargo.toml todo_rebuild` 全绿且四条用例名可 grep。

- [x] **T004**（FR-001）：**压缩 / 多次压缩用例组**（本次重点）——在 `core-rs/src/compact_engine_tests.rs` 按既有 `EngineHarness` + `request_compact` 套路新增：
      ① `todo_table_survives_manual_compact`：写表 → 手动压缩 → 表内容不变，且断言 `history::load_messages` 里已无该 `TodoWrite` 调用（证明状态不来自文件）；
      ② `todo_table_survives_repeated_compaction`：首次压缩 → 追加消息 → 第二次压缩（照 `repeated_compact_keeps_the_global_user_input_head` 的节奏），两次之间与之后表都不变；
      ③ `todo_table_survives_compaction_after_new_write`：压缩 → 再写一次 TodoWrite → 再压缩，表保持第二次写入的清单；
      ④ `todo_rebuild_after_compaction_and_restart_returns_empty`：压缩后用 `clear_session_todos` 清表（模拟进程重启）→ `ensure_session_todos` 重建 → 空（最后一条成功调用已被摘要替换）；
      ⑤ `todo_rebuild_after_compaction_and_restart_uses_surviving_write`：压缩后再写一次（落在保留区）→ 清表 → 重建 → 得到该清单；
      ⑥ `todo_table_survives_auto_compact`：走自动压缩阈值路径（覆盖 `is_auto_compact` 分支）后表不变；
      依赖：T001、T002；完成判据：`cargo test --manifest-path core-rs/Cargo.toml todo_` 全绿，六条用例名可 grep，且 `npm run test:core` 无失败。

- [x] **T005**（FR-002）：契约——`src/shared/types.ts` 新增 `TodoEntry`（`content` / `status` / `activeForm` 全必选）；`src/shared/AssistantEventBus.ts` 新增 `CoreEvent.todosChanged { sessionId, todos }`、`UiRequest.sessionTodosRequested { sessionId }` 与 `UiRequestResultMap.sessionTodosRequested: TodoEntry[]`；依赖：—；完成判据：`npm run check-types` 绿，且类型联合里两个成员名可 grep。

- [x] **T006**（FR-002）：Core 侧应答与推送——`main.rs::dispatch_ui_request` 新增 `sessionTodosRequested` 分支（未知类型仍报错，不静默回空）；`engine.rs::emit_tool_outcome` 在 `SuccessWithTodos` 时上报 toolResult 后 `core.emit(todosChanged)`；依赖：T002、T005；完成判据：`engine_tests.rs::todo_write_emits_todos_changed`（用 `harness.sink.event_of("todosChanged")` 逐字段断言）与 `main_tests.rs::dispatch_ui_request_answers_session_todos` 绿。

- [x] **T007**（FR-002）：宿主接线——`src/host/webviewMessages.ts` 加下行 `sessionTodos` 与上行 `requestSessionTodos`；`src/host/coreFacts.ts` 加 `requestSessionTodos`；`src/host/ui/webviewMessageHandler.ts` 加入站分支并回推；`src/host/WebViewUI.ts` 的 `onCoreEvents` 加 `onTodosChanged`（映射表 31 → 32）；依赖：T005；完成判据：`npm run check-types` 绿，`src/test/hostCoreFacts.test.ts` 补 mock 后 `npm run test:all -- host-core-facts` 绿。

- [x] **T008**（FR-002）：webview 状态——`App.tsx` 新增 `sessionTodos` 状态，切换 / 挂载对话时发 `requestSessionTodos`，处理 `sessionTodos` 消息写入状态；`messagesReplaced`（压缩完成）不清空该状态；依赖：T007；完成判据：`npm run check-types` 绿，且 e2e T012 的「打开对话即显示按钮」「压缩完成按钮不消失」两条通过。

- [x] **T009**（FR-002）：纯函数 `src/host/todoProgress.ts` 的 `countTodoProgress(todos): TodoProgress | null`（`total` = 长度、`done` = completed 条数、空数组 → `null`）；零依赖，不 import 宿主 API 与 core 类型；依赖：T005；完成判据：新增 `src/test/todoProgress.test.ts`（0 条 / 1 条 / 4 条含 in_progress / 全完成 / 缺 status 归一）`npm run test:all -- todo-progress` 绿。

- [x] **T010**（FR-002、FR-003、FR-004）：`src/webview/InputArea.tsx` 按钮与浮层——Row 2 右侧按钮组首位（`ToggleMenu` 之前）、仅 `TodoProgress !== null` 时渲染、文案 `inputArea.todoProgress`（zh `任务进度: {done}/{total}`、en `Progress: {done}/{total}`，不加 title）、`TODO_TIP_DELAY_MS = 100` 悬停计时、点击固定 / 取消、`sessionId` 变化复位、浮层 `pointer-events-none` + `max-h` 内部滚动、配色全取 `colors`、`data-todo-progress*` 三个钩子；依赖：T009；完成判据：`npm run check-types && npm run lint` 绿，且 `src/webview/InputArea.tsx` 内无新增 hex 色值（`grep -n "#[0-9a-fA-F]\{6\}"` 无新增行）。

- [x] **T011**（FR-005）：Explorer——`tools.rs::sub_agent_role_tools("Explorer")` 改为 `["Read", "Glob", "Grep", "Reply", "TodoWrite"]`；`prompt.rs` 角色说明点名 TodoWrite；`tools_tests.rs` 的「恰为四件套」用例改五件套；`prompt_tests.rs` 新增 `explorer_role_description_matches_allowlist`；依赖：T002；完成判据：`cargo test --manifest-path core-rs/Cargo.toml explorer` 与 `prompt_tests` 全绿。

- [x] **T012**（FR-002、FR-003、FR-004）：e2e `e2e/webview/todoProgress.spec.ts`——用例：① 打开对话显示 `任务进度: 1/4`；② 收到 `todosChanged` 推送后变 `2/4` 且浮层同步；③ 悬停 100ms 出浮层、不足 100ms 移出不出；④ 点击固定（指针移出不隐藏）、再点取消；⑤ 切换对话后固定态复位且按新对话清单显示；⑥ 压缩（`messagesReplaced`）后按钮不消失；⑦ dark / light 两轮渲染；⑧ 无 Todo 时按钮不渲染；依赖：T008、T010；完成判据：`npm run test:e2e:webview -- todoProgress` 全绿。

- [x] **T013**（FR-005）：`e2e/electron/subagentExplorer.spec.ts` 的工具断言由四件套改五件套（含 TodoWrite 可用）；依赖：T011；完成判据：`npm run test:e2e:electron -- subagentExplorer` 绿。

- [x] **T014**（FR-001、FR-002、FR-003、FR-004、FR-005）：文档 delta——`docs/architecture/events.md` 2.1 加 `todosChanged` 行（触发点 `engine.rs::emit_tool_outcome`）、2.4 加 `sessionTodosRequested` 行；[docs/core/standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)表格加「会话 Todo 清单」；[docs/hosts/webview-ui.md 第 3 节](../../docs/hosts/webview-ui.md#3-总线注册)的 `onCoreEvents` 31 → 32 并点名分区；新增 `docs/features/todo-list.md`（七节骨架）与 `docs/adr/0009-todo-state-owned-by-core.md`；`docs/features/user-stories/dialog-core.md` 加 US-59、改 US-51 验收标准 1；`docs/features/user-stories.md` 附录登记 US-59 → `e2e/webview/todoProgress.spec.ts`；`docs/README.md` 地图登记；依赖：T006、T012（US 映射与 e2e 文件必须同一次提交落库）；完成判据：`npm run test:all -- docs-lint` 全绿（含事件载荷列 / 2.1 触发点 / 映射表数量 / US ↔ e2e 双向一致四组）。

- [x] **T015**（FR-001、FR-002、FR-003、FR-004、FR-005）：整体验证——`npm run check-types && npm run lint && npm run build:core:host && npm run test:core && npm run test:all`；依赖：T001–T014；完成判据：全部绿，且 `standalone*` 系列没有「跳过」条目（Core 二进制已由 `build:core:host` 产出）。

## 实施备注

- **验证结果**：`check-types` / `lint` / `build:core:host` 绿；`cargo test` 947 通过 0 失败；
  `npm run test:all` 72 通过 / 1 跳过（`sidebarFiles` 环境前置）/ 1 失败，唯一失败项是
  `specs/026-ask-user-question-dsh-schema/tasks.md` 的三处裸「第 N 节」引用——该目录属并行
  工作流（本次改动未触碰），不是本 spec 的回归。
- **e2e**：`e2e/webview/todoProgress.spec.ts` 9 条全绿；`e2e/electron/subagentExplorer.spec.ts`
  2 条全绿（前置：`dist/resources/core/x64-win32/` 必须是刚构建的 Core，`build:core:host`
  只更新 `resources/`，本次手动同步后通过）。
- **ADR 编号**：本 spec 的决策记录落 `docs/adr/0009-todo-state-owned-by-core.md`；specs/026
  原计划占用 0009，落地时需改为 0010（编号连续由 docsLint 校验，先落者占位）。
