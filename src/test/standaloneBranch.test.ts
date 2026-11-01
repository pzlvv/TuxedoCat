/**
 * 分支对话的真实 Core 往返（specs/037 FR-002 / FR-004 / FR-005 / FR-008）：
 *
 * 驱动真实 Core 二进制 + 真实 git 仓库，锁定契约与行为在真实帧通道上成立：
 *
 * - `branchModeChanged { mode: 'branch' }` → `branchStateChanged { view: { state: 'ready' } }`；
 * - 工具写入落在 worktree（主工作区 `git status` 干净、文件不出现）；
 * - `git commit` 推进 `tuxedo/<name>` 分支指针（成果出口）；
 * - `branchPrecheckRequested` 在真仓库 / 非仓库两态上的应答；
 * - `branchTreeRequested` 读 worktree 目录树、非分支会话回 `not-branch`；
 * - 删除会话清理 worktree 与分支。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core:host`）+ 本机 `git`；
 * 任一缺失时 markSkipped（不算通过）。运行方式：npm run test:all -- standalone-branch
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { createChecker, runTests } from './helpers/harness';
import { settingsSnapshotFromHome } from './helpers/fixtures';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HOST_CORE_DIR = corePlatformDir(process.platform, process.arch);
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  HOST_CORE_DIR ?? '__unsupported__',
  HOST_CORE_DIR ? coreBinaryFileName(process.platform) : 'missing',
);

const BRANCH_SESSION = 'sess-branch';
const PLAIN_SESSION = 'sess-plain';

/** 一次工具调用脚本（冒充 OpenAI Chat Completions） */
interface LlmTurn {
  tool?: { id: string; name: string; input: Record<string, unknown> };
}

/**
 * 建一个真实的 git 仓库夹具（仓库根 = home 内的 workspace）。
 *
 * 三件必做的事（specs/037 plan「测试夹具」）：仓库本地 `user.email` / `user.name`
 * （CI 无全局配置）、`GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向空文件、
 * `core.hooksPath` 指向空目录。
 */
function initGitRepo(workspace: string, homeDir: string): { configStub: string; hooksDir: string } {
  const configStub = path.join(homeDir, 'gitconfig-stub');
  const hooksDir = path.join(homeDir, 'empty-hooks');
  fs.writeFileSync(configStub, '', 'utf8');
  fs.mkdirSync(hooksDir, { recursive: true });
  const git = (args: string[], cwd = workspace): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        GIT_CONFIG_GLOBAL: configStub,
        GIT_CONFIG_SYSTEM: configStub,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const run = (args: string[], cwd = workspace): string => {
    const result = git(args, cwd);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'core.hooksPath', hooksDir]);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# sandbox\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-m', 'init']);
  return { configStub, hooksDir };
}

function startFakeLlm(turns: LlmTurn[]): Promise<{ url: string; close: () => Promise<void> }> {
  const state = { hits: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const turn = turns[Math.min(state.hits, turns.length - 1)];
      state.hits += 1;
      void body;
      if (turn?.tool) {
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: turn.tool.id, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.input) } }] } }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: '完成。' } }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function writeSettings(homeDir: string, baseUrl: string): void {
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      defaultAgentMode: 'auto',
      llm: {
        maxTokens: 4096,
        activeProvider: 'fake',
        providers: {
          fake: {
            baseURL: baseUrl,
            apiKey: 'test-key',
            models: ['fake-model'],
            defaultModel: 'fake-model',
            modelConfigs: { 'fake-model': { apiType: 'OpenAI', maxOutputTokens: 4096 } },
          },
        },
      },
    }),
    'utf8',
  );
}

interface Frame {
  kind: string;
  id?: number;
  request?: { type: string; sessionId?: string };
  result?: unknown;
  error?: string;
  event?: { type: string; [key: string]: unknown };
}

