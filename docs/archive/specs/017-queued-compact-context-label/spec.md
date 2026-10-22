---
status: 已收敛
---

# 改动规格：排队压缩的上下文用量文本

手动压缩在会话非空闲时登记为「待压缩」，这个排队事实由 core 的
`SessionRuntimeState.pendingCompact` 根事实承载。webview 与 TUI 在待压缩期间把输入区 /
状态栏的上下文用量文本替换为「准备压缩」，实际开始压缩或待压缩被清除时还原为原用量
文本。排队提示不再以 `message`（`once: true`）形式出现在时间线，也不写入 `meta.json`
的 `onceMessage`。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [第 1 节 来源与调用点](../../docs/core/session-runtime.md#1-来源与调用点) | 修改 | 新增 `pendingCompact` 根事实的写入点与生命周期 |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [第 2 节 对外快照](../../docs/core/session-runtime.md#2-对外快照) | 修改 | 快照字段表补 `pendingCompact`，说明它不参与派生 `idle` |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 修改 | `SessionRuntimeState` 的根事实清单补 `pendingCompact` |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [FR-002 手动压缩与延后执行](../../docs/features/compaction.md#fr-002手动压缩与延后执行) | 修改 | 排队提示从 once 消息改为 `pendingCompact` 事实与用量文本表现（待压缩期间不可点击） |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 11 节 消息区视图行为](../../docs/hosts/webview-ui.md#11-消息区视图行为跳到底部发送模式与一次性通知) | 修改 | once 写入点清单移除压缩排队提示 |
| [docs/hosts/tui.md](../../docs/hosts/tui.md) | [第 7.1 节 布局](../../docs/hosts/tui.md#71-布局) | 修改 | 状态栏上下文 tokens 在待压缩期间显示「准备压缩」 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [US-9 上下文用量与手动压缩](../../docs/features/user-stories.md#us-9-上下文用量与手动压缩) | 修改 | 验收标准补排队期间用量文本显示「准备压缩」且不可点击重复请求 |

## 用户场景与验收标准

- 场景 1：会话忙碌时请求压缩
  - **AC-1**（FR-001）：GIVEN 会话非空闲且存在可压缩消息 WHEN UI 发 `compactRequested` THEN core 运行时快照中该会话 `pendingCompact` 为真并推送 `sessionRuntimeChanged`
  - **AC-2**（FR-004）：GIVEN 会话非空闲 WHEN 手动请求压缩 THEN 时间线不出现「压缩已排队」通知，`meta.json` 的 `onceMessage` 不记录该提示
- 场景 2：webview 待压缩表现
  - **AC-3**（FR-002）：GIVEN 当前会话 `pendingCompact` 为真且 `compacting` 为假 WHEN 输入区渲染 THEN 上下文用量文本显示「准备压缩」，进度条仍按实际用量绘制
  - **AC-4**（FR-002）：GIVEN 当前会话 `pendingCompact` 为真且 `compacting` 为假 WHEN 用户点击上下文用量文本 THEN 不发送 `requestCompress`（无重复压缩请求）
  - **AC-5**（FR-002）：GIVEN 当前会话已登记待压缩 WHEN `compacting` 变为真 THEN 用量文本还原为 `used/total (K)`，并进入压缩中动画
  - **AC-6**（FR-002）：GIVEN 当前会话已登记待压缩 WHEN `pendingCompact` 变为假而 `compacting` 仍为假 THEN 用量文本还原为 `used/total (K)`
  - **AC-7**（FR-002）：GIVEN 当前会话没有运行时快照 WHEN 输入区渲染 THEN 不显示「准备压缩」（事实未到达不猜值）
- 场景 3：TUI 待压缩表现
  - **AC-8**（FR-003）：GIVEN TUI 当前会话 `pendingCompact` 为真且 `compacting` 为假 WHEN 状态栏渲染 THEN 上下文 tokens 位置显示「准备压缩」
  - **AC-9**（FR-003）：GIVEN TUI 当前会话已登记待压缩 WHEN `compacting` 变为真 THEN 状态栏还原为上下文 tokens
- 场景 4：空闲请求与不可压缩边界
  - **AC-10**（FR-001）：GIVEN 会话空闲且存在可压缩消息 WHEN 手动请求压缩 THEN 立即进入压缩，`pendingCompact` 不出现真值
  - **AC-11**（FR-001）：GIVEN 不存在可压缩消息 WHEN 手动请求压缩 THEN `pendingCompact` 保持假（不排队、不显示「准备压缩」）

## 功能需求

### FR-001：待压缩根事实

core 的 `SessionRuntimeState` 增加根事实 `pendingCompact`：该会话已登记手动压缩、等待
下一轮对话开始时执行。

- `pendingCompact` 只由 core 写入：登记待压缩时置真；消费该标记（实际压缩前）或立即
  压缩前清除时置假。
- 不参与派生 `idle`：排队不是正在执行的工作，会话空闲时 `pendingCompact` 可以为真。
- 每次取值变化都经 `sessionRuntimeChanged` 推送全量快照，包括「清除但未实际压缩」的
  路径。
- 没有可压缩消息或已在压缩中时，请求被忽略，`pendingCompact` 不置真。

### FR-002：webview 上下文用量文本

webview 当前会话的上下文用量文本按以下规则显示：

- `pendingCompact === true` 且 `compacting === false`：文本显示「准备压缩」；英文为
  `Preparing`（与现有 `used/total (K)` 同宽，不撑开布局）；进度条仍按实际 token 用量
  绘制。文本不可点击：不发送 `requestCompress`，悬停下划线与「点击压缩」提示一并取消。
- 实际开始压缩（`compacting === true`）：文本还原为 `used/total (K)`，压缩中动画与
  既有表现不变。
- 待压缩被清除而压缩未开始（`pendingCompact` 变假）：文本还原为原用量文本。
- 当前会话没有运行时快照：按事实未到达处理，不显示「准备压缩」。

### FR-003：TUI 状态栏

TUI 状态栏的上下文 tokens 位置按同一规则显示：`pendingCompact === true` 且
`compacting === false` 时显示「准备压缩」（英文 `Preparing`），实际开始压缩或待压缩
清除后还原为 tokens 文本。

### FR-004：移除排队 once 通知

手动压缩登记待压缩时不再发送 `message`（`once: true`）通知，也不再写入 `meta.json`
的 `onceMessage`。once 机制本身保留给其它瞬时通知（LLM 失败回显、`*User Interrupted*`、
宿主失联提示）。

## 边界与错误路径

- 已在压缩中再次请求压缩：忽略，`pendingCompact` 不变（不重复置真、不覆盖现有状态）。
- 待压缩期间再次请求压缩：webview 文本不可点击、不发送 `requestCompress`；即使其它入口
  重复发出，core 也按幂等处理，不重复登记、不产生第二条提示。
- 待压缩被消费但压缩因不可压缩而跳过：清除 `pendingCompact` 并推送快照，UI 还原用量
  文本（不残留「准备压缩」）。
- 会话关闭 / 删除：该会话从快照消失，UI 不再显示其「准备压缩」；重新打开的会话按新的
  core 状态显示。
- 没有可压缩消息：不登记待压缩、不显示「准备压缩」。

## 非目标

- 不改变待压缩的执行时机（仍是下一轮对话开始时执行），也不在会话转空闲时立即触发压缩。
- 不改变上下文进度条的颜色、宽度、点击区域与 token 口径。
- 不改变 once 通知机制本身及其它三类 once 写入点。
- TUI 之外的宿主自有侧栏 / 托盘不展示该文本（它们不渲染上下文用量）。

## 对需求基线的影响

修改 US-9（上下文用量与手动压缩）：验收标准补充「会话忙碌时请求压缩，用量文本显示
『准备压缩』，实际开始压缩时还原」；e2e 仍由 `e2e/webview/inputMenu.spec.ts` 覆盖 US-9。
无新增 US。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/engine.rs` 的 `runtime_state_json` / `emit_runtime`；`src/shared/AssistantEventBus.ts` 的 `SessionRuntimeState.pendingCompact`；`core-rs/fixtures/runtimeState.json` | `core-rs/src/compact_engine_tests.rs`（登记 / 消费 / 清除推送）；`core-rs/src/main_tests.rs` 的 `runtime_state_fields_match_parity_fixture` | 自动 |
| FR-002 | `src/webview/InputArea.tsx` 的 `ContextProgressBar`；`src/webview/App.tsx` 传入当前会话 `pendingCompact`；`src/webview/i18n/zh.ts` / `en.ts` | e2e `e2e/webview/inputMenu.spec.ts`（待压缩文本、重复点击不发请求、开始压缩还原） | 自动 |
| FR-003 | `tui-rs/src/store.rs` 的 `RuntimeState`；`tui-rs/src/app.rs` 状态栏 | `tui-rs/src/store_tests.rs` | 自动 |
| FR-004 | `core-rs/src/engine.rs` 的 `request_compact`（移除 `emit_once_notice`） | `core-rs/src/engine_tests.rs` 的 `compact_requested_while_busy_marks_pending_in_runtime_snapshot`（断言不落 once、快照置 `pendingCompact`） | 自动 |

## 待澄清

无。

## 收敛记录

- 已满足：
  - AC-1 / AC-10 / AC-11（FR-001）：`runtime_state_json` 输出 `pendingCompact`，
    `emit_runtime` 从 `PENDING_COMPACT` 投影；`request_compact` 非空闲登记后推送，
    空闲立即压缩前清除，无可压缩内容提前返回不登记。证据：
    `core-rs/src/engine.rs`；`engine_tests.rs` 的
    `compact_requested_while_busy_marks_pending_in_runtime_snapshot`；
    `compact_engine_tests.rs` 的 `manual_compact_is_deferred_while_the_session_is_busy`、
    `manual_compact_is_a_noop_without_compactable_messages`、
    `pending_compact_is_cleared_when_there_is_nothing_to_summarize`；
    `main_tests.rs` 的 `runtime_state_fields_match_parity_fixture`。
  - AC-2（FR-004）：`request_compact` 删除 `emit_once_notice` 调用；上述 engine 用例
    断言无 `message` 事件，`meta.json` 的 `onceMessage` 不再有排队提示的写入路径。
  - AC-3 / AC-4 / AC-5（FR-002）：`App.tsx` 的 `compactPending` 谓词 +
    `InputArea.tsx` 的 `ContextProgressBar` 纯文本分支；e2e
    `inputMenu.spec.ts` 的「US-9 待压缩时用量文本显示准备压缩且不可重复点击」覆盖
    文本替换、无按钮、点击不发 `requestCompress`、`compacting` 后还原 `(K)`。
  - AC-6（FR-002）：`request_compact` / `run_query_loop` 在清除待压缩但
    `compact_and_apply_messages` 返回 false 时补 `emit_runtime`；core 用例断言推送
    `pendingCompact=false`。UI 侧复用同一 `compactPending` 谓词，e2e 的
    `compacting` 还原路径覆盖同一条渲染分支。
  - AC-8 / AC-9（FR-003）：`tui-rs/src/store.rs` 解析 `pendingCompact`；
    `tui-rs/src/app.rs` 状态栏在 `pending_compact && !compacting` 时显示
    `准备压缩` / `Preparing`；`store_tests.rs::runtime_labels_and_dots` 覆盖字段解析
    与 `label()` 仍为 idle。
  - AC-7（FR-002，无快照不显示「准备压缩」）：实现为 `App.tsx` 的
    `state ? state.pendingCompact && !state.compacting : false` 守卫；e2e 环境始终
    存在运行时快照，无独立自动覆盖——理由是纯防御性缺省，且与既有 abort 按钮
    「缺快照按空闲」同源。
- 偏差：无。
- 未做：无。

反向对照（实现 → spec）：从 diff 枚举的行为分支——登记待压缩、重复请求幂等、
空闲立即压缩、无可压缩内容提前返回、待压缩被消费但跳过压缩、`drop_session` 清理、
Core 失联归零、UI 无快照守卫、待压缩期间不渲染按钮——逐条都能回指 FR-001 /
FR-002 / FR-004 的 AC；`bootstrapCore.ts` 的 Core 失联归零是既有「所有运行时来源
一并归零」的延伸，不新增对外行为。追溯矩阵的测试落点逐个打开验证存在且覆盖所称
内容；影响基线六行按实际 diff 复核均已落地（session-runtime 的「来源与调用点」
「对外快照」、events 的「事件词汇表」、compaction FR-002、webview-ui 的
「消息区视图行为」、tui 的「布局」、US-9），没有多出未声明的契约变更。
`npm run docs:freshness` 报告仅提示，不阻塞；`npm run test:all -- docs-lint` 绿。
