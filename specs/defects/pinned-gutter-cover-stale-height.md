---
status: 已修
---

# 缺陷：置顶背景延伸条不随置顶消息可见高度收缩，被下一条用户消息顶出时在滚动条上留下悬空色块

用户消息吸附置顶后继续下滚，下一条真正的用户消息逼近容器顶部时，置顶消息会被自身
分组容器的底边逐步顶出视口（顶部被滚动容器裁剪）；但滚动条 gutter 上的置顶背景延伸条
（`.pin-gutter-cover`，位于滚动容器父级、不参与滚动裁剪）仍按消息的**完整高度**铺色，
于是延伸条的下段伸出置顶消息的实际底边之外——视觉上顶部消息右侧（滚动条位置）多出
一块异常突起，且突起自带的底边框线悬在滚动条上，与任何消息都不对齐。基线是
[docs/features/user-stories.md 的 US-16](docs/features/user-stories.md#us-16-长消息折叠与用户消息置顶)
验收 2「用户消息滚动到顶时吸附为整宽条」与
[docs/hosts/webview-ui.md 第 11 节](docs/hosts/webview-ui.md#11-消息区视图行为跳到底部与发送模式)
的「置顶背景延伸条」事实：延伸条与置顶消息拼成同一条整宽条，两者必须始终对齐。

## 现状

- `src/webview/MessagesView.tsx` 的 `measurePinnedMessage` 每次按帧把延伸条高度 state
  置为置顶候选元素 `getBoundingClientRect().height`（完整高度），不扣除消息被分组容器
  底边顶出滚动容器顶部的部分。（该 state 已随 pinned-gutter-cover-stale-height-2 的
  修复移除，高度改为 scroll 监听器内直写 DOM。）
- 渲染侧 `.pin-gutter-cover` 以 `position: absolute; top: 0; height: pinnedHeight`
  铺在滚动容器父级上，覆盖滚动条 gutter。滚动容器只裁剪自己内部的 sticky 消息背景，
  管不到这个覆盖层。
- 复现路径：三轮对话（消息间有较长回复撑高滚动区）→ 下滚让第二条用户消息吸附置顶
  → 继续下滚让第三条用户消息顶部进入「容器顶 + 置顶消息高度 + 组间距」范围内。
  此时第二条被顶出、可见高度持续收窄，延伸条仍铺满完整高度，右侧滚动条上留下一截
  与消息底边脱节的色块（报告现象：顶部的消息右边、滚动条位置有异常突起）。
  用例化复现见 RT-1。

## 期望

延伸条只铺置顶消息在滚动容器可视区内的**可见段**：

- 置顶消息完整可见（正常吸附态）时，延伸条高度 = 消息完整高度（现状正确，保持）。
- 置顶消息被下一条用户消息逼近顶出时，延伸条底边跟随消息的实际底边同步上收，
  两者底边始终重合（含延伸条自带的 1px 底边框线）。
- 消息被完全顶出、但二分查找尚未把置顶身份移交下一条的极短窗口内，延伸条高度为 0，
  不渲染任何残段。

## 不变量

- 延伸条的宽度、右侧贴边、`+1px` 与消息背景的重叠缝、底边框线、配色、`zIndex: 20`、
  `pointer-events: none` 均不变；跳到底部按钮（30）/ 吸附容器（10）/ 加载遮罩（40）
  的 z 序关系不变。
- 置顶判定本身不动：二分查找口径（`rect.top <= containerTop + 0.5`）、吸附条件
  （`top: -MESSAGES_CONTAINER_PADDING_TOP`）、点击跳回原位、超高消息退出吸附
  （oversized 集合与滚动补偿）全部保持。
- 消息自身在滚动容器内的整宽背景（负边距 + 内边距 + 底边框）与底边框位置不变；
  本修复只动滚动容器父级上的延伸条高度。
- `pinnedGutter === 0`（overlay 滚动条）时仍不渲染延伸条；无置顶时仍不渲染。
- 测量时序不变：滚动 / 尺寸变化的 rAF 节流、React 短路（值不变不重渲染）保持。

## 回归测试

- **RT-1**：三轮对话，第二条用户消息吸附置顶且延伸条已铺上 gutter 后，再下滚让
  第三条用户消息顶部停在容器顶下约 24px（第二条仍持置顶身份但已被顶出）。断言
  `.pin-gutter-cover` 的视口底边 ≤ `[data-pinned="true"]` 的视口底边 + 1.5px
  （延伸条不得伸出置顶消息实际底边），并断言置顶条仍为第二条消息。
  （落点：`e2e/webview/messagePresentation.spec.ts`「US-16 置顶条被下一条用户消息
  顶出时，滚动条上的背景延伸条随可见高度收窄」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `git stash push -- src/webview/MessagesView.tsx && npm run build:webview && npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "延伸条"` | 红 | `coverBottom (85.125) toBeLessThanOrEqual pinnedBottom + 1.5 (59.75)`：置顶消息被下一条顶出后，延伸条仍按完整高度铺 gutter，底边伸出消息实际底边约 25px |
| 回归用例（修复后） | `npm run build:webview && npm run copy-assets && npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "延伸条"` | 绿 | 中间态断言（延伸条仍在渲染）与底边对齐断言均过 |
| 既有回归 | `npm run test:e2e:webview` | 绿 | webview 全套 76/76（含既有 US-16 置顶两条） |
| `check-types` | `npm run check-types` | 绿 | 三份 tsconfig 均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 缺陷规格链接校验通过 |
