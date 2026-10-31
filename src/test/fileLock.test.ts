/**
 * 单测：fileLock 陈旧锁抢占不破坏互斥、也不无限递归
 * （specs/defects/file-lock-stale-break-destroys-recreated-lock.md、
 * specs/defects/file-lock-stale-unlink-recursion.md）。
 *
 * RT-1 缺陷场景：等待者在 `openSync('wx')` 收到 EEXIST 后做陈旧判定，而持有者恰在这个
 * 间隙完成「释放 → 重建」。判定用的 `statSync` 撞上释放后的空窗抛 ENOENT，
 * `isLockStale` 把「锁已不存在」也判成 true，随后的 `unlinkSync` 删掉的是
 * **并发重建的新锁**——等待者 create 成功，与新持有者双持有。
 *
 * 用子进程脚本化这个交错：在 preload 里包一层 `Module._load`，让 fileLock 拿到的
 * `fs` 是带一次性故障注入的门面（第一次 openSync('wx') 对锁路径报 EEXIST、第一次
 * statSync 对锁路径抛 ENOENT），磁盘上预先放一把「新持有者」的活锁（pid 存活、
 * mtime 新鲜）。直接改写 fs 模块对象的属性在各 Node 版本上可行性不一（部分版本
 * 内置模块属性不可配置），子进程门面是跨版本稳定的注入点。
 *
 * RT-2 缺陷场景：陈旧锁的 `unlinkSync` 失败时（锁路径上是个目录 —— EISDIR），
 * 无条件重试 `tryCreateLock` 会「判定仍旧陈旧 → unlink 再失败 → 再递归」形成无界递归，
 * 栈溢出。真实路径不需注入 fs：`mkdir settings.json.lock` 造出同名目录即可。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLockSync, isLockStale, withFileLock } from '../shared/utils/fileLock.js';
import { createChecker, runTests } from './helpers/harness.js';

/**
 * 子进程脚本：装好门面后调用真实编译产物的 `withFileLock`，把结果打成一行 JSON。
 * 门面必须在 require fileLock 之前就位（Module._load 只影响之后的 require）。
 */
const CHILD_SOURCE = `
const Module = require('module');
const realFs = require('fs');
const path = require('path');

const lockPath = process.argv[2];
const fileLockPath = process.argv[3];
let openCalls = 0;
let statCalls = 0;
function fsError(code) { const err = new Error(code); err.code = code; return err; }
const facade = new Proxy(realFs, {
  get(target, prop) {
    if (prop === 'openSync') {
      return function (p, ...rest) {
        if (p === lockPath && openCalls++ === 0) throw fsError('EEXIST');
        return realFs.openSync(p, ...rest);
      };
    }
    if (prop === 'statSync') {
      return function (p, ...rest) {
        if (p === lockPath && statCalls++ === 0) throw fsError('ENOENT');
        return realFs.statSync(p, ...rest);
      };
    }
    return target[prop];
  }
});
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'fs') return facade;
  return origLoad.call(this, request, ...rest);
};

const { withFileLock } = require(fileLockPath);
(async () => {
  // 「新持有者」的活锁：pid 是本子进程（存活），时间戳新鲜——任何陈旧判据都不该命中
  const ownerContent = process.pid + ' ' + Date.now();
  realFs.writeFileSync(lockPath, ownerContent, 'utf8');
  let resolved = false;
  let errorMessage = null;
  try {
    await withFileLock(lockPath, async () => {
      // 修复后走不到这里：脚本化的交错里锁始终被「新持有者」持有
    });
    resolved = true;
  } catch (err) {
    errorMessage = String(err);
  }
  const exists = realFs.existsSync(lockPath);
  const contentUnchanged = exists && realFs.readFileSync(lockPath, 'utf8') === ownerContent;
  console.log(JSON.stringify({ resolved, errorMessage, exists, contentUnchanged }));
  process.exit(0);
})().catch((err) => { console.error(String(err)); process.exit(1); });
`;

runTests('fileLock', async () => {
  const { check, finish } = createChecker();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-filelock-'));
  const lockPath = path.join(dir, 'settings.json.lock');
  const childPath = path.join(dir, 'child.cjs');

  // 子进程里 require 的是编译产物（本测试文件也在 out/ 下）
  const fileLockPath = path.resolve(__dirname, '../shared/utils/fileLock.js');
  fs.writeFileSync(childPath, CHILD_SOURCE, 'utf8');

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [childPath, lockPath, fileLockPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`子进程异常退出（${code}）：${out}`));
    });
  });
  fs.rmSync(dir, { recursive: true, force: true });

  const result = JSON.parse(stdout) as {
    resolved: boolean;
    errorMessage: string | null;
    exists: boolean;
    contentUnchanged: boolean;
  };

  check(
    'withFileLock 不得在陈旧判定来自「文件消失」时成功拿锁（须以 failed to acquire 拒绝）',
    !result.resolved && result.errorMessage !== null
      && result.errorMessage.includes('failed to acquire file lock'),
  );
  check('并发重建的新锁未被 unlink', result.exists);
  check('新锁内容未被改写', result.contentUnchanged);

  // ---------- RT-2：陈旧锁删不掉时不得无限递归 ----------
  // 场景：锁路径上放的是**目录**（不是文件）——陈旧判定只看 mtime，老的 mtime 让它判为
  // 陈旧，`unlinkSync` 对目录报 EISDIR 被吞掉，随后无条件 `tryCreateLock` 递归：路径没变、
  // 判定还是陈旧、unlink 还是失败，形成无界递归，最终 RangeError（栈溢出）。真实触发面：
  // 被 `mkdir -p settings.json.lock` 之类的手误 / 同步工具建出的同名目录。
  {
    const recursiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-filelock-recursive-'));
    const staleDirLock = path.join(recursiveDir, 'settings.json.lock');
    fs.mkdirSync(staleDirLock);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(staleDirLock, old, old);
    check('前置条件：陈旧锁判据命中', isLockStale(staleDirLock));

    let syncError: unknown = null;
    let syncAcquired = false;
    try {
      syncAcquired = acquireLockSync(staleDirLock);
    } catch (err) {
      syncError = err;
    }
    check(
      'acquireLockSync 遇到删不掉的陈旧锁返回 false，不抛栈溢出',
      syncError === null && syncAcquired === false,
    );

    let asyncError: unknown = null;
    let asyncResolved = false;
    try {
      await withFileLock(staleDirLock, async () => undefined);
      asyncResolved = true;
    } catch (err) {
      asyncError = err;
    }
    check(
      'withFileLock 遇到删不掉的陈旧锁以 failed to acquire 拒绝，不抛栈溢出',
      !asyncResolved && asyncError instanceof Error
        && !(asyncError instanceof RangeError)
        && asyncError.message.includes('failed to acquire file lock'),
    );
    // 目录原样保留：删不掉的对象不能被「当成删掉」
    check('删不掉的锁路径原样保留', fs.statSync(staleDirLock).isDirectory());
    fs.rmSync(recursiveDir, { recursive: true, force: true });
  }

  finish();
});
