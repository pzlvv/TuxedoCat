# 任务分解：Edit / Write 的读后失效守卫

执行顺序：守卫模块与判定矩阵先行（T001），会话生命周期（T002）与三个工具接入点（T003）
依赖它；T003 内同时完成存量用例迁移与守卫专项用例（先红后绿）。文档（T004、T005）、
e2e（T006）、全量回归（T007）收尾。需求口径见 [spec.md](spec.md)，技术方案见
[plan.md](plan.md)。

## 任务清单

- [x] **T001**（FR-001、FR-002）：新增 `core-rs/src/read_guard.rs`——`FileFingerprint`（sha2 对**原始字节**求十六进制）、`record_read` / `record_write`、`verify`（判定矩阵四行）、`normalize`（`canonicalize` 成功即取、失败退化为 `expand_path` 产物按分隔符归一）、`clear_session`、`reset_for_test`、`READ_STALE_MESSAGE` / `READ_MISSING_MESSAGE` 两个文案常量，并在 `core-rs/src/main.rs` 登记 `mod read_guard;` 与测试模块；依赖：—；完成判据：新增 `core-rs/src/read_guard_tests.rs`，覆盖判定矩阵四行（指纹相等放行 / 不等拒绝 / 无记录且文件存在拒绝 / 无记录且文件不存在放行）、`a.ts` 与 `./a.ts` 与 `sub/../a.ts` 归一成同一条记录、两份不同的非法 UTF-8 字节得到不同指纹、两条错误文案逐字锁定；`npm run test:core -- read_guard` 绿。
- [x] **T002**（FR-003）：会话生命周期接入——`core-rs/src/engine.rs` 的 `drop_session` 调 `read_guard::clear_session`（与 `compact::unmark_pending_compact` / `subagent::unregister` 同一处收口），不重复接入 `on_conversation_closed`；依赖：T001；完成判据：`core-rs/src/read_guard_tests.rs`（或 `engine_tests.rs`）覆盖「会话 A 的读取记录不影响会话 B」与「`drop_session` 后记录清空、再次 Edit 要求先 Read」，`npm run test:core` 绿。
- [x] **T003**（FR-001、FR-002、FR-003）：工具接入——`run_read` 文本分支成功时 `record_read(session_id, path, 整份文件原始字节)`（图片 / xlsx / 二进制 / 超限 / 不存在分支不记录）；`run_write` 在 `before_content` 之后、`fs::write` 之前 `verify`，写成功后读回磁盘字节 `record_write`；`run_edit` 在 `read_to_string` 成功后立即 `verify`，写成功后 `record_write`。同时按 [plan.md](plan.md) 的技术方案完成 `core-rs/src/tools_tests.rs` 存量迁移（`Sandbox::seed_read`，守卫用例不 seed 且开头 `read_guard_reset_for_test()`）；依赖：T002；完成判据：`core-rs/src/tools_tests.rs` 的守卫专项用例覆盖 AC-1 ～ AC-7（外部改写后 Edit / Write 被拒且磁盘不变、重新 Read 后放行、连续两次 Edit 不插 Read 仍成功、从未 Read 的已存在文件 Edit 被拒、从未 Read 的 Write 新建放行、片段 Read 建立整份指纹、会话隔离），且既有工具用例全绿；`npm run test:core` 绿。
- [x] **T004**（FR-001、FR-002、FR-003）：文档同步——`docs/core/standalone-core.md`（事实归属之后）落「Read 与 Edit / Write 的时效契约」：什么算读过、失效判据、两条拒绝文案、解除方式、不跨会话 / 不跨重启、片段 Read 的口径；[docs/architecture/events.md 第 2.1 节](../../docs/architecture/events.md#21-coreeventcore--ui单向) `toolResult` 行的 core 侧触发点列补「读后失效拒绝」（载荷不变）；依赖：T003；完成判据：`npm run test:unit -- docs-lint` 绿，且两份文档分别在体积闸门内（`docs/core/standalone-core.md` ≤ 500 行、`docs/architecture/events.md` ≤ 421 行棘轮只降不升——已顶到上限时，新内容必须靠压缩同源表述腾出行数，或按 surface 拆出新文档并登记 `docs/README.md` 地图）。
- [x] **T005**（FR-001）：需求基线——`docs/features/user-stories/tools.md` 的 EP-7 新增 US-74「读后失效的编辑被拒绝并提示重新读取」（**不沿用 plan 里的 US-68：该编号已被 PyCharm 分册的「安装分发 zip 即用」占用**），`docs/features/user-stories.md` 的目录行与附录映射表同步（`e2e/electron/assistant.spec.ts` 那行补 US-74）；依赖：T004；完成判据：`npm run test:unit -- docs-lint` 绿（US 与映射 / 豁免段闭合组通过）。
- [x] **T006**（FR-001、FR-002、FR-003）：e2e——`e2e/electron/assistant.spec.ts` 补一条「Read → 外部改写 → Edit 被拒（错误文案点名重新读取）→ 重新 Read → Edit 成功」，测试名带 `US-74` 与 `FR-001`；依赖：T005；完成判据：`npm run test:e2e:electron -- e2e/electron/assistant.spec.ts` 绿，且 `npm run test:unit -- docs-lint` 的 e2e 测试名 ↔ FR 双向对照组绿。
- [x] **T007**（FR-001、FR-002、FR-003）：全量回归——先 `npm run build:core:host` 再 `npm run test:all`；依赖：T006；完成判据：`npm run check-types && npm run lint && npm run test:core && npm run build:core:host && npm run test:all` 五条命令全绿（`standalone*` 系列驱动真实 Core 二进制而非 skip）。
