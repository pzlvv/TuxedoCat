---
status: 已修
---

# 缺陷：从 Agent 卡片跳到 dst 侧跨工作区对话后切标签页再切回，打开成另一条对话

多工作区标签页里「切回某个工作区时恢复哪条对话」的答案取自**视图 LRU 顺序**
（`ChatViewManager.setActiveWorkspace` 里 `[...this.lru].reverse().find(...)`）。
LRU 记录的是「最近被登记 / touch 过」，不是「用户最近看到过」：`new-` 临时视图的
正式 sessionId 是页面加载完成后才由 `registerSession` push 进 LRU 队尾的，因此
**空白的预加载新对话反而比刚从卡片跳转打开的跨工作区对话更「新」**。

复现路径（specs/025 FR-005 的跳转入口）：

1. 工作区 A、B 双开，A 为活动项；A 里派发带 `target` 的 `Agent` 调用；
2. 目标工作区 B 里出现 dst 侧跨工作区对话（顶层普通对话），等待它跑完；
3. 在 A 的 `Agent` 卡片上点会话 id 链接 → 宿主切到标签页 B 并打开该对话；
4. 切回标签页 A，再切回 B → 聊天区显示的是**另一条对话**（实测是 B 的后台预热 /
   新对话视图），侧栏选中行也跟着跑到那条对话上。

用户看到的效果是「我明明还开着那条 dst 对话，切个标签页回来就变成别的对话了」。

## 现状

- `ChatViewManager.setActiveWorkspace(workspace, id)` 按 LRU 倒序找该工作区第一个存活
  视图，命中即 `show()`；命中不到就 `openNewConversation(id)`。
- LRU 的 push 点有三处，都不是「用户看到过它」：`openNewConversation`（新建）、
  `createView` 路径之后 `openConversation` 的 `touch`，以及 `registerSession`（页面
  加载完成后把 `new-` 临时 key 换成正式 sessionId 并 `push` 到队尾）。
- 承载「该工作区上次看哪条对话」的持久语义没有任何字段：`lastShownByWorkspace`
  这类记录不存在，`show()` 只写 `currentSessionId`（全局唯一一个）。
- 复现命令（修复前红）：
  `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "从发起方 Agent 卡片跳转"`
  ——断言「切回 B 后侧栏选中行仍是 dst 对话」失败，实测侧栏 `.item.active` 落在
  另一条（`session_*`，即 B 的后台新对话视图）上。

## 期望

- 「切回工作区时恢复哪条对话」的依据是**用户最近实际看到的那条**：视图被切到前台
  （`show()`）时记下 `工作区 id → 视图 key`，切标签页时优先按它恢复。
- 该记录与视图生命周期同步：视图被销毁（关闭对话 / LRU 淘汰 / `disposeAll`）时，
  指向它的记录一并清掉，不留「记录命中但视图已死」的悬空态。
- `new-` 临时 key 转正（`registerSession`）时，若记录指向该临时 key，记录跟着换成正式
  sessionId——新建对话首次上报后切走再切回，仍回到这条对话。
- 没有记录（首次激活、记录已失效）时行为不变：回退到该目录最近使用的存活视图，
  再没有就新建对话。

## 不变量

- 视图不随标签页切换重建：`show()` 仍只做 `removeChildView` / `addChildView` + 聚焦，
  对话的滚动位置、草稿与运行状态一律保留。
- 标签页切换仍会切活动工作目录（provider + 侧栏列表 + 标题栏刷新），不因为恢复
  对话而少做任何一步。
- LRU 仍按原口径管理视图数量上限（`maxViews`）与淘汰（当前活动视图不淘汰）。
- 非活动标签页的后台预热视图继续保留（切过去直接 `show()`，不重新加载）。
- 工作区归属判等仍按 id（`workspaceRefKey`）而不是路径：远程同路径不同主机是两个
  工作区，各自的「上次对话」互不串。
- 关闭工作区 / 窗口的清理语义不变（`closeWorkspace` / `disposeAll` 语义不动）。

## 回归测试

- **RT-1**：e2e——从发起方 `Agent` 卡片跳到 dst 侧跨工作区对话，切到另一标签页再切回，
  侧栏选中行仍是那条 dst 对话且全局只有一行 `.item.active`（落点：
  `e2e/electron/crossWorkspaceAgent.spec.ts` 的「从发起方 Agent 卡片跳转到 dst 对话后
  切标签页再切回」）。
- **RT-2**：e2e——dst 侧对话从侧栏点开（不走跳转链路），切标签页再切回，选中行不丢
  （落点：同文件的「dst 侧跨工作区对话打开后切标签页再切回」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "从发起方 Agent 卡片跳转"` | 红 | 失败断言：切回 B 后侧栏 `.item.active` 不是 dst 对话（实测落在 `session_*` 新对话视图）；已单独 `git stash` 掉修复复跑确认红 |
| RT-1（修复后） | 同修复前命令 | 绿 | 切回 B 后 `.item[data-session-id="<dst>"]` 带 `active`，且全局只有一行 `.active` |
| RT-2（修复前后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "dst 侧跨工作区对话打开后切标签页"` | 绿 | 侧栏直接打开的路径本来就命中 LRU，加锁后仍绿（不回归） |
| 既有 US-56 回归 | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g US-56` | 绿 | 同文件四条用例（派发落点 / 输入禁用与返回发起方 / 设置继承与 creator 落盘 / 两条新用例）全过 |
| 类型与构建 | `npm run check-types:electron && npm run build:electron` | 绿 | — |
