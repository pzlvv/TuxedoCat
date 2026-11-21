/**
 * e2e 整应用实例的关闭（`e2e/helpers/processTeardown.ts` 的 `killSpawnedApp`）。
 *
 * 缺陷背景（`specs/defects/e2e-linux-teardown-leaves-orphans.md`）：Linux 分支原先是
 * `child.kill('SIGKILL')` 一行——只杀主进程、不等退出、不碰子进程。孤儿 Electron 子进程
 * 与下一条用例争 CPU，CDP 握手变慢 → 断言超时 → `retries: 1` 重试 → 又留孤儿，逐条放大。
 * 实测：同一份代码 Windows 整轮 2.5 分钟，Linux CI 140 分钟跑不完。
 *
 * 这些用例用**真实子进程**验行为，不是读源码猜：
 * - 起一个自己再 fork 一个孙进程的父进程，模拟 Electron 主进程 + GPU/renderer；
 * - 调用被测的关闭函数；
 * - 断言父与孙都真的消失（`process.kill(pid, 0)` 抛 ESRCH）。
 *
 * 跨平台：缺陷**只在 POSIX 上成立**——Windows 的 `child.kill()` 会连带结束子进程
 * （实测 `parent_alive=false grandchild_alive=false`），POSIX 只杀主进程
 * （实测 `parent_alive=false grandchild_alive=true`）。因此这些用例在 Windows 上必然
 * 通过（旧实现也能过），真正抓缺陷的是 CI 的 ubuntu `tests` job。Windows 上不静默跳过：
 * 打一行说明，让人知道本地这次没有验证到孤儿分支。
 *
 * 跑法：`npm run test:unit -- e2eProcessTeardown`（CI 在 Linux 上跑，才有判别力）
 */

import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { killSpawnedApp } from '../../e2e/helpers/processTeardown';
import { runTests } from './helpers/harness';

/** 缺陷只在 POSIX 成立（Windows 的 kill 语义会连带结束子进程） */
const IS_POSIX = process.platform !== 'win32';

/** 进程是否还活着（ESRCH = 已退出；EPERM = 活着但没权限，算活） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 轮询等到某 pid 消失，超时返回 false */
async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/**
 * 起一个「父 + 孙」进程树：父进程用 node 再 spawn 一个长睡的子进程，并把自己的 pid 与
 * 孙进程 pid 写到文件，供用例读取。
 *
 * 为什么不用 Electron：单测不该依赖 Electron 运行时；进程树形状才是被测对象。
 */
function spawnTree(marker: string): { child: ChildProcess; pidsFile: string } {
  const pidsFile = path.join(os.tmpdir(), `tc-teardown-${marker}.json`);
  fs.rmSync(pidsFile, { force: true });
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({
      parent: process.pid,
      grandchild: grandchild.pid,
    }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    // 与产品一致：POSIX 上让子进程自成进程组，关闭时才能整组杀
    detached: process.platform !== 'win32',
  });
  return { child, pidsFile };
}

/** 等 pids 文件出现并读出两个 pid */
async function readPids(pidsFile: string): Promise<{ parent: number; grandchild: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidsFile)) {
      const text = fs.readFileSync(pidsFile, 'utf8');
      if (text.trim().length > 0) {
        try {
          const parsed = JSON.parse(text) as { parent: number; grandchild: number };
          if (parsed.parent > 0 && parsed.grandchild > 0) return parsed;
        } catch {
          // 文件正在写，重试
        }
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等不到 pids 文件：${pidsFile}`);
}

/** 清理可能残留的进程（用例失败时兜底，避免污染后续运行） */
function forceKill(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已退出
  }
}

runTests('e2eProcessTeardown', async () => {
  // RT-1：关闭后**父进程真的消失**（不是发完信号就返回）
  {
    const marker = `parent-${process.pid}-${Date.now()}`;
    const { child, pidsFile } = spawnTree(marker);
    let pids: { parent: number; grandchild: number } | undefined;
    try {
      pids = await readPids(pidsFile);
      assert.ok(isAlive(pids.parent), '前提：父进程应存活');
      await killSpawnedApp({ child, ownsHomeDir: false, homeDir: '' });
      assert.ok(
        await waitGone(pids.parent, 5_000),
        `关闭后父进程 ${pids.parent} 仍存活——killSpawnedApp 发完信号就返回了`,
      );
    } finally {
      forceKill(pids?.parent);
      forceKill(pids?.grandchild);
      forceKill(child.pid);
      fs.rmSync(pidsFile, { force: true });
    }
  }

  // RT-2：关闭后**孙进程也消失**（杀的是进程树，不是单个进程）。
  // 这条是缺陷的判别用例：POSIX 上旧实现会留下孤儿（实测），Windows 上两种实现都通过。
  if (!IS_POSIX) {
    console.log('   skip  RT-2 孤儿断言：Windows 的 child.kill() 会连带结束子进程，测不出缺陷');
  } else {
    const marker = `tree-${process.pid}-${Date.now()}`;
    const { child, pidsFile } = spawnTree(marker);
    let pids: { parent: number; grandchild: number } | undefined;
    try {
      pids = await readPids(pidsFile);
      assert.ok(isAlive(pids.grandchild), '前提：孙进程应存活');
      await killSpawnedApp({ child, ownsHomeDir: false, homeDir: '' });
      assert.ok(
        await waitGone(pids.grandchild, 5_000),
        `关闭后孙进程 ${pids.grandchild} 仍存活——孤儿进程会与下一条用例争 CPU`,
      );
    } finally {
      forceKill(pids?.parent);
      forceKill(pids?.grandchild);
      forceKill(child.pid);
      fs.rmSync(pidsFile, { force: true });
    }
  }

  // RT-3：关的是沙箱目录（ownsHomeDir 为真时删掉）
  {
    const marker = `home-${process.pid}-${Date.now()}`;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-teardown-home-'));
    fs.writeFileSync(path.join(homeDir, 'marker.txt'), 'x');
    const { child, pidsFile } = spawnTree(marker);
    let pids: { parent: number; grandchild: number } | undefined;
    try {
      pids = await readPids(pidsFile);
      await killSpawnedApp({ child, ownsHomeDir: true, homeDir });
      assert.ok(!fs.existsSync(homeDir), '关闭后沙箱目录应被删除');
    } finally {
      forceKill(pids?.parent);
      forceKill(pids?.grandchild);
      forceKill(child.pid);
      fs.rmSync(pidsFile, { force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }

  // RT-4：对已退出的进程调用不抛错（幂等；调用方在启动失败路径上会重复调用）
  {
    const { child } = spawnTree(`gone-${process.pid}-${Date.now()}`);
    const pid = child.pid;
    forceKill(pid);
    await waitGone(pid ?? 0, 5_000);
    await killSpawnedApp({ child, ownsHomeDir: false, homeDir: '' });
    await killSpawnedApp({ child, ownsHomeDir: false, homeDir: '' });
    assert.ok(true, '对已退出进程重复关闭不抛错');
  }

  console.log('全部通过');
});
