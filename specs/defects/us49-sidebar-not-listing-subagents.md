---
status: 已修
---

# 缺陷：US-49 e2e 首用例侧栏恒见 1 个会话（宿主侧列表已到 7）

`e2e/electron/subagentConcurrency.spec.ts` 首用例「并发上限 4：直取 + 跨轮排队均受限」
在侧栏计数断言上稳定红：`sb.locator('#list .item[data-session-id]').count()` 期望 7、
30s 轮询恒为 1。同文件第二用例（中止路径，同样的选择器与页面获取方式）通过，
`subagentExplorer.spec.ts` 的侧栏定位也正常。

## 现状

- 引擎与宿主侧行为正常（`E2E_DEBUG=1` 实测，2026-10-23，HEAD=`60dea61`）：
  - 首轮 4 个 `Agent` 调用全部启动，`Conversation list refreshed` 序列 1 → 5 → … → 7，
    「7 conversations」出现 21 次（父 1 + 子 6），发送后约 1.1s 内到达；
  - 6 个子代理首请求全部到达 mock LLM（另一轮失败面里该断言先通过、侧栏断言后红，
    两处证据互补：请求侧与宿主列表侧都成立）。
- 红的只有**侧栏页面的 DOM**：宿主反复刷新列表的同时，`sidebarPage()` 句柄下的
  `#list .item[data-session-id]` 恒为 1（只有父会话）。
- 归因排除：
  - 非本机负载（安静机器单独跑仍红）；
  - 非近期 specs/023 引入（在 `2bee849`（specs/023 的前一个提交）的独立 worktree
    里构建产物后复跑，同样红）；
  - 非选择器不匹配子代理条目（第二用例同选择器数到 5，`e2e/electron/subagentExplorer.spec.ts` 亦用之）。
- 该用例自 specs/005（`497456d`）落地时声称 e2e 147/147 全绿；此后某时点起转红，
  因 electron e2e 不在 CI、且此前无人重跑，转红时点无法从历史直接定位。

## 期望

- 侧栏 DOM 与宿主会话列表一致：6 个子代理会话创建后，侧栏列出父 1 + 子 6 共 7 条
  （US-49 验收「子代理会话出现在侧栏」）。
- 若根因在测试观察层（页面句柄过期 / 侧栏视图重建后旧句柄冻结），修 e2e 的页面
  获取方式；若在侧栏渲染（事件未驱动重渲），修渲染侧。二选一，以侧栏真实显示为准。

## 不变量

- 并发上限 4、FIFO 排队、排队者不提前建会话的引擎语义不变（本缺陷不涉引擎；
  首用例后半段的 `maxOverlap === 4` / FIFO 断言所依赖的数据均已在 mock 侧核实存在）。
- 第二用例（前台中止：排队取消、不建会话）与 `e2e/electron/subagentExplorer.spec.ts` 的侧栏交互不变。

## 回归测试

- **RT-1**：`npx playwright test -c e2e/playwright.config.ts --project=electron-app
  subagentConcurrency` 首用例绿（当前红，`Expected: 7, Received: 1`，30s 超时）。
- **RT-2**：第二用例持续绿（当前绿，防修复时回归中止路径）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 修复前的红（RT-1） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 红 | 首用例 `Expected: 7, Received: 1`（侧栏计数，30s 超时）；第二用例绿 |
| RT-2 既有绿（中止路径） | 同上 | 绿 | 第二用例（前台中止：排队取消、不建会话）持续绿——修复时不得回归 |
| 应用日志取证 | 同 RT-1 + `E2E_DEBUG=1` | 部分验证 | `Conversation list refreshed` 序列 1→5→…→7（21 次 `7 conversations`），宿主列表正常；侧栏 DOM 停在 1——红在侧栏观察层，不在引擎 |
| 前置归因 | `git worktree`（`2bee849`）构建 webview/electron/core 后复跑 | 红 | 排除 specs/023 及其后提交引入；worktree 用后即删 |
| 产物新旧归因 | `npm run build:core:host && npm run build:electron` 后复跑 | 红 | 排除产物过期 |
| 根因定位（只读代码） | 读 `electron/sidebar/main.ts` 的 `isSubExpanded` / `defaultSubExpanded` + `src/host/ui/conversationTreeDefaults.ts` | 绿 | 根因是用例期望写错，不是渲染缺陷：`SUBAGENT_AUTO_EXPAND_LIMIT = 5`，6 个子会话**默认折叠**只渲染父行 1 条；第二用例 4 个子会话 < 5 自动展开 → 5 条，所以它一直绿。`期望` 第一条「侧栏列出 7 条」在折叠态下不成立，产品行为与基线一致（阈值由 `src/test/conversationTreeDefaults.test.ts` 锁定） |
| 修复后（RT-1 + RT-2） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 绿 | 2 passed（11.8s）：用例先断言默认折叠 1 条，再点父会话 `toggle-sub` 展开断言 7 条 |
| 既有回归（阈值口径） | `node scripts/run-tests.mjs conversationTreeDefaults` | 绿 | 5 通过：默认展开阈值未改动 |
