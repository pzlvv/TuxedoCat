---
status: 已修
---

# 缺陷：同一对话已被其它实例打开时，重新打开仍进加载态并亮「已打开」绿点

US-66 验收第 1 条（[docs/features/user-stories/sessions-and-llm.md](../../docs/features/user-stories/sessions-and-llm.md)）
要求：实例 A 已打开会话 S 时，实例 B 装载 S 收到明确的占用错误，不展示内容、不提供只读视图。
现状是「拒绝」只到 Core 为止——宿主与界面仍按「正在打开 / 已经打开」推进这次操作：单视图宿主
（VS Code）的消息区一直停在「正在加载对话…」遮罩上；Electron 宿主还新起了一个视图，
并把该会话算进「已打开会话」集合，侧栏对话行因此亮起绿点（`.loaded-dot`），而那个视图
永远不会拿到内容。用户看到的是一条打不开、却在列表上标着「已打开」的对话。

## 现状

- Core 侧拒绝本身是对的：`conversationLoadRequested` 先取会话锁
  （`core-rs/src/session_lock.rs`），被其它实例持有时回错误并发
  `notice.session.lockedOpen`（`params.pid` 为持有者）。
- 宿主侧的装载错误**没有终点**：`WebviewMessageHandler.handleLoadConversation`
  调 `loadConversationForHost(sessionId)`（`UiRequest.conversationLoadRequested`），
  promise 被拒后异常由 `handleWebviewMessage` 的 `try/catch` 兜底成一条日志
  （`src/host/ui/webviewMessageHandler.ts`），既不回 wire 消息、也不通知视图层。
- 单视图宿主（VS Code / 浏览器）的加载态只有「该会话的 `conversationLoaded` 到达」
  一个结束条件（`src/webview/hooks/useConversationLoading.ts`，见
  [docs/hosts/host-info.md](../../docs/hosts/host-info.md) 的会话跳转一节）。装载被拒
  时 `conversationLoaded` 永不到达，`pendingSessionId` 一直非空 → `MessagesView` 的
  `.conversation-loading-overlay` 一直显示，而进入加载态时被清空的消息也回不来。
- Electron 侧：`ChatViewManager.openConversation` 建好视图就 `show()` 并
  `emitLoadedChanged()`，`getLoadedSessionIds()` 只看「视图对象存活」，于是
  - 侧栏 `loadedSessions` 命中该会话 → 对话行出现 `.loaded-dot`（title「已打开」）；
  - `onLoadedChanged` 同时喂 `WebViewUI.setOpenSessions`，`UserChoiceQueue` 认为
    该会话 open；
  - 侧栏点击时已乐观 `setActive(sessionId)`，被拒后没有任何人把它推回去，
    高亮停在那个空视图上。
- 影响面：只有「会话被另一实例持有」这一条路径（US-66 / specs/032）。其它装载失败
  （Core 崩溃等）走各自路径，不在本缺陷范围。

## 期望

1. **被拒即结束**：装载被拒时那次打开整体作废——不进加载态、不停在加载态。通知照常
   弹出（占用原因与持有者 pid 必须可见）。
2. **界面停在打开前的原位置**：当前对话、消息、滚动位置与输入框内容一律不动
   （「失败的打开动作无副作用」，与 Overlay 部署闸门的放弃打开同口径）。
3. **不把被拒的对话算作已打开**：Electron 侧栏不亮绿点，`UserChoiceQueue` 不把它当
   open；本次新建的视图被销毁，侧栏「当前对话」高亮回到打开前那条对话。
4. **「已打开」按装载完成计**：视图建好但内容仍在读盘 / 传输时不算已打开，
   装载完成（`conversationLoaded`）后才进入已打开集合。
5. 单视图宿主的拒绝判据只认「被拒的正是本视图在等的那个会话」：别的会话的占用通知
   不结束当前加载，也不清空当前界面。

## 不变量

- Core 的锁语义与文案不变：`notice.session.lockedOpen` 的键与 `pid` 参数照旧，
  拒绝方向仍是「拒外」（`docs/core/client-connection.md` 的会话跨实例独占一节）。
- 不新增 UiEvent / CoreEvent / UiRequest / 落盘字段；事件词汇表与 wire 消息类型集合不变。
- 正常打开路径的时序不变：视图创建 → 装载 → `conversationLoaded` → 显示内容；
  只是「已打开」的成立时刻从「视图建好」改为「装载完成」。
- 切换已有视图（该会话早已装载完成）仍是瞬切，不重新读盘、不产生在途打开。
- 视图销毁序列（`closeView` / LRU 淘汰 / 关闭工作区）语义不变：在途打开的登记随视图
  一起消失，不会把会话永久排除在「已打开」集合之外。
- 校验移交：被拒的打开**不**向 Core 发 `conversationClosed`（core 本就没为该会话
  建立会话实例，多 Connection 下按会话路由会抛错）。

## 回归测试

- **RT-1**：待打开登记的口径——`begin` 之后该会话**不在**「已打开」集合，`settle` 之后
  才在；`reject` 交回打开前的视图 key 且只生效一次；视图销毁（`drop`）清掉登记；重复
  `begin` 不覆盖「打开前那条」。（落点：`src/test/pendingOpen.test.ts` 的
  `pendingOpen` 用例组）
- **RT-2**：webview 拒绝判据——只有 `notice.session.lockedOpen` 且 `sessionId` 等于
  本视图在等的会话时结束加载；别的会话、`sessionLockedChange`、其它瞬时提示、缺失
  `sessionId` 都不干预。（落点：同文件 `rejectedLoadSessionOf` 断言组）
- **RT-3**：宿主出口接线——内容装载完成后 `ChatViewManager.revealOpen` 让会话进入
  已打开集合；`notice.session.lockedOpen` 经 `WebViewUI.onConversationOpenRejected`
  走到 `rejectPendingOpen`（无 UI 自动化覆盖：Electron 视图层依赖真实 `WebContentsView`，
  由 RT-1 的口径 + 代码走查锁定）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2（修复前） | `npm run test:unit -- pending-open` | 红 | 修复前不存在 `electron/pendingOpen.ts` 与 `src/webview/conversationLoadRejection.ts`：加载态没有第二个结束条件，`getLoadedSessionIds` 也没有「在途打开」概念，用例无法通过 |
| RT-1 / RT-2（修复后） | `npm run test:unit -- pending-open` | 绿 | 19 通过 / 0 失败 |
| RT-3（走查 + 类型） | `npm run check-types` | 绿 | `WebViewUI.onConversationLoaded` / `onConversationOpenRejected` 在 `electron/main.ts` 接到 `revealOpen` / `rejectPendingOpen`；单视图宿主不注入，两个出口为空 |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测（含 docs-lint）通过 |
| 既有回归 | `npm run lint` | 绿 | eslint src 零告警 |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | docsLint 49 通过 / docsLintLocalOnlyPaths 6 通过 |
| 真实双实例手测 | — | not-run | 需两个宿主进程与同一会话，按 specs/032 既有豁免口径（双实例端到端不进车道）；判据由 RT-1 / RT-2 与代码走查锁定 |
