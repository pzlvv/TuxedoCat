# 任务分解：Standalone Core 把「工具卡片上架」误标为等待用户

执行顺序：先落两侧用例（T001 Rust、T003 Embedded，用例先红后绿），再改 Rust 实现（T002）让 T001 转绿，随后文档同步（T004），最后全量验证（T005）。缺陷表现与验收见 [defect.md](defect.md)，技术方案见 [plan.md](plan.md)。

## 任务清单

- [x] **T001**（RT-1、RT-2）：`core-rs/src/engine_tests.rs` 新增两个用例——①auto 免确认的工具调用（`toolPermissionRequested` 自动回 `allow`）全程 `waiting` 恒假；②manual 模式（`toolPermissionRequested` 回 `ask` + 随后 `userChoice` 应答）`waiting` 只在 `userChoice` 在途为真；依赖：—；完成判据：改实现前 ① 红、② 绿，改实现后两个都绿（`npm run test:core`）
- [x] **T002**（RT-1、RT-2）：`core-rs/src/engine.rs` 拆分请求路径——`waiting_request` 保留「标记 waiting + 发请求 + 等应答」给 `request_user_choice`，新增不标记 waiting 的 `plain_request`（超时 / 取消语义不变）供 `request_tool_permission` 使用；依赖：T001；完成判据：`npm run test:core` 全绿（含 T001 两例与既有权限 / 引擎用例）
- [x] **T003**（RT-3）：新增 `src/test/toolPermissionWaiting.test.ts`——用 `src/test/helpers/scenario.ts` 驱动 Embedded 侧「用户消息 → 工具轮 → 权限」链路，断言运行时快照的 `waiting` 序列与 T001 同一期望（auto 恒假 / manual 只在 `userChoice` 在途为真）；依赖：—；完成判据：`npm run test:all -- toolPermissionWaiting` 全绿
- [x] **T004**（RT-1、RT-2、RT-3）：文档同步——[docs/core/session-runtime.md 第 1 节](../../docs/core/session-runtime.md#1-来源与调用点) 的 `waiting` 来源补「`toolPermissionRequested` 往返不算」；[docs/core/core-parity.md](../../docs/core/core-parity.md) 登记该对等面；依赖：T002、T003；完成判据：`npm run test:all -- docs-lint` 全绿
- [x] **T005**（RT-1、RT-2、RT-3）：全量验证——`npm run build:core:host`（让 parity / standalone 用例真实运行）、`npm run check-types`、`npm run lint`、`npm run test:all`、`npm run test:core` 全绿；并用 e2e 探针复跑「auto 免确认的工具调用」确认不再出现 `waiting` 推送（提示音 / 托盘闪烁随之消失）；依赖：T002、T003、T004；完成判据：命令退出码全 0（已达成：`check-types` 0 错 / `lint` 干净 / `test:all` 129 项全过 / `test:core` 825 全过）；e2e 探针已复跑（先 `npm run copy-assets` 把修好的 Core 刷进 `dist/resources`）：auto 免确认的「写入文件」推送序列为 `idle → running → idle`（无 `waiting`），manual 模式为 `idle → running → waiting → running → idle`（只有真确认框那一次）
