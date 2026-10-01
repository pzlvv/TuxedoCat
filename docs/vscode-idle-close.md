# 规格：VS Code 单视图宿主的空闲对话回收

本规格描述 VS Code 单视图宿主（`HostInfo.conversationView === 'single'`）对空闲对话的
回收能力。回收只释放运行时内存，不删除磁盘上的对话数据；被回收的对话再次打开时从磁盘重建。

---

## 1. 能力

对话满足以下全部条件时被回收：

1. 该对话不在前台（不是当前正在打开的对话）；
2. 该对话处于空闲状态；
3. 该对话距最后一次活动已满 2 小时。

计时随以下事件重置：打开 / 加载对话、新建对话、用户发送消息、对话进入非空闲、
对话从非空闲回到空闲，以及对话处于前台期间的每次巡检。

回收只在 VS Code 单视图宿主生效；多视图宿主（Electron）不参与。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 活动会话（active session） | 当前在 webview 中展示的会话 | UI（宿主侧读取器注入） |
| 空闲（idle） | `sessionResources.isSessionIdle(sessionId)` 的返回值 | core `sessionRuntime` |
| 临时会话 | 尚未上报正式 `sessionId` 的新建会话（`new-` 前缀） | UI |
| 空闲阈值 | 2 小时 | 本规格 |
| 巡检间隔 | 1 分钟 | 本规格 |

`idle === false` 当且仅当该会话自身存在 `query` / `waiting` / `compacting` / `background`
事实，或存在非空闲子代理（递归）。判定失败时按「非空闲」处理。

---

## 3. 行为规格

### 3.1 参与回收的会话

- 每个出现过活动事件的正式会话进入跟踪集合。
- 临时会话不进入跟踪集合，不参与回收。
- 跟踪集合在会话被回收后移除对应条目。

### 3.2 计时与重置

每个被跟踪会话持有「最后一次活动时刻」。以下事件把该时刻置为当前时间：

| 事件 | 触发点 |
| --- | --- |
| 加载 / 打开对话 | `webviewMessageHandler.handleLoadConversation` |
| 新建对话 | `webviewMessageHandler.handleStartNewConversation` |
| 用户发送消息 | `webviewMessageHandler.handleSendMessage` |
| 对话进入非空闲 | `ConversationManager.updateSessionStates` 的状态跃迁 |
| 对话从非空闲回到空闲 | 同上（工作结束后从头计时） |
| 对话处于前台 | 每次巡检（前台会话永不关闭，并持续刷新计时） |

### 3.3 巡检与关闭判定

巡检每 1 分钟执行一次。对跟踪集合中的每个会话，按顺序判定：

1. 该会话是活动会话 → 不关闭，并把计时置为当前时间；
2. 距最后一次活动不足 2 小时 → 不关闭；
3. `isSessionIdle(sessionId)` 为 `false`，或判定失败 → 不关闭，并把计时置为当前时间；
4. 通过以上判定 → 关闭该会话。

判定过程中的 `await` 可能让状态变化，因此关闭前对「活动会话」与「空闲状态」各复查一次；
任一条件不再满足则放弃本次关闭并重置计时。

### 3.4 关闭动作

关闭动作经宿主注入的回调分发：

```
idleCloseHandler(sessionId)
  → WebViewUI.closeConversation(sessionId)
      → releaseConversation(sessionId)        // 卸内存：发 conversationClosed + UI 侧 fan-out
      → host.closeConversationView(sessionId) // 单视图宿主为空实现
```

- `conversationClosed` 由 core 处理，释放该会话的引擎 / 消息缓存 / MCP 引用 / 运行时状态。
- UI 侧 fan-out 清理 `SessionUiState`、`UserChoiceManager`、`WebviewMessageHandler` 的
  per-session 状态。
- 关闭成功（回调 resolve）后从跟踪集合移除该会话。
- 关闭失败（回调 reject）时保留该会话，记录日志，下轮巡检再次尝试。

