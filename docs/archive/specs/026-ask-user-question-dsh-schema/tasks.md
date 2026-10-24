# 任务分解：AskUserQuestion 入参对齐 dsh 的 questions 形状

执行顺序按「契约 → core → host → webview → 测试 → 文档 → 整体验证」推进，先让两侧共享
的判别联合定稿，再逐层落地。需求见同目录 [`spec.md`](spec.md)，技术方案见
[`plan.md`](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002、FR-006）：契约类型定稿——`src/shared/UserChoiceQueue.ts`
  定义 `UserQuestion` / `UserAnswer` / `UserChoiceOptions` / `UserChoiceResult` 判别联合；
  `src/shared/AssistantEventBus.ts` 的 `CoreRequestResultMap.userChoice` 改为
  `UserChoiceResult`；`core-rs/src/tool_input.rs` 的 `ask_user_fields` 改为 `questions`
  数组并新增 question item 校验；依赖：—；完成判据：`npm run check-types` 绿，
  `grep -n "UserQuestion\|UserAnswer" src/shared/UserChoiceQueue.ts` 命中。
- [x] **T002**（FR-001、FR-006）：Core 工具定义与校验——`core-rs/src/tools.rs` 的
  `definitions()` 展开 `questions` / `options` 的 `items` 与 `minItems` / `maxItems`；
  `validate_input` 改为逐题校验 `question` 非空；`tool_input.rs` 的 `check_questions`
  校验 1–9 项、`id` 唯一、option `label` 非空且同题唯一；依赖：T001；完成判据：
  `cargo test --manifest-path core-rs/Cargo.toml tool_input` 与
  `cargo test --manifest-path core-rs/Cargo.toml ask_user` 绿。
- [x] **T003**（FR-002、FR-005）：Core 请求与结果——`core-rs/src/tools.rs` 的
  `run_ask_user_question` 规范化 `questions` 并发送
  `{ kind: 'question', toolName: 'AskUserQuestion', questions }`，收到
  `{ kind: 'question', answers }` 后产出 `{"answers":[...]}` JSON；`core-rs/src/engine.rs`
  的 `request_user_choice`（权限确认）载荷加 `kind: 'permission'`；依赖：T002；完成判据：
  `cargo test --manifest-path core-rs/Cargo.toml ask_user` 绿，且
  `engine_tests.rs` 的 `userChoice` 载荷断言含 `kind`。
- [x] **T004**（FR-001、FR-002）：Core 对照表与提示词——`core-rs/fixtures/toolSchema.json`
  的 AskUserQuestion 段展开 `items`；`core-rs/fixtures/toolInputValidation.json` 与
  `core-rs/fixtures/systemPrompt.json` 按新形状重生成；`core-rs/src/prompt.rs` 的
  AskUserQuestion 段改为 dsh 参数与示例；依赖：T002、T003；完成判据：
  `cargo test --manifest-path core-rs/Cargo.toml` 中 `tool_schema` /
  `tool_input_validation` / `system_prompt` 三组对照测试绿。
- [x] **T005**（FR-002）：Host 契约与透传——`src/host/webviewMessages.ts` 的
  `requestUserChoice` / `respondUserChoice` 加 `kind` 与对应字段；
  `src/host/ui/userChoice.ts` 按 `kind` 透传；`src/host/ui/webviewMessageHandler.ts` 的
  `handleRespondUserChoice` 按 `kind` 构造结果；`src/host/ui/toolHandler.ts` 权限确认读
  `index`；`src/host/WebViewUI.ts` 返回 `Promise<UserChoiceResult>`；依赖：T001；完成判据：
  `npm run check-types` 绿，`src/test/userChoice*.test.ts` 编译通过。
- [x] **T006**（FR-003、FR-004）：Webview 逐页 UI——`src/webview/types.ts` 的
  `UserChoiceRequest` 改为判别联合；`src/webview/UserChoiceOverlay.tsx` 新增 question
  分支（逐页、进度条可点击、上一页 / 下一页 / 提交、多选、其他项、Enter / Shift+Enter、
  自动下一页）；`src/webview/hooks/useAppHandlers.ts` 提交 `answers`；
  `src/webview/hooks/handlers/toolHandlers.ts` 解析 `questions`；`src/webview/App.tsx`
  数字键按 `kind` 分支；`src/webview/i18n/{zh,en}.ts` 补文案；依赖：T005；完成判据：
  `npm run check-types` 与 `npm run lint` 绿，手动打开 webview 可逐页作答并回传
  `answers`。
- [x] **T007**（FR-007）：历史卡片兼容——`src/webview/tools/AskUserQuestion.tsx` 优先读
  `questions[].question`，旧 `question` / `choices` 仍能只读展示；依赖：T006；完成判据：
  `npm run check-types` 绿，旧形状 tool_use 渲染不抛错。
- [x] **T008**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006、FR-007）：测试收口——
  更新 `src/test/userChoiceDelivery.test.ts` / `userChoice.test.ts` /
  `userChoiceQueue.test.ts` 的载荷；更新 `core-rs/src/tools_tests.rs` /
  `engine_tests.rs` / `prompt_tests.rs`；新增 e2e 用例或在
  `docs/features/user-stories.md` 按既有口径登记豁免；依赖：T003–T007；完成判据：
  `npm run test:all -- user-choice` 与 `cargo test --manifest-path core-rs/Cargo.toml`
  绿。
- [x] **T009**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006、FR-007）：文档 delta——
  [docs/architecture/events.md](../../../docs/architecture/events.md) 的 `userChoice` 载荷与结果、
  [docs/architecture/host-ui-modules.md 第 1 节](../../../docs/architecture/host-ui-modules.md#1-userchoicemanager)、
  [docs/hosts/webview-ui.md 第 9 节](../../../docs/hosts/webview-ui.md#9-生命周期dropsession)、
  [docs/core/standalone-core.md 第 4 节](../../../docs/core/standalone-core.md#4-契约)、
  [docs/features/user-stories/messages.md EP-4](../../../docs/features/user-stories/messages.md#ep-4-权限与用户确认)；
  新增 `docs/features/ask-user-question.md`
  与 `docs/adr/0010-ask-user-question-dsh-schema.md`；`docs/README.md` 地图登记；依赖：
  T006；完成判据：`npm run test:all -- docs-lint` 全绿。
- [x] **T010**（FR-001、FR-002、FR-003、FR-004、FR-005、FR-006、FR-007）：整体验证——
  `npm run check-types && npm run lint && npm run build:core:host && npm run test:core &&
  npm run test:all`；依赖：T001–T009；完成判据：全部绿，`standalone*` 系列无「跳过」条目。
