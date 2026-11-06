---
status: 已收敛
---

# 改动规格：时间线节点「从这里继续」（Rewind）

在消息区时间线左侧的状态点上提供右键菜单，其中一项「从这里继续」把对话**回退到该
节点之前**：删除该节点之后（含该节点所属轮次之后）的全部对话内容，并把此后被改动过的
文件回滚到改动前，让用户可以从中断点换条路重来。当前同类能力只有单次 Edit / Write
的「回滚修改到此」（`UiEvent.editRolledBack`），没有对话级回退。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/architecture/events.md` | 2.3 UiEvent 汇总表 | 新增 | 新增 `conversationRewound`（携带目标节点与其后的文件回滚结果） |
| `docs/architecture/events.md` | 2.1 CoreEvent 汇总表 | 新增 / 修改 | 新增 `conversationRewoundDone`（回退完成，UI 据此整批替换消息并提示）；`toolCall` 载荷补 `messageUuid`（节点身份载体） |
| `docs/hosts/webview-ui.md` | 11. 消息区视图行为 | 修改 | 新增一行：时间线状态点的右键菜单与「从这里继续」的确认口径 |
| `docs/features/user-stories/dialog-core.md` | EP-1 对话核心 | 修改 | 新增 US（从时间线节点回退对话并回滚其后的文件改动） |
| `docs/features/user-stories/messages.md` | US-15 回滚编辑 | 修改 | 补一句：对话级回退复用同一套「修改前内容」备份，不复用单次回滚的入口 |

## 用户场景与验收标准

- 场景 1：从节点继续
  - **AC-1**（FR-001）：GIVEN 会话已跑过若干轮 WHEN 右键时间线上某个节点 THEN 弹出菜单，含唯一一项「从这里继续」
  - **AC-2**（FR-002）：GIVEN 菜单已弹出 WHEN 点「从这里继续」 THEN 先弹确认框，文案说明「删除该节点之后的内容且不可恢复」
  - **AC-3**（FR-002）：GIVEN 确认框已弹出 WHEN 点取消 THEN 不发生变化：消息不删、文件不动
  - **AC-4**（FR-003）：GIVEN 确认框已确认 WHEN 回退完成 THEN 该节点之后的全部消息（含工具调用卡片与工具结果）从消息区消失，磁盘上的会话记录同步截断
  - **AC-5**（FR-004）：GIVEN 节点之后有 Edit / Write 改过文件 WHEN 确认回退 THEN 每个被改过的文件按「该文件在节点之后的第一次 Edit / Write 的修改前内容」恢复；新建的文件被删除
- 场景 2：边界
  - **AC-6**（FR-005）：GIVEN 节点是时间线最末一个节点 WHEN 右键 THEN 菜单项置灰（其后没有可删的内容）
  - **AC-7**（FR-005）：GIVEN 会话正在查询 / 压缩中 WHEN 尝试回退 THEN 菜单项置灰并在确认框内说明「会话忙时不能回退」
  - **AC-8**（FR-006）：GIVEN 节点之后没有文件改动 WHEN 确认回退 THEN 只截断对话，回执说明「没有需要回滚的文件」

## 功能需求

### FR-001：入口与菜单

时间线每个节点（工具调用卡片、assistant 文本、thinking、系统消息）左侧的状态点可右键：
命中该点或该点所在行时弹出菜单，当前只含一项「从这里继续」。菜单沿用 webview 既有的
antd Dropdown 主题（`dropdownMenuTheme`），不走宿主原生菜单——菜单的归属是 webview
自己的状态（`docs/architecture/principles.md` 的「UI 决定表现」）。

菜单项的启用条件：该节点**不是时间线最后一个节点**、且会话不处于压缩中（查询态由 core 裁决，
见 FR-005）。

节点身份优先取 JSONL 行的 `uuid`；工具卡片在实时流式期还没有落盘（core 先发 `toolCall`
后写 JSONL），此时用 `toolCallId`——core 的 `truncate_index` 两种目标都认，且 `toolCallId`
与 JSONL 里 `tool_use.id` 是同一个值。

### FR-002：确认框

点「从这里继续」先弹确认框，明确写出三件事：会删除哪一段（被点节点之后的 N 条消息）、
会回滚哪些文件、操作不可恢复。确认框是 webview 内的居中模态（与
`ApplyDefaultsDialog` 同一形态），确认 / 取消两个按钮，默认焦点在「取消」。

### FR-003：消息截断

确认后 webview 上报 `rewindConversation`（含会话 id 与目标节点 id）。宿主翻译为
`UiEvent.conversationRewound`，core 执行：

- 保留目标节点**及其之前**的全部消息，删除其后的全部记录（含 `tool_result`
  消息、`isMeta` 注入、压缩摘要）；
- 整文件重写会话 JSONL（复用 `history::replace_messages`），清掉内存里对应的消息与
  `persisted_count` / `last_uuid`；
- 完成后发 `CoreEvent.conversationRewoundDone`（含删除条数、回滚文件清单、目标节点 id），
  由宿主整批替换 webview 的消息列表（复用 `messagesReplaced`）——UI 不自己算截断，
  消息顺序的唯一写入点在 core。

目标是 `user` 消息时，该用户消息本身保留（用户想重发/改写同一句）；目标是工具调用卡片
时，保留到含该 `tool_use` 的 assistant 消息为止，并把该批未完成的工具结果一并清掉。

### FR-004：文件回滚

对被删区间里出现过的每个文件，取**该文件在区间内第一次 Edit / Write 的修改前内容**
（`_meta.beforeContent`，缺失时回退到 `tool_result.beforeContent`）写回磁盘：这是复用
`rollback.rs` 已有的备份口径，不新建快照机制。

- `beforeContent` 为 `null`（文件原本不存在）→ 删除该文件；
- 找不到任何备份的文件 → 跳过并在回执里列出（不阻止其余文件的恢复）；
- 目标节点**之前**也改过的文件同样恢复到「区间内第一次改之前」，即回到该节点时刻的状态。

### FR-005：忙与空态

- 会话正在跑查询（`running`）或压缩（`compacting`）时不能回退。**判据比 `session_is_idle`
  窄**：排队中的用户消息与后台任务都不阻止回退——回退只截断**已有**历史，与「还没轮到
  的那条消息」无关。core 侧是权威判据（`Core::session_is_rewind_blocked`），webview 侧
  只挡「正在压缩」这一种一定不能截断的状态；查询态由 core 最终裁决，拒绝时经
  `conversationRewoundDone.error` 回执提示，不静默忽略。
- 目标节点是最后一个节点时菜单项置灰：其后没有可删内容。
- 压缩摘要消息（`isCompactSummary`）不作为目标节点（压缩是整体替换，回退到它之前没有
  可恢复的原始记录）——该节点的菜单项置灰并说明原因。

### FR-006：回执

回退完成后消息区末尾出现一条系统消息（与 `editRolledBack` 的回执同一形态）：说明删除了
多少条消息、恢复了哪些文件、哪些文件因缺备份被跳过。回执不进 LLM 上下文（与单次回滚
回执同一口径）。

回执必须先落盘、再发 `messagesReplaced` 的整批替换——否则下发内容里没有它，用户看不到
这次回退的结果。

## 边界与错误路径

- 目标节点 id 在历史里找不到（并发压缩 / 别的视图已经回退过）：返回错误回执，不动任何
  文件。
- 回滚某个文件时写盘失败（权限 / 目录被删）：其余文件照常恢复，回执逐条列出失败项。
- 会话在确认框打开期间被关闭：上报被 core 丢弃（会话不存在 → 空操作），UI 收到
  `queryEnd` 后照常收敛。
- 回退区间跨越压缩边界：只回退边界之后的部分，边界之前的内容属于已归档历史，不动归档文件。

## 非目标

- 不做「重跑」语义：回退只删除与恢复，不自动重新发起查询（用户自己重新输入）。
- 不做多分支 / 时间线树（多分支并行工作不在本 spec 范围）。
- 不回滚 Bash 命令造成的文件改动（没有 before / after 备份，无法安全复原）——只在回执里
  提示「区间内有 Bash 调用，其文件改动未回滚」。
- 不做持久化的撤销栈（回退本身不可逆，确认框已明示）。

## 对需求基线的影响

新增 US（`docs/features/user-stories/dialog-core.md` 的 EP-1）：从时间线节点回退对话。
e2e 覆盖：`e2e/electron/assistant.spec.ts` 补一条（Edit 改文件 → 右键节点 → 确认 →
该节点之后的消息消失且文件回到改动前）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/MessagesView.tsx` 的时间线节点（右键菜单）；`src/webview/components/` 的确认框 | e2e `e2e/webview/messagePresentation.spec.ts` | 自动 |
| FR-002 | 同上 | 同上 | 自动 |
| FR-003 | `core-rs/src/rewind.rs`；`core-rs/src/history.rs` 的 `replace_messages` | `core-rs/src/rewind_tests.rs`（截断语义、user 节点保留、工具批清理） | 自动 |
| FR-004 | `core-rs/src/rewind.rs`（复用 `rollback.rs` 的备份口径） | `core-rs/src/rewind_tests.rs`（恢复 / 删除新建 / 缺备份跳过） | 自动 |
| FR-005 | `core-rs/src/rewind.rs` 的守卫；webview 的置灰判定 | `core-rs/src/rewind_tests.rs`（忙碌丢弃、末节点拒绝） | 自动 |
| FR-006 | `core-rs/src/rewind.rs` 的回执文本 | `core-rs/src/rewind_tests.rs` | 自动 |

