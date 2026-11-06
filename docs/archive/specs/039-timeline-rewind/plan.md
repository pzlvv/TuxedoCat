# 实施方案：时间线节点「从这里继续」（Rewind）

技术路线：webview 只负责入口（右键菜单 + 确认框）与上报目标节点 id；截断、文件回滚与
回执全部在 core 的 `rewind.rs` 里做，结果经 `messagesReplaced` 整批替换回 webview。节点
身份用会话 JSONL 里已有的 `uuid`（`src/shared/types.ts` 的 `MessageData.messageUuid`
已经能透传到 webview），不新增持久化字段、不新建快照机制——文件备份复用
`rollback.rs` 的 `beforeContent` 口径。需求口径见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 节点身份（先解决的前提）

时间线节点现在没有稳定 id：`MessagesView.tsx` 的 `timelineItems` 用
`message.toolCallId || msg-<segment>-<index>` 当 key，后者是渲染期临时值，Core 不认识。
方案：**给 `MessageData` 的每条展示消息带 `messageUuid`**（字段已存在，当前只有用户消息
在用）。改动点三处，都不新增字段：

- `core-rs/src/replay.rs::build_replay_message_data`：每个 `out.push(json!{..})` 补
  `"messageUuid": message.get("uuid")`（`None` 时留 `Value::Null`，`system` / `assistant` /
  `toolcall` 三类都要带）。
- `core-rs/src/engine.rs` 的实时 `message` / `messagesReplaced` 事件：`persist_message`
  已拿到 `append_message` 返回的 `uuid`，把它塞进事件的 `data.messageUuid`（用户消息的
  路径 `notify_user_message` 已经在写，补其余角色）。
- `src/webview/types.ts` 的 `Message` 已有 `uuid?`（排队项用）；这里**不复用**它——给
  `Message` 增加 `messageUuid?: string`，`MessagesView` 的 `timelineItems` 用
  `message.messageUuid ?? message.toolCallId ?? fallback` 作 key 并把 `nodeId` 一起放进
  item，供右键菜单读出。`once` 通知（`once: true`）没有 JSONL 行，`messageUuid` 为空，
  右键菜单对它整体置灰（它本来也不是可回退的对话节点）。

这条前置在实施时单独一个提交（`Flow: L2`，纯载体补齐、行为不变），再叠 rewind。

### 2. 消息截断（`core-rs/src/rewind.rs`，新增）

```rust
pub struct RewindOutcome {
    pub removed: usize,             // 删除的 JSONL 行数
    pub target: String,             // 目标节点 uuid
    pub files: Vec<RewindFile>,     // 回滚结果
    pub skipped: Vec<RewindFile>,   // 无备份而跳过
}

pub fn rewind(session_id: &str, target_uuid: &str) -> Result<RewindOutcome, String>;
```

流程：

1. `config::project_root(session_id)` + `history::load_messages` 拿全量消息（与
   `rollback.rs` 同一入口）。
2. 在 `messages` 里按 `uuid` 定位目标下标。找不到 → `Err("target node not found; the history may have been compacted")`，不动任何文件（spec 边界第 1 条）。
3. 截断点规则（spec FR-003）：
   - 目标是 `user` 消息 → **保留**该条，截断点 = 下标 + 1；
   - 目标是 `assistant` 或 `toolcall`（`tool_use` 来自 assistant 消息）→ 保留到该
     assistant 消息（含），截断点 = 该 assistant 下标 + 1，紧随其后的 `user` 消息里的
     `tool_result` 一并删除；
   - 目标是 `system` / `thinking` → 截断点 = 下标（不含该条：它是产出物，不是「继续
     之后」的起点）。三条规则集中在纯函数 `truncate_index(messages, target) -> usize`，
     单测直接驱动。
4. 对 `messages[cut..]` 里出现过的 `Edit` / `Write` tool_use：按 `tool_use_id` 索引
   `_meta.beforeContent`（缺失时回退 `tool_result.beforeContent`），**按路径取区间内第一次
   出现的那次**。多个 tool_use 改同一文件时只用最早的 before（spec FR-004 第 3 条）。
5. `history::replace_messages(session_id, project, &messages[..cut])` 整文件重写。
6. 内存侧：`state.messages.truncate(cut)`；`state.persisted_count = cut`；
   `state.last_uuid = messages[..cut].last().and_then(|m| m["uuid"].as_str())`——三个字段
   同一次锁内更新，避免下一轮请求拿旧 `last_uuid` 追加到已删分支（与 `replace_messages`
   之后的既有权衡同款）。
