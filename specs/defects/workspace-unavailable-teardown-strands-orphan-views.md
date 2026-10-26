---
status: 已修
---

# 缺陷：工作区标红清理先拆 Connection 后拆视图，孤儿视图滞留并在 LRU 淘汰时炸主进程

远程 daemon / 链路死亡标红（`markWorkspaceUnavailable`，runtime）时，清理顺序是先
`emitWorkspaceChange('closed')` 摘 Connection、后 `chatViews.closeWorkspace` 销毁视图。
摘除后视图释放（`conversationClosed`）在 Client 路由层必然抛「No Connection owns
session」；`ChatViewManager.closeWorkspace` 裸 for 调 `destroyViewEntry` 且无
fallback，第一个视图抛错即中断整批——剩下的视图留在 views + lru，而它们所属的
Connection 已被摘除。孤儿视图此后两条危害：重连成功后被 `setActiveWorkspace` 当作
该目录最近使用的视图直接复活（用户回到旧对话，见
[ssh-reconnect-send-dropped-before-connection-ready](ssh-reconnect-send-dropped-before-connection-ready.md)
的窗口期叠加）；任何 touch → trim 路径（打开 / 切换对话）再走 `destroyViewEntry`
对同一会话路由抛错——trim 调用链上没有任何 try/catch，主进程又未注册
uncaughtException 处理，异常直接杀死主进程（整应用崩溃）。

## 现状

- `markWorkspaceUnavailable`（`electron/main.ts`）的清理段顺序：
  1. `emitWorkspaceChange('closed', ref)` → `Client.closeWorkspace` → `detachConnection`
     同步摘除连接表与 `sessionToConnection` 映射；
  2. `chatViews?.closeWorkspace(refKey(ref))`——外层 try/catch 只兜住首次抛错并记日志
     （「清理失败不阻断状态收敛」）。
- `ChatViewManager.closeWorkspace`（`electron/ChatViewManager.ts`）裸 `for` 逐 key 调
  `destroyViewEntry`；`destroyViewEntry` 的第一步是 `closeConversation(key)`（宿主注入
  = `WebViewUI.releaseConversation`），正式会话会
  `requireEventBus().emitToCore({ type: 'conversationClosed', sessionId })` →
  `Client.connectionForSession` 查不到归属（映射已被 detach 清掉）且无唯一连接退路时
  抛 `No Connection owns session "…"`。抛错点在 `views.delete` / lru / 标记清理之前，
  该视图滞留；外层 for 中断，本批剩余视图全部滞留。
- 单工作区宿主（`connections.size === 0`）必抛；多工作区宿主若仅存一个其它 Connection，
  唯一连接退路把会话误登记到**别的**工作区连接上（不抛，但属于跨工作区误路由）。
- 复现（真实 SSH，`e2e/electron/remoteSshExecution.spec.ts` 的「SSH 断连标红重连：孤儿视图清零、恢复后发送正常往返」，SIGSTOP 远端
  daemon 制造沉默判死）：标红后重连成功，`setActiveWorkspace` 从 lru 找到孤儿视图直接
  show——重连后旧对话内容可见（复现日志
  `[复现] 重连后旧对话内容可见（孤儿视图被复用）: true`）。
- 崩溃链为代码推演：孤儿视图滞留后，`trim()`（touch → 超过 12 上限）对最旧条目
  `destroyViewEntry` → 同一路由抛错；`touch` 的调用方（show / openConversation /
  openNewConversation / IPC 与菜单链）无 try/catch，Electron 主进程未处理
  uncaughtException（全仓库无注册）→ 进程退出。

## 期望

- 标红清理顺序对调：**先销毁该工作区的对话视图，后 `emitWorkspaceChange('closed')`
  摘 Connection**。此时会话归属映射仍在，`conversationClosed` 正常路由（远程死链上
  帧只缓冲不送达，无副作用）；红点 / 状态推送仍先于全部清理（既有回归保持）。
- `closeWorkspace` 逐视图销毁互不牵连：单个视图的卸内存抛错不中断整批，
  views / lru / 预热与未发送标记的清理必须完成（finally 语义；被跳过卸内存的会话，
  其资源随随后的 Connection 销毁一并消亡，无泄漏）。
- 标红收敛后该工作区视图清零：`getLoadedSessionIds()` 不再含其会话，重连后不复活旧
  对话视图（聊天区从新对话开始，历史经侧栏重开）。

## 不变量

- 「先推送红点再清理」的时序保持（`syncTitlebarWorkspaces` / `broadcastWorkspaces`
  仍排在清理之前——该顺序是既有缺陷的修复成果，见 `e2e/electron/workspace.spec.ts`
  多工作区标红用例的注释）。
- Client「查不到归属报错、不静默丢弃」的路由语义不变（[docs/core/client-connection.md 第 6 节](../../docs/core/client-connection.md#6-会话路由)）。
- `destroyViewEntry` 的既有销毁序列（卸内存 → 移除 ChildView → close webContents →
  清标记）顺序与语义不变；closeView / disposeAll / LRU trim 的行为不变。
- 重连正常路径（无标红）的视图保留行为不变：setActiveWorkspace 仍按工作区恢复最近
  使用的对话。

## 回归测试

- **RT-1**：真实 SSH 场景（electron-ssh 车道）：链路死亡标红 → 重连成功后，旧对话
  视图已被销毁——重连后的聊天页不再呈现旧对话内容，聊天区为新空对话。现状红：
  旧对话内容可见（孤儿视图被复用）。（落点：`e2e/electron/remoteSshExecution.spec.ts`
  「SSH 断连标红重连：孤儿视图清零、恢复后发送正常往返」，与
  [ssh-reconnect-send-dropped-before-connection-ready](ssh-reconnect-send-dropped-before-connection-ready.md)
  共用场景）
- **RT-2**：同场景断言清理完成性：孤儿滞留时旧会话的每次发送都持续抛
  「No Connection owns session」（多工作区宿主无唯一连接退路）——修复后全程无该
  路由错误、应用存活。现状红（两次发送均死信）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `E2E_DEBUG=1 npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "孤儿视图清零"` | 红 | `[复现] 重连后旧对话内容可见（孤儿视图被复用）: true`；紧接发送与就绪后发送均死信（LLM 请求数停在 2，`No Connection owns session`）——持续死信对应「必须关开对话」 |
| 回归用例（修复后） | 同上 | 绿 | `[复现] 重连后旧对话内容可见: false`；紧接发送与就绪后发送均响应到达（LLM 请求数 2 → 3 → 4），全程无 `No Connection owns session` |
| 既有回归（单测全量） | `npm run test:unit` | 绿 | 85 通过 / 0 失败 / 1 跳过（sidebarFiles 环境前置不满足，既有 skip 分支）；docsLint 含两份缺陷规格的闸门校验 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 无错误 |
