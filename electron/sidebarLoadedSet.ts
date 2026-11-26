/**
 * 侧栏「已打开」投影（绿点）的写入仲裁（Electron 专属）。
 *
 * 这份投影的事实 owner 是 `ChatViewManager`（`docs/architecture/contracts.md` 第 4 节：
 * `loaded` 不进列表流 / 状态流，由它单独推送）。侧栏是消费者，只做「读状态 → 调本模块 →
 * 写回」，因此本模块刻意不 import electron，单测直接驱动（与 `sidebarFilesMode.ts` 同法）。
 *
 * 为什么需要仲裁：侧栏除了消费推送，还要在切工作目录时主动重取一次快照（推送是
 * 「变化时才推」，重载 / 迟挂的场景要靠这次重取补空档）。但重取回包**没有版本号**，
 * 而它从发起到落地之间可能已经过去了若干次推送——直接整体替换就会用旧快照盖掉新事实，
 * 绿点永久消失且没有通道再纠正（`specs/defects/sidebar-loaded-set-overwritten-by-stale-refetch.md`）。
 *
 * 判据：重取只在「发起之后没有任何新推送」时才可应用。用单调递增的推送序号作版本，
 * 不引入 wire 字段、不改落盘格式。
 */

/** 归一化 IPC 传来的 loaded sessionId 列表（跨进程边界，做一次防御性校验） */
export function normalizeLoadedSessions(sessionIds: unknown): Set<string> {
  if (!Array.isArray(sessionIds)) return new Set();
  return new Set(sessionIds.filter((id): id is string => typeof id === 'string'));
}

/**
 * 一次重取的凭据：发起时刻的推送序号 + 该次重取自己的序号。
 *
 * 调用方拿到它之后唯一能做的是连同回包一起交回 `applyRefetch`；凭据本身不携带数据，
 * 过期判定完全由模块内部比较序号完成。
 */
export interface LoadedRefetchTicket {
  /** 发起时的推送序号：期间若 owner 又推过，回包即为旧快照 */
  readonly pushedAt: number;
  /** 本次重取自己的序号：同一推送序号下并发多次重取时用来判谁更旧 */
  readonly issuedAt: number;
}

/** 「已打开」投影的写入仲裁：当前集合 + 推送序号 */
export interface LoadedSetTracker {
  /** 当前应当渲染的集合（返回新 Set：调用方改它不影响内部状态） */
  current(): Set<string>;
  /** 消费 owner 推送：整体替换，并把推送序号 +1（唯一推进版本的事件） */
  applyPush(sessionIds: unknown): void;
  /** 发起一次重取的凭据；回包必须原样交回 `applyRefetch` */
  beginRefetch(): LoadedRefetchTicket;
  /**
   * 应用重取回包。
   *
   * 返回 true 表示已应用（发起后无新推送），false 表示丢弃（发起后已有新推送——新推送
   * 携带的是更新的事实，旧快照不得覆盖它）。
   */
  applyRefetch(ticket: LoadedRefetchTicket, sessionIds: unknown): boolean;
}

/**
 * 建一个仲裁器。
 *
 * `initial` 是启动播种值（首次装载时主动拉一次快照）；它不算一次推送，因此不推进序号——
 * 序号只用来区分「推送」与「重取」两种来源的先后。
 */
export function createLoadedSetTracker(initial?: unknown): LoadedSetTracker {
  let current = normalizeLoadedSessions(initial);
  let pushSeq = 0;
  // 已应用的重取世代：同一份推送序号下可能并发多次重取，后发的那次回包一旦应用，
  // 先发的那次即使同序也必须作废——否则晚到的旧快照仍会盖掉刚写入的新值。
  let appliedRefetch = 0;
  let refetchSeq = 0;

  return {
    current(): Set<string> {
      return new Set(current);
    },

    applyPush(sessionIds: unknown): void {
      current = normalizeLoadedSessions(sessionIds);
      pushSeq += 1;
      // 推送推进了版本，在途重取全部作废（凭据的 pushedAt 会小于 pushSeq）
      appliedRefetch = refetchSeq;
    },

    beginRefetch(): LoadedRefetchTicket {
      refetchSeq += 1;
      return { pushedAt: pushSeq, issuedAt: refetchSeq };
    },

    applyRefetch(ticket: LoadedRefetchTicket, sessionIds: unknown): boolean {
      // 发起之后已有新推送 —— 回包是旧快照，丢弃（这是本缺陷的修复点）
      if (ticket.pushedAt !== pushSeq) return false;
      // 同序下已有更晚发起的重取应用过：本次是更旧的快照，丢弃
      if (ticket.issuedAt < appliedRefetch) return false;
      current = normalizeLoadedSessions(sessionIds);
      appliedRefetch = ticket.issuedAt;
      return true;
    },
  };
}
