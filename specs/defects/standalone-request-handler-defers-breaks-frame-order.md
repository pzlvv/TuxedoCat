---
status: 已修
---

# 缺陷：帧通道把 request 处理器推迟到微任务——同 chunk 内后续 event 帧先派发，工具卡片失去 thinking

Standalone Core 的帧通道里，`CoreRequest` 帧的处理器不是随帧同步启动，而是被排进微任务；
于是同一个输出 chunk 里紧随其后的 `CoreEvent` 帧（`toolCall` / `toolResult`）先被派发。
对话里表现为：工具卡片显示**已完成**，但 thinking 动画已经熄灭——工具批次收尾到下一轮
`aiBegin` 之间的那段窗口（落盘 / 刷新列表 / 组装提示词）没有任何进行中指示。

## 现状

- `src/host/standalone/StandaloneEventBus.ts` 的 `handleCoreRequest` 用
  `Promise.resolve().then(() => handler(request))` 调用处理器。这个包装的初衷是「同步抛错也走
  reject 分支回 `ok:false`」，但它同时把处理器的**同步段**整体推到微任务。
- `FrameDecoder.push`（`src/host/standalone/protocol.ts`）在同一个 stdout chunk 内同步逐行派发；
  本进程微任务要等这次同步派发全部结束才执行。因此同 chunk 里 `request` 之后的 `event` 帧
  先到达宿主，`request` 的处理器最后才启动。
- 微任务只排一次，但方向是反的：实际观测顺序是 `toolCall` → `toolResult` → `toolPermissionRequested`，
  与 core 的写入顺序（`toolCall` → `toolPermissionRequested` → `toolCall` → `toolResult`，
  见 `core-rs/src/engine.rs` 的 `resolve_permission`）相反。
- 用户可见的后果链（Standalone Core，含经 daemon 的远程工作区；两条路径共用
  `createCoreChannelBus`，`CoreDaemon.handleFrame` 同样同步转发）：
  1. `CoreEvent.toolCall` → `WebViewUI.onToolCall` → `markToolPhase` + 投 `updateToolStatus: running`；
     此刻 webview 里还没有卡片，状态更新落进 `bufferedToolStatusRef`。
  2. `CoreEvent.toolResult` → `WebViewUI.onToolResult` → `SessionUiState.endToolPhase`（工具计数仍为 0，
     属重复结束，直接返回）→ 查询仍活跃，于是发 `showThinkingAnimation: true`。
  3. 微任务里的 `CoreRequest.toolPermissionRequested` → `WebViewUI.requestToolPermission`
     → `SessionUiState.beginToolPhase` + `ToolHandler.requestToolPermission` 投 `addMessage`
     （`role: 'toolcall'`，`status: 'normal'`）。
  4. webview 收到这张卡片时 `shouldKeepThinkingForToolCard('Bash', 'normal')` 为假
     （`normal` 算「进行中」）→ 关 thinking；`flushBufferedToolStatus` 立刻把卡片的 buffered
     `success` 应用上去，卡片直接显示完成。
  最终形态：卡片已完成、thinking 熄灭、后续还有一整段无指示的窗口——即用户报告的现象。
