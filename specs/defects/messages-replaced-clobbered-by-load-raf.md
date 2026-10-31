---
status: 已修
---

# 缺陷：加载窗口内到达的 `messagesReplaced` 被 `conversationLoaded` 的 rAF 整批覆盖

`conversationLoaded` 的 `setMessages(restoredMessages)` 排在 `requestAnimationFrame`
回调里（为回放跨会话缓冲的 updateToolStatus），而 `requestSessionTodos` 等同步先发——
「按钮已亮、消息未铺」的窗口内（`conversationLoadingRef` 为 true 到 rAF 执行之间），
webview 收到 `messagesReplaced`（core 压缩后重建 / 宿主展开归档共用的整批替换）会立即
`setMessages(替换)`，随后被同一 rAF 里的 `setMessages(恢复消息)` 覆盖：替换结果丢失，
界面停留在加载快照。真实场景：用户打开会话与压缩完成落在同一帧窗口（概率低但存在，
e2e 的 todoProgress 压缩用例已在 CI 上实际撞出，run 41184108430 首跑 10.4s 超时）。
同窗口内的 `updateToolStatus` 已有既有机制（进 `bufferedToolStatusRef`、rAF 内回放），
`messagesReplaced` 没有同等对待。

## 现状

- `src/webview/hooks/handlers/conversationHandlers.ts` `handleConversationMessagesReplaced`：
  会话过滤后直接 `scrollToBottomBeforeRender()` + `setMessages(msg.messages.map(toUiMessage))`，
  不检查 `props.conversationLoadingRef.current`。
- `handleConversationConversationLoaded` 的 rAF 回调（约 360 行起）最后
  `props.setMessages(restoredMessages)`（约 430 行）——无条件覆盖之前任何
  `setMessages` 的结果。
- 复现路径（e2e，确定性）：假宿主在 `loadConversation` 应答的 `conversationLoaded`
  之后**同批**发出 `messagesReplaced`（两条 wire 消息挤进同一批任务，webview 的 rAF
  必然晚于两者处理）→ 替换内容不渲染，界面显示加载快照原文。

## 期望

- 加载窗口内到达的 `messagesReplaced` 与 `updateToolStatus` 同等对待：进缓冲，
  由 `conversationLoaded` 的 rAF 收尾时应用——`messagesReplaced` 在 wire 上晚于
  `conversationLoaded`，是更晚的事实，必须生效（`src/host/webviewMessages.ts` 载荷
  注释「整批替换后的消息……顺序即显示顺序」；同一会话窗口内多次到达按 last-wins）。
- 窗口外（正常态）的替换行为不变：立即整批替换。

## 不变量

- 会话过滤不变：非当前会话的替换仍被过滤（不入缓冲、不渲染）。
- `conversationLoaded` rAF 内既有动作不变：details 收起、updateToolStatus 回放、
  预滚动、`finishConversationLoad`、streamId 关联、`conversationLoadingRef` 复位时序。
- 新加载入口清掉同会话旧窗口的缓冲残留（wire 顺序：新加载快照晚于旧窗口内的替换）。
- 加载异常路径（解析失败 / 恢复抛错的 catch 分支）不遗留缓冲条目。
- todoProgress 的 e2e 断言语义不变（压缩后按钮计数不变，FR-002 / FR-003）。

## 回归测试

- **RT-1**：加载窗口内到达的整批替换必须生效——假宿主在 `conversationLoaded` 应答后
  同批发 `messagesReplaced`，断言替换后内容可见、加载快照原文不出现
  （落点：`e2e/webview/conversation.spec.ts` 新增用例，`chunkDelayMs` 无关、无计时竞态）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "不被加载快照覆盖"` | 红 | 替换先上屏（toBeVisible 过），随后被 conversationLoaded 的 rAF 覆盖回加载快照原文（toHaveCount 0 收到 1）；headless rAF 晚到使暴露点后移，机制一致 |
| RT-1（修复后） | 同上 | 绿 | 替换内容可见、加载快照原文清零（446ms，无计时竞态） |
| 既有回归（压缩用例去掉前置等待） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "压缩（messagesReplaced）"` | 绿 | todoProgress 压缩用例不再需要「等首条消息渲染」，直接走修复后的窗口路径 |
| 既有回归（webview 车道全量） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 绿 | 126 用例（含 RT-1）；多轮中偶发单例 `page.goto: net::ERR_UNSAFE_PORT`（本地静态服务器随机端口撞上 Chromium 封禁端口，逐轮换用例、复跑即绿，与改动无关） |
