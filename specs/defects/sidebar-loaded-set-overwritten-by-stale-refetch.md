---
status: 已修
---

# 缺陷：侧栏清空「已打开」投影后靠异步重取补回，陈旧回包会覆盖更新的推送

侧栏的绿色「已打开」圆点是 `ChatViewManager` 持有的视图集合在渲染层的一份投影。侧栏每次收到
`sidebar:workspaces-changed` 都先把这份投影整体清空，再发一次异步重取（`getLoadedSessions`）
补回；重取回包没有新鲜度校验，只要目录代次没变就整体替换。当回包在**更新的推送之后**才落地
（CI 上主进程停顿期间即可发生），旧快照就把新事实盖掉，绿点永久消失且没有任何通道再纠正——
它在 [docs/architecture/contracts.md 第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager)
的「`loaded`（视图已打开）不进这两条流」下应是「owner 推送，侧栏只读」；侧栏自行清空并整体
替换这份投影，也就是让一个投影反过来充当写入点（`AGENTS.md` 架构铁律 4「一份事实只有一个
写入点」）。

## 现状

owner 与投影的口径（as-built 规格）：`loaded` 是 Electron 视图层事实，owner 是 `ChatViewManager`，
由它**单独推送** `sidebar:session-loaded-changed`；「已打开」按**装载完成**计。规格同时写明侧栏
渲染时把列表流 / 状态流 / loaded 流合并——侧栏是消费者，不是写入者。

侧栏的 `loadedSessions` 有三个写入点（`electron/sidebar/main.ts`）：

1. `onSessionLoadedChanged` —— 应用 owner 推送，整体替换（正确路径）；
2. `onWorkspacesChanged` —— **无条件执行 `loadedSessions = new Set()` 清空**，随后 render 一次，
   再发异步 `getLoadedSessions()` 重取，回包在 `generation === listGeneration` 时整体替换，
   否则丢弃；`.catch(() => undefined)` 静默吞掉失败；
3. 启动播种（`init` 里首次 `getLoadedSessions()` 的回包）—— 正常。

清空之后的恢复只有那条异步重取，而它是**没有版本号的快照**：主进程的
`ipcMain.handle('sidebar:get-loaded-sessions')` 直接同步返回 `chatViews.getLoadedSessionIds()`
的当时值。于是存在这样一条可发生（且在 CI 上由主进程停顿放大）的交错：

- 侧栏发出重取，主进程**尚未执行** handler；
- 期间某会话完成 `registerSession` → `emitLoadedChanged()` 推出一份**新**集合；
- handler 随后执行，读到的仍是旧集合；回包在新推送之后到达侧栏；
- 目录代次没变（一次切换只 +1，没有第二次切换），回包被当作有效值整体替换 →
  **新事实被旧值抹掉**。此后 loaded 流只在视图事件时推、无周期性补推（`electron/sidebar/main.ts`
  内与 loaded 相关的定时器为零），这份缺失不会被纠正。

可观察后果：侧栏列表里**行在、绿点没有**（行来自对话列表流，与本缺陷无关，因此不受影响）。
`all.yml` 的 run 45635252492 首轮 `e2e/electron/desktopShell.spec.ts` 的「关闭所有空闲对话」
即为此形态：失败时 `error-context.md` 的可达性快照里有 B 的对话行
（`在 e2e-menu-idle-b 里跑一轮 刚刚 2 条 1 个对话`）而断言 `loaded-dot` 报
`element(s) not found`——一个绿点都没有。

同一条分支上还有一处同类问题：`onWorkspacesChanged` 清空的注释只把「状态流不能清空」的理由
写给了 `sessionStates`（那里确实没清），`loadedSessions` 违反了同一条理由。

需要说明的边界：本地用探针（owner 与投影同时采样、DOM 变异观察、3 个 CPU 抢占进程 +
`repeat-each=3`）**未能复现**该交错——正常时序下投影在 1–3ms 内自行恢复。因此「CI 那次失败
正是这条交错」**没有被日志证实**：`all.yml` 的 electron 车道不开 `E2E_DEBUG`，侧栏对 loaded
变化零日志埋点，主进程 handler 也不记录调用与返回内容。

## 期望

- 侧栏**不写** `loaded` 这份投影：`onWorkspacesChanged` 不再清空 `loadedSessions`。切工作区
  不改变「哪些会话视图开着」这个事实，保留旧值到有新值覆盖即可（与 `sessionStates` 同口径）。
- 重取回包**不得覆盖**在它发起之后到达的推送：回包只在「发起之后没有任何新推送」时才可应用，
  否则丢弃。新鲜度判据落在侧栏侧即可，不新增 wire 消息、不新增契约成员、不改落盘字段。
