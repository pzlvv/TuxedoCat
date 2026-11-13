import { fileContentRunner } from '../../electron/gitFileContent';
import { gitTail, type GitCommandRunner } from '../../electron/sidebarDocView';
import { createChecker, runTests } from './helpers/harness';

/**
 * 变更视图的 git 取数（`electron/gitFileContent.ts`，specs/040 FR-001 / FR-003）。
 *
 * 覆盖点：
 * - `showAtHead`：HEAD 有该文件 → 原文；HEAD 无该文件 → null（不是错误）；
 *   无 HEAD 的新仓 → null；真失败（非「不存在」）向上抛；
 * - `hasHeadVersion`：「新增」判据，与 FR-003 的映射表同源；
 * - `isClean`：`diff --quiet` 的退出码语义（0 无差异 / 1 有差异 / 其它为失败）。
 *
 * 运行方式：npm run test:unit -- git-file-content
 */

/** 脚本化假 runner：按命令前缀给出回包，并记录每次调用的参数（逐字断言用） */
function fakeRunner(
  scripts: Array<{ match: string[]; code?: number; stdout?: string; stderr?: string }>,
  calls: string[][] = [],
): GitCommandRunner {
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push(args);
    const stripped = gitTail(args);
    const hit = scripts.find((entry) => entry.match.every((token, index) => stripped[index] === token));
    if (!hit) throw new Error(`未脚本的 git 调用: ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  return {
    run,
    runBatch: async (commands) => {
      const replies: Array<{ code: number; stdout: string; stderr: string }> = [];
      for (const args of commands) replies.push(await run(args));
      return replies;
    },
    readFile: async () => null,
    lineCounts: async () => new Map(),
    exists: async () => true,
  };
}

runTests('gitFileContent', async () => {
  const { check, finish } = createChecker();

  // ---------- showAtHead ----------
  {
    const calls: string[][] = [];
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['show'], stdout: 'old content\n' },
    ], calls));
    const text = await runner.showAtHead('src/a.ts');
    check('HEAD 有该文件：返回原文', text === 'old content\n');
    const showCall = calls.find((args) => args.includes('show')) ?? [];
    check('show 的参数逐字（含 HEAD:<rel>）',
      JSON.stringify(gitTail(showCall)) === JSON.stringify(['show', 'HEAD:src/a.ts']));
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['show'], code: 128, stderr: "fatal: path 'src/new.ts' does not exist in 'HEAD'" },
    ]));
    check('HEAD 无该文件：返回 null（新增，不是错误）', (await runner.showAtHead('src/new.ts')) === null);
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], code: 128, stderr: "fatal: Needed a single revision" },
    ]));
    check('无 HEAD 的新仓：返回 null', (await runner.showAtHead('a.ts')) === null);
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['show'], code: 128, stderr: 'fatal: bad object' },
    ]));
    let thrown = '';
    try {
      await runner.showAtHead('a.ts');
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    check('真失败向上抛（不静默当空文件）', thrown.includes('git show 失败'));
  }

  // ---------- hasHeadVersion ----------
  {
    const calls: string[][] = [];
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['cat-file'], code: 0 },
    ], calls));
    check('有 HEAD 版本 → true', (await runner.hasHeadVersion('a.ts')) === true);
    const catCall = calls.find((args) => args.includes('cat-file')) ?? [];
    check('cat-file 的参数逐字',
      JSON.stringify(gitTail(catCall)) === JSON.stringify(['cat-file', '-e', 'HEAD:a.ts']));
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['cat-file'], code: 128, stderr: 'fatal: Not a valid object name' },
    ]));
    check('无 HEAD 版本 → false（新增判据）', (await runner.hasHeadVersion('new.ts')) === false);
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], code: 128 },
    ]));
    check('无 HEAD 的新仓 → 全部视为新增', (await runner.hasHeadVersion('a.ts')) === false);
  }

  // ---------- isClean ----------
  {
    const calls: string[][] = [];
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['diff'], code: 0 },
    ], calls));
    check('diff --quiet 退出 0 → 无改动', (await runner.isClean('a.ts')) === true);
    const diffCall = calls.find((args) => args.includes('diff')) ?? [];
    check('diff 的参数逐字（HEAD + -- + rel）',
      JSON.stringify(gitTail(diffCall)) === JSON.stringify(['diff', '--quiet', 'HEAD', '--', 'a.ts']));
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['diff'], code: 1 },
    ]));
    check('diff --quiet 退出 1 → 有改动', (await runner.isClean('a.ts')) === false);
  }
  {
    const runner = fileContentRunner(fakeRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['diff'], code: 129, stderr: 'usage: git diff' },
    ]));
    let thrown = '';
    try {
      await runner.isClean('a.ts');
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    check('diff 其它退出码是真失败（不当作「有改动」）', thrown.includes('git diff 失败'));
  }

  finish();
});