## 待澄清

（无）

## 收敛记录

### 已满足

| 验收标准 | 证据落点 |
| --- | --- |
| AC-1（FR-001）时间线节点右键弹「从这里继续」菜单 | `MessagesView.tsx` 的 `onNodeContextMenu` + `.rewind-node-menu`；e2e US-75 右键工具卡片后菜单出现 |
| AC-2（FR-002）点菜单项先弹确认框并写明三件事 | `components/RewindConfirmDialog.tsx` 的 `rewindDialog.body`（删除 N 条 / 回滚 M 个文件 / 不可恢复）；e2e 断言 `从这里继续？` 可见 |
| AC-3（FR-002）取消后消息与文件都不变 | e2e US-75 取消路径：确认框消失、磁盘仍是 `改过的内容` |
| AC-4（FR-003）确认后该节点之后消息消失、落盘同步截断 | `rewind.rs::truncate_index` + `history::replace_messages`；`rewind_tests.rs` 的 `rewind_restores_files_and_truncates_the_conversation`（落盘只剩 1 条）；e2e 确认路径 |
| AC-5（FR-004）按区间内第一次改之前的备份恢复，新建文件被删除 | `collect_restores` 取最早 before；`rewind_uses_the_earliest_backup_per_file` / `rewind_deletes_files_created_in_the_range` |
| AC-6（FR-005）末节点菜单项置灰 | `MessagesView.tsx` 的 `lastTimelineNodeId`（跨 segment 求最后节点）+ `rewindAvailability(.., isLast, ..)`；`rewindTimeline.test.ts` 的末节点用例 |
| AC-7（FR-005）会话忙时置灰并说明 | `rewindAvailability` 的 `busy` 分支 + core 的 `session_is_rewind_blocked`（窄口径：只有 running / compacting）；`rewind_guard_only_blocks_running_and_compacting` |
| AC-8（FR-006）无文件改动时只截断、回执说明 | `receipt_says_nothing_to_roll_back_when_clean` |
| FR-005 压缩摘要不作为目标 | `MessagesView.tsx` 的 item 带 `isCompactSummary` 并传给 `rewindAvailability` |

