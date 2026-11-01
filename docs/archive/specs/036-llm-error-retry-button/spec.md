---
status: 已收敛
---

# 改动规格：LLM 失败 once 通知的一键重试按钮

LLM 请求失败时时间线末位的 once 通知（`❌ **LLM API Error**`，specs/014 形态）目前
只读，用户只能手动重新输入。本次改动让该通知末尾出现「重试」按钮：点击后 core 以
**既有上下文**直接重跑一轮 LLM 查询——失败轮次的用户消息已落盘、已在上下文里，重试
不追加、不落盘任何新消息（走 `sendMessage` 重发会产生重复节点，不可用）。为此
once 载荷需要能区分「LLM 失败通知」与其他 once（中断 / 压缩排队 / 失联），重试需要
一条新的 `UiEvent`。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2.1 节](../../docs/architecture/events.md#21-coreeventcore--ui单向) | 修改 | `message` 事件载荷列补 `noticeKind` 成员（LLM 失败 once 通知的类别标记，随通知写入 `meta.json` 的 `onceMessage`）；触发点列不变 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2.3 节](../../docs/architecture/events.md#23-uieventui--core单向) | 新增 | 新增 `queryRetryRequested` 行：`retryQuery` wire 消息翻译而来，core 侧消费方 `Core::on_query_retry_requested` |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为) | 修改 | 「一次性通知」行补 LLM 失败通知的重试按钮渲染规则（末尾按钮、点击剥除本视图 once 节点） |
| `docs/features/user-stories/dialog-core.md` | US-73 | 新增 | 新增「LLM 失败一键重试」用户故事，登记进 EP-1（对话核心）分组与 `docs/features/user-stories.md` 的索引及 e2e 用例表 |

## 用户场景与验收标准

- 场景 1：失败通知携带重试按钮
  - **AC-1**（FR-001）：GIVEN 某轮 LLM 请求失败（非用户取消）WHEN 失败回显到达 THEN `message` 事件载荷 `once: true` 且 `noticeKind: 'llmError'`，`meta.json` 的 `onceMessage` 携带同一标记
  - **AC-2**（FR-002）：GIVEN 时间线末位有该失败通知 WHEN 渲染 THEN 通知文本末尾出现「重试」按钮；`*User Interrupted*` / 压缩排队 / 失联等其他 once 通知与常规系统消息不出现按钮
  - **AC-3**（FR-001）：GIVEN 时间线末位有该失败通知 WHEN 重开 / 刷新会话（`onceMessage` 恢复到末位）THEN 恢复的通知末尾仍有「重试」按钮
- 场景 2：点击重试
  - **AC-4**（FR-003）：GIVEN 会话空闲且末位有失败通知 WHEN 点击重试 THEN core 收到 `queryRetryRequested` 并以既有上下文发起一轮查询：`<sid>.jsonl` 与时间线不新增用户消息节点，`queryBegin` / busy 状态 / 流式回复 / 中止等既有轮次信号照常
  - **AC-5**（FR-004）：GIVEN 点击重试 WHEN 视图处理 THEN 本视图的 once 节点立即剥除；本轮再次失败时新 once 替换（至多一条、总在末位），按钮在新通知上照常可用
  - **AC-6**（FR-003）：GIVEN 会话忙碌（查询或压缩进行中）、spin 模式或子代理已收尾 WHEN 重试请求到达 THEN core 丢弃并记日志，不产生任何轮次、不改任何状态
- 场景 3：重试成功收尾
  - **AC-7**（FR-003）：GIVEN 重试发起 WHEN 本轮成功产生流式回复 THEN 通知不复活（`stripOnce` 既有规则），落盘、`messageCount`、对话列表刷新与常规轮次一致

## 功能需求

### FR-001：once 通知携带类别标记

- `CoreEvent.message` 的载荷 `data: MessageData` 新增可选成员 `noticeKind: 'llmError'`：
  LLM 失败回显（`llm_error_message` 的 `emit_once_notice` 调用点）携带；其余 once 通知
  （`*User Interrupted*`、压缩排队、宿主失联提示）与常规消息不带。成员形态与 `once`
  同模式（`MessageData` 的按角色取值子集可选成员袋，specs/014 FR-001 同款；该类型不在
  可选成员冻结范围，联合本体零改动）。
- 标记随通知写入 `meta.json` 的 `onceMessage`（载荷 JSON 整体落盘），恢复场景据此仍能
  渲染按钮；宿主侧 `src/shared/history/Conversation.ts` 的 `onceMessage` 类型、
  `src/host/webviewMessages.ts` 的 `addMessage` 载荷与 webview `Message` 类型同步扩展。
- 失败通知的文案与触发条件不变，只加标记。

### FR-002：失败通知渲染重试按钮

- webview 侧：`once: true` 且 `noticeKind === 'llmError'` 的系统消息，在通知文本末尾
  渲染「重试」按钮；按钮文案走 i18n（zh「重试」/ en「Retry」）。
- 按钮不改变通知的既有形态：info 图标 + 文本、时间线末位、`stripOnce` 规则、
  不可折叠、不进卡片，均维持 [docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)
  现状。

### FR-003：重试请求（新 UiEvent `queryRetryRequested`）

- 新 `UiEvent`：`{ type: 'queryRetryRequested', sessionId }`。UI 侧触发点是 webview 新
  wire 消息 `retryQuery`（由 `WebviewMessageHandler` 翻译成事件，与 `sendMessage` →
  `userMessageSubmitted` 同路）；core 侧消费方是 `Core::on_query_retry_requested`。
- 会话空闲时的行为：以既有上下文直接发起一轮 LLM 查询——重试动作本身不产生任何
  输入消息（不追加用户消息、reminder、Skill 注入，不落盘新输入）；本轮产出的
  assistant 回复照常落盘（与常规轮次一致，见 AC-7）。`queryBegin` / `queryEnd` /
  `sessionRuntimeStates` / 中止 / 流式 / 工具执行全部走既有轮次管线；本轮再次失败时
  沿既有失败路径发新 once（替换旧通知）。
- 会话忙碌（`queryRunning` / `compacting` 任一为真）、spin 模式、子代理已收尾
  （`on_user_message` 的同名守卫口径）时丢弃并记日志——幂等忽略，与
  `bashBackgroundRequested` 无匹配前台执行时同口径。按钮可见时会话必为空闲（once 在
  轮次收尾才出现、任何新节点追加即剥除），丢弃只兜多视图与提交时序的竞态。

### FR-004：点击后的本地反馈

- 点击重试后，本视图立即剥除该 once 节点（UI 本地决定表现，不等 core 回声）；随后的
  反馈由既有信号接管（thinking 动画 / 流式节点 / 再次失败的新 once）。
- 节点剥除后按钮随之消失，不存在重试期间的二次点击入口。

## 边界与错误路径

- 重试轮次失败：新 once 替换旧通知（specs/014 AC-7），按钮在新通知上照常可用；连续
  失败不堆积通知。
- 忙碌 / spin / 已收尾子代理时的重试请求：core 丢弃并记日志，不抛错——这是设计允许的
  竞态兜底，不是静默降级（按钮在正常时序下不可见）。
- 通知到达时视图正被销毁 / 会话已切换：沿 `addMessage` 既有会话过滤丢弃，无额外处理。
- 失联提示（宿主侧 `markConnectionSessionsFailed`，只当次显示不记 meta）不带
  `noticeKind`，Core 不可写时重试也无从谈起，天然无按钮。
- TUI 等其他宿主收到带 `noticeKind` 的消息按常规 once 通知渲染（增量成员向后兼容），
  按钮接入不在本次范围。

## 非目标

- 不做「编辑后重发」/「重新发送上一条用户消息」：用户消息已落盘，重发会产生重复
  节点；若日后需要带编辑的重发，另开 spec。
- 不改变失败通知的文案、触发条件与 once 语义（不落盘、末位、后继即删）。
- 不新增独立 CoreEvent / CoreRequest / 面板：重试走 UiEvent 单向，与 `compactRequested`
  同形态。
- TUI / PyCharm 宿主的按钮 UI 接入不在本次范围（契约增量对它们向后兼容）。

## 对需求基线的影响

- 新增 **US-73 LLM 失败一键重试**（归 EP-1 对话核心）：作为用户，当 LLM 请求失败时，
  我希望在失败通知上直接点「重试」重跑本轮，以便不用重新输入消息。验收标准回指
  AC-1～AC-7；登记进 `docs/features/user-stories.md` 索引与 e2e 用例表
  （`e2e/webview/messagePresentation.spec.ts`，与既有 once 用例同文件）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/engine.rs`（`emit_once_notice` 调用点与 `meta.json` 落盘）、`src/shared/history/Conversation.ts`、`src/host/webviewMessages.ts`、`src/shared/types.ts`（`MessageData`） | `core-rs/src/engine_tests.rs`（失败回显载荷带标记 + `onceMessage` 持久化）、`src/test/docsLint.test.ts`（事件表载荷列） | 自动 |
| FR-002 | `src/webview/MessagesView.tsx`（`SystemMessage`）、`src/webview/i18n/`（zh / en） | `e2e/webview/messagePresentation.spec.ts`（按钮渲染 / 非 LLM 失败通知无按钮） | 自动 |
| FR-003 | `src/host/webviewMessages.ts`（`retryQuery` wire + 翻译）、`src/shared/AssistantEventBus.ts`（UiEvent 联合）、`core-rs/src/engine.rs`（`on_query_retry_requested` + 轮次消费） | `core-rs/src/engine_tests.rs`（空闲重试开轮不落盘 / 忙碌丢弃）、`e2e/webview/messagePresentation.spec.ts`（点击 → 新回复） | 自动 |
| FR-004 | `src/webview/MessagesView.tsx`（点击剥除） | `e2e/webview/messagePresentation.spec.ts`（点击后通知消失） | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
  - AC-1**（FR-001）：`engine_tests.rs` 的
    `run_consumer_reports_turn_failures_as_system_messages` 扩断言——事件载荷与
    `meta.json` 的 `onceMessage` 均带 `noticeKind: "llmError"`（同源，整份 JSON 落盘）。
  - AC-2 / AC-5（按钮出现 / 无 noticeKind 无按钮 / 点击剥除 / 再败替换）**（FR-002 /
    FR-004）：e2e `messagePresentation.spec.ts` 的 US-73 用例——失败通知按钮可见 →
    无 noticeKind 的 `*User Interrupted*` 按钮不渲染（替换口径顺带锁定）→ 新失败通知
    按钮恢复 → 点击后节点剥除（`failNode` count 0）+ `waitForSent('retryQuery')`。
    core 侧「再败新 once 替换」由 `query_retry_failure_replaces_the_previous_once_notice`
    锁定（`onceMessage` 整体覆盖 + `noticeKind` 在位）。
  - AC-3**（FR-001）：同 e2e 用例尾段——`onceMessage` 带 `noticeKind` 的会话重开后
    按钮照常渲染（`toUiMessage` 与 `onceMessage` 恢复两处透传，shared.ts）。
  - AC-4**（FR-003）：`query_retry_requested_reruns_query_without_persisting_new_messages`
    ——FakeLlm 恰收到一次请求、用户消息零新增（失败轮次那条仍是唯一 user）、
    assistant 回复照常落盘（AC-7 口径）、`running` 归 false、`wait_query_end` 走
    queryBegin→queryEnd 全对。
  - AC-6**（FR-003）：`query_retry_requested_is_dropped_while_busy`——running 时不登记
    槽位、不拉消费循环（观察窗无 `queryBegin`）。spin / 已收尾子代理守卫无专门用例：
    守卫代码与 `on_user_message` 同名分支逐字同款（该两守卫的存量测试覆盖同一语义），
    记已满足（同路覆盖）。
  - AC-7**（FR-003）：成功轮 core 不发失败回显（`emit_once_notice` 只在 `run_turn`
    返回 Err 时调用），流式节点追加走 `stripOnce` 既有规则；落盘一致性由 AC-4 用例
    断言（assistant 照常落盘）。
- 偏差：无。（实施中两处 spec 文字修订已留痕：FR-003 的「不落盘任何新消息」收紧为
  「不追加、不落盘任何**输入**消息，本轮 assistant 回复照常落盘」——首轮测试把
  断言写宽后修正了判据口径；AC-4 表述同步。）
- 未做：无。

反向对照（实现 → spec）：`flush_queued_messages` 对 `QueuedBatch::Retry` 的空臂是
match 穷尽性防御（重试槽位只在空闲受理、轮次内必空，注释已写明不可达理由），非行为
分支；busy 丢弃走 `self.log` 记日志（FR-003 已声明）；`events.md` 2.1 旧行「压缩排队
提示带 once 标记」与代码不一致（压缩排队早已改走运行时快照 `pendingCompact`，无 once
发射点）——按「文档与代码不一致先修使一致」顺手修正该格，属文档纠偏非行为变更，
`compact_requested_while_busy_marks_pending_in_runtime_snapshot` 既有测试锁定。
追溯矩阵测试落点逐个打开验证存在；影响基线各行（events.md 2.1 载荷列 / 2.3 新行、
[webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)、US-73 + 索引 + 附录 + e2e 表、
host-ui-modules 消息类型数 44→45）
按实际 diff 复核均已落地；`core-rs/fixtures/eventTypes.json` 的 `uiEvents` 登记
`queryRetryRequested`（Rust 侧双向锁定绿）。

闸门证据：`cargo test` 全量 1051 绿；`npm run build:core:host` 后 `npm run test:all`
238 通过——5 个失败（todoProgress:282、fileExplorer:354、preview 3 项）经 `git stash`
基线复跑逐一证实为 main 存量失败（`data:text/html` 预览窗口环境类），与本次改动无关；
`check-types` / `lint` / docs-lint（49+6）全绿；e2e messagePresentation 8/8 绿。
