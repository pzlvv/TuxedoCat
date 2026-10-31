---
status: 已修
---

# 缺陷：重放路径丢掉 `is_canceled` 的 tool_result，被中止的工具在压缩 / 展开归档后显示成「还在运行」

工具结果重放（`buildReplayMessageData`）是压缩后重建与展开归档的**唯一**转换点。
它建 `toolResultMap` 时跳过 `is_canceled: true` 的 `tool_result`——正确的意图是
「被取消的工具不该产出成功结果」，但跳过之后没有任何东西补上「它已结束」这个事实：
对应的 `tool_use` 在产物里落成 `status: 'running'`。

后果是 UI 侧的连锁反应：卡片时间线把 `running` 当作「工具还没结束」画成旋转的
风扇（`MessagesView` 的 `dotKind`），自动滚动的 scrollHeight 轮询按
`hasRunningTools` 一直空转（`MessagesView` 的 `hasRunningTools`），载入遮罩的
`hasLiveActivity` 也把它当实时内容。被中止的工具明明是过去时，恢复后看起来还在跑。

同一条消息在**另一条**恢复路径（`conversationLoaded` 的 webview 侧还原，
`restoreMessagesFromConversation`）里就是按失败态渲染的——两条路径对同一条历史给出
两种不同的卡片状态。

## 现状

- `buildToolResultMap`（`src/shared/utils/replayMessages.ts`）跳过被取消的结果：

  ```ts
  if (result.type === 'tool_result' && result.tool_use_id && result.is_canceled !== true) {
    map.set(result.tool_use_id, { ... });
  }
  ```

  之后 `buildReplayMessageData` 里 `const result = toolResultMap.get(toolUseId)` 得到
  `undefined`，状态据此落成 `'running'`：

  ```ts
  status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
  ```

- 对照面：`restoreMessagesFromConversation`（`src/webview/hooks/handlers/shared.ts`）
  专门收集被取消的结果并渲染成 `'fail'`：

  ```ts
  if (result.is_canceled === true) {
    if (result.tool_use_id) canceledToolResults.set(result.tool_use_id, result.content || '');
    continue;
  }
  // ...
  const canceledContent = canceledToolResults.get(toolUseId);
  if (canceledContent !== undefined) {
    restoredMessages.push({ ..., status: 'fail' });
    continue;
  }
  ```

- 复现（仓库根，构造一条「tool_use + is_canceled tool_result」的历史）：

  ```
  node /tmp/probe_replay_canceled.cjs
  ```

  实测输出：

  ```
  [
   { "role": "user", "content": "go", "isCompactSummary": false },
   { "role": "toolcall", "content": "", "param": "⚙️ Bash", "toolName": "Bash",
     "toolArgs": { "command": "ls" }, "toolCallId": "toolu_1", "status": "running" }
  ]
  ```

  期望最后一条的 `status` 是 `"fail"`、`content` 是那条取消说明
  （`[Previous session interrupted] Tool "Bash" was canceled before execution.` 这类）。

- 触发面不止「用户中止」：`core-rs/src/compact.rs` 的 `sanitizeToolPairing` 在压缩时
  为保留区里孤立的 `tool_use` 补一条合成的 `is_canceled: true` `tool_result`。
  也就是说**只要做过一次压缩**，被截断的那一端工具就会在重放里变成「运行中」。
  这条落盘形态已被 `core-rs/fixtures/compact.json` 的 replay 段固化
  （用例名「已取消的 tool_result 不产生结果」），两侧行为现在是同构的同一处缺陷。

## 期望

1. **被取消的工具在重放里是失败态**：`is_canceled: true` 的 `tool_result` 让对应
   `tool_use` 落成 `status: 'fail'`，`content` 取那条结果自带的说明文本。
2. **两条恢复路径同口径**：与 `restoreMessagesFromConversation` 的 `'fail'` 一致
   （同一条历史不该因为走的是 `conversationLoaded` 还是 `messagesReplaced` 而不同）。
3. **不产生幽灵卡片**：没有对应 `tool_use` 的取消结果不额外产出 toolcall 项。
4. **未取消的结果语义不变**：正常 `tool_result` 照样按 `exit_code` 落成
   `success` / `fail`；没有结果且没被取消的 `tool_use` 仍是 `running`。

## 不变量

- 落盘格式不变：不新增 / 不改 `tool_result` 的字段，`is_canceled` 的写入方（core 的
  中止路径与 `sanitizeToolPairing`）一个字都不改。
- `messagesReplaced` 的载荷形状不变（`MessageData[]`，字段集不变）。
- `buildToolResultMap` 仍然「同一 `tool_use_id` 后写覆盖先写」（`Map.set` 语义不变）。
- 未被取消的历史重放结果逐字不变。
- `core-rs/fixtures/compact.json` 的 replay 段是与 Rust 侧共用的行为对照表，
  本次修复必须两侧同步（`core-rs/src/replay.rs` 与 fixture 一起改），保持
  `replay_message_data_parity` 与新增的 TS 用例同口径。

## 回归测试

- **RT-1**：`tool_use` + `is_canceled: true` 的 `tool_result` → 重放产物 `status === 'fail'`
  且 `content` 是取消说明（修复前红：`status === 'running'`、`content === ''`）。
  （落点：`src/test/replayMessages.test.ts` 的「被取消的工具」用例组；
  Rust 侧 `core-rs/src/replay_tests.rs` 的对应用例）
- **RT-2**：没有对应 `tool_use` 的取消结果不产出额外 toolcall 项。
- **RT-3**：未被取消的工具结果仍是 `success` / `fail`（按 `exit_code`），
  无结果且无取消的 `tool_use` 仍是 `running`——守护既有语义不回归。
- **RT-4**：`core-rs/fixtures/compact.json` 的 replay 用例「已取消的 tool_result 不产生结果」
  的期望更新为 `status: 'fail'`，`replay_message_data_parity` 与 TS 用例同口径通过。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `node /tmp/probe_replay_canceled.cjs` | 红 | 被取消的工具落成 `"status": "running"`、`"content": ""`；TS 侧断言报 `RT-1：被取消的工具是失败态，不是运行中` |
| 回归用例（修复后） | `npm run test:unit -- replay-messages` | 绿 | 7 通过 / 0 失败 |
| 对等面（修复前） | 把 `core-rs/src/replay.rs` 的行为退回旧口径后 `cargo test replay` | 红 | 3 条失败：`canceled_tool_use_renders_as_failed_not_running`、`tool_result_map_skips_canceled_and_keeps_last`、`replay_message_data_parity`（「已取消的 tool_result 落成失败态与取消说明」） |
| 对等面（修复后） | `npm run test:core -- replay` | 绿 | fixture 与 Rust 同口径；全量 `npm run test:core` 1051 + 1 通过 |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测 1809 条 ok |
| 静态检查 | `npm run check-types` | 绿 | 含 webview / electron 三份配置 |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法 |
