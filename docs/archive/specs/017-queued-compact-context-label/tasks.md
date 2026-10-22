# 任务分解：排队压缩的上下文用量文本

执行顺序：先 core 快照事实（T001）与待压缩生命周期 / once 摘除（T002），再同步 TS
契约投影（T003），随后 webview 文本与点击态（T004）、e2e（T005）、TUI（T006），最后
文档同步（T007）与全量闸门（T008）。需求见 [spec.md](spec.md)，技术方案见
[plan.md](plan.md)；每条任务完成即勾选，全勾后进 /converge。

## 任务清单

- [x] **T001**（FR-001）：`core-rs/src/engine.rs` 的 `runtime_state_json` 增加
  `pending_compact` 参数与 `"pendingCompact"` 字段，`emit_runtime` 读
  `compact::is_pending_compact` 传入；`core-rs/fixtures/runtimeState.json` 的 `fields`
  增加 `pendingCompact`；`core-rs/src/main_tests.rs` 调用补参数；
  `core-rs/src/engine_tests.rs` 的 `emit_runtime_reports_idle_and_waiting_flags` /
  `emit_runtime_reports_root_facts_and_busy_subagents` 补 `pendingCompact=false` 断言；
  依赖：—；完成判据：`cargo test`（`runtime_state_fields_match_parity_fixture`、
  `emit_runtime_reports_*`）绿。
- [x] **T002**（FR-001、FR-004）：`core-rs/src/engine.rs` 的 `request_compact` 非空闲
  分支改为 `mark_pending_compact` + `emit_runtime`，删除 `emit_once_notice` 调用；立即
  压缩分支与 `run_query_loop` 消费待压缩后，在 `project_of` 失败或
  `compact_and_apply_messages` 返回 false 时补 `emit_runtime`；`drop_session` 调
  `compact::unmark_pending_compact`；改写 `engine_tests.rs` 的
  `compact_requested_while_busy_emits_once_notice` 与 `compact_engine_tests.rs` 的
  `manual_compact_is_deferred_while_the_session_is_busy`（断言无 `message` 事件、
  `pendingCompact` 置真 / 清除后置假），新增「待压缩被消费但无可压缩内容 → 推送
  `pendingCompact=false`」用例；依赖：T001；完成判据：`cargo test` 相关用例绿，
  `history::load_metadata` 不再出现「压缩已排队」的 `onceMessage`。
- [x] **T003**（FR-001）：`src/shared/AssistantEventBus.ts` 的
  `SessionRuntimeState.pendingCompact: boolean`；`src/host/webviewMessages.ts` 的
  `sessionRuntimeStates.states` 内联类型；`src/webview/types.ts` 投影；
  `src/webview/hooks/handlers/conversationHandlers.ts` 映射
  `pendingCompact: !!s.pendingCompact`；`src/host/bootstrapCore.ts` 失联归零补
  `pendingCompact: false`；`e2e/helpers/fakeHost.ts`、`e2e/webview/conversation.spec.ts`、
  `e2e/webview/sendModes.spec.ts` 的状态字面量补字段；依赖：T001；完成判据：
  `npm run check-types && npm run check-types:e2e` 绿。
- [x] **T004**（FR-002）：`src/webview/App.tsx` 用 `useMemo` 计算
  `compactPending = pendingCompact && !compacting`（依赖 `currentSessionId` /
  `sessionIdleVersion`）并传给 `InputArea`；`src/webview/InputArea.tsx` 的
  `ContextProgressBar` 待压缩时渲染纯文本、不渲染 `<button>`、去掉 hover 下划线与
  「点击压缩」提示，进度条仍按实际用量绘制；`src/webview/i18n/zh.ts` / `en.ts` 新增
  `inputArea.compactPending`（`准备压缩` / `Preparing`）；依赖：T003；完成判据：
  `npm run check-types:webview` 绿，且 `ContextProgressBar` 的 `compactPending`
  分支不挂 `onClick`。
- [x] **T005**（FR-002）：`e2e/webview/inputMenu.spec.ts` 扩展 US-9——推送
  `pendingCompact=true` 快照后断言「准备压缩」可见、点击不新增 `requestCompress`；
  再推送 `compacting=true` 快照断言还原 `(K)`；依赖：T004；完成判据：
  `npm run test:e2e:webview -- inputMenu` 绿。
- [x] **T006**（FR-003）：`tui-rs/src/store.rs` 的 `RuntimeState` 增加
  `pending_compact` 并解析 `"pendingCompact"`；`tui-rs/src/app.rs` 状态栏在
  `pending_compact && !compacting` 时渲染 `i18n::tt("准备压缩", "Preparing")`；
  `tui-rs/src/store_tests.rs` 补字面量与解析用例；依赖：T001；完成判据：
  `cargo test --manifest-path tui-rs/Cargo.toml` 绿。
- [x] **T007**（文档同步）：按 spec 影响基线修订 `docs/core/session-runtime.md`、
  `docs/architecture/events.md`、`docs/features/compaction.md`、
  `docs/hosts/webview-ui.md`、`docs/hosts/tui.md`、
  `docs/features/user-stories.md`；依赖：T002–T006；完成判据：
  `npm run test:all -- docs-lint` 的 specs 结构组与本次文档对照组绿（仓库既有
  `specs/defects/once-replacement-skips-autoscroll.md` 的 `待跑` 取值红与本次无关，
  单独登记）。
- [x] **T008**（全量闸门）：`npm run check-types && npm run lint`；
  `npm run build:core:host` 后 `npm run test:all`；`npm run test:core`；
  `npm run test:e2e:webview -- inputMenu`；依赖：T001–T007；完成判据：全部绿，
  结果回写本文件。实测：check-types / lint 绿；build:core:host 成功；test:all 62 项
  全绿（含 docs-lint 46 组）；test:core 896 用例全绿；inputMenu e2e 13 项全绿；
  tui `cargo test` 全绿。