async function run(): Promise<void> {
  const { check, finish, markSkipped } = createChecker();

  if (!fs.existsSync(CORE_BINARY)) {
    markSkipped(`真实 Core 集成：${path.relative(REPO_ROOT, CORE_BINARY)} 缺失（npm run build:core:host）`);
    finish();
    return;
  }
  const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitProbe.status !== 0) {
    markSkipped('真实 git 夹具：本机没有可用的 git');
    finish();
    return;
  }

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-branch-'));
  const workspace = path.join(homeDir, 'workspace');
  const plainDir = path.join(homeDir, 'plain-dir');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(plainDir, { recursive: true });
  const { configStub } = initGitRepo(workspace, homeDir);
  const gitIn = (args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        GIT_CONFIG_GLOBAL: configStub,
        GIT_CONFIG_SYSTEM: configStub,
      },
    });
  const git = (args: string[], cwd = workspace): string => {
    const result = gitIn(args, cwd);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };

  const llm = await startFakeLlm([
    {
      // 分支会话的首轮：把文件写进 worktree（相对路径按工具根解析）
      tool: { id: 'call_write', name: 'Write', input: { file_path: 'branch-only.txt', content: 'from the branch\n' } },
    },
    // `commit -am` 只提交已跟踪文件；新建文件必须先 `add`（这条也顺带验证
    // worktree 里的 git 仓库已就绪：无需 init / 配置）
    { tool: { id: 'call_commit', name: 'Bash', input: { command: 'git add -A && git commit -m "branch work"', description: 'Commit on the branch' } } },
    { tool: { id: 'call_guard', name: 'Bash', input: { command: 'git worktree remove --force .', description: 'Try to delete our own worktree' } } },
  ]);
  writeSettings(homeDir, llm.url);

  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      USERPROFILE: homeDir,
      HOME: homeDir,
      GIT_CONFIG_GLOBAL: configStub,
      GIT_CONFIG_SYSTEM: configStub,
    },
    windowsHide: true,
  });
  const frames: Frame[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          frames.push(JSON.parse(line) as Frame);
        } catch {
          /* 忽略非法行 */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);

  const send = (frame: unknown): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const pending = new Map<number, (frame: Frame) => void>();
  let requestSeq = 1000;
  const request = async (payload: unknown, timeoutMs = 15_000): Promise<Frame> => {
    const id = (requestSeq += 1);
    const answer = new Promise<Frame>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        pending.delete(id);
        reject(new Error(`request ${(payload as { type?: string }).type} timed out`));
      }, timeoutMs);
    });
    send({ kind: 'request', id, request: payload });
    return answer;
  };
  const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };
  const events = (type: string): Array<{ type: string; [key: string]: unknown }> =>
    frames.filter((frame) => frame.kind === 'event' && frame.event?.type === type).map((frame) => frame.event!);

  // 应答在途请求：CoreRequest 全放行，UiRequest 交给下方的自动应答表
  child.stdout.on('data', () => undefined);
  const pump = setInterval(() => {
    for (const frame of frames.splice(0)) {
      if (frame.kind === 'response' && typeof frame.id === 'number') {
        pending.get(frame.id)?.(frame);
        pending.delete(frame.id);
      } else if (frame.kind === 'request' && typeof frame.id === 'number') {
        const type = frame.request?.type;
        if (type === 'toolPermissionRequested') {
          send({ kind: 'response', id: frame.id, ok: true, result: { behavior: 'allow' } });
        } else if (type === 'userChoice') {
          send({ kind: 'response', id: frame.id, ok: true, result: { index: 0 } });
        } else {
          send({ kind: 'response', id: frame.id, ok: false, error: `unexpected request ${type}` });
        }
      } else {
        frames.push(frame);
      }
    }
  }, 10);

  try {
    send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    await waitFor(() => frames.some((frame) => frame.kind === 'ready'));
    send({
      kind: 'uiEvent',
      event: {
        type: 'hostEnvironmentProvided',
        extensionPath: REPO_ROOT,
        logToConsole: false,
        configDirName: CONFIG_DIR_NAME,
        settings: settingsSnapshotFromHome(homeDir),
        mcpServers: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ---- branchPrecheckRequested：真仓库 / 非仓库两态 ----
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: BRANCH_SESSION, workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: PLAIN_SESSION, workspacePath: workspace } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const precheckOk = await request({ type: 'branchPrecheckRequested', workspacePath: workspace });
    const okPayload = precheckOk.result as { ok: boolean; head?: string; dirty?: boolean; baseBranch?: string };
    check('真仓库的 branchPrecheckRequested 应答 ok', okPayload.ok === true);
    check(
      'precheck 的 head 是 commit 短 id',
      typeof okPayload.head === 'string' && okPayload.head.length >= 7,
    );
    check('precheck 的 dirty 是布尔（干净仓库为 false）', okPayload.dirty === false);
    check('precheck 的 baseBranch 是当前分支', okPayload.baseBranch === 'main');

    const precheckNotGit = await request({ type: 'branchPrecheckRequested', workspacePath: plainDir });
    const notGitPayload = precheckNotGit.result as { ok: boolean; reason?: string; detail?: string };
    check('非 git 目录的 precheck 应答 not-git', notGitPayload.ok === false && notGitPayload.reason === 'not-git');
    check('not-git 应答带 detail（原因原文）', typeof notGitPayload.detail === 'string' && notGitPayload.detail.length > 0);

    // ---- 恰恰：普通会话先打开（branchStateChanged 应为 plain） ----
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: PLAIN_SESSION } });
    send({ kind: 'uiEvent', event: { type: 'conversationOpened', sessionId: PLAIN_SESSION } });
    check(
      '普通会话收到 branchStateChanged { state: plain }',
      await waitFor(() =>
        events('branchStateChanged').some(
          (event) => event.sessionId === PLAIN_SESSION && (event.view as { state?: string })?.state === 'plain',
        ),
      ),
    );

    // ---- 分支会话建立 ----
    send({ kind: 'uiEvent', event: { type: 'branchModeChanged', sessionId: BRANCH_SESSION, mode: 'branch' } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: BRANCH_SESSION } });
    send({ kind: 'uiEvent', event: { type: 'conversationOpened', sessionId: BRANCH_SESSION } });
    check(
      '分支会话收到 branchStateChanged { state: ready }',
      await waitFor(() =>
        events('branchStateChanged').some(
          (event) => event.sessionId === BRANCH_SESSION && (event.view as { state?: string })?.state === 'ready',
        ),
      ),
    );
    const readyEvent = events('branchStateChanged').find(
      (event) => event.sessionId === BRANCH_SESSION && (event.view as { state?: string })?.state === 'ready',
    );
    const readyView = readyEvent?.view as
      | { state: string; branch: string; worktree: string; baseCommit: string; baseBranch: string }
      | undefined;
    check('ready 视图带 branch 名（不含 tuxedo/ 前缀）', typeof readyView?.branch === 'string' && !readyView.branch.startsWith('tuxedo/'));
    check('ready 视图的 branch 名符合格式', /^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$/.test(readyView?.branch ?? ''));
    check('ready 视图的 baseBranch 是 main', readyView?.baseBranch === 'main');
    check(
      'ready 视图的 baseCommit 是 40 位提交 id',
      /^[0-9a-f]{40}$/.test(readyView?.baseCommit ?? ''),
    );
    check(
      'worktree 在 Core 数据目录、不在仓库里',
      typeof readyView?.worktree === 'string'
        && readyView.worktree.length > 0
        && !readyView.worktree.startsWith(workspace)
        && fs.existsSync(readyView.worktree),
    );
    check(
      'ready 视图不带 commits / dirty / peers / deps（窄口径）',
      readyView !== undefined
        && !('commits' in (readyView as object))
        && !('dirty' in (readyView as object))
        && !('peers' in (readyView as object))
        && !('deps' in (readyView as object)),
    );
    check(
      '分支已建出（tuxedo/<name> 在 refs/heads 下）',
      (readyView ? git(['branch', '--list', `tuxedo/${readyView.branch}`]) : '').includes('tuxedo/'),
    );

    // ---- 分支目录树 ----
    const treeRoot = await request({ type: 'branchTreeRequested', sessionId: BRANCH_SESSION, dir: '' });
    const treePayload = treeRoot.result as { ok: boolean; entries?: Array<{ name: string; kind: string; mtimeMs: number | null }> };
    check('branchTreeRequested 的应答 ok', treePayload.ok === true);
    check(
      'worktree 根目录树包含 README.md（条目形态 name / kind / mtimeMs）',
      (treePayload.entries ?? []).some((entry) => entry.name === 'README.md' && entry.kind === 'file'),
    );
    check(
      '目录树条目没有 change 字段（不做差异标记）',
      (treePayload.entries ?? []).every((entry) => !('change' in entry)),
    );
    const notBranch = await request({ type: 'branchTreeRequested', sessionId: PLAIN_SESSION, dir: '' });
    check(
      '普通会话的 branchTreeRequested 应答 not-branch（宿主回落主工作区）',
      (notBranch.result as { ok: boolean; reason?: string }).ok === false
        && (notBranch.result as { reason?: string }).reason === 'not-branch',
    );
    const traversal = await request({ type: 'branchTreeRequested', sessionId: BRANCH_SESSION, dir: '../..' });
    check(
      '越界相对路径被拒绝（同 not-branch 形态）',
      (traversal.result as { ok: boolean }).ok === false,
    );

    // ---- 工具写入落 worktree、提交推进分支指针 ----
    const projectBefore = git(['rev-parse', 'HEAD']);
    send({
      kind: 'uiEvent',
      event: { type: 'userMessageSubmitted', sessionId: BRANCH_SESSION, content: '在分支上写个文件并提交', uuid: 'user_branch_1' },
    });
    check(
      'Write 工具返回结果',
      await waitFor(() => events('toolResult').some((event) => event.toolName === 'Write')),
    );
    check(
      '文件落在 worktree 内、主工作区没有该文件',
      readyView !== undefined
        && fs.existsSync(path.join(readyView.worktree, 'branch-only.txt'))
        && !fs.existsSync(path.join(workspace, 'branch-only.txt')),
    );
    check('主工作区 git status 干净（分支内容不可见）', git(['status', '--porcelain']).trim() === '');
    check(
      'commit 推进了 tuxedo/<name> 分支指针',
      await waitFor(() => {
        if (!readyView) return false;
        const tip = gitIn(['rev-parse', `tuxedo/${readyView.branch}`], workspace);
        return tip.status === 0 && tip.stdout.trim() !== projectBefore.trim();
      }),
    );
    check(
      '自毁命令被拒绝（git worktree remove 自身）',
      await waitFor(() =>
        events('toolResult').some(
          (event) =>
            event.toolName === 'Bash'
            && event.status === 'error'
            && String(event.output ?? '').includes('refused'),
        ),
      ),
    );
    check('worktree 仍在（自毁被拦下）', readyView !== undefined && fs.existsSync(readyView.worktree));

    // ---- 删除会话：清理 worktree 与分支 ----
    send({ kind: 'uiEvent', event: { type: 'conversationDeleted', sessionId: BRANCH_SESSION } });
    check(
      '删除会话清理了 worktree 目录',
      await waitFor(() => (readyView ? !fs.existsSync(readyView.worktree) : true), 20_000),
    );
    check(
      '删除会话清理了 tuxedo/<name> 分支',
      readyView !== undefined && !git(['branch', '--list', `tuxedo/${readyView.branch}`]).includes('tuxedo/'),
    );
  } finally {
    clearInterval(pump);
    child.stdin.end();
    await llm.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  finish();
}

runTests('standaloneBranch', run);
