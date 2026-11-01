import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  collectGitEntries,
  collectRecordEntries,
  localGitRunner,
  probeGitWorkspace,
} from '../../electron/sidebarDocView';
import { createChecker, runTests } from './helpers/harness';

/**
 * 文档视图 git 口径的真实仓库端到端（`localGitRunner` + `collectGitEntries`）：
 * 修改 / 纯重命名跳过 / 未跟踪计行 / 删除过滤 / .gitignore / 无 HEAD 新仓 /
 * 探测分流。环境无 git 时整组跳过（产品本身硬依赖 git，此分支只是护栏）。
 *
 * 运行方式：npm run test:all -- sidebarDocViewGit
 */

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args], { windowsHide: true });
}

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

async function gitAvailable(): Promise<boolean> {
  try {
    await exec('git', ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

runTests('sidebarDocViewGit', async () => {
  const { check, finish, markSkipped } = createChecker();
  if (!(await gitAvailable())) {
    markSkipped('环境无 git：真实仓库用例未验证');
    finish();
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-docview-git-'));
  try {
    // —— 仓一：常规变更（修改 / 纯重命名 / 删除 / 未跟踪 / 忽略）——
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 't@t');
    await git(root, 'config', 'user.name', 't');
    writeLines(path.join(root, 'docs/a.md'), ['a1', 'a2', 'a3']);
    writeLines(path.join(root, 'b.md'), ['b1', 'b2']);
    writeLines(path.join(root, 'gone/d.md'), ['d1']);
    writeLines(path.join(root, 'keep.txt'), ['x']);
    writeLines(path.join(root, '.gitignore'), ['ignored.md']);
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'base');

    writeLines(path.join(root, 'docs/a.md'), ['a1', 'a3', 'n1', 'n2']); // -1 / +2
    await git(root, 'mv', 'b.md', 'c.md'); // 纯重命名：0/0 跳过
    fs.rmSync(path.join(root, 'gone/d.md')); // 删除：过滤
    writeLines(path.join(root, 'new.md'), ['x', 'y', 'z']); // 未跟踪：+3/-0
    writeLines(path.join(root, 'ignored.md'), ['i']); // 被忽略：不出现

    const runner = localGitRunner(root);
    const probe = await probeGitWorkspace(runner);
    const result = await collectGitEntries(runner);
    const listed = result.ok ? result.entries.map((e) => `${e.path} +${e.plus}/-${e.minus}`) : [];
    check('真实仓：修改 + 未跟踪命中，纯重命名 / 删除 / 忽略不出现',
      probe === 'yes'
      && result.ok === true
      && listed.join('|') === 'docs/a.md +2/-1|new.md +3/-0');

    const record = await collectRecordEntries(
      ['docs/a.md', 'gone/d.md', 'c.md'],
      runner.exists,
    );
    check('记录口径：现存条目保留（无行数），已删除过滤',
      record.map((e) => `${e.path}:${e.plus}`).join('|') === 'c.md:null|docs/a.md:null');

    // —— 仓一（续）：文件名需要 git 的 C 风格引号转义（引号 / 制表符）——
    // `core.quotepath=false` 只关掉非 ASCII 的八进制转义；含 `"`、`\`、制表符、换行的
    // 路径仍然被双引号包裹并逐字符转义。未反转义时回查存在性必然失败，条目整条消失。
    const quotedName = 'quo"te.md';
    const tabName = 'tab\tname.md';
    writeLines(path.join(root, quotedName), ['q1', 'q2']);
    writeLines(path.join(root, tabName), ['t1']);
    const quotedResult = await collectGitEntries(runner);
    const quotedListed = quotedResult.ok ? quotedResult.entries.map((e) => `${e.path} +${e.plus}/-${e.minus}`) : [];
    check('真实仓：含引号 / 制表符的文件名同样列出（C 风格引号被反转义）',
      quotedListed.includes(`${quotedName} +2/-0`) && quotedListed.includes(`${tabName} +1/-0`));

    // —— 仓二：无 HEAD 新仓（已暂存按全文计）——
    const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-docview-unborn-'));
    try {
      await git(unborn, 'init', '-q');
      await git(unborn, 'config', 'user.email', 't@t');
      await git(unborn, 'config', 'user.name', 't');
      writeLines(path.join(unborn, 'staged.md'), ['s1', 's2', 's3', 's4', 's5']);
      writeLines(path.join(unborn, 'u.md'), ['u1', 'u2']);
      await git(unborn, 'add', 'staged.md');
      const unbornResult = await collectGitEntries(localGitRunner(unborn));
      const unbornListed = unbornResult.ok
        ? unbornResult.entries.map((e) => `${e.path} +${e.plus}/-${e.minus}`)
        : [];
      check('无 HEAD 新仓：已暂存与未跟踪都按全文行数计',
        unbornListed.join('|') === 'staged.md +5/-0|u.md +2/-0');
    } finally {
      fs.rmSync(unborn, { recursive: true, force: true });
    }

    // —— 非 git 目录：探测分流到记录口径 ——
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-docview-plain-'));
    try {
      const plainProbe = await probeGitWorkspace(localGitRunner(plain));
      check('非 git 目录探测为 no（分流记录口径）', plainProbe === 'no');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  finish();
});
