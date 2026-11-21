/**
 * e2e 整应用实例的关闭（从 `electronApp.ts` 抽出的独立模块）。
 *
 * 为什么要独立成文件：关闭逻辑要被单测直接执行（`src/test/e2eProcessTeardown.test.ts`），
 * 而 `electronApp.ts` 顶层 import 了 `playwright` / `electron` 运行时，单测加载不了。
 * 这里只依赖 `node:child_process`，可以在任何平台直接跑。
 *
 * 平台语义（`specs/defects/e2e-linux-teardown-leaves-orphans.md` 的实测）：
 * - Windows：`child.kill()` 会连带结束子进程，`taskkill /T /F` 再兜一层并轮询等退出；
 * - POSIX：`child.kill()` **只杀主进程**，孙进程（Electron 的 GPU / renderer / Core）会
 *   变成孤儿。实测 `parent_alive=false grandchild_alive=true`。所以 POSIX 必须杀进程组。
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** 关闭所需的最小进程信息（`ChildProcess` 天然满足，便于直接传 `spawned.child`） */
export interface TeardownTarget {
  child: Pick<ChildProcess, 'pid' | 'kill'>;
  /** 是否拥有这个沙箱 HOME（是则关闭时删除） */
  ownsHomeDir: boolean;
  homeDir: string;
}

/** 等进程真正退出的上限（与 Windows 分支同口径） */
const EXIT_WAIT_MS = 10_000;

/** 进程是否还活着（ESRCH = 已退出；EPERM = 活着但没权限，算活） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 轮询等进程消失；超时返回 false（调用方不因此抛错——关闭是尽力而为） */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isAlive(pid);
}

/**
 * 关闭一个由 `launchApp` 拉起的整应用实例。
 *
 * 与 `e2e/README.md` 已知坑 17 同口径：**必须等进程树真正退出再返回**——串行用例下，
 * 下一个实例若与垂死的 Electron / Core 争 CPU，时序敏感的断言会偶发超时（实测回归）。
 *
 * 任何一步失败都不抛错（尽力而为），沙箱目录在 `finally` 里删。
 */
export async function killSpawnedApp(target: TeardownTarget): Promise<void> {
  try {
    const pid = target.child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        // Windows：taskkill 杀整棵树（GPU / 渲染器随父进程退出不可靠时兜底）
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
        });
        await waitForExit(pid, EXIT_WAIT_MS);
      } else {
        // POSIX：只 kill 主进程会留下孤儿（实测 parent_alive=false grandchild_alive=true），
        // 必须杀整个进程组。前提：spawn 时带 `detached: true`，子进程自成进程组、组号 = 子进程 pid。
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // 组杀失败（进程已退出 / 不是组长）时退回单进程，不让关闭失败
          target.child.kill('SIGKILL');
        }
        await waitForExit(pid, EXIT_WAIT_MS);
      }
    }
  } finally {
    if (target.ownsHomeDir) {
      const fs = await import('node:fs');
      await fs.promises.rm(target.homeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
