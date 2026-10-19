# 任务分解：once 一次性通知消息

执行顺序：先 shared / wire 类型（T001），core-rs 三个 emit 点与落盘摘除（T002–T003），
宿主透传（T004），webview 时间线规则（T005），然后测试（T006–T007）与文档同步（T008）、
全量闸门（T009）。需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)；每条任务
完成即勾选，全勾后进 /converge。

## 任务清单

- [x] **T001**（FR-001）：`src/shared/types.ts` 的 `MessageData.once?`、
  `src/host/webviewMessages.ts` 的 addMessage `once?`、`src/webview/types.ts` 的
  `Message.once?`；依赖：—；完成判据：`npm run check-types` 绿。
- [x] **T002**（FR-003）：`core-rs/src/engine.rs` 三个 emit 点带 `"once": true`
  （LLM 失败回显、压缩排队提示、`emit_user_interrupted`）；依赖：—；完成判据：
  `cargo test`（engine 相关用例）绿。
- [x] **T003**（FR-001、FR-003）：`emit_user_interrupted` 摘除落盘段（jsonl / 内存列表 /
  last_uuid / persisted_count / announce），签名改 `()` 并修 4 个调用点；静默中止豁免
  不变；依赖：T002；完成判据：`engine_tests.rs` 中断用例改为「不落盘 + once 标记」后
  `cargo test` 绿。
- [x] **T004**（FR-003）：`src/host/bootstrapCore.ts` 的 `markConnectionSessionsFailed`
  失联提示 `data.once = true`；依赖：T001；完成判据：`npm run check-types` 绿。
- [x] **T005**（FR-002、AC-9）：webview——`toUiMessage` 透传 `once`，`shared.ts` 新增
  `stripOnce` 纯函数，`toolHandlers` 三个追加分支与 `streamHandlers` 新建节点分支接入
  （就地更新路径不接）；依赖：T001；完成判据：`npm run check-types` 与
  `npm run build:webview` 绿。
- [x] **T006**（FR-002、FR-004）：e2e 消息域用例——fakeHost 注入 `once: true` 的
  system addMessage：末位显示系统样式节点；随后注入用户消息 once 消失；工具卡片就地
  更新 once 保留；重载（messagesReplaced）后无 once；依赖：T005；完成判据：
  `npx playwright test --project=webview-ui` 相关 spec 绿。
- [x] **T007**（FR-001、FR-003）：core 侧用例收口——中断用例改断言（UI 事件带 once、
  磁盘无记录、messageCount 不含）；LLM 失败与压缩排队用例补 once 断言；依赖：T002、
  T003；完成判据：`cargo test` 全量绿。
- [x] **T008**（文档同步）：events.md 2.1 `message` 载荷列、US-2 中止回显条目、
  compaction FR-002、[webview-ui 第 2 节](../../docs/hosts/webview-ui.md#2-内部流程约定) `onMessage` 行；依赖：T002–T005；完成判据：
  `npm run test:all -- docs-lint` 绿。
- [x] **T009**（全量闸门）：`npm run check-types && npm run lint && npm run test:all`
  与 `npm run test:core`；依赖：T001–T008；完成判据：全部绿，结果回写本文件。
  实测（先 `npm run build:core:host` 重建本机二进制）：check-types 0 错、lint 干净、
  test:all 57 项全绿（含 docs-lint 45 组，standalone* 驱动新二进制）、test:core
  857 用例全绿；e2e messagePresentation 7 项全绿（含 once 用例）。
