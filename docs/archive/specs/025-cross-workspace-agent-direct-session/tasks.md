# 任务分解：跨工作区子代理直建普通对话与会话创建者归属

执行顺序：契约基座先行（T001），Rust creator 根事实与派发行为随后（T003 → T004），宿主 /
webview 消费面（T002 / T005 / T007）并行推进，容器删除收口（T006），文档同步（T008）、
e2e（T009）与全量回归（T010）收尾。见同目录 `spec.md` / `plan.md`。

## 任务清单

- [x] **T001**（FR-002、FR-005、FR-006）：契约基座——新增 `src/shared/sessionCreator.ts`
      （零 import 判别联合）；`src/shared/AssistantEventBus.ts` 快照 `SessionRuntimeState`
      增 `creator`、`CoreRequest.crossWorkspaceAgentRequested` 删 `originTitle`、
      `UiEvent.remoteSubAgentStarted` 删 `parentSessionId` / `originTitle`；
      `src/host/WebViewUI.ts` 的 `requestCrossWorkspaceAgent` 删 `ph_` 生成与两字段透传；
      依赖：—；完成判据：`npm run check-types && npm run lint` 绿。
- [x] **T002**（FR-002）：`src/shared/history/Conversation.ts` —— meta 读取增 `creator`
      （缺失报错，数据异常不回退）、删 `crossWorkspaceOrigin` / `placeholder` 字段与列表
      占位派生段；依赖：T001；完成判据：`npm run check-types` 绿 + history 读取单测
      （creator 解析 / 缺失报错 / 派生段删除）绿。
- [x] **T003**（FR-002、FR-007）：Rust creator 根事实——`core-rs/src/engine.rs` 增
      `SessionCreator` enum 与 `SessionState.creator`（默认 User）；建档四处写 creator
      （`update_title_if_needed` / `touch_metadata` 兜底 / `create_sub_agent_metadata` /
      `create_remote_sub_agent_metadata` 收缩签名）；`ensure_loaded` 恢复（缺失报错）；
      `runtime_state_json` 增 `creator` 并同步 `core-rs/fixtures/runtimeState.json`；
      `deliver_agent_reply` 改读 creator、删 `CrossWorkspaceOrigin`；
      `spawn_remote_agent` payload 删 `originTitle`、`start_remote_sub_agent` 删
      `parentSessionId` / `originTitle` 读取并写 creator、`parent_session_id` 不写；
      依赖：—；完成判据：`npm run test:core` 绿，`engine_tests.rs` 含 creator 写入 / 恢复 /
      缺失报错 / 快照字段新用例。
- [x] **T004**（FR-005、FR-006）：`core-rs/src/engine.rs` 的 `start_remote_sub_agent`
      行为——删除 Master / 非 Master 角色裁剪（prompt mode / 联网搜索 / MCP 名单全量按
      载荷应用，`persist_context` 与 `write_session_enabled` 照旧）；
      `core-rs/src/prompt.rs` 新增 `remote_sub_agent_system_prompt`（创建方身份 + `Reply`
      要求模板）并作为 `system_prompt_prefix`，本地子代理照旧
      `sub_agent_communication_section`；依赖：T003；完成判据：`npm run test:core` 绿，
      `engine_tests.rs` 含 Explorer 全量继承 / MCP 名单 / 生效 SystemPrompt 含身份与
      `Reply` 说明 / 角色白名单用例。
- [x] **T005**（FR-003）：托盘与绿灯改读 creator——`electron/trayAttention.ts` 的
      `SessionRuntimeSummary` 增 `creator`、完成抑制改 agent-form 判定；
      `electron/completionAttention.ts` 差分增 `creator`、agent-form 的 running→idle
      不武装对话行与标签页；依赖：T001；完成判据：`npm run test:all -- trayAttention`
      与 `npm run test:all -- completionAttention` 绿（agent-form 完成静默 / 等待提醒 /
      user 形态照旧用例）。