- 与 as-built 冲突两处：
  [`docs/core/standalone-core.md` 第 5.2 节](../../docs/core/standalone-core.md#52-帧类型)写「帧按写入
  顺序处理；`request` 的应答顺序不受此约束」——被推迟的是**应答**之外的处理本身；
  [orphan-stalls-on-permission-roundtrip](orphan-stalls-on-permission-roundtrip.md) 的不变量写
  「宿主在线时工具卡片的上架时序不回退：帧通道有序，request 先于后续 `toolCall` 事件被宿主处理」。
- 复现路径：任何走 Standalone Core 且触发工具调用的对话。`toolPermissionRequested` 与其后的
  `toolCall` / `toolResult` 载荷都很小，实际总落在同一个 chunk 里，因此这条顺序错位是常态而非偶发。

## 期望

- `request` 帧的处理器在帧派发中**同步启动**：处理器的同步段（上架卡片、进入工具阶段）先于
  同一 chunk 内后续帧的派发；handler 返回的 Promise 决定的 `response` 帧仍异步回写。
- 顺序在 `request` 位于两个 `event` 之间时同样成立：`event` → `request` 的同步段 → `event`。
- 处理器同步抛错时仍回 `ok:false` 的 `response` 帧，异常不冒泡到 `FrameDecoder`
  （现行为保持，不能被「同步启动」改坏）。

## 不变量

- `response` 帧的 `id` 回带、异步回写与连接世代校验（`connectionEpoch` 不一致即丢弃）不变。
- handler 的返回值 / 拒绝值决定 `ok` 与 `result` / `error`，处理器表与载荷契约面零变化。
- 未注册 `CoreRequest` 处理器、或缺某个 `type` 的处理器时回 `ok:false` 的行为不变。
- 单方向帧顺序与背压不丢帧的既有保证不变（`standaloneBus.test.ts` 的突发帧用例）。
- `toolPermissionRequested` 仍是「发后不等」的展示同步请求，core 不以应答为执行前置。

## 回归测试

- **RT-1**：同一次同步派发内送入 `request`（`toolPermissionRequested`）→ `event`（`toolCall`）
  → `event`（`toolResult`），断言观测顺序是 `toolPermissionRequested` → `toolCall` → `toolResult`，
  且 `response` 帧仍按原 `id` 回 `ok:true`（落点：`src/test/standaloneBus.test.ts`
  用例「同 chunk 内 request 帧的处理器同步启动，先于后续 event 帧派发」）。
- **RT-2**：`event` → `request` → `event` 的三帧组里，`request` 的同步段仍夹在两个事件之间，
  不被挪到最前或最后（落点：同文件用例「event → request → event 的时序不重排」）。
- **RT-3**：处理器同步抛错时 `response` 回 `ok:false` 且消息带异常文本，异常不冒泡到帧派发，
  同 chunk 里后续的 `event` 帧照常派发（对应「期望」第三条；落点：同文件用例
  「处理器同步抛错仍回 ok:false，且异常不冒泡到帧派发」/「处理器抛错后同 chunk 的后续 event 帧照常派发」）。
  修复段补入：同步启动把 `try` 的位置从 promise 链挪到了帧派发路径，异常路径必须同批锁住。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- standalone-bus` | 红 | 60 通过 / 2 失败。RT-1 实际顺序 `toolCall:call_1 → toolResult:call_1`（`toolPermissionRequested` 的同步段整段落到了断言之后）；RT-2 实际顺序 `toolCall:call_2 → toolResult:call_2`。同一用例里「应答仍按原 id 异步回写（ok:true）」已绿——说明只错在处理器的启动时机，应答链路正常 |
| 回归用例（修复后） | `npm run test:unit -- standalone-bus` | 绿 | 64 通过 / 0 失败。RT-1 顺序转为 `toolPermissionRequested:call_1 → toolCall:call_1 → toolResult:call_1`；RT-2 为 `toolCall:call_2 → toolPermissionRequested:call_2 → toolResult:call_2`；RT-3 两条断言（异常不冒泡 / 后续 event 照常派发）通过 |
| 既有回归 | `npm run test:unit` | 绿 | 135 通过 / 0 失败 / 2 跳过（`sidebarFiles`、`sidebarDocViewGit` 为环境前置 skip，与本改动无关） |
| 类型与静态检查 | `npm run check-types` + `npm run lint` | 绿 | exit 0 |
| docsLint | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格结构 / 章节 / 结果取值通过（49 通过 / 0 失败），改文档后复跑仍绿 |

备注：修复段在「回归测试」节补了 RT-3（同步抛错路径）。同步启动把 `try` 的位置从 promise 链
挪到了帧派发路径上，异常分支的观测口径随之改变，属于同一缺陷的验收面，故与 RT-1 / RT-2 同批锁住；
「现状 / 期望」两节未改。文档同步：[docs/core/standalone-core.md 第 5.2 节](../../docs/core/standalone-core.md#52-帧类型)
把「帧按写入顺序处理，但 `request` 的应答顺序不受此约束」改写成「处理器的同步段随帧派发、
只有应答顺序不受约束」——原表述与 as-built 的应有行为冲突，是本缺陷的规格侧落点。
