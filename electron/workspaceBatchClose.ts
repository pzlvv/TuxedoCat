/**
 * 工作区批量关闭的判定（纯数据，无任何 import——主进程菜单组装与 src/test 单测共用）。
 *
 * 标签页右键菜单的两项批量动作（关闭所有空闲会话 / 关闭其它所有工作区）的「关哪些、
 * 要不要确认」判定在这里收敛为纯函数：主进程只负责收集事实（sessionIsBusy）与执行，
 * 判定可单测——「当前选中的对话空闲也包含在内」「判定后转忙走既有逐会话确认」
 * 「汇总确认一次」这些口径漂了会红在 src/test/workspaceBatchClose.test.ts。
 */

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
