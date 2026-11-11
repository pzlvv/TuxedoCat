---
status: 已修
---

# 缺陷：真实用户消息前面是 role=user 的系统消息时，发送后不复位滚离、不回底

用户向上翻阅历史（滚离底部）后发消息，视口停在上方不动：自己的消息与随后的回复都在视口外，
用户看不到「发出去了」的反馈，也不自动跟随本轮回复。是否复现取决于时间线最后一条消息的角色：
只要末位是 `role=user` 的**系统自动消息**（后台 Bash 完成通知、子代理 From、压缩摘要），或者
用户在上一轮回显后立刻又发了一条（相邻两条真实用户消息），新到的真实用户消息就判不出「这是一条
新的用户消息」。影响面是所有「用户先上翻、再发消息」的交互，即最需要发送后回底的时刻。

与 as-built 规格的差异：[docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为)
声明「真正的用户消息到达」是复位滚离抑制的入口；[specs/defects/tiny-up-scroll-yanked-back-to-bottom.md](tiny-up-scroll-yanked-back-to-bottom.md)
的不变量同样写「真实用户消息的强制回底语义不变」。当前实现两个说法都不成立。

## 现状

`src/webview/MessagesView.tsx` 的 `useAutoScroll` 在 `useLayoutEffect` 里判定「新的用户消息」，
判据是**末位角色发生 user 转变**，而不是「列表末位多了一条新的真实用户消息」：

- 一个记录「上次末位角色」的 ref 在 `useLayoutEffect` 里每次提交都写成 `lastMsg.role`。
- 判定式是 `isPinnableUserMessage(lastMsg) && ref.current !== 'user'`。
- 该布尔为 false 时走不到「复位 `userScrolledAwayRef` + `scrollToBottom(true)`」分支，后续
  `if (userScrolledAwayRef.current) return;` 直接让位——滚动发生在别处（`scrollToBottomBeforeRender`
  也遵守滚离），视口停在用户上翻的位置。

`role=user` 但**不是**真实用户输入的消息有三类，它们都让那个「上次末位角色」提前变成 `user`：

| 来源 | 载荷 | 渲染 |
| --- | --- | --- |
| 后台 Bash 完成通知 | `origin: 'bash'` | `isPinnableUserMessage` 排除 |
| 子代理 From / To | `origin: 'agent'` | `isPinnableUserMessage` 排除 |
| 压缩摘要 | `isCompactSummary: true` | `isPinnableUserMessage` 排除 |

同一根因还覆盖「相邻两条真实用户消息」：第二条到达时末位角色已是 `user`（第一条用户气泡），
同样判不出新消息。

复现（webview-ui 车道，假宿主驱动真实 bundle，viewport 1280×500）：

1. 撑高时间线后接一条 `origin: 'bash'` 的用户角色通知（或 `origin: 'agent'` 的 From、或
   `isCompactSummary: true` 的摘要），滚轮向上滚离，实测 `distanceFromBottom` 338～371px。
2. 在输入框键入内容后按 Enter（真实发送路径，宿主按 wire 回显 `addMessage role=user`）。
3. 实测发送后 `distanceFromBottom` 停在 423～459px（只增不减，即新用户气泡与流式回复都长在
   视口下方），`useLayoutEffect` 日志为 `branch` 缺失、`SKIP userScrolledAway=true`。

顺带记录同一根因下「两条相邻真实用户消息」的实测：上翻到 338px 后注入第二条用户气泡，
距离增加到 390px、视口不动。

## 期望

- 「复位滚离抑制并强制回底」的判定以**消息身份**为键：末位是真实用户消息（
  `isPinnableUserMessage`，即排除 `origin=agent` / `origin=bash` / 压缩摘要），且它与上一次提交
  判定的那条用户消息不是同一个对象实例，即视为「新的真实用户消息到达」。
- 该判定与末位之前是什么角色无关：紧随 `origin=agent` / `origin=bash` / 压缩摘要 / 上一条真实
  用户消息之后的真实用户消息，同样复位并回底。
- 系统自动消息本身（`origin=agent` / `origin=bash`、压缩摘要）仍然不得复位滚离、不得把视口拉回
  底部。

## 不变量

- 会话加载、`forceScrollKey`（选择框弹出 / 应答提交 / 排队项出现与清除 / 压缩展开）的强制回底
  语义不变。
- 用户自己滚回底部才恢复跟随的规则不变；滚离期间流式内容、工具卡片、`once` 通知都不得把视口
  拉回底部（[specs/defects/tiny-up-scroll-yanked-back-to-bottom.md](tiny-up-scroll-yanked-back-to-bottom.md)
  与 [specs/defects/once-replacement-skips-autoscroll.md](once-replacement-skips-autoscroll.md) 的全部断言）。
- 跳到底部按钮的显隐口径不变：仍只由「一次向下滚轮手势累计位移 > 可视高度 1/3」显示，向上滚动
  任意幅度隐藏。
- 不新增事件 / 契约成员 / 落盘字段，不改消息渲染结构与滚动频率。

## 回归测试

- **RT-1**：时间线末位是后台任务完成通知（`origin=bash`、`role=user`，非用户输入）→ 真实滚轮
  上翻离底 → 输入框键入并 Enter（真实发送路径）→ 自己的用户消息可见且视口贴底
  （`distanceFromBottom ≤ 2`），随后的流式回复继续跟随（落点：`e2e/webview/jumpToBottom.spec.ts`
  的用例「US-47 滚离后发送消息回底（末位是 role=user 的后台任务通知）」）。
- 同根因的其他形态（末位是子代理 From `origin=agent`、压缩摘要 `isCompactSummary: true`、
  上一条真实用户气泡）由 RT-1 的同一条判据覆盖：判据是「末位是新的真实用户消息」，与前置
  消息的角色 / 来源无关，四种形态都走同一个分支。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "滚离后发送消息回底"` | 红 | 1 failed（10.9s）：上翻到 338px 后 Enter 发送，`expect.poll(distanceFromBottom).toBeLessThanOrEqual(2)` 超时，实测停在 426px——自己的消息与回复都在视口下方；`useLayoutEffect` 日志为 `SKIP userScrolledAway=true`（未进 user/force 分支） |
| 既有回归（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui e2e/webview/jumpToBottom.spec.ts --grep-invert "滚离后发送消息回底"` | 绿 | 9 passed：既有 US-47 显隐 / 点击回底、once 替换贴底、选择框与权限应答复位、上滚 1px 两条抑制用例全部不变 |
| 回归用例（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "滚离后发送消息回底" --repeat-each=3` | 绿 | 3 passed（3.9s，单次约 0.9s）：上翻后 Enter 发送，自己的消息可见且 `distanceFromBottom ≤ 2`，本轮回复继续跟随 |
| A/B 复核（修复前源码） | 仅把 `MessagesView.tsx` 回到修复前并重建 `dist/webview`，再跑同一条用例 | 红 | 10.8s 超时，`distanceFromBottom = 510`；同一用例在修复后源码上绿——红绿由本改动决定，非用例自身抖动 |
| 既有回归 | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui e2e/webview/jumpToBottom.spec.ts` | 绿 | 10 passed：既有 US-47 显隐 / 点击回底、once 替换贴底、选择框与权限应答复位、上滚 1px 两条抑制用例均不变 |
| 全量 webview e2e | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 绿 | 128 passed（2.4m），0 failed |
| `check-types` | `npm run check-types` | 绿 | 三份 tsconfig（含 webview / electron）0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败（缺陷规格组 0 处问题） |
