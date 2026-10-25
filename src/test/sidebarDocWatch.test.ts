import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { DocSentinelManager, type DocSentinelIo } from '../../electron/sidebarDocWatch';
import { localGitRunner } from '../../electron/sidebarDocView';
import { createChecker, runTests } from './helpers/harness';

/**
 * 文档视图 git 哨兵（`electron/sidebarDocWatch.ts`，specs/030 FR-003）：生命周期
 * （挂 / 摘 / 幂等）、去抖合并、`workspaceFileChanged` 分流（哨兵命中、查看器
 * watchId 不误触）、非 git 不监听；本地监听用真实临时 git 仓验证 commit / stage
 * 触发。环境无 git 时真实仓部分跳过。
 *
 * 运行方式：npm run test:all -- sidebarDocWatch
 */

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args], { windowsHide: true });
}

function fakeIo(): {
  io: DocSentinelIo;
  watchedDirs: string[];
  remoteWatches: Array<{ watchId: string; workspacePath: string; path: string }>;
  unwatched: string[];
  invalidated: string[];
  dirCallbacks: Array<() => void>;
  stopped: string[];
} {
  const state = {
    watchedDirs: [] as string[],
    remoteWatches: [] as Array<{ watchId: string; workspacePath: string; path: string }>,
    unwatched: [] as string[],
    invalidated: [] as string[],
    dirCallbacks: [] as Array<() => void>,
    stopped: [] as string[],
  };
  const io: DocSentinelIo = {
    resolveGitDir: async (workspacePath) => `${workspacePath}/.git`,
    watchDir: async (dir, onChange) => {
      state.watchedDirs.push(dir);
      state.dirCallbacks.push(onChange);
      return () => {
        state.stopped.push(dir);
      };
    },
    watchRemote: async (request) => {
      state.remoteWatches.push(request);
      return { ok: true };
    },
    unwatchRemote: async (request) => {
      state.unwatched.push(request.watchId);
    },
    onInvalidate: (workspaceId) => state.invalidated.push(workspaceId),
    log: () => undefined,
  };
  return { io, ...state };
}

runTests('sidebarDocWatch', async () => {
  const { check, finish, markSkipped } = createChecker();

  // ── 假 IO：生命周期 / 去抖 / 分流 ──
  {
    const s = fakeIo();
    const manager = new DocSentinelManager(s.io, 20);
    await manager.enable('ws1', '/repo', null);
    await manager.enable('ws1', '/repo', null); // 幂等：重复开启不重复挂
    check('本地：.git 与 refs/heads 两目录、重复开启幂等',
      s.watchedDirs.join('|') === '/repo/.git|/repo/.git/refs/heads');

    s.dirCallbacks[0]();
    s.dirCallbacks[1]();
    s.dirCallbacks[0]();
    await sleep(60);
    check('本地：多次变更去抖合并为一次失效信号', s.invalidated.filter((id) => id === 'ws1').length === 1);

    await manager.disable('ws1');
    check('本地：disable 关闭全部 watcher', s.stopped.length === 2);
  }

  {
    const s = fakeIo();
    const manager = new DocSentinelManager(s.io, 20);
    await manager.enable('ws-r', '/srv/app', { host: 'h', port: 22, user: 'u', auth: null });
    const watchIds = s.remoteWatches.map((w) => w.watchId);
    check('远程：两条路径各一个 watchId（specs/018 通道）',
      s.remoteWatches.length === 2
      && s.remoteWatches[0].path === '/srv/app/.git'
      && s.remoteWatches[1].path === '/srv/app/.git/refs/heads'
      && watchIds[0] !== watchIds[1]
      && s.watchedDirs.length === 0);

    const handledKnown = manager.handleWatchEvent(watchIds[0]);
    const handledViewer = manager.handleWatchEvent('11111111-2222-3333-4444-555555555555');
    await sleep(60);
    check('分流：哨兵 watchId 命中并触发，查看器 watchId 不误触',
      handledKnown === true && handledViewer === false && s.invalidated.join() === 'ws-r');

    await manager.disable('ws-r');
    check('远程：disable 注销远端监听且后续事件不再消费',
      s.unwatched.length === 2 && manager.handleWatchEvent(watchIds[0]) === false);
  }

  {
    const s = fakeIo();
    const manager = new DocSentinelManager(s.io, 20);
    const io: DocSentinelIo = { ...s.io, resolveGitDir: async () => null };
    await new DocSentinelManager(io, 20).enable('plain', '/no/git', null);
    check('非 git：不挂任何监听', s.watchedDirs.length === 0);
    await manager.disable('plain');
  }

  // ── 真实临时 git 仓：commit / stage 触发（ElectronUIHost 注入的同一 fs.watch 实现） ──
  let gitOk = true;
  try {
    await exec('git', ['--version'], { windowsHide: true });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    markSkipped('环境无 git：真实仓触发分支未验证');
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-docwatch-'));
    try {
      await git(root, 'init', '-q');
      await git(root, 'config', 'user.email', 't@t');
      await git(root, 'config', 'user.name', 't');
      fs.writeFileSync(path.join(root, 'a.md'), 'one\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'base');

      const fired: string[] = [];
      const manager = new DocSentinelManager(
        {
          resolveGitDir: async (workspacePath) => {
            const out = await localGitRunner(workspacePath).run(['rev-parse', '--absolute-git-dir']);
            return out.code === 0 ? out.stdout.trim() : null;
          },
          watchDir: (dir, onChange) =>
            new Promise((resolve) => {
              try {
                const watcher = fs.watch(dir, () => onChange());
                resolve(() => watcher.close());
              } catch {
                resolve(null);
              }
            }),
          watchRemote: async () => ({ ok: false, error: 'not remote' }),
          unwatchRemote: async () => undefined,
          onInvalidate: (workspaceId) => fired.push(workspaceId),
          log: () => undefined,
        },
        50,
      );
      await manager.enable('real', root, null);
      await sleep(100);
      fired.length = 0;

      fs.writeFileSync(path.join(root, 'a.md'), 'one\ntwo\n');
      await git(root, 'add', 'a.md');
      await sleep(400);
      const stageFired = fired.length >= 1;
      fired.length = 0;

      await git(root, 'commit', '-q', '-m', 'second');
      await sleep(400);
      const commitFired = fired.length >= 1;

      await manager.disable('real');
      check('真实仓：stage 与 commit 都触达哨兵（去抖后各至少一次失效信号）',
        stageFired && commitFired);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  finish();
});
