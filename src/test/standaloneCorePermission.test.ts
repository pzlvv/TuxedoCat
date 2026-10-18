/**
 * Core 权限链路（引擎 → 权限判定 → 工具执行 → 卡片事件）：
 *
 * - `risk` 模式下普通命令（`sleep 1`）**不弹确认框**，直接执行
 *   —— 这是「sleep 1 被拒绝」那个 bug 的回归用例；
 * - `manual` 模式下同一命令会走「上架卡片 → 弹确认框 → 用户选择」两步；
 * - 用户拒绝时工具以 error 结束，消息为「用户拒绝操作」；
 * - `auto` 模式下危险命令也不弹框。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 * 运行方式：npm run test:all -- standalone-core-permission
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { createChecker, runTests } from './helpers/harness';
import { settingsSnapshotFromHome } from './helpers/fixtures';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

interface Frame {
  kind: string;
  id?: number;
  request?: {
    type?: string;
    toolName?: string;
    permResult?: { behavior?: string };
  };
  event?: { type: string; [key: string]: unknown };
}

/** 假 LLM：先回一次 Bash 工具调用，再回最终文本 */
function startFakeLlm(command: string): Promise<{ url: string; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const isFirst = hits === 0;
      hits += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isFirst) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_perm',
                      function: { name: 'Bash', arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`,
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

function writeSettings(homeDir: string, baseUrl: string, agentMode: string): void {
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      defaultAgentMode: agentMode,
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

interface Scenario {
  /** 会话询问模式（settings.json 的 defaultAgentMode） */
  mode: string;
  /** 工具命令 */
  command: string;
  /** 用户对确认框的选择：0 = 允许，1 = 拒绝 */
  userChoice?: number;
}

interface ScenarioResult {
  frames: Frame[];
  permissionRequests: Frame[];
  userChoices: Frame[];
  toolResult?: { status?: string; output?: string };
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-perm-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // `git reset --hard HEAD` 只在真实仓库里才会以 0 退出；
  // 否则 Bash 会上报非零退出 → status error，掩盖「用户允许后执行」的断言。
  try {
    execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
    execFileSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'],
      { cwd: workspace, windowsHide: true },
    );
  } catch {
    // 没有 git 时保留空目录：该断言会退化为非零退出
  }
  const llm = await startFakeLlm(scenario.command);
  writeSettings(homeDir, llm.url, scenario.mode);

  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });
  const frames: Frame[] = [];
  const send = (frame: unknown): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
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
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          // 模拟真实 UI 的 ToolHandler：原样回传 permResult（allow 直接放行，
          // ask 再由 userChoice 取用户选择）
          if (frame.kind === 'request' && typeof frame.id === 'number') {
            if (frame.request?.type === 'toolPermissionRequested') {
              send({
                kind: 'response',
                id: frame.id,
                ok: true,
                result: frame.request.permResult ?? { behavior: 'ask' },
              });
            } else if (frame.request?.type === 'userChoice') {
              send({
                kind: 'response',
                id: frame.id,
                ok: true,
                result: { index: scenario.userChoice ?? 0 },
              });
            }
          }
        } catch {
          /* 忽略非法行 */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };

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
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: 'sess-perm', workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: 'sess-perm' } });
    send({
      kind: 'uiEvent',
      event: {
        type: 'userMessageSubmitted',
        sessionId: 'sess-perm',
        content: '跑一下',
        uuid: 'user_perm_1',
      },
    });
    await waitFor(() =>
      frames.some((frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd'),
    );

    const events = (type: string): Array<{ type: string; [key: string]: unknown }> =>
      frames
        .filter((frame) => frame.kind === 'event' && frame.event?.type === type)
        .map((frame) => frame.event!);
    const toolResult = events('toolResult')[0] as
      | { status?: string; output?: string }
      | undefined;

    return {
      frames,
      permissionRequests: frames.filter(
        (frame) => frame.kind === 'request' && frame.request?.type === 'toolPermissionRequested',
      ),
      userChoices: frames.filter(
        (frame) => frame.kind === 'request' && frame.request?.type === 'userChoice',
      ),
      toolResult,
    };
  } finally {
    try {
      send({ kind: 'shutdown' });
      child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    child.kill();
    await llm.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  // ---- risk 模式：普通命令直接执行，不弹确认框（回归用例）----
  {
    const result = await runScenario({ mode: 'risk', command: 'sleep 1' });
    // 允许路径也会发一次 toolPermissionRequested（UI 上架卡片），
    // 但 permResult 是 allow，不会再有 userChoice 确认框。
    check(
      'risk 模式：sleep 1 只上架卡片、不弹确认框',
      result.permissionRequests.length === 1 &&
        result.permissionRequests[0].request?.permResult?.behavior === 'allow',
    );
    check('risk 模式：不弹用户选择框', result.userChoices.length === 0);
    check('risk 模式：工具执行成功', result.toolResult?.status === 'success');
  }

  // ---- risk 模式：git 写子命令不拦截（与 rm 同口径）----
  {
    const result = await runScenario({ mode: 'risk', command: 'git reset --hard HEAD' });
    check('risk 模式：git reset 只上架卡片、不弹确认框', result.userChoices.length === 0);
    check('risk 模式：git reset 执行成功', result.toolResult?.status === 'success');
  }

  // ---- risk 模式：破坏性命令仍然拦截 ----
  {
    // count=0 让 dd 立即结束：命中破坏性名单即可，不必真的写数据
    const result = await runScenario({ mode: 'risk', command: 'dd if=/dev/zero of=x count=0' });
    check('risk 模式：dd 触发确认框', result.userChoices.length === 1);
    check('risk 模式：用户允许后工具执行成功', result.toolResult?.status === 'success');
  }

  // ---- risk 模式：用户拒绝 ----
  {
    const result = await runScenario({
      mode: 'risk',
      command: 'dd if=/dev/zero of=x count=0',
      userChoice: 1,
    });
    check('risk 模式：用户拒绝后工具以 error 结束', result.toolResult?.status === 'error');
    check(
      'risk 模式：拒绝消息为「用户拒绝操作」',
      String(result.toolResult?.output ?? '').includes('用户拒绝操作'),
    );
  }

  // ---- manual 模式：普通命令也要确认 ----
  {
    const result = await runScenario({ mode: 'manual', command: 'sleep 1' });
    check('manual 模式：普通命令也弹确认框', result.userChoices.length === 1);
    check('manual 模式：允许后工具执行成功', result.toolResult?.status === 'success');
  }

  // ---- manual 模式：只读命令不弹框 ----
  {
    const result = await runScenario({ mode: 'manual', command: 'ls -la' });
    check(
      'manual 模式：只读命令只上架卡片、不弹确认框',
      result.permissionRequests.length === 1 &&
        result.permissionRequests[0].request?.permResult?.behavior === 'allow',
    );
    check('manual 模式：只读命令不弹用户选择框', result.userChoices.length === 0);
    check('manual 模式：只读命令执行成功', result.toolResult?.status === 'success');
  }

  // ---- auto 模式：危险命令也不弹框 ----
  {
    const result = await runScenario({ mode: 'auto', command: 'dd if=/dev/zero of=x count=0' });
    check(
      'auto 模式：只上架卡片、不弹确认框',
      result.permissionRequests.length === 1 &&
        result.permissionRequests[0].request?.permResult?.behavior === 'allow',
    );
    check('auto 模式：不弹用户选择框', result.userChoices.length === 0);
  }

  finish();
}

runTests('standalone-core-permission', run);
