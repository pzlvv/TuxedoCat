/**
 * 改动分级闸门：`scripts/githooks/commit-msg` 对四类提交的放行 / 拒绝判据
 * （AGENTS.md 第 5 节；specs/010-tiered-change-workflow 的 FR-006）。
 *
 * 为什么这样测：闸门是 shell 钩子，判据依赖 git 在提交时注入的消息文件与暂存区，
 * 纯函数测不到。这里建临时仓库、只装这一个钩子，用真实 `git commit` 跑一遍——
 * 坏掉的后果是闸门静默失效（历史教训：旧 pre-commit 的判据「specs/ 下有任意目录
 * 就放行」形同虚设，动了两侧 Core 的提交照样带 `--no-verify` 过去）。
 *
 * 运行方式：npm run test:all -- gitHookGate
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';

/** 仓库根：编译产物在 `out/src/test/`，往上三层 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK_SOURCE = path.join(REPO_ROOT, 'scripts', 'githooks', 'commit-msg');

/** 隔离 git 全局配置：临时 HOME + 空全局配置，避免本机 hooks / 别名干扰 */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const globalConfig = path.join(home, 'gitconfig');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
}

interface GitRun {
  status: number;
  output: string;
}

function run(dir: string, home: string, args: string[]): GitRun {
  try {
    const out = execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      env: gitEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: out ?? '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function stage(dir: string, rel: string, content = 'x\n'): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  execFileSync('git', ['add', '--', rel], { cwd: dir, windowsHide: true });
}

runTests('gitHookGate', async () => {
  const { check, finish } = createChecker();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hookgate-'));
  const hooksDir = path.join(home, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, path.join(hooksDir, 'commit-msg'));
  fs.chmodSync(path.join(hooksDir, 'commit-msg'), 0o755);
  const hookArg = `core.hooksPath=${hooksDir.replace(/\\/g, '/')}`;

  /** 新仓库：每次用例独立，避免上一次的暂存区状态污染下一条断言 */
  const newRepo = (): string => {
    const dir = fs.mkdtempSync(path.join(home, 'repo-'));
    const init = run(dir, home, ['init', '-q']);
    assert.strictEqual(init.status, 0, `git init 失败：${init.output}`);
    return dir;
  };

  /** 带档位声明提交（钩子生效） */
  const commit = (dir: string, message: string): GitRun =>
    run(dir, home, ['-c', hookArg, 'commit', '-q', '-m', message]);

  /** 准备性提交（绕过钩子，只用于造仓库状态） */
  const commitNoVerify = (dir: string, message: string): GitRun =>
    run(dir, home, ['commit', '-q', '--no-verify', '-m', message]);

  // ---------- 场景 1：L0 与缺档位 ----------

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'chore: 只改样式\n\nFlow: L0');
    check('L0 声明放行', res.status === 0);
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'chore: 没写档位');
    check('无 Flow trailer 拒绝', res.status !== 0 && res.output.includes('没有 Flow trailer'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'chore: 两条档位\n\nFlow: L0\nFlow: L1');
    check('多条 Flow 拒绝', res.status !== 0 && res.output.includes('档位有歧义'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'chore: 未知档位\n\nFlow: L9');
    check('未知 Flow 取值拒绝', res.status !== 0 && res.output.includes('非法'));
  }

  // ---------- 场景 2：L1 缺陷 ----------

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'fix: 缺 Defect trailer\n\nFlow: L1');
    check('L1 缺 Defect trailer 拒绝', res.status !== 0 && res.output.includes('需要一行 Defect'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'fix: 缺陷报告不存在\n\nFlow: L1\nDefect: nope');
    check('L1 产物缺失拒绝', res.status !== 0 && res.output.includes('不存在'));
  }

  {
    const dir = newRepo();
    stage(dir, 'specs/defects/menu-scrollbar.md', '# 缺陷：菜单滚动条透明\n');
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'fix: 菜单滚动条\n\nFlow: L1\nDefect: menu-scrollbar');
    check('L1 产物存在放行', res.status === 0);
  }

  // ---------- 场景 3：L2 需求变更 ----------

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'feat: 需求变更没带文档\n\nFlow: L2');
    check('L2 无 docs 规格改动拒绝', res.status !== 0 && res.output.includes('没有 docs/'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    stage(dir, 'docs/core/session-runtime.md', '# 规格：会话运行时\n');
    const res = commit(dir, 'feat: 需求变更带文档\n\nFlow: L2');
    check('L2 带 docs 规格改动放行', res.status === 0);
  }

  // ---------- 场景 4：L3 新特性 ----------

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    const res = commit(dir, 'feat: 没有规格目录\n\nFlow: L3\nSpec: 010');
    check('L3 规格目录不存在拒绝', res.status !== 0 && res.output.includes('不存在'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    stage(dir, 'specs/010-x/spec.md', '# 改动规格：x\n');
    const res = commit(dir, 'feat: 三件套不齐\n\nFlow: L3\nSpec: 010');
    check('L3 三件套不齐拒绝', res.status !== 0 && res.output.includes('缺 plan.md'));
  }

  {
    const dir = newRepo();
    stage(dir, 'src/a.ts');
    stage(dir, 'specs/010-x/spec.md', '# 改动规格：x\n');
    stage(dir, 'specs/010-x/plan.md', '# 实施方案：x\n');
    stage(dir, 'specs/010-x/tasks.md', '# 任务分解：x\n');
    const res = commit(dir, 'feat: 三件套齐\n\nFlow: L3\nSpec: 010');
    check('L3 三件套齐放行', res.status === 0);
  }

  // ---------- 场景 5：豁免 ----------

  {
    const dir = newRepo();
    stage(dir, 'docs/core/session-runtime.md', '# 规格：会话运行时\n');
    const res = commit(dir, 'docs: 纯文档提交');
    check('纯文档提交不要求档位', res.status === 0);
  }

  {
    const dir = newRepo();
    stage(dir, 'src/base.ts', 'base\n');
    commitNoVerify(dir, 'base');
    // 分支名必须在首次提交之后取：空仓库的 HEAD 是未诞生的引用，取到的是字面量 "HEAD"
    const branch = run(dir, home, ['rev-parse', '--abbrev-ref', 'HEAD']).output.trim();
    run(dir, home, ['checkout', '-q', '-b', 'side']);
    stage(dir, 'src/side.ts', 'side\n');
    commitNoVerify(dir, 'side');
    run(dir, home, ['checkout', '-q', branch]);
    const merge = run(dir, home, ['merge', '--no-commit', '--no-ff', 'side']);
    assert.strictEqual(merge.status, 0, `准备 merge 失败：${merge.output}`);
    const res = commit(dir, 'merge side（无 Flow 声明）');
    check('merge 提交豁免档位', res.status === 0);
  }

  // ---------- 场景：仓库里钩子的文件模式 ----------
  //
  // specs/defects/commit-msg-hook-not-executable：commit-msg 曾被跟踪为 100644，
  // 按 AGENTS.md 装 core.hooksPath 后 git 只打一行 hint 就跳过钩子——闸门静默消失。
  // 上面的用例都显式 chmod 0o755 装钩子，测的是脚本逻辑，测不到仓库里的模式，
  // 所以这一组直接查 index。

  {
    /** `git ls-files -s <dir>` 的每一行：`<mode> <sha> <stage>\t<path>` */
    const lsFiles = run(REPO_ROOT, home, ['ls-files', '-s', 'scripts/githooks/']);
    const entries = lsFiles.output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [meta, file = ''] = line.split('\t');
        const [mode = '', blob = ''] = (meta ?? '').trim().split(/\s+/);
        return { mode, blob, file: path.basename(file) };
      });

    // RT-1：五个钩子都必须带可执行位（新增钩子忘加同样会红）
    check('scripts/githooks 下的钩子全部登记', entries.length > 0);
    const nonExecutable = entries.filter((entry) => entry.mode !== '100755').map((entry) => entry.file);
    check(
      `scripts/githooks 下钩子全部可执行（不可执行：${nonExecutable.join(', ') || '无'}）`,
      nonExecutable.length === 0,
    );

    // RT-2：按 index 里的真实模式装钩子（刻意不 chmod 成 755），闸门必须真的拦住
    // 缺 trailer 的代码提交——index 是 100644 时它就会静默跳过、提交被放行。
    const commitMsg = entries.find((entry) => entry.file === 'commit-msg');
    assert.ok(commitMsg, 'index 里找不到 scripts/githooks/commit-msg');
    const dir = newRepo();
    const hookPath = path.join(dir, 'hooks', 'commit-msg');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const content = execFileSync('git', ['cat-file', 'blob', commitMsg.blob], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    fs.writeFileSync(hookPath, content);
    fs.chmodSync(hookPath, commitMsg.mode === '100755' ? 0o755 : 0o644);
    stage(dir, 'src/host/Client.ts', '// change\n');
    const res = run(dir, home, [
      '-c',
      `core.hooksPath=${path.join(dir, 'hooks').replace(/\\/g, '/')}`,
      'commit',
      '-q',
      '-m',
      'bad: 没有 Flow trailer 的代码改动',
    ]);
    check('按 index 模式装钩子后，缺 Flow 的代码提交被拒', res.status !== 0);
    check('拒绝提示包含 Flow', res.output.includes('Flow'));
  }

  finish();
});
