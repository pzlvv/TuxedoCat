/**
 * 文档视图的 git 哨兵监听（specs/030 FR-003）。
 *
 * 会话内外 commit / stage / checkout 的唯一刷新触发源：对 git 目录与 `refs/heads`
 * 目录挂监听（这些操作必然原子替换其中文件），变更去抖合并后通知重取文档视图数据。
 * 本地用 `fs.watch` 目录（监听目录而不是单个文件：git 用 rename 替换 `HEAD` /
 * `index`，文件句柄会跟丢）；远程复用 specs/018 的 `watchWorkspaceFile` 通道。
 * 监听只优化刷新时机、不是事实来源——建立失败记日志，取数照常按需执行。
 *
 * IO 全部注入（`ElectronUIHost` 组装真实实现），`src/test/sidebarDocWatch.test.ts`
 * 用假 IO 驱动生命周期与分流。
 */

import type { WorkspaceEndpoint } from '../src/host/workspaceRef.js';

/** 哨兵 IO：由 ElectronUIHost 组装（本地 fs.watch / 远程 coreFacts 通道 / SSH 探测） */
export interface DocSentinelIo {
  /**
   * 解析 git 目录（本地 spawn / 远程 SSH exec `git rev-parse --absolute-git-dir`）：
   * 工作区根可能是仓库子目录，哨兵挂在真正的 `.git` 上。非 git（或探测失败）返回
   * null——非 git 工作区无任何监听（spec 非目标口径）。
   */
  resolveGitDir(workspacePath: string, endpoint: WorkspaceEndpoint | null): Promise<string | null>;
  /** 本地目录监听；建立失败返回 null（记日志，不阻断） */
  watchDir(dir: string, onChange: () => void): Promise<(() => void) | null>;
  /** 远端单路径监听（specs/018 通道） */
  watchRemote(request: { watchId: string; workspacePath: string; path: string }): Promise<{ ok: boolean; error?: string }>;
  /** 注销远端监听 */
  unwatchRemote(request: { watchId: string; workspacePath: string }): Promise<void>;
  /** 去抖后的失效信号（重取文档视图） */
  onInvalidate(workspaceId: string): void;
  log(...args: unknown[]): void;
}

interface SentinelEntry {
  workspaceId: string;
  workspacePath: string;
  stoppers: Array<() => void>;
  remoteWatchIds: string[];
  debounceTimer: NodeJS.Timeout | null;
}

export class DocSentinelManager {
  private readonly entries = new Map<string, SentinelEntry>();
  /** 远端 watchId → 工作区（workspaceFileChanged 分流表；watchId 不解析、只查表） */
  private readonly watchIdToWorkspace = new Map<string, string>();

  constructor(
    private readonly io: DocSentinelIo,
    private readonly debounceMs = 200,
  ) {}

  /** 开启某工作区的哨兵；重复开启幂等（已在监听则直接返回） */
  async enable(workspaceId: string, workspacePath: string, endpoint: WorkspaceEndpoint | null): Promise<void> {
    if (this.entries.has(workspaceId)) return;
    const entry: SentinelEntry = {
      workspaceId,
      workspacePath,
      stoppers: [],
      remoteWatchIds: [],
      debounceTimer: null,
    };
    // 先登记再接线：中途任何失败都能被 disable 干净收掉
    this.entries.set(workspaceId, entry);

    const gitDir = await this.io.resolveGitDir(workspacePath, endpoint);
    if (gitDir === null || gitDir.length === 0) {
      this.io.log(`doc sentinel: no git dir (${workspaceId})，非 git 工作区不监听`);
      return;
    }
    const targets = [gitDir, `${gitDir.replace(/[\\/]+$/, '')}/refs/heads`];
    if (endpoint !== null) {
      for (const [index, dir] of targets.entries()) {
        const watchId = `sidebar-doc:${index === 0 ? 'git' : 'heads'}:${workspaceId}`;
        const result = await this.io.watchRemote({ watchId, workspacePath, path: dir });
        if (result.ok) {
          this.watchIdToWorkspace.set(watchId, workspaceId);
          entry.remoteWatchIds.push(watchId);
        } else {
          this.io.log(`doc sentinel: remote watch failed (${dir}): ${result.error ?? 'unknown'}`);
        }
      }
      return;
    }
    for (const dir of targets) {
      const stop = await this.io.watchDir(dir, () => this.schedule(entry));
      if (stop !== null) entry.stoppers.push(stop);
      else this.io.log(`doc sentinel: watch unavailable (${dir})`);
    }
  }

  /** 停掉某工作区的哨兵（文档视图关闭 / 工作区关闭） */
  async disable(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    for (const stop of entry.stoppers) stop();
    for (const watchId of entry.remoteWatchIds) {
      this.watchIdToWorkspace.delete(watchId);
      await this.io.unwatchRemote({ watchId, workspacePath: entry.workspacePath }).catch(() => undefined);
    }
  }

  /** `workspaceFileChanged` 分流：命中哨兵 watchId → 去抖后发失效信号；返回是否被消费 */
  handleWatchEvent(watchId: string): boolean {
    const workspaceId = this.watchIdToWorkspace.get(watchId);
    if (workspaceId === undefined) return false;
    const entry = this.entries.get(workspaceId);
    if (!entry) return false;
    this.schedule(entry);
    return true;
  }

  private schedule(entry: SentinelEntry): void {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this.io.onInvalidate(entry.workspaceId);
    }, this.debounceMs);
  }
}
