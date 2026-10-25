---
status: 已修
---

# 缺陷：US-16 置顶条点击用例断言「置顶条完全消失」，与 sticky 吸附语义不符（CI 必红）

`e2e/webview/messagePresentation.spec.ts` 的「US-16 用户消息滚出视口顶部时吸附置顶，点击
回到原位」在 CI（Linux headless Chromium）上稳定红：点击置顶条后 `[data-pinned="true"]`
5s 内仍可见。本地（Windows）绿是因为断言抢在了一帧空窗里——用例期望与产品的 sticky 语义
不一致，不是产品缺陷。

## 现状

- 点击置顶条的执行链（`src/webview/MessagesView.tsx`）：
  1. `jumpToMessageStaticPosition`：临时把目标消息改回 `static` 量出内容流位置，把
     `container.scrollTop` 设到「该消息贴住内容区顶部」，再 `clearPinned()`；
  2. 滚动事件触发 `schedulePinnedMeasure` → rAF → `measurePinnedMessage`：按
     「最后一条 top ≤ 容器顶 + 0.5」重新选置顶候选。
- 跳回后目标消息（第二条）正好贴在内容区顶部，**不再是候选**；而它上一条用户消息
  （第一条）此刻仍在容器顶之上，按同一规则接替成为置顶条。这是 sticky 吸附的应有语义。
- 因此点击后的最终状态是「置顶条还在，但内容换成了第一条」；`clearPinned()` 到下一次
  重算之间有一帧 `pinnedMessage === null` 的空窗。原用例 `expect(locator).toBeHidden()`
  只要在空窗内首次求值就通过（本地 Win 常赢这一帧），CI 上首次求值落在重算之后 → 恒红
  （重试两次同样红，`14 × locator resolved to <div data-pinned="true" …>`）。
- 探针实测（本地，同一操作序列）：点击后第 0 次采样 `pins: []`，第 1 次采样起
  `pins: ["第一条用户消息"]` 并保持稳定；`scrollTop` 390 → 252，第一条消息的
  `top - containerTop = -35`（仍在视口之上）。

## 期望

- 用例断言产品真实契约，而不是某一帧的瞬时状态：
  1. 跳回后「第二条用户消息」不再是置顶条（不再出现在 `[data-pinned="true"]` 的内容里）；
  2. 第二条消息的置顶包裹层回到内容区顶部（吸附偏移 = 容器上内边距 16px，落在 `[0, 60)`）。
- 不把「上一条用户消息接替置顶」当成失败：那正是 sticky 语义。
- 产品代码不改：`jumpToMessageStaticPosition` / `measurePinnedMessage` 的行为与
  [US-16](../../docs/features/user-stories/messages.md#us-16-长消息折叠与用户消息置顶) 基线一致。

## 不变量

- 置顶候选的选取规则（最后一条 top ≤ 容器顶 + 0.5）与「超高消息不吸附」不变。
- 点击消息内链接 / 按钮 / 有选区时不跳转的守卫不变。
- 同文件其它 US-16 用例（折行数变化、置顶条只铺内容区）不受影响。

## 回归测试

- **RT-1**：`npx playwright test -c e2e/playwright.config.ts --project=webview-ui
  messagePresentation -g "US-16 用户消息滚出视口顶部"` 连续 6 次绿（落点：
  `e2e/webview/messagePresentation.spec.ts` 的同名用例，断言改为「第二条不再置顶」+
  「包裹层回到顶部」）。
- **RT-2**：`webview-ui` 车道全量绿（120 条），确认改动没有波及其它用例。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| CI 上的红 | GitHub Actions `e2e` / `e2e-ui` 车道 | 红 | `expect(locator).toBeHidden()` 失败：`14 × locator resolved to <div data-pinned="true" …>`，重试同样红；同车道其余 138 条绿 |
| 根因定位（只读代码 + 本地探针） | 读 `MessagesView.tsx` 的 `jumpToMessageStaticPosition` / `measurePinnedMessage`；临时探针 spec 打印点击后 6 次采样 | 部分验证 | 点击后第 0 次采样无置顶条、第 1 次起稳定为「第一条用户消息」；`scrollTop` 390→252，第一条 `top-containerTop=-35` |
| 修复后（RT-1） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui messagePresentation -g "US-16 用户消息滚出视口顶部" --repeat-each=6` | 绿 | 6 passed（5.1s） |
| 既有回归（RT-2） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 绿 | 120 passed |
| 本地全量（改动前） | `npm run test:e2e` | 绿 | 该用例本地一直绿（抢到一帧空窗），所以问题只在 CI 暴露 |
