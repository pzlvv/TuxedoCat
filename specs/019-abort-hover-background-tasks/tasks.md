# 任务分解：abort 按钮黄色态悬停显示运行明细

执行顺序：先 Core 侧事实与快照（T001–T002）与 TS 契约 / 聚合函数（T003–T004，可与
Core 并行），再 webview 表现（T005）、e2e（T006），最后文档同步（T007）与全量验证
（T008）。需求见 [spec.md](spec.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001）：core-rs 快照扩展——`SessionState` 新增
  `sub_agent_description` 并在 `create_sub_agent` 写入；`emit_runtime` 读取该字段并调
  `bash_task::running_tasks_for_session` 取运行中任务；`runtime_state_json` 扩签名输出
  `backgroundTasks` / `subAgentDescription`；`core-rs/fixtures/runtimeState.json` 的
  `fields` 追加两项；`main_tests.rs` 的 `runtime_state_fields_match_parity_fixture`
  调用点补参；依赖：—；完成判据：`npm run test:core` 中
  `runtime_state_fields_match_parity_fixture` 绿。
- [x] **T002**（FR-001）：`engine_tests.rs` 新增三个用例——快照按注册序列出运行中任务
  且任务结束后清单收敛为空（AC-7）、子代理条目带创建时 description 而普通会话为
  `null`（AC-8）、两个运行中任务结束其一布尔位不变仍推送且清单只剩一项（AC-9）；依赖：
  T001；完成判据：`npm run test:core` 三个 `runtime_snapshot_` 前缀新用例绿。
- [x] **T003**（FR-001）：TS 契约——`src/shared/AssistantEventBus.ts` 的
  `SessionRuntimeState` 新增 `backgroundTasks` / `subAgentDescription` 成员并新增
  `BackgroundTaskBrief`；`src/webview/types.ts` 镜像同两成员；依赖：—；完成判据：
  `npm run check-types` 绿。
- [x] **T004**（FR-001）：`src/shared/sessionRuntime.ts` 新增聚合纯函数
  `collectRunningSubAgents`（深先序、同层按数组序、只经非空闲节点下钻）；
  `src/test/sessionBusyLevel.test.ts` 补直接子代理 / 嵌套 / 空闲跳过 / 空集用例；依赖：
  T003；完成判据：`npm run test:all -- sessionBusyLevel` 绿。
- [x] **T005**（FR-002、FR-003）：webview 表现——`App.tsx` 计算 `abortHoverDetail`
  （含 spec 缺字段口径注释）并连同 `sessionId` 传 `InputArea`；`InputArea.tsx` 黄色态
  1s 悬停计时（`HOVER_TOOLTIP_DELAY_MS = 1000`）、只读浮层（`pointer-events: none`、
  双组皆空不渲染、离黄 / 切会话即隐藏）、黄色态不再设 native `title`；`i18n/zh.ts` /
  `en.ts` 增 `abortHoverTasks` / `abortHoverSubAgents` /
  `abortHoverSubAgentFallback` 三键、删 `inputArea.abortBackground`；依赖：T004；完成
  判据：`npm run check-types && npm run lint` 绿，且 `grep -n abortBackground
  src/webview` 无残留引用。
- [x] **T006**（FR-002、FR-003）：`e2e/webview/conversation.spec.ts` 新增悬停用例——
  注入黄色态 + 任务 / 子代理明细后 `hover()` 断言浮层出现（断言超时 > 1s，AC-1 /
  AC-2）、移出消失（AC-4）、红色态无浮层（AC-5）、点击浮层区域无 `abort` 上行
  （AC-10）、任务清单减一后浮层内容刷新（AC-11）；依赖：T005；完成判据：
  `npm run test:e2e:webview -- conversation` 绿。
- [x] **T007**（FR-001、FR-002）：文档同步——`docs/core/session-runtime.md` [第 2 节](../../docs/core/session-runtime.md#2-对外快照)
  字段表加 `backgroundTasks` / `subAgentDescription` 两行；`docs/architecture/contracts.md`
  [第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager)成员说明、`docs/architecture/events.md` [第 2 节](../../docs/architecture/events.md#2-事件词汇表) `sessionRuntimeChanged` 行、
  `docs/hosts/webview-ui.md` [第 8 节](../../docs/hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定)链路表 webview 行按需补注；`user-stories.md` 索引与
  分册 dialog-core.md EP-13 新增 US-52（US-51 已被并行落库的 specs/020 占用，编号顺延）并在附录
  e2e 映射表登记 `conversation.spec.ts` 悬停用例；依赖：T005；完成
  判据：`npm run test:all -- docs-lint` 绿。
- [x] **T008**（FR-001、FR-002、FR-003）：全量验证收尾——`npm run build:core:host`
  后依次 `npm run check-types && npm run lint`、`npm run test:all`、`npm run test:core`、
  `npm run test:e2e:webview`；依赖：T002、T004、T005、T006、T007；完成判据：四组命令
  全绿（`standalone*` 系列真实驱动 Core 二进制而非 skip）。
