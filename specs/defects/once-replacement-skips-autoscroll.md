---
status: 已修
---

# 缺陷：once 通知被新消息覆盖后，时间线有概率停在中间而不自动贴底

once 通知总在时间线末位；下一条消息到达时，webview 先剥除 once 节点再追加新节点。
「删一条 + 加一条」不改变消息数组长度，自动滚动据此误判为「没有新内容」，当新节点比
被删的 once 通知更高时视口停在中间。影响面是所有走 `addMessage` 的 once 后继消息
（用户消息 / 助手消息 / 工具卡片 / 新 once 通知），用户表现为新回复或自己刚发的消息
下半截被裁掉，且不会自行回到底部。

## 现状

- `src/webview/hooks/handlers/toolHandlers.ts` 的 `handleToolAddMessage` 在追加新节点前
  执行 `[...stripOnce(prev), newMessage]`；`src/webview/hooks/handlers/streamHandlers.ts`
  新建流式节点时同样先 `stripOnce` 再 `concat`。once 节点在末位时，追加后
  `messages.length` 与追加前相同。
- `src/webview/MessagesView.tsx` 的自动滚动 `useLayoutEffect` 依赖 `messages.length`，
  「是否有新消息」也只用 `messages.length > prevMsgCountRef.current` 判定。长度不变时
  effect 不重跑，追加分支不执行。
- `src/webview/hooks/useMessageHandler.ts` 的 `scrollToBottomBeforeRender` 在 `setMessages`
  之前按**旧的** `scrollHeight` 预滚到底；React 提交后 once 节点被删、新节点更高，
  旧的 `scrollTop` 只到新内容的中段。`ResizeObserver` 观察的是固定高度的滚动容器
  （`flex-1 min-h-0`），内容变高不改它的盒尺寸；`scrollHeight` 轮询只在流式 / 工具
  运行中启用，空闲时没有兜底。
- 复现：时间线撑到可滚动且停在底部 → 收到 `once: true` 的系统通知 → 收到一条比该通知
  更高的普通消息（用户 / 助手 / 工具卡片）→ 时间线停在中间，`distanceFromBottom > 2`。
  概率取决于新节点是否比被删的 once 通知高。

## 期望

- 任何「追加新节点」的入口（包括 once 后继替换导致的等长变更）都必须在用户原本位于
  底部时继续贴底：渲染提交后 `scrollHeight - scrollTop - clientHeight ≤ 2`。
- once 节点被更高节点替换与普通追加同权，不能因为数组长度不变而跳过自动滚动。
- once 节点被更矮节点替换时保持贴底（现状由浏览器 clamp 保证，修复后仍成立）。

## 不变量

- 用户滚离优先：`userScrolledAway` 为 true 时，任何自动滚动路径都不得把视口拉回底部。
- 就地更新（工具状态推进 / 参数 / 流式增量）保留 once 节点，且不额外触发强制滚动。
- 会话加载、真实用户消息、`forceScrollKey` 的强制回底语义不变。
- once 通知的落盘 / 恢复 / `stripOnce` 渲染规则不变（见
  [docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)）。
- 流式跟随频率不增加：修复不得把每个流式帧变成额外的强制滚动。

## 回归测试

- **RT-1**：时间线撑高并停在底部 → 追加一条 once 系统通知 → 追加一条比通知更高的助手
  回复；等新回复渲染完成后断言消息容器 `scrollHeight - scrollTop - clientHeight ≤ 2`。
  （落点：`e2e/webview/jumpToBottom.spec.ts`「once 通知被更高新消息替换后仍贴底」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "once 通知被更高新消息替换后仍贴底"` | 红 | `expect.poll` 10s 超时，`distanceFromBottom` 稳定在 112px（预期 ≤ 2）——once 删除 + 新节点追加后长度不变，`useLayoutEffect` 未重跑，视口停在中段 |
| 回归用例（修复后） | `npm run build:webview && npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "once 通知被更高新消息替换后仍贴底"` | 绿 | 1 passed（4.3s）：once 替换后 `distanceFromBottom ≤ 2` |
| 既有 once 用例 | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "once 通知：末位显示"` | 绿 | 1 passed（4.3s）：末位显示 / 就地更新保留 / 新节点先删 / 重开从 meta 恢复均不变 |
| 既有回归 | `npm run test:e2e:webview -- --reporter=line` | 部分验证 | 91 条中 81 通过、10 失败；失败集中在输入历史 / 余额 / 会话草稿 / US-16 吸附等既有的环境相关抖动（commit 38688fc 已记录同一类 10 失败）。A/B 复核：把 `MessagesView` 还原到 HEAD 重建后，US-16 吸附用例仍以同一断言失败（`[data-pinned="true"]` 未隐藏）；`jumpToBottom.spec.ts` 串行跑 3 通过 / 2 失败，两条失败单独重跑均通过，RT-1 在两次运行中均绿 |
| `check-types` | `npm run check-types` | 绿 | 三份 tsconfig 均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 46 通过 / 0 失败（缺陷规格组含 slug / 五节 / RT / 验证记录取值与落点存活） |
