---
status: 已收敛
---

# 缺陷规格：Standalone Core 把「工具卡片上架」误标为等待用户

Standalone Core（`core-rs/`）在 `toolPermissionRequested` 这段「工具卡片上架 / 权限结果回传」的往返期间把会话标成 `waiting`，而 Embedded Core（`src/core/`）只在真正弹用户选择框（`userChoice`）时标记。后果是**每次工具调用都凭空多出一次 `running → waiting` 迁移**：托盘「任务结束提醒」闪一下（毫秒级、肉眼看不见）并响一声（听得见），侧栏会话黄灯同样闪一下。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md#1-来源与调用点) | 1. 来源与 owner | 修改 | `waiting` 的来源表补一句：`toolPermissionRequested` 的往返不算等待用户（只有 `userChoice` 算），两侧一致 |
| [docs/core/core-parity.md](../../docs/core/core-parity.md) | 已由对照表锁定的对等面 | 修改 | 登记本缺陷锁定的对等面：哪些请求在途时标记 `waiting` |

## 现状

复现（e2e 整应用 + mock LLM，`defaultAgentMode: auto` 免确认、主窗口隐藏）：

```text
push: idle    → running（本轮开始）
push: waiting ← 工具卡片上架（toolPermissionRequested 往返），此刻并无用户交互
push: running
push: idle    → 提醒（本轮结束）
```

同一场景换成 `coreKind: embedded` 则**没有** `waiting` 那一跳。也就是说：

- `core-rs/src/engine.rs` 的 `waiting_request` 同时服务 `request_tool_permission`（`toolPermissionRequested`）与 `request_user_choice`（`userChoice`），两者都在途期间把 `state.waiting` 置真；
- Embedded 侧 `src/core/tools/RunTools.ts` 的 `emitToolPermissionRequest` 是普通 `requireEventBus().request(...)`，**不碰** `sessionRuntime`；`waiting` 只由 `Integration.requestUserChoice`（入队）与宿主 `userChoicePendingChanged`（弹出 / 应答）写入；
- 宿主侧 `src/host/ui/toolHandler.ts` 的 `requestToolPermission` 拿到 `permResult` 就返回（`ask` 也直接返回，真正的确认框由随后的 `userChoice` 弹），所以这段往返里根本不存在「等用户」。

用户可见症状：auto / risk 模式下每次工具调用都触发一次提醒（托盘闪 + 提示音响）；manual 模式下每次工具调用额外多一次提醒（卡片上架那一跳），紧随其后的真确认框才是真提醒。

## 期望

- `waiting` 只在**真的等用户**时置真：`userChoice` 的弹出 / 应答（含宿主 `userChoicePendingChanged`）与入队。
- `toolPermissionRequested` 的往返（工具卡片上架 / 权限结果回传）不改变 `waiting`——两侧 Core 同口径。
- 由此，auto 免确认模式下工具调用不产生 `running → waiting` 迁移（不闪、不响）；manual 模式下每次确认只产生一次提醒（真确认框那次）。

## 不变量

- `sessionRuntimeChanged` 快照的字段与语义不变（`queryRunning` / `waiting` / `compacting` / `backgroundRunning` / `subAgentRunning` / `idle` / `parentSessionId`）。
- `toolPermissionRequested` / `userChoice` 两条 `CoreRequest` 的载荷、时序与失败兜底（无订阅者 / 超时按 deny）不变。
- `userChoice` 在途期间仍标记 `waiting`（侧栏黄灯 / 托盘等待提醒 / 空闲回收的既有判定不变）。
- 工具卡片的上架与状态（`pendingToolUseIds` 的 normal / 等待确认）不变。
- 不改 `waiting` 的其它消费者：`sessionResources.isSessionIdle`、`isIdleInSnapshot`、睡眠阻断。

## 回归测试

