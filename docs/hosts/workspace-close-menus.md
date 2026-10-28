---
owner: pzlvv
last_reviewed: 2026-10-28
---

# 规格：工作区标签页右键菜单的关闭动作

本规格描述多工作区标签页右键菜单里**关闭类**菜单项的候选、确认与执行语义；打开集合
与关闭确认的总口径（远程三选 / 本地两态，specs/031）见
[docs/hosts/electron-multi-workspace.md 第 8.2 节](electron-multi-workspace.md#82-关闭)，
本文件只展开右键菜单自己的差异。菜单的非关闭类条目（打开命令行 / 终端）见 [electron-multi-workspace.md 第 8.2 节](electron-multi-workspace.md#82-关闭)与
[第 14.1 节](electron-multi-workspace.md#141-入口与可用性)。

## 1. 菜单项与语义

- 「关闭」与标签页关闭按钮同一语义：存在忙碌会话先经与关闭按钮同一份确认（远程三选 /
  本地两态），之后走同一份清理链（`teardownWorkspace`）。
- 「关闭所有空闲会话」只作用于右键的工作区，候选＝该工作区**已打开**的对话视图
  （含子代理对话）：逐个按判定时刻的会话运行时快照判定忙闲（忙碌含等待用户不动），
  空闲即关——当前选中的对话只要空闲也包含在内，关闭后由既有关闭入口切到相邻会话；
  判定与执行分离，执行时逐会话走既有关闭入口——判定后转忙的会话在关闭时刻落入既有
  逐会话忙碌确认（确认则关、取消则跳过继续其余），不静默跳过。只出现在磁盘对话列表、
  本进程没打开过的会话不进候选：它没有可卸的视图与运行时资源，关闭它只会发一条按
  sessionId 路由的 `conversationClosed`，多 Connection 下查不到归属直接抛错（异常还会
  中断整批关闭）。判定纯函数在 `electron/workspaceBatchClose.ts`
  （`selectWorkspaceLoadedSessions` / `selectClosableIdleSessions` /
  `summarizeOtherWorkspaces`），口径由 `src/test/workspaceBatchClose.test.ts` 锁定。
  该工作区没有已打开的空闲对话时菜单项置灰。本地与远程（SSH）工作区同语义。
- 「关闭其它所有工作区」在任一其它工作区有忙碌会话时先弹**一次**汇总确认（取消则
  全部不动），确认后逐个工作区走同一份清理链（不经逐区确认，否则一次确认被放大成
  每区一次）。只有一张标签时置灰。

## 2. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 关闭候选 / 批量判定的纯函数 | `electron/workspaceBatchClose.ts` |
| 右键菜单装配 | `electron/main.ts`（标签页右键菜单） |
| 清理链 | `electron/main.ts`（`teardownWorkspace`） |