7. 文件回滚：`rollback.rs` 现在只有「按单个 tool_use 回滚」的入口。新增 pub(crate)
   `rollback::restore_before(project, path, before: Option<&str>) -> Result<(), String>`
   ——`Some` 写回、`None`（原本不存在）删除。`rollback_inner` 改调它，行为零变化
   （一次小重构，单测已有覆盖）。
8. 返回 `RewindOutcome`，由调用方组 `conversationRewoundDone`。

文件回滚的逐文件失败不中断其余文件（spec 边界第 2 条）：收集 `Vec<RewindFile{path, error}>`
进事件；`skipped` 是「区间内没有 beforeContent」的那批。

### 3. 契约与事件

两侧各加一个成员（[docs/architecture/events.md 第 2.1 节](../../docs/architecture/events.md#21-coreeventcore--ui单向) / [第 2.3 节](../../docs/architecture/events.md#23-uieventui--core单向)各一行）：

| 方向 | 成员 | 载荷 |
| --- | --- | --- |
| UiEvent | `conversationRewound` | `sessionId`, `targetUuid` |
| CoreEvent | `conversationRewoundDone` | `sessionId`, `targetUuid`, `removed`, `files: Array<{path, ok, error}>`, `skipped: string[]`, `hadBash: boolean` |

- webview → 宿主：新增协议消息 `rewindConversation`（`{ sessionId, targetUuid }`），在
  `WebviewMessageHandler` 里翻译成 `UiEvent.conversationRewound`（与 `rollbackEdit` 同一张
  表）。
- Core 处理：`main.rs` 的 `"conversationRewound"` 分支调 `rewind::rewind`，成功则先回执
  事件、再 `replay::replay_messages_to_ui` 走既有的 `messagesReplaced`（**复用整批替换**，
  UI 不自己算截断，spec FR-003 第 3 条）。
- 忙守卫：`rewind` 调 `core.session_is_idle(session_id)`（已有），非空闲直接
  `Err("session is busy")`，宿主把它转成 `notice`（不是静默忽略，spec FR-005）。
- 回执文本（spec FR-006）：截断后**追加**一条 `role: "system"` 的展示消息，内容由
  `rewind.rs` 生成（删除条数 / 恢复了哪些 / 哪些因缺备份跳过 / 区间内有 Bash 调用时补一句
  「其文件改动未回滚」）。它进 JSONL（作为 system 消息）但不进 LLM 上下文——与
  `editRolledBack` 的回执同一口径（`replay.rs` 已跳过 `subtype: compact_boundary`，这里
  复用 `once` 之外的既有 system 展示规则；实施时确认 system 消息是否被 `build_raw_api_messages`
  过滤，若未过滤则在 `rewind.rs` 落盘时带 `_meta.excludeFromContext: true` 并在该处补一条
  过滤）。

### 4. webview 入口

- `MessagesView.tsx` 的 `msg-timeline-item` 上挂 `onContextMenu`：命中状态点或该行即
  `preventDefault` + 弹 `Dropdown`（复用 `components/dropdownMenuTheme.ts`，与既有菜单同主题）。
- 菜单项「从这里继续」的禁用条件在 `useMemo` 里算一次（不是渲染期临时值）：
  - 该节点是最后一个节点（`index === items.length - 1`）；
  - `sessionRuntime` 非 idle（`running || compacting`）；
  - 节点是压缩摘要（`message.isCompactSummary`）或 `once` 通知（无 `messageUuid`）；
  - 父节点不可见（`onContextMenu` 不传 `disabled` 时由菜单自己读）。
- 禁用项的 `title` 写原因（末节点 / 会话忙 / 压缩摘要不可回退），点击不发消息。
- 确认框新建 `components/RewindConfirmDialog.tsx`，形状照 `ApplyDefaultsDialog`
  （fixed 遮罩 + 居中卡片 + 确认 / 取消），默认焦点在「取消」（`autoFocus` + `onKeyDown`
  处理 Enter / Esc）。文案由 webview i18n 提供，三件事：删除该节点之后的 N 条消息、会回滚
  的文件数、不可恢复。
- 收到 `conversationRewoundDone`：走既有 `messagesReplaced` 通道（Core 已经发了整批替换），
  webview 只做两件事——关确认框、必要时把 `rewindDone` 的 notice 文案弹一次（失败态）。

### 5. 测试落点

- `core-rs/src/rewind_tests.rs`（新增）：`truncate_index` 三种目标类型、找不到目标、
  `beforeContent` 缺失跳过、`null` 删文件、区间内先改后改取最早、忙守卫、Bash 区间标记
  （AC-1 ～ AC-8 的 core 侧判定层）。
- `src/test/rewindTimeline.test.ts`（新增纯函数）：菜单项禁用条件矩阵（末节点 / 忙 /
  压缩摘要 / 无 uuid），组件只渲染结果。
- `e2e/electron/assistant.spec.ts`：Edit 改文件 → 右键节点 → 确认 → 该节点之后的消息
  消失且文件回到改动前（AC-1 / AC-3 / AC-4 的端到端）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/rewind.rs` / `rewind_tests.rs` | 新增 | 无（模块内） |
| `core-rs/src/main.rs` | `mod rewind;` + `conversationRewound` 分支 | `UiEvent.conversationRewound` 消费 |
| `core-rs/src/rollback.rs` | 抽 `restore_before` pub(crate) | 无（行为等价） |
| `core-rs/src/replay.rs` | 展示消息补 `messageUuid` | `MessageData.messageUuid` 覆盖面扩大 |
| `core-rs/src/engine.rs` | 实时消息补 `messageUuid`；`conversationRewoundDone` 发出 | 新增 CoreEvent 成员 |
| `src/shared/AssistantEventBus.ts` | `conversationRewound` / `conversationRewoundDone` 两个联合成员 | 新增 2 个成员 |
| `src/host/ui/webviewMessageHandler.ts` | `rewindConversation` 翻译 | 新协议消息 |
| `src/host/WebViewUI.ts` | `conversationRewoundDone` 处理 | 传给 webview |
| `src/webview/MessagesView.tsx` | 右键菜单 + 节点 id | 无 |
| `src/webview/components/RewindConfirmDialog.tsx` | 新增 | 无 |
| `src/webview/types.ts` | `Message.messageUuid` | 无 |
| `src/webview/i18n/{zh,en}.ts` | 菜单 / 确认框 / 回执键 | 用户可见文本 |
| `docs/architecture/events.md` | 2.1 / 2.3 各一行 | 事件表 |
| [docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为) | 新增一行（状态点右键菜单口径） | 无 |
| `docs/features/user-stories/dialog-core.md` / `messages.md` | 新增 US + US-15 补一句 | 需求基线 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md` 第 1 节）：截断与文件回滚全在 `core-rs/`（消息顺序的唯一
      写入点在 core）；webview 只做菜单 / 确认框（UI 决定表现）；宿主只做协议翻译。
- [x] 架构铁律（`AGENTS.md` 第 4 节）：不过度 fallback——目标找不到 / 会话忙都是显式错误
      回执，不静默忽略、不猜目标；契约成员全必选（新事件字段全填，`error` 用 `null` 不用
      缺省）；一份事实一个写入点（截断在 `rewind.rs`，UI 不自己算；文件恢复的唯一实现是
      `rollback::restore_before`）；默认值单源（无新默认值）。
- [x] Core 行为与落盘格式同步义务（`AGENTS.md` 第 5 节）：落盘仍是既有 JSONL 形态
      （`history::replace_messages`），不新增字段；`src/shared/history/` 无需同步。新增的
      `messageUuid` 是 wire 载荷，不是落盘格式。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`events.md` 两张表、[webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)、
      两条 US 与代码同一提交；spec 收敛时 delta 并入 `docs/features/`。

## 被否决的替代方案

1. **webview 自己截断消息数组**：消息顺序与落盘顺序会出现两份事实，压缩 / 重开就会分叉
   （[架构原则第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)）。否决，截断只在 core。
2. **新建 rewind 快照（每轮存整目录）**：磁盘成本高、与既有 `beforeContent` 备份重复，
   还会引入「快照与 JSONL 不同步」的第二类故障。spec FR-004 明确复用 `rollback.rs`。否决。
3. **用渲染期 key（`msg-<segment>-<index>`）当目标 id**：压缩 / 展开归档后下标漂移，
   回退会打错节点。否决，先补 `messageUuid` 载体。
4. **回退顺带重跑最后一条用户消息**：spec 非目标明确「只删除与恢复」，重跑由用户自己
   决定；自动重跑还会在文件已回滚的情况下让模型看到不一致的世界。否决。
5. **回滚 Bash 造成的文件改动**：没有 before / after 备份，无法安全复原。spec 非目标，
   只在回执里提示。否决。
6. **持久化撤销栈（可再次前进）**：回退本身不可逆是明示决策（确认框已写）。否决。