- **RT-1**：Standalone Core 驱动一次 auto 免确认的工具调用（`toolPermissionRequested` 自动回 `allow`），断言全过程推送的 `sessionRuntimeChanged` 快照里 `waiting` 恒为假（落点：`core-rs/src/engine_tests.rs` 的新用例）
- **RT-2**：同一场景在 manual 模式下（`toolPermissionRequested` 回 `ask`、随后 `userChoice` 应答）断言 `waiting` 只在 `userChoice` 在途期间为真，`toolPermissionRequested` 往返期间为假（落点：`core-rs/src/engine_tests.rs` 的新用例）
- **RT-3**：Embedded Core 侧同一期望的行为用例——同一脚本下 `waiting` 恒假（auto）/ 只在 `userChoice` 在途为真（manual），与 RT-1 / RT-2 逐条同口径（落点：`src/test/toolPermissionWaiting.test.ts`，驱动 `src/core/tools/RunTools.ts` + `Integration.requestUserChoice`）

## 对需求基线的影响

无新增 US：这是核心状态机的对等性修复，不新增用户故事。用户可见面的变化是「少了一次假提醒」，落在既有 [US-33 系统托盘与任务提醒](../../docs/features/user-stories.md#us-33-系统托盘与任务提醒) 的验收 2 范围内（该验收描述的是真等待 / 完成时的提醒），沿用它的 e2e 豁免口径。

## 追溯矩阵

| 回归用例 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| RT-1 | `core-rs/src/engine.rs` 的 `request_tool_permission`（不再经 `waiting_request`） | `core-rs/src/engine_tests.rs` | 自动 |
| RT-2 | 同上（`request_user_choice` 保持标记 waiting） | `core-rs/src/engine_tests.rs` | 自动 |
| RT-3 | `src/core/tools/RunTools.ts` 的 `emitToolPermissionRequest`（已不碰 `sessionRuntime`，本次只补用例锁死） | `src/test/toolPermissionWaiting.test.ts` | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
  - **RT-1**（auto 免确认不产生 `waiting`）：`core-rs/src/engine_tests.rs` 的
    `auto_approved_tool_permission_never_marks_the_session_waiting`——修实现前红（`waiting` 快照 1 条，期望 0），
    修后绿；e2e 探针（standalone、主窗口隐藏、`写入文件`）推送序列 `idle → running → idle`，无 `waiting`。
  - **RT-2**（manual 只在真确认框在途为真）：同文件 `manual_tool_permission_marks_waiting_only_while_the_choice_is_pending`
    ——修实现前红（2 条，期望 1），修后绿；e2e 探针为 `idle → running → waiting → running → idle`（只有真确认框那一次）。
  - **RT-3**（Embedded 同口径）：`src/test/toolPermissionWaiting.test.ts` 四条断言全绿；
    反向对照——把 `markSessionWaiting` 临时塞进 `RunTools.emitToolPermissionRequest` 后该用例两条 `waiting` 断言立刻红，
    撤掉后恢复绿。
  - 对等性：`coreKind: embedded` 与 `standalone` 在同一 auto 场景下推送序列一致（均无 `waiting`）。
  - 全量：`npm run test:core` 825 项全过、`npm run test:all` 129 项全过（含 `docs-lint` 43 组）、
    `npm run check-types` 0 错、`npm run lint` 干净。
- 偏差：
  - 反向对照发现 spec 未写的细节：`plain_request` 与 `waiting_request` 共用发送 / 等待 / 超时摘除三段，
    拆成 `send_request` / `await_response` 两个私有方法后两条路径才不重复（实现细节，已按此落地，不改本 spec 的期望与不变量）。
  - 影响基线两行按实际 diff 复核：`docs/core/session-runtime.md` 补的是「`waiting` 只在真的等用户时为真」一段（不是表格行），
    `docs/core/core-parity.md` 补的是「不靠对照表、由两侧行为用例锁定的对等面」表（新增小节而非改既有行）——已按实际落点更正。
- 未做：
  - 无（T001–T005 全勾）。附带说明：`e2e/electron/subagentConcurrency.spec.ts` 的 US-49 用例在本机仍失败
    （6 个子代理都跑起来了，日志可见 `Agent` 权限往返与子会话 `Reply` 成功，卡在「侧栏 30s 内列出 7 项」），
    与本缺陷无关、不在本 spec 范围；刷新 Core 后同样复现，建议单独开缺陷追。
