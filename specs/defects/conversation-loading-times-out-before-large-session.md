---
status: 已修
---

# 缺陷：会话加载态带固定兜底超时，大对话在数据到达前先露出新对话空态

打开一个大对话时，消息区先显示一段时间「新对话空态」（占位 logo + 工作视图勾选框），
要等数据真正到达后才渲染出内容。用户看到的是「加载动画消失了但什么都没有」，而不是
「一直在加载」。

## 现状

- 进 loading 时消息已被清空：`App.tsx` 的 `navigateToSession()` 先
  `beginConversationLoad(sessionId)` 再 `setMessages([])`，页面的消息区因此是空列表。
- 加载态带**固定兜底超时** `CONVERSATION_LOAD_TIMEOUT_MS = 15_000`
  （`src/webview/hooks/useConversationLoading.ts`）：到点就把 `pendingSessionId` 置空，
  与「数据是否到达」无关。
- 超时到点后的可见结果：`isLoadingConversation` 变 false → 遮罩卸载；
  `messages.length === 0` → `MessagesView` 的 `isEmpty` 分支成立 → 渲染新对话空态的
  占位 logo 与 `showWorkViewOption` 勾选框，直到 `conversationLoaded` 到达才换成消息。
- 读盘耗时没有上界（会话大小 / 链路带宽），实测同一台远端工作区上的两个会话：

  ```
  03:57:50.959  conversation loaded from disk: messages=390   readMs=47
  03:58:48.652  conversation loaded from disk: messages=2068  readMs=24863
  ```

  2068 条消息的会话读盘 24.9s，正好落在「15s 超时之后、数据到达之前」的窗口里——
  这就是用户看到的空态时长。
- 与规格冲突：hook 自身的注释与
  [docs/hosts/host-info.md 第 3.1 节](../../docs/hosts/host-info.md#31-会话跳转的唯一入口)
  都把应有的结束条件写成「收到该会话的 conversationLoaded」，现状多了一个「等太久就
  放弃」的出口。

## 期望

1. **加载态只有一个结束条件**：本视图等待的那个会话的 `conversationLoaded` 到达。
   不存在「等太久就放弃」的出口，因此读盘再久也不会露出新对话空态。
2. **完成判据按会话严格匹配**：迟到的旧会话数据不得结束新会话的加载
   （否则同一症状会从「快速连点两个对话」这个入口复现）。
3. **没有待加载会话时（新对话 / 已加载完成）不进加载态**，空值只有 `null` 一种表示。
4. **结束判据只有一份实现**：判据是纯函数（`src/webview/conversationLoadingState.ts`），
   hook 只做状态组装、组件只渲染结果。

## 不变量

- 会话跳转的唯一 UI 入口仍是 `App.tsx.navigateToSession()`；`begin` / `finish` / `reset`
  的调用点与调用时机不变。
- loading 遮罩的淡出机制不变：conversationLoaded 关闭 `isLoadingConversation` 后，
  `MessagesView` 仍按 `scrollHeight` 稳定轮询保留遮罩再淡出。
- Electron 多视图（`openConversation`）下本视图不进入 loading 的既有分工不变。
- 消息清空时机、排队横幅清理、强制回底（`forceScrollKey`）等切换前动作不变。
- 不新增 wire 消息类型、不动 `HostToWebviewMessage` 判别联合。

## 回归测试

- **RT-1**：进入加载后，无论等多久（超过任何固定超时）加载态都保持；
  只有该会话的 `conversationLoaded` 到达才结束。
  （落点：`src/test/conversationLoading.test.ts` 的
  `RT-1 等待期间（含超过任何固定超时）加载态保持，不会自行放弃` /
  `RT-1 该会话的 conversationLoaded 到达才结束加载`）
- **RT-2**：其它会话的 `conversationLoaded` 不结束当前加载；没有在等任何会话时保持 null。
  （落点：同文件的 `RT-2 其它会话的数据不结束当前加载` / `RT-2 没有在等任何会话时保持 null`）
- **RT-3**：空 sessionId（`undefined` / `''`）归一成「没有待加载会话」。
  （落点：同文件的 `RT-3` 两条）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- conversation-loading`（临时在判据里加回等价的「15s 放弃」出口） | 红 | `FAIL RT-1 等待期间（含超过任何固定超时）加载态保持，不会自行放弃`；其余 7 条通过 |
| 回归用例（修复后） | `npm run test:unit -- conversation-loading` | 绿 | 8 通过 / 0 失败 |
| 静态检查 | `npm run check-types` | 绿 | 含 `check-types:webview`（webview 侧类型） |
| 静态检查 | `npm run lint` | 绿 | — |
| 单测全量 | `npm run test:unit` | 绿 | 121 通过 / 0 失败 / 2 跳过（跳过项 `sidebarDocViewGit` / `sidebarFiles` 为环境前置不满足，与本缺陷无关） |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | docsLint 与 docsLintLocalOnlyPaths 均 0 失败 |
| 真机大对话复现（8MB / 慢速 SSH） | 手工打开该会话 | 部分验证 | 判据与实测读盘耗时（24.9s > 旧超时 15s）已确定；修复后未在真实慢链路上重跑一次完整打开，回归由 RT-1 在纯函数层锁定 |
