# 实施方案：Standalone Core 把「工具卡片上架」误标为等待用户

把 `waiting` 的写入面收回到「真的等用户」这一件事上（缺陷表现与验收见同目录 [defect.md](defect.md)）：`core-rs` 的 `request_tool_permission` 不再经 `waiting_request`，与 Embedded 的 `emitToolPermissionRequest` 对齐；两侧各补一条行为用例锁死。

## 技术方案

### 1. Rust 侧：拆开「在途标记 waiting」与「普通请求」

`core-rs/src/engine.rs` 现在只有一个 `waiting_request`（发 `CoreRequest` → 置 `waiting = true` → `emit_runtime` → 等应答 → 置假 → `emit_runtime`），`request_tool_permission`（`toolPermissionRequested`）与 `request_user_choice`（`userChoice`）共用它。

改法：把「发请求 + 等应答」与「标记 waiting」拆开——`waiting_request` 保留给 `request_user_choice`（真等用户），新增 `plain_request`（同样的超时 / 取消语义，不碰 `waiting`、不额外 `emit_runtime`）给 `request_tool_permission` 用。判据是宿主侧事实：`src/host/ui/toolHandler.ts` 的 `requestToolPermission` 拿到 `permResult` 就返回（`ask` 也直接返回，真确认框由随后的 `userChoice` 弹），这段往返里没有「等用户」。

### 2. Embedded 侧：实现已对，只补用例

`src/core/tools/RunTools.ts` 的 `emitToolPermissionRequest` 是普通 `requireEventBus().request(...)`，不碰 `sessionRuntime`；`waiting` 只由 `Integration.requestUserChoice`（入队）与 `uiPort` 的 `userChoicePendingChanged`（弹出 / 应答）写入。本次不动实现，只补一条行为用例把这条口径锁死，避免以后有人「顺手」给权限往返加 waiting。

### 3. 回归用例

- `core-rs/src/engine_tests.rs`：两个用例——auto 免确认的工具调用全程 `waiting` 恒假；manual 模式只在 `userChoice` 在途期间为真。用例直接读引擎推送的 `sessionRuntimeChanged` 快照（现有 harness 的 frame 记录）。
- `src/test/toolPermissionWaiting.test.ts`：同一期望的 Embedded 侧用例，用 `src/test/helpers/scenario.ts` 驱动「用户消息 → LLM 脚本 → 工具轮 → 权限」整条链路，断言记录到的运行时快照序列。

### 4. 文档

- `docs/core/session-runtime.md` 的来源表：`waiting` 一行补「`toolPermissionRequested` 的往返不算（只有 `userChoice` 算）」。
- `docs/core/core-parity.md`：登记这条对等面（哪些请求在途标记 `waiting`）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/engine.rs` | 修改：`waiting_request` 拆分，`request_tool_permission` 改走不标记 waiting 的路径 | 无（`CoreRequest` 载荷 / 时序 / 失败兜底不变） |
| `core-rs/src/engine_tests.rs` | 新增两个用例 | 无 |
| `src/test/toolPermissionWaiting.test.ts` | 新增 | 无 |
| `docs/core/session-runtime.md` | 修改：`waiting` 来源表 | 无 |
| `docs/core/core-parity.md` | 修改：登记对等面 | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 Core 内部（Rust 引擎 + 既有 TS 路径的用例），不 import host / 宿主 API、无宿主嗅探；宿主侧一行未动。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback——`toolPermissionRequested` 的失败兜底（无订阅者 / 超时按 deny）逐字保留，只去掉 waiting 标记；一份事实一个写入点——`waiting` 的写入点收敛到 `userChoice` 入队 / 弹出 / 应答，与 Embedded 同一处；契约成员全必选、无新增字段；默认值单源不涉及。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：**本次就是 parity 修复**——Rust 向 Embedded 对齐，两侧各补一条同口径行为用例，`docs/core/core-parity.md` 登记该对等面；`npm run test:core` 与 `npm run test:all` 都要绿。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：同步 `docs/core/session-runtime.md` 与 `docs/core/core-parity.md`；无新增文档、`docs/README.md` 地图不变；`npm run test:all -- docs-lint` 绿。

## 被否决的替代方案

1. **在宿主侧（托盘 / 侧栏）过滤掉毫秒级的 waiting 抖动**：治标不治本——`waiting` 是 core 暴露的事实，事实错了该改事实；过滤还会把真等待（用户手速极快时）一起吃掉。
2. **把 `waiting` 的标记从 `waiting_request` 里整体删掉**：会让真确认框在途期间不再标记 waiting，侧栏黄灯 / 托盘等待提醒 / 空闲回收全线失准。
3. **只改 Rust 测试不改实现**（把用例写成「允许一次抖动」）：等于把缺陷固化成契约。
