/**
 * 工作区批量关闭的判定（纯数据，无任何 import——主进程菜单组装与 src/test 单测共用）。
 *
 * 标签页右键菜单的两项批量动作（关闭所有空闲会话 / 关闭其它所有工作区）的「关哪些、
 * 要不要确认」判定在这里收敛为纯函数：主进程只负责收集事实（已打开的会话视图 /
 * sessionIsBusy）与执行，判定可单测——「候选＝该工作区已打开的会话视图（含子代理对话）」
 * 「当前选中的对话空闲也包含在内」「判定后转忙走既有逐会话确认」「汇总确认一次」
 * 这些口径漂了会红在 src/test/workspaceBatchClose.test.ts。
 */

/** 单个「已打开会话视图」的事实：sessionId 与它所属工作区的稳定 id（`workspaceRefKey`） */
export interface LoadedSessionFacts {
  sessionId: string;
  workspaceId: string;
}

/**
 * 「关闭所有空闲会话」的候选来源：右键工作区里**已打开**的会话视图（含子代理对话）。
 *
 * 只有已打开的会话有视图与运行时资源可卸。只出现在磁盘对话列表、本进程没打开过的
 * 会话不进候选——关它没有可卸的东西，却要发一条按 sessionId 路由的 `conversationClosed`，
 * 多 Connection 下 Client 查不到归属直接抛错（异常还会中断整批关闭，
 * 见 docs/hosts/electron-multi-workspace.md 第 8.2 节）。
 */
export function selectWorkspaceLoadedSessions(
  loaded: readonly LoadedSessionFacts[],
  workspaceId: string,
): string[] {
  return loaded
    .filter((session) => session.workspaceId === workspaceId)
    .map((session) => session.sessionId);
}

/** 单个会话的批量关闭事实：busy 由主进程在打开菜单时点收集 */
export interface WorkspaceSessionFacts {
  sessionId: string;
  /** 判定时刻该会话是否忙碌（含等待用户；判定依据 sessionBusyLevel !== 'idle'） */
  busy: boolean;
}

/**
 * 「关闭所有空闲会话」的可关清单：忙碌不动（没有进行中的工作才值得关），空闲即关
 * ——当前选中的对话只要空闲也包含在内（关闭后由既有关闭入口切到相邻会话）。
 * 返回空数组时菜单项置灰。
 */
export function selectClosableIdleSessions(sessions: readonly WorkspaceSessionFacts[]): string[] {
  return sessions.filter((session) => !session.busy).map((session) => session.sessionId);
}

/** 其余工作区的事实项 */
export interface OtherWorkspaceFacts {
  id: string;
  hasBusySession: boolean;
}

/** 「关闭其它所有工作区」的计划：目标清单 + 是否需要一次汇总确认（任一他区忙碌即需要） */
export interface CloseOthersPlan {
  needsConfirm: boolean;
  ids: string[];
}

/**
 * 汇总确认只弹一次：确认后全部关闭、取消则全部不动，不存在部分关闭。主进程执行时
 * 逐个走同一份工作区清理链；个别会话在确认后转忙的场景由既有逐会话忙碌确认兜底。
 */
export function summarizeOtherWorkspaces(workspaces: readonly OtherWorkspaceFacts[]): CloseOthersPlan {
  return {
    needsConfirm: workspaces.some((workspace) => workspace.hasBusySession),
    ids: workspaces.map((workspace) => workspace.id),
  };
}
