---
owner: pzlvv
last_reviewed: 2026-11-07
---

# 规格：工作区菜单的会话整理与路径动作

本规格描述 Electron 宿主菜单里**处理工作区与会话**的条目的条目集、候选、确认与执行
语义：标签页右键菜单与主菜单里的同名动作共用同一批判据。打开集合与关闭确认的总口径
（远程三选 / 本地两态，specs/031）见
[docs/hosts/electron-multi-workspace.md 第 8.2 节](electron-multi-workspace.md#82-关闭)，
本文件只展开菜单自己的差异。终端类条目的可用性见 [第 14.1 节](electron-multi-workspace.md#141-入口与可用性)。

## 1. 菜单项与语义

标签页右键菜单按以下顺序装配（`electron/main.ts` 的 `popupTabContextMenu`）：
关闭 / 关闭所有空闲会话 / 关闭其它所有工作区 / 分隔线 / 复制工作区路径 / 打开命令行
（本地工作区）或打开终端（远程工作区）。

- 「关闭」与标签页关闭按钮同一语义：存在忙碌会话先经与关闭按钮同一份确认（远程三选 /
  本地两态），之后走同一份清理链（`teardownWorkspace`）。
- 「关闭所有空闲会话」只作用于右键的工作区，候选＝该工作区**已打开**的对话视图
  （含子代理对话）：逐个按判定时刻的会话运行时快照判定忙闲（忙碌含等待用户不动），
  空闲即关——当前选中的对话只要空闲也包含在内，关闭后由既有关闭入口切到相邻会话；
  判定与执行分离，执行时逐会话走既有关闭入口——判定后转忙的会话在关闭时刻落入既有
  逐会话忙碌确认（确认则关、取消则跳过继续其余），不静默跳过。只出现在磁盘对话列表、
  本进程没打开过的会话不进候选：它没有可卸的视图与运行时资源，关闭它只会发一条按
  sessionId 路由的 `conversationClosed`，多 Connection 下查不到归属直接抛错（异常还会
  中断整批关闭）。该工作区没有已打开的空闲对话时菜单项置灰。本地与远程（SSH）工作区
  同语义。
- 「关闭其它所有工作区」在任一其它工作区有忙碌会话时先弹**一次**汇总确认（取消则
  全部不动），确认后逐个工作区走同一份清理链（不经逐区确认，否则一次确认被放大成
  每区一次）。只有一张标签时置灰。
- 「复制工作区路径」把工作目录的路径写进剪贴板，两种工作区写的都是**目录本身**
  （`src/host/workspaceRef.ts` 的 `workspaceClipboardPath`）：本地是该目录的绝对路径，
  远程是目标机器上的目录串——不带 `scheme://user@host` 前缀，可直接粘进该工作区的
  终端 / 远端 shell，与侧栏文件浏览器「复制完整路径」的远程口径一致。展示形态另有
  `workspaceRefDisplayPath`（带连接目标前缀），两者不互相复用。条目恒可点：目录已不
  存在 / 远程不可连时照常可复制，此时路径正是排查要用的信息。
- 主菜单的「关闭所有空闲对话」是同一个批量动作的**跨工作区入口**：候选＝打开集合里
  每个工作区已打开的对话视图，忙闲判定、逐会话确认与执行序列与右键的「关闭所有空闲
  会话」完全一致（`selectClosableIdleSessionsAcrossWorkspaces`）。工作区标签不受影响。
  条目恒可点：主菜单页按建菜单时刻的内容缓存，运行时状态变化不重建（重建会关掉正在
  打开的菜单），按快照置灰会留下「会话已空闲、条目仍灰着」的陈旧态；点击时刻重新收集
  候选，没有可关的对话就 no-op。

判定纯函数在 `electron/workspaceBatchClose.ts`（`selectWorkspaceLoadedSessions` /
`selectClosableIdleSessions` / `selectClosableIdleSessionsAcrossWorkspaces` /
`summarizeOtherWorkspaces`），口径由 `src/test/workspaceBatchClose.test.ts` 锁定。

## 2. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 关闭候选 / 批量判定的纯函数 | `electron/workspaceBatchClose.ts` |
| 标签页右键菜单装配 | `electron/main.ts`（`popupTabContextMenu`） |
| 主菜单「关闭所有空闲对话」 | `electron/main.ts`（`buildMenuSections` / `closeAllIdleConversations`） |
| 复制路径的剪贴板取值 | `src/host/workspaceRef.ts`（`workspaceClipboardPath`） |
| 清理链 | `electron/main.ts`（`teardownWorkspace`） |
