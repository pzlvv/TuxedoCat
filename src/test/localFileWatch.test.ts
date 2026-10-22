/**
 * 本地查看器文件监听（`electron/localFileWatch.ts`，specs/018 FR-001 / FR-005）。
 *
 * 覆盖点：普通写入 → changed、删除 → deleted、关闭后不再上报。
 * 用真实临时目录 + 真实 `fs.watch`（该模块的职责就是平台 fs 行为，mock 掉就没有意义）；
 * 断言用带超时的轮询，不依赖固定 sleep。
 *
 * 运行方式：npm run test:all -- localFileWatch
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLocalFileWatcher, type LocalWatchEvent } from '../../electron/localFileWatch';
import { createChecker, runTests } from './helpers/harness';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-local-watch-'));
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'one');
  const events: LocalWatchEvent[] = [];
  const handle = createLocalFileWatcher(file, (event) => events.push(event), () => undefined);

  try {
    fs.writeFileSync(file, 'two');
    check('普通写入上报 changed', await waitFor(() => events.some((e) => e.kind === 'changed')));

    events.length = 0;
    fs.rmSync(file);
    check('删除上报 deleted', await waitFor(() => events.some((e) => e.kind === 'deleted')));

    events.length = 0;
    fs.writeFileSync(file, 'three');
    check('重建上报 changed', await waitFor(() => events.some((e) => e.kind === 'changed')));

    events.length = 0;
    const tmp = path.join(dir, '.note.txt.tmp');
    fs.writeFileSync(tmp, 'atomic');
    fs.renameSync(tmp, file);
    check('原子保存上报 changed', await waitFor(() => events.some((e) => e.kind === 'changed')));

    handle.close();
    events.length = 0;
    fs.writeFileSync(file, 'after-close');
    await new Promise((resolve) => setTimeout(resolve, 200));
    check('关闭后不再上报', events.length === 0);
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
}

runTests('localFileWatch', run);