### 偏差（已就地修正或补进 spec）

1. **回退守卫的口径比 `session_is_idle` 窄**。spec FR-005 只写「会话非空闲时置灰」，实测 `session_is_idle` 把排队中的用户消息也算忙——那会挡住合法回退（回退只截断已有历史，与还没轮到的那条消息无关）。就地新增 `Core::session_is_rewind_blocked`（只有 `running || compacting` 为真），core 与 webview 两侧同口径；spec FR-005 补一句说明。
2. **UI 侧不按查询态置灰**。调试实测 webview 的查询标志比 core 晚一步复位，用它置灰会把合法回退误挡在门外。UI 侧只挡「正在压缩」，查询态由 core 的 `session_is_rewind_blocked` 最终裁决，拒绝时经 `conversationRewoundDone.error` 回执提示。spec FR-005 的「菜单项置灰」限定为「压缩中 / 末节点 / 压缩摘要 / 非对话节点」，查询态写明由 core 裁决。
3. **节点身份可以是 tool_use id**。FR-001 只写「节点 id 用 JSONL 的 uuid」，但工具卡片在实时流式期还没有 JSONL 行（core 先发 `toolCall` 后落盘），拿不到 uuid。`truncate_index` 因此同时接受 uuid 与 tool_use id 两种目标；webview 对 `toolcall` 角色一律用 `toolCallId`。spec FR-001 补这一条。
4. **回执落盘顺序**。回执必须先于 `messagesReplaced` 落盘，否则整批替换的下发内容里没有它、用户看不到结果。写进 FR-006。
5. **`toolCall` 事件载荷新增 `messageUuid`**。spec 的影响基线只声明了两个新事件，实际还扩了 `toolCall`（`toolUseId` → 加 `messageUuid`）与 `updateToolStatus`（加 `messageUuid: string | null`）。已登记进事件表与 `eventTypes.json`。

### 未做

无。T001 ～ T008 全部完成，`test:core` 1119 passed、`test:unit` 106 通过、e2e 五车道 261 passed。