---

## 4. 归属与边界（DEVELOPMENT.md 约束）

| 关注点 | 归属 | 依据 |
| --- | --- | --- |
| 计时 / 巡检 / 关闭判定 | 宿主层 `SingleWebViewConversationManager` | 第 5.4、12.4 节 |
| 「是否空闲」事实 | core `sessionResources.isSessionIdle`（只读） | 第 4.5、5.4 节 |
| 「哪个会话在前台」 | UI（`activeSessionProvider`） | 第 12.7 节 |
| 关闭动作 | `WebViewUI.closeConversation` → `conversationClosed` | 第 5.5、10.5 节 |
| 启用范围 | 仅 VS Code | 第 8.6 节 |

边界规则：

- 宿主不直接修改 core 状态：关闭动作经 `conversationClosed` 事件表达。
- core 不参与计时：core 只提供 `isSessionIdle` 只读事实。
- 空闲判定失败时保守视为「非空闲」，不关闭。
- 未注入关闭回调时不关闭任何会话。
- 「活动会话」不落进 core：前台会话由 UI 持有并注入。
- 多视图宿主不启用本能力。

---

## 5. 接线与生命周期

接线（VS Code 扩展激活，共享骨架之后）：

```ts
conversations.setActiveSessionProvider(() => ui.getActiveSessionId() ?? null);
conversations.setIdleCloseHandler((sessionId) => ui.closeConversation(sessionId));
conversations.startIdleMonitor();
```

生命周期：

| 时机 | 行为 |
| --- | --- |
| 扩展激活 | 启动巡检（幂等，重复调用只启动一个定时器） |
| 扩展停用 | 停止巡检；进程级 core 资源由 `shutdownCore()` 释放 |

巡检定时器 `unref()`，不阻止进程退出。

---

## 6. 不变量

- 活动会话永不关闭。
- 非空闲会话永不关闭。
- 回收只卸内存，不删除磁盘对话数据。
- 临时会话不参与回收。
- 同一会话的关闭动作在一轮巡检内只执行一次。
- 计时状态在会话被回收后清空，避免无界增长。

---

## 7. 验收要点

1. 活动会话经过任意时长不被回收，且计时持续刷新。
2. 非活动会话在最后一次活动满 2 小时后被回收。
3. 加载对话、新建对话、发送消息分别重置计时。
4. 对话进入非空闲、以及从非空闲回到空闲分别重置计时。
5. 判定为忙碌（后台 Bash / 等待用户 / 压缩中 / 非空闲子代理）的会话不被回收。
6. 关闭回调未注入时，巡检不关闭任何会话。
7. 关闭动作触发 `conversationClosed`，core 与 UI 侧 per-session 状态被清理。
8. 多视图宿主不启动本能力。
9. 扩展停用后巡检定时器停止。

---

## 8. 落点对照

| 规格项 | 现有落点 |
| --- | --- |
| 阈值 / 巡检间隔 | `src/VSCodeConversationManager.ts` 的 `SESSION_IDLE_CLOSE_MS` / `SESSION_IDLE_CHECK_INTERVAL_MS` |
| 计时重置（加载 / 新建 / 发消息） | `src/host/ui/webviewMessageHandler.ts` 的 `noteSessionActivity` 调用点 |
| 计时重置（状态跃迁） | `src/VSCodeConversationManager.ts` 的 `updateSessionStates` |
| 巡检 / 关闭判定 | `src/VSCodeConversationManager.ts` 的 `sweepIdleSessions` |
| 空闲事实 | `src/core/sessionResources.ts` 的 `isSessionIdle` |
| 前台读取器 | `src/extension.ts` 的 `setActiveSessionProvider` |
| 关闭动作 | `src/host/WebViewUI.ts` 的 `closeConversation` / `releaseConversation` |
| 启动 / 停止 | `src/extension.ts` 的 `startIdleMonitor` / `deactivate` |