- [x] **T006**（FR-001）：容器删除——`core-rs/src/history.rs` 的 `load_conversation_list`
      占位派生段删除；`electron/main.ts` 删 `PLACEHOLDER_SESSION_PREFIX` /
      `showCrossWorkspacePlaceholder` / `jumpToCrossWorkspaceConversation` /
      `chat:jump-to-origin` IPC 与占位分支；`electron/chatPlaceholderHtml.ts` 删
      `crossWorkspaceAgent` kind；`electron/sidebar/main.ts` 删 `containerRowState` /
      placeholder 分支 / 标题后缀 / `openConversation` 传参；`src/shared/sessionRuntime.ts`
      删 `deriveContainerBusyLevel`；依赖：T001、T002、T003；完成判据：
      `npm run check-types && npm run lint`、`npm run test:all -- chatPlaceholderReason`
      与 `npm run test:core` 绿（列表用例同步更新）。
- [x] **T007**（FR-002、FR-004）：webview creator 消费与输入禁用——
      `src/host/webviewMessages.ts` / `conversationPayload.ts` /
      `ui/webviewMessageHandler.ts` 的 `conversationLoaded` 字段 `crossWorkspaceOrigin` →
      `creator`，`src/webview/hooks/handlers/conversationHandlers.ts` 与
      `src/webview/types.ts` 镜像；`App.tsx` 返回按钮与 `isSubAgent` 改读 creator；
      `src/webview/inputAreaState.ts` 禁用改判别原因（`spinMode` > `notUserCreated` >
      `providerNotConfigured`）；`InputArea.tsx` 接入并删红边框 / `subAgentWarning` 横幅；
      `i18n/zh.ts` / `en.ts` 增 `inputArea.placeholderNotUserCreated`、删
      `inputArea.subAgentWarning`；依赖：T001、T002；完成判据：`npm run check-types` 绿 +
      inputAreaState 单测（新原因 / 优先级）与 `npm run test:all -- hostI18n` 绿。
- [x] **T008**（FR-001 ~ FR-007）：文档同步——`docs/architecture/events.md` 两事件载荷列、
      `docs/core/session-runtime.md` 快照表（增 `creator`、`parentSessionId` 语义收窄）、
      `docs/features/cross-workspace-agent.md`（FR-003 / FR-004 删除 / FR-005、3.1 / 3.2 /
      3.3）、
      [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)、
      [docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)、
      `docs/features/user-stories/desktop.md` US-33 / US-56、
      `docs/features/user-stories/dialog-core.md` US-51；依赖：T003–T007；完成判据：
      `npm run test:all -- docs-lint` 绿。
- [x] **T009**（FR-001、FR-002、FR-004、FR-005）：`e2e/electron/crossWorkspaceAgent.spec.ts`
      改造——三个既有用例由容器 / 占位页口径改为顶层普通对话：目标侧顶层行与无占位条目、
      打开为对话视图、meta 断言 `creator` / 无 `parentSessionId` / 无
      `crossWorkspaceOrigin`、输入框禁用文案、读盘断言七项设置与 MCP 名单全量继承；依赖：
      T004、T006、T007；完成判据：`npm run test:e2e:electron -- -g "US-56"` 绿。
- [x] **T010**（FR-001 ~ FR-007）：全量回归——先 `npm run build:core:host`（真实双端
      前置），再 `npm run check-types && npm run lint`、`npm run test:all`（含 docs-lint）、
      `npm run test:core`、`npm run test:e2e:electron`；依赖：T008、T009；完成判据：四条
      命令全绿（既有无关失败按其记录单独说明）。
      执行记录：check-types / lint 绿；test:all 绿（72 通过 / 1 跳过——sidebarFiles 环境
      前置不满足，既有口径）；test:core 绿（933 通过）；test:e2e:electron 72 通过 / 1 失败
      ——失败项为 `e2e/electron/subagentConcurrency.spec.ts` 的 US-49 并发上限用例，
      与 specs/defects/cross-workspace-placeholder-jump-always-unavailable.md 验证记录里
      登记的既有失败是同一项（023 时期在未含修复的 HEAD 上同样失败，与本改动无关）。
