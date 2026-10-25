import {
  buildDocRows,
  collectGitEntries,
  countLines,
  normalizeRenamedPath,
  parseLsFiles,
  parseNumstat,
  probeGitWorkspace,
  type DocEntry,
  type GitCommandRunner,
} from '../../electron/sidebarDocView';
import { createChecker, runTests } from './helpers/harness';

/**
 * 文档视图纯逻辑（`electron/sidebarDocView.ts`）：numstat 解析与跳过规则、重命名
 * 路径归一、计行、git 口径编排（假 runner 驱动，含错误路径与无 HEAD 分支）、
 * 渲染行的层级铺平。真实 git 仓的端到端见 `sidebarDocViewGit.test.ts`。
 *
 * 运行方式：npm run test:all -- sidebarDocView
 */

/** 脚本化假 runner：按命令前缀给出回包（剥掉 `-c core.quotepath=false` 前缀后匹配）；
 * 未命中的 run 抛错（暴露编排里的意外命令） */
function fakeRunner(scripts: Array<{ match: string[]; code?: number; stdout?: string; stderr?: string }>): GitCommandRunner {
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const stripped = args[0] === '-c' ? args.slice(2) : args;
    const hit = scripts.find((s) => s.match.every((token, index) => stripped[index] === token));
    if (!hit) throw new Error(`未脚本的 git 调用: ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  return {
    run,
    readFile: async (rel) => (rel === 'missing.md' ? null : 'l1\nl2\nl3'),
    exists: async (rel) => rel !== 'deleted.md' && rel !== 'missing.md',
  };
}

runTests('sidebarDocView', async () => {
  const { check, finish } = createChecker();

  check('parseNumstat：常规行收集、0/0 与二进制跳过、重命名归一到新名',
    (() => {
      const text = [
        '3\t1\tdocs/a.md',
        '0\t0\told.md => new.md',
        '-\t-\tblob.md',
        '1\t1\trename/x.md => rename/y.md',
        '2\t0\tdocs/{old => new}/z.md',
      ].join('\n');
      const entries = parseNumstat(text);
      return entries.length === 3
        && entries[0].path === 'docs/a.md' && entries[0].plus === 3 && entries[0].minus === 1
        && entries[1].path === 'rename/y.md'
        && entries[2].path === 'docs/new/z.md';
    })());

  check('normalizeRenamedPath：引号剥除与空串拒绝',
    normalizeRenamedPath('"a b.md"') === 'a b.md'
    && normalizeRenamedPath('  plain.md ') === 'plain.md'
    && normalizeRenamedPath('') === null);

  check('countLines：末尾换行不另计、空文件 0 行',
    countLines('a\nb\nc') === 3
    && countLines('a\nb\nc\n') === 3
    && countLines('') === 0
    && countLines('单行') === 1);

  check('parseLsFiles：按行取路径、空行过滤',
    parseLsFiles('a.md\n\ndocs/b.md\n').join('|') === 'a.md|docs/b.md');

  const probeYes = await probeGitWorkspace(fakeRunner([{ match: ['rev-parse'], stdout: 'true\n' }]));
  const probeNo = await probeGitWorkspace(fakeRunner([
    { match: ['rev-parse'], code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' },
  ]));
  const probeErr = await probeGitWorkspace(fakeRunner([{ match: ['rev-parse'], code: 1, stderr: 'weird' }]));
  check('probeGitWorkspace：yes / no / 错误三分',
    probeYes === 'yes'
    && probeNo === 'no'
    && typeof probeErr === 'object' && probeErr.error.includes('weird'));

  const gitFlow = await collectGitEntries(fakeRunner([
    { match: ['rev-parse'], stdout: 'abc123\n' },
    {
      match: ['diff'],
      stdout: '3\t1\tdocs/a.md\n0\t0\told.md => new.md\n2\t2\tdeleted.md\n',
    },
    { match: ['ls-files', '--others'], stdout: 'new.md\nmissing.md\n' },
  ]));
  check('git 口径：numstat 收集 + 未跟踪计行 + 删除文件过滤',
    gitFlow.ok === true
    && gitFlow.mode === 'git'
    && gitFlow.ok && gitFlow.entries.length === 2
    && gitFlow.entries[0].path === 'docs/a.md' && gitFlow.entries[0].plus === 3
    && gitFlow.entries[1].path === 'new.md' && gitFlow.entries[1].plus === 3 && gitFlow.entries[1].minus === 0
    && !gitFlow.entries.some((e) => e.path === 'deleted.md'));

  const unborn = await collectGitEntries(fakeRunner([
    { match: ['rev-parse'], code: 1, stderr: '' },
    { match: ['ls-files'], stdout: 'staged.md\n' },
    { match: ['ls-files', '--others'], stdout: '' },
  ]));
  check('无 HEAD 新仓：索引内文件按全文行数计新增',
    unborn.ok === true
    && unborn.ok && unborn.entries.length === 1
    && unborn.entries[0].path === 'staged.md' && unborn.entries[0].plus === 3 && unborn.entries[0].minus === 0);

  const diffFail = await collectGitEntries(fakeRunner([
    { match: ['rev-parse'], stdout: 'abc\n' },
    { match: ['diff'], code: 129, stderr: 'boom' },
  ]));
  check('git 命令失败转错误态（不静默空列表）',
    diffFail.ok === false && (!diffFail.ok && diffFail.error.includes('boom')));

  const rows = buildDocRows([
    { path: 'docs/a.md', plus: 3, minus: 1 },
    { path: 'docs/sub/x.md', plus: 1, minus: 0 },
    { path: 'b.md', plus: null, minus: null },
  ] as DocEntry[]);
  check('buildDocRows：目录优先、深度铺平、全部层级展开',
    (() => {
      const seq = rows.map((r) => `${r.rel}:${r.kind}:${r.depth}`).join('|');
      return seq === 'docs:directory:0|docs/sub:directory:1|docs/sub/x.md:file:2|docs/a.md:file:1|b.md:file:0'
        && rows[3].plus === 3 && rows[3].minus === 1
        && rows[4].plus === null;
    })());

  check('buildDocRows：空条目给空行集', buildDocRows([]).length === 0);

  finish();
});
