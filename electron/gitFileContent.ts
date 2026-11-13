/**
 * 变更视图的 git 取数（specs/040 FR-001 / FR-003 / FR-004）。
 *
 * diff 的两侧都在主进程取：`before` 来自 `git show HEAD:<rel>`，`after` 来自读盘。
 * 三个方法都建立在既有的 `GitCommandRunner` 上（`electron/sidebarDocView.ts`），
 * **不新写一份 git 调用层**——远程工作区由 `electron/main.ts` 的 `remoteGitRunner`
 * （SSH exec）实现同一接口，行为一致。
 *
 * 刻意不 import electron：单测直接驱动（`src/test/gitFileContent.test.ts`）。
 */

import { GIT_COMMON_ARGS, type GitCommandRunner } from './sidebarDocView.js';

/**
 * 变更视图的取数接口。
 *
 * 三个方法都是「事实查询」，失败（超时 / 非零退出且不属于「不存在」）向上抛，
 * 由调用方转成视图错误态（spec 边界第 1 条：不静默空态）。
 */
export interface FileContentRunner {
  /** `git show <rev>:<path>`；无该版本（新增文件 / 无 HEAD 的新仓）返回 `null`，不是错误 */
  showAtHead(rel: string): Promise<string | null>;
  /**
   * 文件是否有 HEAD 版本。这是 spec FR-003 的「新增」判据：`false` 即新增。
   * 与 `sidebarDocView.ts` 的 git 口径同源，不另写一份跟踪状态判定。
   */
  hasHeadVersion(rel: string): Promise<boolean>;
  /** HEAD 内容是否与工作区当前内容相同（「没有改动」空态用，spec AC-2） */
  isClean(rel: string): Promise<boolean>;
}

/** git 是否已有 HEAD（全新的仓没有）：一次 `rev-parse --verify -q HEAD` */
async function hasHeadCommit(runner: GitCommandRunner): Promise<boolean> {
  const head = await runner.run([...GIT_COMMON_ARGS, 'rev-parse', '--verify', '-q', 'HEAD']);
  return head.code === 0;
}

/** 本地 / 远程共用同一实现：只依赖 `GitCommandRunner` 接口 */
export function fileContentRunner(runner: GitCommandRunner): FileContentRunner {
  return {
    async showAtHead(rel) {
      if (!(await hasHeadCommit(runner))) return null;
      const out = await runner.run([...GIT_COMMON_ARGS, 'show', `HEAD:${rel}`]);
      if (out.code === 0) return out.stdout;
      // git 对「该路径不在 HEAD 里」的报错（英文与本地化两版都认）
      if (/does not exist|exists on disk, but not in|不在|不存在/i.test(out.stderr)) return null;
      throw new Error(`git show 失败: ${out.stderr.trim()}`);
    },
    async hasHeadVersion(rel) {
      if (!(await hasHeadCommit(runner))) return false;
      const out = await runner.run([...GIT_COMMON_ARGS, 'cat-file', '-e', `HEAD:${rel}`]);
      return out.code === 0;
    },
    async isClean(rel) {
      const out = await runner.run([...GIT_COMMON_ARGS, 'diff', '--quiet', 'HEAD', '--', rel]);
      // `--quiet` 用退出码表达结果：0 = 无差异，1 = 有差异；其它值是真失败
      if (out.code === 0) return true;
      if (out.code === 1) return false;
      throw new Error(`git diff 失败（code ${out.code}）: ${out.stderr.trim()}`);
    },
  };
}

/** 本地工作区的取数器：`git -C <root>`（与 `localGitRunner` 同一套 spawn 口径） */
export function localFileContentRunner(
  runner: GitCommandRunner,
): FileContentRunner {
  return fileContentRunner(runner);
}
