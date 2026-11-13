import * as docViewModule from '../../electron/sidebarDocView';
import {
  buildDocRows,
  collectGitEntries,
  countLines,
  gitTail,
  normalizeRenamedPath,
  parseLsFiles,
  parseNumstat,
  probeGitWorkspace,
  unquoteGitPath,
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

/** 脚本化假 runner：按命令前缀给出回包（剥掉 `GIT_COMMON_ARGS` 前缀后匹配）；
 * 未命中的 run 抛错（暴露编排里的意外命令）。
 *
 * `runBatch` 逐条委托给 `run`：修复后 `collectGitEntries` 只发批处理，脚本表照旧按
 * 子命令匹配，用例读起来与逐条调用时一致。`lineCounts` 用同一份假内容计行。 */
function fakeRunner(scripts: Array<{ match: string[]; code?: number; stdout?: string; stderr?: string }>): GitCommandRunner {
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    const stripped = gitTail(args);
    // 前缀匹配 + 最长优先：`ls-files` 与 `ls-files --others` 都以 `ls-files` 开头，
    // 按 token 数降序取第一条（同长度保持声明顺序，即稳定排序）
    const hit = scripts
      .map((script, order) => ({ script, order }))
      .filter((entry) => entry.script.match.every((token, index) => stripped[index] === token))
      .sort((a, b) => (b.script.match.length - a.script.match.length) || (a.order - b.order))
      .map((entry) => entry.script)[0];
    if (!hit) throw new Error(`未脚本的 git 调用: ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  const readFile = async (rel: string): Promise<string | null> =>
    (rel === 'missing.md' ? null : 'l1\nl2\nl3');
  return {
    run,
    runBatch: async (commands) => {
      const replies: Array<{ code: number; stdout: string; stderr: string }> = [];
      for (const args of commands) replies.push(await run(args));
      return replies;
    },
    readFile,
    lineCounts: async (rels) => {
      const counts = new Map<string, number>();
      for (const rel of rels) {
        const content = await readFile(rel);
        if (content !== null) counts.set(rel, countLines(content));
      }
      return counts;
    },
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

  // 引号只剥两端、**不做 trim**：文件名允许首尾空格（` lead.md` / `trail.md `），
  // git 对这类名字既不引号包裹也不转义，trim 会把它们变成不存在的路径。
  check('normalizeRenamedPath：剥引号、保留首尾空格、空串拒绝',
    normalizeRenamedPath('"a b.md"') === 'a b.md'
    && normalizeRenamedPath(' lead.md') === ' lead.md'
    && normalizeRenamedPath('trail.md ') === 'trail.md '
    && normalizeRenamedPath('') === null);

  // git 在文件名含引号 / 反斜杠 / 制表符 / 换行时**即使 `core.quotepath=false`** 也用
  // C 风格引号包裹并转义（`"a\"b.md"`、`"tab\tname.md"`）。此前只剥两端引号、不反转义，
  // 回查存在性必然失败——这类文件在文档视图里整条消失。
  check('normalizeRenamedPath：C 风格引号内的转义被还原',
    normalizeRenamedPath('"a\\"b.md"') === 'a"b.md'
    && normalizeRenamedPath('"tab\\tname.md"') === 'tab\tname.md'
    && normalizeRenamedPath('"back\\\\slash.md"') === 'back\\slash.md');

  check('parseLsFiles：C 风格引号路径反转义',
    parseLsFiles('"a\\"b.md"\nplain.md\n"tab\\tname.md"\n').join('|')
      === 'a"b.md|plain.md|tab\tname.md');

  check('parseLsFiles / parseNumstat：首尾空格的文件名不被 trim 掉',
    parseLsFiles(' lead.md\ntrail.md \n').join('|') === ' lead.md|trail.md '
    && parseNumstat('1\t0\t lead.md\n2\t0\ttrail.md \n').map((e) => e.path).join('|')
      === ' lead.md|trail.md ');

  check('unquoteGitPath：连续八进制按 UTF-8 解码（quotepath 打开时的非 ASCII 字节）',
    unquoteGitPath('"\\303\\274n.md"') === 'ün.md'
    && unquoteGitPath('"ctl\\001x.md"') === 'ctl\u0001x.md'
    && unquoteGitPath('"q\\z.md"') === 'q\\z.md');

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
      // 已删除条目不再出现在这里：`--diff-filter=d` 让 git 自己剔掉（RT-1 的 exists=0）
      stdout: '3\t1\tdocs/a.md\n0\t0\told.md => new.md\n',
    },
    { match: ['ls-files', '--others'], stdout: 'new.md\n' },
    { match: ['ls-files'], stdout: '' },
  ]));
  check('git 口径：numstat 收集 + 未跟踪计行（纯重命名跳过）',
    gitFlow.ok === true
    && gitFlow.mode === 'git'
    && gitFlow.ok && gitFlow.entries.length === 2
    && gitFlow.entries[0].path === 'docs/a.md' && gitFlow.entries[0].plus === 3
    && gitFlow.entries[1].path === 'new.md' && gitFlow.entries[1].plus === 3 && gitFlow.entries[1].minus === 0
    && !gitFlow.entries.some((e) => e.path === 'old.md'));

  const unborn = await collectGitEntries(fakeRunner([
    { match: ['rev-parse'], code: 1, stderr: '' },
    { match: ['diff'], code: 128, stderr: 'fatal: bad revision' },
    { match: ['ls-files', '--others'], stdout: '' },
    { match: ['ls-files'], stdout: 'staged.md\n' },
  ]));
  check('无 HEAD 新仓：索引内文件按全文行数计新增',
    unborn.ok === true
    && unborn.ok && unborn.entries.length === 1
    && unborn.entries[0].path === 'staged.md' && unborn.entries[0].plus === 3 && unborn.entries[0].minus === 0);

  const diffFail = await collectGitEntries(fakeRunner([
    { match: ['rev-parse'], stdout: 'abc\n' },
    { match: ['diff'], code: 129, stderr: 'boom' },
    { match: ['ls-files', '--others'], stdout: '' },
    { match: ['ls-files'], stdout: '' },
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

  // ---------- 取数范围参数化（specs/041 FR-002 / FR-003） ----------
  // 各处 git 调用的 args 逐字断言：pathspec 只由 `pathspecFor` 定义，`all` 时 `--` 之后为空。
  // 取数走一次批处理，因此记录点在 `runBatch`（命令逐条记平）。
  {
    const calls: string[][] = [];
    const recordingRunner = (scripts: Array<{ match: string[]; stdout?: string }>): GitCommandRunner => {
      const base = fakeRunner(scripts.map((s) => ({ ...s, code: 0 })));
      return {
        ...base,
        runBatch: async (commands) => {
          for (const args of commands) calls.push(args);
          return base.runBatch(commands);
        },
      };
    };
    calls.length = 0;
    const allScope = await collectGitEntries(recordingRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['diff'], stdout: '1\t1\tsrc/app.ts\n' },
      { match: ['ls-files', '--others'], stdout: 'new.ts\n' },
      { match: ['ls-files'], stdout: '' },
    ]), 'all');
    const diffCall = calls.find((args) => args.includes('diff')) ?? [];
    const untrackedCall = calls.find((args) => args.includes('--others')) ?? [];
    check('scope=all：diff 不带 pathspec（`--` 后为空）',
      allScope.ok === true
      && JSON.stringify(diffCall.slice(diffCall.indexOf('--'))) === JSON.stringify(['--']));
    check('scope=all：ls-files --others 不带 pathspec',
      JSON.stringify(untrackedCall.slice(untrackedCall.indexOf('--'))) === JSON.stringify(['--']));
    check('scope=all：非 Markdown 文件进清单',
      allScope.ok && allScope.entries.some((e) => e.path === 'src/app.ts'));

    // 同一脚本换 scope=doc：args 与既有口径逐字一致
    calls.length = 0;
    await collectGitEntries(recordingRunner([
      { match: ['rev-parse'], stdout: 'abc\n' },
      { match: ['diff'], stdout: '' },
      { match: ['ls-files', '--others'], stdout: '' },
      { match: ['ls-files'], stdout: '' },
    ]), 'doc');
    const docDiffCall = calls.find((args) => args.includes('diff')) ?? [];
    const docUntrackedCall = calls.find((args) => args.includes('--others')) ?? [];
    check('scope=doc：diff 的 pathspec 是 Markdown 两份',
      JSON.stringify(docDiffCall.slice(docDiffCall.indexOf('--')))
        === JSON.stringify(['--', '*.md', '*.markdown']));
    check('scope=doc：ls-files --others 的 pathspec 是 Markdown 两份',
      JSON.stringify(docUntrackedCall.slice(docUntrackedCall.indexOf('--')))
        === JSON.stringify(['--', '*.md', '*.markdown']));
  }
  {
    // 无 HEAD 分支的 pathspec 也按 scope 走
    const calls: string[][] = [];
    await collectGitEntries({
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      runBatch: async (commands) => {
        for (const args of commands) calls.push(args);
        return commands.map((args) => (args.includes('rev-parse')
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 0, stdout: '', stderr: '' }));
      },
      readFile: async () => '',
      lineCounts: async () => new Map(),
      exists: async () => true,
    }, 'all');
    const lsFilesCall = calls.find((args) => args.includes('ls-files') && !args.includes('--others')) ?? [];
    check('无 HEAD + scope=all：ls-files 不带 pathspec',
      JSON.stringify(lsFilesCall.slice(lsFilesCall.indexOf('--'))) === JSON.stringify(['--']));
  }
  {
    // `all` 下纯重命名（numstat 0/0）跳过；已删除由 `--diff-filter=d` 交给 git，
    // 因此 git 的 numstat 输出里本来就没有它（这条断言的是「照样剔得干净」）。
    const allWithRenames = await collectGitEntries({
      run: async (args: string[]) => {
        const stripped = gitTail(args);
        if (stripped[0] === 'rev-parse') return { code: 0, stdout: 'abc\n', stderr: '' };
        if (stripped[0] === 'diff') {
          return {
            code: 0,
            stdout: '0\t0\told.ts => new.ts\n1\t0\tkept.ts\n',
            stderr: '',
          };
        }
        if (stripped[0] === 'ls-files') return { code: 0, stdout: '', stderr: '' };
        throw new Error(`未脚本的 git 调用: ${args.join(' ')}`);
      },
      runBatch: async (commands) => commands.map((args) => {
        const stripped = gitTail(args);
        if (stripped[0] === 'rev-parse') return { code: 0, stdout: 'abc\n', stderr: '' };
        if (stripped[0] === 'diff') {
          return { code: 0, stdout: '0\t0\told.ts => new.ts\n1\t0\tkept.ts\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }),
      readFile: async () => '',
      lineCounts: async () => new Map(),
      exists: async () => true,
    }, 'all');
    check('scope=all：纯重命名与已删除文件仍被剔除',
      allWithRenames.ok === true
      && allWithRenames.entries.length === 1
      && allWithRenames.entries[0].path === 'kept.ts');
  }

  // ---------- 远程往返次数（specs/defects/remote-change-list-n-plus-one-round-trips.md） ----------
  // 缺陷：远程工作区上每个变更条目各付一次 SFTP 往返（未跟踪整文件读回本地数行数、
  // 已删除逐条 stat），加上数条独立 git exec。这里用「调用次数」把往返次数钉住：
  // 一次 git 口径的取数只允许一次批处理 + 一次批量计行。
  {
    /**
     * 记录调用次数的 runner。
     *
     * 新增的两个成员（`runBatch` / `lineCounts`）在修复前不在 `GitCommandRunner` 里，
     * 这里按交叉类型声明：修复前它们只是被记录、永不被调用（量到就是缺陷），
     * 修复后成为真实契约成员。
     */
    type BatchRunner = GitCommandRunner & {
      runBatch: (commands: string[][]) => Promise<Array<{ code: number; stdout: string; stderr: string }>>;
      lineCounts: (rels: string[]) => Promise<Map<string, number>>;
    };
    const counting = (untracked: string = 'new.md') => {
      const counts = { run: 0, runBatch: 0, lineCounts: 0, exists: 0, readFile: 0 };
      const batchCalls: string[][] = [];
      const replies = (args: string[]): { code: number; stdout: string; stderr: string } => {
        const stripped = gitTail(args);
        if (stripped[0] === 'rev-parse') return { code: 0, stdout: 'abc\n', stderr: '' };
        if (stripped[0] === 'diff') return { code: 0, stdout: '3\t1\tdocs/a.md\n', stderr: '' };
        if (stripped[0] === 'ls-files') {
          // 索引内容段（无 HEAD 才用）与未跟踪段（`--others`）分开给：未跟踪才有行数
          return { code: 0, stdout: stripped.includes('--others') ? untracked : '', stderr: '' };
        }
        throw new Error(`未脚本的 git 调用: ${args.join(' ')}`);
      };
      const runner: BatchRunner = {
        run: async (args) => {
          counts.run += 1;
          return replies(args);
        },
        runBatch: async (commands) => {
          counts.runBatch += 1;
          for (const args of commands) batchCalls.push(args);
          return commands.map(replies);
        },
        lineCounts: async (rels) => {
          counts.lineCounts += 1;
          return new Map(rels.map((rel) => [rel, 4]));
        },
        readFile: async () => {
          counts.readFile += 1;
          return 'l1\nl2\n';
        },
        exists: async () => {
          counts.exists += 1;
          return true;
        },
      };
      return { runner, counts, batchCalls };
    };

    const first = counting();
    const result = await collectGitEntries(first.runner, 'all');
    check('RT-1 git 口径：四条事实一次往返取回，不再逐条 stat / 逐文件读',
      result.ok === true
      && first.counts.runBatch === 1
      && first.counts.run === 0
      && first.counts.exists === 0
      && first.counts.readFile === 0);

    const headOf = (args: string[]): string => gitTail(args)[0] ?? '';
    check('RT-2 diff 带 --diff-filter=d 与 --relative',
      (() => {
        const diffArgs = first.batchCalls.find((args) => headOf(args) === 'diff');
        if (!diffArgs) return false;
        return diffArgs.includes('--diff-filter=d') && diffArgs.includes('--relative');
      })());

    check('RT-2 批处理：四条命令同序（HEAD / diff / 索引 / 未跟踪），一次发出',
      first.counts.runBatch === 1
      && first.batchCalls.length === 4
      && first.batchCalls.map(headOf).slice(0, 3).join(',') === 'rev-parse,diff,ls-files'
      && first.batchCalls[3].includes('--others'));

    check('RT-3 未跟踪行数：一次批量计行，不逐文件读回内容',
      first.counts.lineCounts === 1
      && first.counts.readFile === 0
      && result.ok === true
      && result.entries.some((entry) => entry.path === 'new.md' && entry.plus === 4 && entry.minus === 0));

    check('RT-4 git 口径：取数命令带只读锁参数',
      (() => {
        const anyCall = first.batchCalls[0] ?? [];
        return anyCall.includes('--no-optional-locks')
          && anyCall.includes('core.untrackedCache=false')
          && anyCall.includes('core.fsmonitor=false');
      })());

    // 无未跟踪文件时不发这次批量计行（不白付一次往返）
    const noUntracked = counting('');
    const emptyUntracked = await collectGitEntries(noUntracked.runner, 'doc');
    check('RT-3 无未跟踪文件：不发批量计行',
      emptyUntracked.ok === true && noUntracked.counts.lineCounts === 0);

    const failed = await collectGitEntries({
      run: async () => ({ code: 129, stdout: '', stderr: 'boom' }),
      runBatch: async () => [
        { code: 0, stdout: 'abc\n', stderr: '' },
        { code: 129, stdout: '', stderr: 'boom' },
        { code: 0, stdout: '', stderr: '' },
        { code: 0, stdout: '', stderr: '' },
      ],
      lineCounts: async () => new Map(),
      readFile: async () => null,
      exists: async () => false,
    } as BatchRunner);
    check('RT-5 git 失败：带 stderr 原文的错误态，不静默空列表',
      failed.ok === false && failed.error.includes('boom'));
  }

  // 批处理脚本与输出解析是可单测的纯函数
  {
    const batch = docViewModule as unknown as {
      buildGitBatchScript?: (commands: string[][]) => string;
      parseGitBatchOutput?: (
        stdout: string,
        commandCount: number,
      ) => Array<{ code: number; stdout: string; stderr: string }>;
    };
    const script = batch.buildGitBatchScript?.([['rev-parse', '--verify', '-q', 'HEAD']]);
    check('RT-6 批处理脚本：每条命令带独立标记段',
      typeof script === 'string'
      && script.includes('rev-parse')
      && /__GIT_BATCH_BEGIN_[0-9]+__/.test(script)
      && /__GIT_BATCH_CODE_[0-9]+__/.test(script));

    const stdoutSample = [
      '__GIT_BATCH_BEGIN_0__',
      'true',
      '__GIT_BATCH_CODE_0__0',
      '__GIT_BATCH_ERR_0__',
      '__GIT_BATCH_ERREND_0__',
      '__GIT_BATCH_BEGIN_1__',
      '3\t1\tdocs/a.md',
      '__GIT_BATCH_CODE_1__0',
      '__GIT_BATCH_ERR_1__',
      'warn',
      '__GIT_BATCH_ERREND_1__',
    ].join('\n') + '\n';
    const parsed = batch.parseGitBatchOutput?.(stdoutSample, 2) ?? [];
    check('RT-6 批处理输出：按标记还原 code / stdout / stderr',
      parsed.length === 2
      && parsed[0].code === 0 && parsed[0].stdout === 'true\n'
      && parsed[1].code === 0 && parsed[1].stdout === '3\t1\tdocs/a.md\n'
      && parsed[1].stderr === 'warn\n');

    let mismatch = false;
    try {
      batch.parseGitBatchOutput?.('__GIT_BATCH_BEGIN_0__\ntrue\n__GIT_BATCH_CODE_0__0\n', 3);
    } catch {
      mismatch = true;
    }
    check('RT-6 批处理输出：命令数不匹配时报错而不是错位还原', mismatch);
  }

  // 远端拼装：批处理与逐条调用必须用同一份工作目录（`-C <root>`）。
  // 批处理漏掉 `-C` 时远端在 SSH 登录目录跑 git，两个变更视图在远程工作区上整条
  // 报错；本地实现带 `-C` 不会暴露，因此只能在这一层锁定
  //（specs/defects/remote-git-batch-drops-worktree-cwd.md）。
  {
    const remote = docViewModule as unknown as {
      buildRemoteGitCommand?: (root: string, args: string[]) => string;
      buildRemoteGitBatchScript?: (root: string, commands: string[][]) => string;
    };
    const root = '/home/u/work space/sub';
    const prefix = `git '-C' '/home/u/work space/sub' `;
    const single = remote.buildRemoteGitCommand?.(root, ['diff', '--numstat', 'HEAD', '--']);
    check('RT-1 远端单条命令：`git -C <root>` 且工作目录单引号转义',
      typeof single === 'string'
      && single.startsWith(prefix)
      && single.includes("'diff'"));

    const batchScript = remote.buildRemoteGitBatchScript?.(root, [
      ['rev-parse', '--verify', '-q', 'HEAD'],
      ['diff', '--numstat', '-M', '--relative', '--diff-filter=d', 'HEAD', '--'],
    ]) ?? '';
    const gitLines = batchScript.split('\n').filter((line) => line.startsWith('git '));
    check('RT-2 远端批处理：每条命令都带 `-C <root>`（与单条同一份拼接）',
      gitLines.length === 2
      && gitLines.every((line) => line.startsWith(prefix))
      && (gitLines[1] ?? '').includes("'--relative'"));

    const lineCountsCmd = docViewModule
      .buildRemoteLineCountsCommand('/home/u/work space/sub', ['new.md', "we'ird.md"]) ?? '';
    // `sh -c <脚本> sh <root> <rels…>`：`-c` 之后第一个参数必须是 `$0` 占位，否则脚本里
    // 的 `cd "$1"` 会 cd 到第一个相对路径（specs/defects/remote-line-counts-shifts-cwd-into-first-path.md）
    check('RT-3 远端计行：`sh -c` 的 `$0` 已占位，工作区根是 `$1`',
      lineCountsCmd.startsWith(`sh -c '`)
      && lineCountsCmd.includes(`' 'sh' '/home/u/work space/sub' 'new.md' 'we'\\''ird.md'`)
      && lineCountsCmd.includes('cd "$1"'));
  }

  finish();
});
