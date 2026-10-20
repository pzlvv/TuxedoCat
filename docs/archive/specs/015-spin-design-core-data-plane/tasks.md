# 任务分解：Spin 设计器数据面经 Core

执行顺序：先定契约与 Core 数据面（T001–T004），再接宿主统一入口与设计器编排
（T005–T014），然后补测试（T015–T017），最后同步文档并跑全量验证（T018–T020）。
需求与验收见 [spec.md](spec.md)，技术路线见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002）：在 `src/shared/AssistantEventBus.ts` 增加
  `UiRequest.spinDesignRequested` / `spinDesignSaveRequested`、`SpinDesignSkill` /
  `SpinDesignReadResult` / `SpinDesignSaveResult`，并补 `UiRequestResultMap` 两项；
  依赖：—；完成判据：`npm run check-types` 0 错，`UiRequest` 联合为 11 个成员，
  `UiRequestResultMap` 含两个新键。
- [x] **T002**（FR-001、FR-002）：`core-rs/src/spin.rs` 增加
  `read_spin_json_state(cwd) -> Result<Option<Value>, String>`（不存在 → `Ok(None)`，
  读取 / 解析失败 → `Err`），保留 `read_spin_json` 的 `Option` 语义；去掉
  `write_spin_json` 的 `#[cfg_attr(not(test), allow(dead_code))]`；依赖：T001；
  完成判据：`npm run test:core` 中 `read_spin_json_state` 的 missing / ok / invalid
  三个用例绿。
- [x] **T003**（FR-001、FR-002、FR-005）：`core-rs/src/main.rs` 的 `dispatch_ui_request`
  增加两个分支与 payload 组装：用 `config::session_workspace(session_id)` 严格解析
  （不走 `project_root`），读取返回 `{ status, data, skills }`，保存走
  `spin::write_spin_json` 并返回 `{ status }`；技能用 `skills::get_all_skills(cwd)`
  过滤 `!is_hidden && user_invocable`；保存不广播 `spinDesignDataChanged`；依赖：T002；
  完成判据：`cargo test --manifest-path core-rs/Cargo.toml` 中新增的 dispatch 用例绿。
- [x] **T004**（FR-001、FR-002、FR-005）：`core-rs/src/main_tests.rs` 补
  `spinDesignRequested` 的「有文件 / 无文件 / 非法 JSON / 未登记会话」与
  `spinDesignSaveRequested` 的「成功落盘 / 未登记会话」用例，断言保存后目标目录出现
  `spin.json` 且没有 `spinDesignDataChanged` 事件；`core-rs/src/spin_tests.rs` 补
  `read_spin_json_state` 三态；依赖：T003；完成判据：
  `npm run test:core` 全绿，新增用例名可在输出中检索。
- [x] **T005**（FR-001、FR-002）：`src/host/coreFacts.ts` 增加
  `requestSpinDesign(sessionId)` 与 `saveSpinDesign(sessionId, data)`，内部走
  `requireEventBus().requestCore(...)`；依赖：T001；完成判据：`npm run check-types`
  0 错，`hostCoreFacts` 测试能观察到两个请求（T016）。
- [x] **T006**（FR-003）：`src/host/SpinDesign.ts` 把 `open(workspacePath?: string)` 改为
  `open(sessionId: string | null)`，更新契约注释（数据来自 Core、首次读取失败不建窗口、
  已打开失败保持原绑定）；依赖：T001；完成判据：`npm run check-types` 0 错，
  `docsLint` 的 SpinDesign 成员对照仍为 `open` / `refresh`。
- [x] **T007**（FR-003、FR-004）：`src/host/WebViewUI.ts` 的 `openSpinDesign()` 传活动
  `sessionId`（`undefined` → `null`），失败时用 `CoreNoticeKeys.spinCannotRead` 发
  `notice`；`onCommandSend` 的 `/spin` 分支改用 `requestSpinDesign(sessionId)` +
  `shouldOpenSpinDesign(result)`，错误时不打开设计器并提示；删除 `workspaceForSession`；
  依赖：T005、T006、T008；完成判据：`npm run check-types` 0 错，`spinDesignCore`
  测试的「/spin 存在性来自 Core」用例绿。
- [x] **T008**（FR-004）：`src/shared/history/spinCommand.ts` 改为纯判定
  `shouldOpenSpinDesign(result: SpinDesignReadResult)`（`status === 'ok' &&
  data === null`），删除 `spinJsonPathFor`、`fs` 与 `getProjectConversationDir` 依赖；
  依赖：T001；完成判据：`npm run check-types` 0 错，文件不再 import `fs`。
- [x] **T009**（FR-001、FR-003、FR-005）：`src/VSCodeSpinDesign.ts` 的 `open` / `refresh`
  改走 `requestSpinDesign`：同会话聚焦、异会话先读成功再绑定、失败推
  `spinDesignError` 并保持原绑定；删除 `readSpinDesignData` 的本地 `fs` /
  `getProjectConversationDir` / `getAllSkills`；依赖：T005、T006、T013；完成判据：
  `npm run check-types` 0 错，文件不再 import `fs` / `shared/history/Config`。
- [x] **T010**（FR-002）：`src/VSCodeSpinDesign.ts` 的保存改走 `saveSpinDesign`，
  删除 `writeSpinJsonQueued` 与本地 `mkdirSync`；`sessionId === null` 时回
  `spinSaveResult` 失败；依赖：T009；完成判据：`npm run check-types` 0 错，
  文件不再引用 `shared/spin/Engine`。