- 重取失败**不得静默**：`.catch` 记一条日志（与 `getConversations` 分支的
  `console.error('[sidebar] reload conversations failed:', err)` 同口径），让同类问题下次能在
  artifact 里看见。
- 上述判定抽成不可 import `electron` 的纯模块，由单测直接驱动（与 `electron/sidebarFilesMode.ts`
  的既有做法一致），渲染层只做「读状态 → 调模块 → 写回」。

## 不变量

- `loaded` 事实的 owner 仍是 `ChatViewManager`；`getLoadedSessionIds()` 的判据（排除 `new-`
  临时 key、排除已销毁视图、经 `pendingOpens.onlySettled` 排除在途打开）不变。
- 推送时机不变：仍在视图 open / close / LRU 淘汰 / 装载完成 / 新建对话复用时推全量集合。
- 切换工作区后**列表**仍按新目录重新拉取，`conversations` 的等待态 / 搜索关键字清空、
  目录代次丢弃旧回包的行为不变（`loaded` 之外的部分不碰）。
- 侧栏绿点的渲染条件不变（`loadedSessions.has(sessionId)`），「已打开」仍按装载完成计。
- 「关闭所有空闲对话」等依赖绿点断言的功能语义不变。
- 不新增 IPC 通道、不新增落盘字段；e2e 钩子若引入必须与 `E2E_SLOW_LIST_ENV` /
  `E2E_REMOTE_GIT_OPS_ENV` 同口径（env 门控、不设时零行为差异）。

## 回归测试

- **RT-1**：侧栏 `onWorkspacesChanged` 分支不再无条件清空 loaded 投影，且重取失败留有日志
  （落点：`src/test/sidebarLoadedSet.test.ts`，用例「workspaces-changed 不清空已打开投影」——
  对 `electron/sidebar/main.ts` 该分支做接线检查，与 `sidebarFilesMode.test.ts` 的接线检查同法）。
- **RT-2**：陈旧回包被丢弃、新推送不被覆盖；无推送时回包正常应用；清空不再发生
  （落点：`src/test/sidebarLoadedSet.test.ts`，用例「重取回包不得覆盖发起后到达的推送」等纯函数断言）。
- **RT-3**：e2e 端到端——用 env 门控的惰回包钩子（`<envPrefix>_E2E_SLOW_LOADED_MS`）让
  `sidebar:get-loaded-sessions` 的回包晚于一次推送到达，断言该会话的绿点仍在
  （落点：`e2e/electron/sessions.spec.ts`，用例「陈旧 loaded 回包不覆盖新推送的绿点」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2（修复前） | `npm run test:unit -- sidebarLoadedSet` | 红 | 3 通过 / 3 失败：`RT-1 切工作区不清空 loadedSessions`、`RT-1 重取失败留日志`、`RT-2 回包应用前校验新鲜度` 全红——源码确有 `loadedSessions = new Set()`、确有 `.catch(() => undefined)`、确无版本校验 |
| RT-3（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "陈旧 loaded 回包"` | 红 | `loaded-dot` 报 `element(s) not found`，而同一时刻可达性快照里 B 的行仍在（`新工作区里的一轮 刚刚 2 条 1 个对话`）——与 CI run 45635252492 的失败形态一致 |
| RT-1 / RT-2（修复后） | `npm run test:unit -- sidebarLoadedSet` | 绿 | 15 断言全过：陈旧回包丢弃、新事实保留、同序下先发凭据作废、无推送时回包照常生效、推送可清空、非法载荷归一 |
| RT-3（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "陈旧 loaded 回包"` | 绿 | 陈旧回包 8s 后落地，绿点仍在（等过落地时刻再断言一次） |
| 既有回归（侧栏 / 主菜单） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app e2e/electron/sessions.spec.ts` | 绿 | 8 通过，含三条绿点用例与本轮新增的 RT-3 |
| 既有回归（多工作区 / 关闭空闲对话） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app e2e/electron/desktopShell.spec.ts` | 绿 | 见下一条备注 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 三份 tsconfig + eslint 无报错 |
| docsLint（本规格） | `npm run test:unit -- docs-lint` | 绿 | 章节引用失效 0 处、缺陷规格结构 0 处问题 |
| docsLintLocalOnlyPaths | `npm run test:unit -- docs-lint` | 绿 | 它 spawn 一次编译后的 docsLint 判退出码，docsLint 红时必然跟着红（本规格初次提交时即由此被带红） |
| CI 那次失败的实际交错 | — | not-run | `all.yml` 未开 `E2E_DEBUG`、侧栏无 loaded 日志，无法从 artifact 反查；本缺陷由「结构性违反 + 可复现的回归用例」立据，RT-3 已在回退版上红、在修复版上绿 |
