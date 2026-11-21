# 任务分解：abort 悬停明细显示已执行时间与远程子代理

执行顺序：先落 Core 侧三个新事实与 parity 锁定（T001–T004），再同步契约镜像与 webview
派生（T005–T007），然后是时长格式化与浮层渲染（T008–T010），最后补测试、文档与全量验证
（T011–T016）。需求见 [spec.md](spec.md)，技术路线见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：`core-rs/src/engine.rs` 的 `runtime_state_json` / `emit_runtime` 把后台任务 `start_time` 投影成 `backgroundTasks[].startedAt`；依赖：—；完成判据：`cargo test --manifest-path core-rs/Cargo.toml runtime_snapshot_background_task_carries_started_at` 绿
- [x] **T002**（FR-002）：`emit_runtime` 投影本地子代理 `subagent::created_at` 成 `subAgentStartedAt`（未登记为 `null`）；依赖：T001；完成判据：`cargo test --manifest-path core-rs/Cargo.toml runtime_snapshot_carries_sub_agent_started_at` 绿
- [x] **T003**（FR-003）：`core-rs/src/subagent.rs` 的 `RemoteRecord` 补 `description` / `created_at`，`register_remote` 收 description 入参，新增 `remote_sub_agents_for_session`；依赖：—；完成判据：`cargo test --manifest-path core-rs/Cargo.toml remote_registry_carries_description_and_created_at` 绿
- [x] **T004**（FR-003）：`emit_runtime` 投影 `remoteSubAgents`（发起方会话的登记清单，结束 / 目标不可达后为空），`spawn_remote_agent` 传 description；依赖：T003；完成判据：`cargo test --manifest-path core-rs/Cargo.toml runtime_snapshot_lists_remote_sub_agents_until_ended` 绿
- [x] **T005**（FR-001、FR-002、FR-003）：`core-rs/fixtures/runtimeState.json` 字段集与 `main_tests.rs` 的 parity 样例同步；依赖：T002、T004；完成判据：`cargo test --manifest-path core-rs/Cargo.toml runtime_state_fields_match_parity_fixture` 绿
- [x] **T006**（FR-001、FR-002、FR-003）：契约与三处镜像加成员——`src/shared/AssistantEventBus.ts`（新增 `RemoteSubAgentBrief`）、`src/host/webviewMessages.ts`、`src/webview/types.ts`；依赖：T005；完成判据：`npm run check-types` 绿且四处字段一致
- [x] **T007**（FR-001、FR-003）：`src/webview/hooks/handlers/conversationHandlers.ts` 缺字段归一（`startedAt` / `subAgentStartedAt` / `remoteSubAgents`）；依赖：T006；完成判据：`npm run check-types` 绿，旧快照经 webview 不抛错
- [x] **T008**（FR-004）：`src/shared/sessionRuntime.ts` 的 `RunningSubAgentBrief` 扩字段、聚合合并远程清单（层内本地先、远程后、不下钻）；依赖：T006；完成判据：`npm run test:unit -- sessionBusyLevel` 绿（含新增远程合并用例）
- [x] **T009**（FR-005）：新增 `src/webview/elapsedTime.ts` 的 `formatElapsedTime`（零单位省略、负值钳 0、全部为零 `0秒`）；依赖：—；完成判据：`npm run test:unit -- elapsedTime` 绿（`5秒` / `1分5秒` / `1小时2分5秒` / `1天2小时3分4秒` / `0秒`）
- [x] **T010**（FR-004、FR-005）：`src/webview/App.tsx` 明细推导透传新字段；`src/webview/InputArea.tsx` 秒级定时器与行内时长 / 远程身份；`i18n/{zh,en}.ts` 四个单位文案；依赖：T008、T009；完成判据：`npm run check-types` + `npm run test:unit -- webview-i18n` 绿
- [x] **T011**（FR-003、FR-005）：`src/host/bootstrapCore.ts` 失联归零时一并清 `backgroundTasks` / `remoteSubAgents`；依赖：T006；完成判据：`npm run check-types` 绿
- [x] **T012**（FR-001、FR-002、FR-003）：`core-rs/src/engine_tests.rs` / `subagent_tests.rs` 三条快照用例与注册表用例落地（T001–T004 的判据）；依赖：T001–T005；完成判据：`npm run test:core` 绿
- [x] **T013**（FR-004、FR-005）：e2e `e2e/webview/conversation.spec.ts` 的 US-52 用例扩展——任务 / 子代理行含时长、远程行含 `→ <workspaceId>`、秒级刷新、隐藏后停止刷新；依赖：T010；完成判据：`npm run test:e2e:webview -- conversation.spec.ts` 绿
- [x] **T014**（FR-001、FR-002、FR-003、FR-004、FR-005）：文档同步——`docs/core/session-runtime.md` §2 字段表、`docs/features/abort-button.md`（FR-003 / FR-004 / §4 / §5）、`docs/features/cross-workspace-agent.md` 的「跨工作区中止」一节、`docs/hosts/webview-ui.md` §8、US-52 验收标准；依赖：T010、T011；完成判据：`npm run test:unit -- docs-lint` 绿
- [x] **T015**（FR-001、FR-002、FR-003、FR-004、FR-005）：全量验证——`npm run check-types`、`npm run lint`、`npm run build:core:host` + `npm run test:core`、`npm run test:unit`；依赖：T012–T014；完成判据：四条命令全绿（`docsLintLocalOnlyPaths` 的 EXDEV 单独记录）
- [x] **T016**（FR-001、FR-002、FR-003、FR-004、FR-005）：收敛记录三分类 + 归档（delta 并入 docs 后移入 `docs/archive/specs/`）；依赖：T015；完成判据：spec status `已收敛` 且 `npm run test:unit -- docs-lint` 绿、目录已归档