- [x] **T011**（FR-001、FR-003、FR-005）：`electron/ElectronSpinDesign.ts` 的 `open` /
  `refresh` 改走 `requestSpinDesign`，删除本地 `getProjectConversationDir` / `fs` 读取与
  `getAllSkills`；异会话先读成功再绑定、失败推 `spinDesignError`；依赖：T005、T006、T013；
  完成判据：`npm run check-types` 0 错，文件不再 import `fs` / `shared/history/Config`。
- [x] **T012**（FR-002）：`electron/ElectronSpinDesign.ts` 的保存改走 `saveSpinDesign`，
  删除 `writeSpinJsonQueued` / `mkdirSync` / `getProjectConversationDir` 包装；
  `sessionId === null` 时回 `spinSaveResult` 失败；依赖：T011；完成判据：
  `npm run check-types` 0 错，文件不再引用 `shared/spin/Engine`。
- [x] **T013**（FR-001、FR-002、FR-005）：`src/host/ui/spinDesignHtml.ts` 增加
  `spinDesignError` 消息处理（`toast.loadFailed`）、`saveDesign()` 的 `__spinCanSave`
  守卫（`toast.loadRequired`）、`getSpinDesignHtml` 的必填 `saveEnabled` 入参；
  `spinDesignData` 到达后允许保存；依赖：T006；完成判据：`spinDesignCore` 测试断言
  生成的 HTML 含 `spinDesignError` / `__spinCanSave`，且 zh / en 两个 `toast.loadFailed`
  与 `toast.loadRequired` 都存在。
- [x] **T014**（FR-001、FR-002）：`src/shared/spin/Engine.ts` 移除
  `readSpinJson` / `writeSpinJson` / `enqueueSpinWrite` / `writeSpinJsonQueued` /
  `updateNodeMeta` 与 `fs` / `Config` 依赖，纯函数按 spec 非目标保留；依赖：T010、T012；
  完成判据：`grep -r "writeSpinJsonQueued\|enqueueSpinWrite" src electron` 无命中，
  `npm run check-types` 0 错。
- [x] **T015**（FR-001、FR-002、FR-003、FR-004、FR-005）：新增
  `src/test/spinDesignCore.test.ts`：假总线断言两个 `UiRequest` 的载荷与路由、
  读取 / 保存错误映射、`/spin` 存在性判定、请求失败时宿主不创建
  `conversations/.../spin.json` 或 `workspace.meta.json`；依赖：T005、T008、T009、
  T011、T013；完成判据：`npm run test:all -- spinDesignCore` 全绿。
- [x] **T016**（FR-001、FR-002）：`src/test/hostCoreFacts.test.ts` 的
  `UiRequestHandlers` 补 `spinDesignRequested` / `spinDesignSaveRequested`，把
  「9 类请求各到一次」改为 11 类并加两个断言；依赖：T005；完成判据：
  `npm run test:all -- hostCoreFacts` 全绿。
- [x] **T017**（FR-002）：扩展 `e2e/electron/desktopShell.spec.ts` 的 US-39 用例：
  打开设计器后点击保存，断言 `app.homeDir` 沙箱的会话目录出现 `spin.json`，
  且宿主进程没有在别的路径写同名文件；依赖：T012、T013；完成判据：
  `npm run test:e2e:electron -- desktopShell` 中 US-39 用例绿。
- [x] **T018**（FR-001、FR-002、FR-003、FR-004、FR-005）：同步架构 / Core 文档：
  [events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)（`UiRequest` 数量
  9→11、总数 60→62）、
  [standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约) /
  [第 7 节](../../docs/core/standalone-core.md#7-事实归属)、
  [standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)、
  [contracts.md 第 2 节](../../docs/architecture/contracts.md#2-spin-设计器契约spindesign)、
  [principles.md 第 4 节](../../docs/architecture/principles.md#4-core-的资源跟-core-的事实走) /
  [第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)、
  [core-ui-separation.md 第 5 节](../../docs/architecture/core-ui-separation.md#5-core-的部署形态)、
  [client-connection.md 第 4.1 节](../../docs/core/client-connection.md#41-与-core-数据目录的关系)；
  依赖：T003、T007、T009、T011；完成判据：`node out/src/test/docsLint.test.js`
  的事件数量 / 成员清单 / 章节引用三组绿。
- [x] **T019**（FR-001、FR-002、FR-003、FR-004、FR-005）：同步宿主与需求基线：
  [host-matrix.md 第 4 节](../../docs/hosts/host-matrix.md#4-spindesign-实现对照表) 的
  读取 / 保存行改为 `UiRequest`，
  [user-stories.md US-39](../../docs/features/user-stories.md#us-39-spin-设计器)
  验收 2 明确保存写回会话所属 Core 所在机器的会话目录；依赖：T009、T011；
  完成判据：`node out/src/test/docsLint.test.js` 的 US↔e2e 映射与宿主对照表两组绿。
- [x] **T020**（FR-001、FR-002、FR-003、FR-004、FR-005）：全量验证：
  `npm run check-types && npm run lint`、`npm run build:core:host`、
  `npm run test:all`、`npm run test:core`、`npm run test:e2e:electron -- desktopShell`；
  依赖：T001–T019；完成判据：上述命令全部绿，`docsLint` 46 组全过，验证记录写进
  提交信息。
