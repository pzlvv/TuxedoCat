---
status: 已修
---

# 缺陷：底部上滚小距离后仍被自动滚动拉回底部

用户在时间线底部向上滚动一点点（≤2px 的精准触控板微动、滚动条慢速拖动、触摸滑动）时，
视口不会停在用户滚到的位置：下一条内容到达就被自动滚动拉回底部。表现是「上滚没反应、
内容一刷新就弹回底部」，用户无法从底部脱身，只能一次滚出 2px 以上才停得住。影响面是所有
正在流式输出 / 工具运行 / 有新消息到达的场景，即用户最需要向上翻阅的时刻。

与 as-built 规格的差异：[docs/hosts/webview-ui.md 第 11 节](../../docs/hosts/webview-ui.md#11-消息区视图行为跳到底部发送模式与一次性通知)
声明「滚轮上滚仍抑制自动跟随」，[docs/features/user-stories.md](../../docs/features/user-stories.md)
US-47 验收标准 1 声明「用户向上滚动（任意幅度）」。当前实现两条都不成立。

## 现状

`src/webview/MessagesView.tsx` 的 `useAutoScroll` 用 `userScrolledAwayRef` 抑制自动滚动，
但「离开底部」与「回到顶部」两侧都按 2px 判定带处理，导致微小上滚既置不住位、又会被主动清零。

- **滚离置位**（scroll 监听的 `handleScroll`）要求同时满足 `distanceFromBottom > 2` 与单次
  scroll 事件位移 `scrollTop < lastScrollTop - 2`。`lastScrollTop` 每个事件都更新，所以这是
  逐事件阈值而非累计位移：滚动条慢速拖动、触摸滑动每帧只走 1px 时永远置不了位，无论累计
  上滚多远。
- **三处复位**无条件按 `distanceFromBottom <= 2` 清零同一标志：scroll 监听、ResizeObserver、
  流式 / 工具轮询。用户从底部上滚 1px 后距离正是 1px，落在这条判定带里。
- 滚轮监听 `handleWheel` 在 wheel 事件上先置位，但随后的 scroll 事件带着 distance=1 触发上面的
  复位分支，标志在同一次滚动的下一帧就被清掉。
- 标志为 false 时，内容到达的每条路径都会滚到底：`useLayoutEffect` 的追加分支
  （`hasNewMessage` → `scrollToBottom(true)`）、`scrollToBottom` 的 rAF 二次同步、
  渲染前预滚 `src/webview/hooks/useMessageHandler.ts` 的 `scrollToBottomBeforeRender` 与
  `MessagesView.tsx` 的 `handleBeforePreviewRender`（`distanceFromBottom <= 50` 即预滚）。
- 复现 A（滚轮）：时间线撑高并停在底部 → 滚轮 `deltaY = -1` → 距离 1px、标志被复位 →
  下一条助手消息到达 → 视口回到 `distanceFromBottom = 0`。
- 复现 B（拖动/触摸）：时间线撑高并停在底部 → 拖动滚动条 / 触摸滑动逐像素步进（每次 scroll
  位移 1px，`pointermove` 刷新输入时刻）→ 标志从未置位 → 下一条助手消息到达 → 视口回到底部。

## 期望

- 用户以真实滚动输入（wheel / touchmove / pointermove 拖动 / 键盘）从底部向上移动，即使只
  离开 1px，也置位滚离抑制，并在用户自己回到底部之前一直保持。
- 滚离期间，任何自动滚动路径（ResizeObserver、流式轮询、settle 轮询、`useLayoutEffect`
  追加分支、渲染前预滚、rAF 二次同步）都不得把视口拉回底部。
- 「回底恢复跟随」只允许由两种事实触发：真实滚动事件把位置带回 `distanceFromBottom <= 2`
  且该次位移不是向上滚出来的；或容器已经无可滚动区域（`scrollHeight <= clientHeight`）。
- 内容收缩导致浏览器 clamp `scrollTop`（向下回弹）不得被误判为用户上滚，从而错误置位。

## 不变量

- 会话加载、真实用户消息、`forceScrollKey` 的强制回底语义不变（仍清滚离并滚到底）。
- 系统自动消息（`origin=agent` / `origin=bash`、压缩摘要）不得重置滚离，不得把视口拉回底部。
- 跳到底部按钮的显隐口径不变：仍只由「一次向下滚轮手势累计位移 > 可视高度 1/3」显示，
  向上滚动任意幅度隐藏；滚离标志与按钮显隐保持解耦。
- `distanceFromBottom <= 2` 作为「是否在底部」的既有含义不变（`isAtBottomRef`、按钮回底隐藏、
  贴底断言同口径）。
- 流式跟随频率不增加：不得把每个流式帧变成额外的强制滚动。
- 不新增事件 / 契约成员 / 落盘字段，不改消息渲染结构。

## 回归测试

- **RT-1**：时间线撑高并停在底部 → 真实滚轮向上 1px（断言 `0 < distanceFromBottom <= 2`，
  确认落在判定带内）→ 追加一条助手消息 → 新消息可见后断言 `distanceFromBottom > 0`
  （落点：`e2e/webview/jumpToBottom.spec.ts`「US-47 底部上滚 1px 后新消息到达不把视口拉回底部」）
- **RT-2**：时间线撑高并停在底部 → `pointermove(buttons=1)` + `scrollTop -= 1` 逐像素步进
  （模拟慢速拖动滚动条，无滚轮输入；断言 `0 < distanceFromBottom <= 2`）→ 追加一条助手消息 →
  新消息可见后断言 `distanceFromBottom > 0`
  （落点：`e2e/webview/jumpToBottom.spec.ts`「US-47 慢速拖动上滚 1px 后新消息到达不把视口拉回底部」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "上滚 1px" --reporter=line --workers=1` | 红 | 源码侧 A/B：仅 `MessagesView.tsx` 回到修复前并重建 `dist/webview`，连跑两次均 2 failed。RT-1 / RT-2 都卡在收尾断言 `expect(after).toBeGreaterThan(0)`，实测 `distanceFromBottom = 0`（新消息到达后被拉回底部）；前置断言 `0 < distanceFromBottom <= 2` 全部通过——上滚确实只走 1px、落在判定带内，失败点是拉回 |
| 回归用例（修复后） | 同上 | 绿 | 2 passed；`e2e/webview/jumpToBottom.spec.ts` 整文件（含既有 US-47 与 once 用例）连跑 3 次均 7 passed。ResizeObserver / 流式轮询 / 展开收起的复位条件实现为 `distanceFromBottom <= SCROLL_JITTER_PX`（真的贴底），是「期望」第二条的等价实现，并顺带覆盖「内容收缩把 scrollTop 夹回底部」——只写 `scrollHeight <= clientHeight` 会漏掉 clamp 落点（不变量第 4 条） |
| 既有回归 | `npm run test:e2e:webview -- --reporter=line` | 绿 | 整轮跑 3 次：第 1、2 次 93 passed / 1 failed（第 1 次为 `messagePresentation.spec.ts`「US-13 mermaid 代码块带「预览图表」按钮」并发下 15s 超时；该文件单独跑 3 次均 7 passed，修复前源码上单独跑也 7 passed，用例不经过滚动路径），第 3 次 94 passed 全绿 |
| `check-types` | `npx tsc --noEmit` / `npx tsc --noEmit -p tsconfig.webview.json` | 绿 | 根工程与 webview 两份配置均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:all -- docs-lint` | 部分验证 | 43 通过 / 3 失败，3 项全部来自工作区既有文件：`docs/archive/specs/019-abort-hover-background-tasks/`（验证时在 `specs/` 下，后归档）的裸章节引用与 019 编号重复、`specs/defects/file-watch-rejects-missing-target.md` 的「绿*」取值非法。缺陷规格组只报后一个文件 1 处问题，本文件无告警 |

