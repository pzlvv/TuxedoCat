/**
 * Bash cwd 语义对等测试（Embedded ↔ Standalone）。
 *
 * Embedded `Bash.call` 用 `const cwd = input.cwd || context.cwd`：`input.cwd` **原样**
 * 交给 Node 的 `spawn({ cwd })`——相对路径由 OS 按宿主进程 cwd 解析（**不是**会话
 * 工作目录），`~` 也不展开；空串是假值，回退 `context.cwd`。
 *
 * Standalone 侧见 `core-rs/src/tools.rs` 的 `run_bash`，对应用例
 * `core-rs/src/tools_tests.rs::bash_passes_cwd_through_without_expansion`。
 *
 * 运行方式：npm run test:all -- bash-cwd-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../core/tools/bash/Bash';
import { createChecker, runTests } from './helpers/harness';

async function callBash(
  inputCwd: string,
  contextCwd: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await (BashTool as any).call(
    { command, cwd: inputCwd },
    {
      cwd: contextCwd,
      sessionId: 's1',
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => undefined,
    },
    undefined,
    undefined,
  );
  return result.data as { stdout: string; stderr: string; exitCode: number };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-cwd-parity-'));
  const sub = path.join(workspace, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'marker.txt'), 'here\n');

  try {
    // 绝对 cwd：正常命中
    const absolute = await callBash(sub, workspace, 'cat marker.txt');
    check('绝对 cwd 命中会话目录下的文件', absolute.stdout.includes('here'));

    // 相对 cwd：按宿主进程 cwd 解析，**不**按会话工作目录展开。
    // context.cwd 是会话工作目录；若实现按会话目录展开，这里会命中 marker.txt。
    const relative = await callBash('sub', workspace, 'cat marker.txt');
    if (relative.stdout.includes('here')) {
      console.error(
        `    相对 cwd 命中会话目录：stdout=${JSON.stringify(relative.stdout)} stderr=${JSON.stringify(relative.stderr)}`,
      );
    }
    check('相对 cwd 不按会话工作目录展开', !relative.stdout.includes('here'));

    // 空串是假值：回退 context.cwd
    const empty = await callBash('', workspace, 'cat sub/marker.txt');
    check('空 cwd 回退会话工作目录', empty.stdout.includes('here'));
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }

  finish();
}

runTests('bash-cwd-parity', run);
