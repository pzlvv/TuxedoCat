/**
 * Standalone Core 重启续读端到端。
 *
 * `docs/standalone-core.md` 第 7.1 节：Core 崩溃 / 退出后由宿主重启，接线恢复。本文件验证**磁盘是唯一
 * 事实来源**——第一轮跑完 → 杀掉 Core 进程 → 起一个新进程（同一个 HOME）→
 * 打开同一会话 → 再发一条用户消息，第二次 LLM 请求里必须带上第一轮的历史。
 *
 * 「用户消息 → 流式回复 → 工具执行」三段的端到端分别由
 * `standaloneCoreEngine.test.ts` 与 `standaloneCoreTools.test.ts` 覆盖；
 * 真实 LLM 需要凭据，不在自动化范围（用本地假 LLM 冒充 OpenAI Chat Completions）。
 *
 * 运行方式：npm run test:all -- standalone-core-restart
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { createChecker, runTests } from './helpers/harness';
import { settingsSnapshotFromHome } from './helpers/fixtures';
import { makeTempDir } from './helpers/fixtures';

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
  event?: { type: string; [key: string]: unknown };
  request?: { type: string; [key: string]: unknown };
  id?: number;
}

/** 记录每次 LLM 请求体，供「历史是否被带回来」断言 */
function startFakeLlm(reply: string): Promise<{
  url: string;
  close: () => Promise<void>;
  bodies: () => Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
}> {
  const bodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push({});
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        })}\n\n`,
      );
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
        bodies: () => bodies,
      });
    });
  });
}

function writeSettings(homeDir: string, baseUrl: string): void {
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
    'utf8',
  );
}

interface CoreHandle {
  send: (frame: unknown) => void;
  frames: Frame[];
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;
  kill: () => Promise<void>;
  stop: () => Promise<void>;
}

function startCore(homeDir: string): CoreHandle {
  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
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

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };

  return {
    send: (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`),
    frames,
    waitFor,
    // 模拟崩溃：直接杀进程，不发 shutdown
    kill: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        try {
          child.kill();
        } catch {
          resolve();
        }
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          child.stdin.end();
        } catch {
          /* 已关闭 */
        }
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

/** 握手 + 宿主环境 + 活动工作目录；返回后就绪 */
async function bootstrap(core: CoreHandle): Promise<boolean> {
  core.send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
  return core.waitFor(() => core.frames.some((frame) => frame.kind === 'ready'), 10_000);
}

function emit(core: CoreHandle, event: unknown): void {
  core.send({ kind: 'uiEvent', event });
}

function hostEnvironment(homeDir: string): unknown {
  return {
    type: 'hostEnvironmentProvided',
    extensionPath: REPO_ROOT,
    logToConsole: false,
    configDirName: CONFIG_DIR_NAME,
    settings: settingsSnapshotFromHome(homeDir),
    mcpServers: [],
  };
}

function eventsOf(core: CoreHandle, type: string): Array<Record<string, unknown>> {
  return core.frames
    .filter((frame) => frame.kind === 'event' && frame.event?.type === type)
    .map((frame) => frame.event as Record<string, unknown>);
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  const home = makeTempDir('restart');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const llm = await startFakeLlm('收到。');
  writeSettings(home, llm.url);

  const sessionId = 'restart-1';
  let first: CoreHandle | null = null;
  let second: CoreHandle | null = null;
  try {
    // ---------- 第一轮：新建会话 + 一条用户消息 ----------
    first = startCore(home);
    check('第一次握手成功', await bootstrap(first));
    emit(first, hostEnvironment(home));
    emit(first, { type: 'sessionWorkspaceAssigned', sessionId, workspacePath: workspace });
    emit(first, { type: 'conversationStarted', sessionId, workspacePath: workspace });
    emit(first, { type: 'conversationOpened', sessionId });
    emit(first, {
      type: 'userMessageSubmitted',
      sessionId,
      content: '第一轮：记住这个数字 42',
      uuid: 'user-restart-1',
      workspacePath: workspace,
    });
    check(
      '第一轮跑完（收到 queryEnd）',
      await first.waitFor(() => eventsOf(first!, 'queryEnd').length >= 1),
    );
    check(
      '第一轮回复落盘（收到带内容的 streamEnd）',
      eventsOf(first, 'streamEnd').some((event) =>
        JSON.stringify(event.data ?? {}).includes('收到。'),
      ),
    );

    // ---------- 崩溃：直接杀进程 ----------
    await first.kill();
    first = null;

    // ---------- 第二轮：新进程，同一个 HOME ----------
    second = startCore(home);
    check('重启后握手成功', await bootstrap(second));
    emit(second, hostEnvironment(home));
    emit(second, { type: 'sessionWorkspaceAssigned', sessionId, workspacePath: workspace });

    // 会话列表里能读到第一轮的会话（对话列表来自磁盘）
    second.send({
      kind: 'request',
      id: 1,
      request: { type: 'conversationListRequested', workspacePath: workspace },
    });
    check(
      '重启后对话列表能读到该会话',
      await second.waitFor(() => second!.frames.some((frame) => frame.kind === 'response' && frame.id === 1)),
    );
    const listFrame = second.frames.find((frame) => frame.kind === 'response' && frame.id === 1) as
      | { result?: Array<{ sessionId?: string }> }
      | undefined;
    check(
      '列表里含 restart-1',
      (listFrame?.result ?? []).some((item) => item.sessionId === sessionId),
    );

    emit(second, { type: 'conversationOpened', sessionId });
    emit(second, {
      type: 'userMessageSubmitted',
      sessionId,
      content: '第二轮：我让你记住的数字是多少？',
      uuid: 'user-restart-2',
      workspacePath: workspace,
    });
    check(
      '第二轮跑完（收到 queryEnd）',
      await second.waitFor(() => eventsOf(second!, 'queryEnd').length >= 1),
    );

    // ---------- 关键断言：第二次 LLM 请求带上了第一轮的历史 ----------
    const bodies = llm.bodies();
    check(`发生了两次 LLM 请求（实际 ${bodies.length}）`, bodies.length >= 2);
    const secondBody = bodies[bodies.length - 1];
    const flat = JSON.stringify(secondBody);
    check(
      '第二次请求带上了第一轮的用户消息',
      flat.includes('第一轮：记住这个数字 42'),
    );
    check('第二次请求带上了第一轮的助手回复', flat.includes('收到。'));
    check(
      '第二次请求带上了第二轮的用户消息',
      flat.includes('第二轮：我让你记住的数字是多少？'),
    );
    // 首条是 system（系统提示），历史部分按 user → assistant → user 排列
    const roles = (secondBody.messages ?? [])
      .map((message) => message.role)
      .filter((role) => role !== 'system');
    check(
      `第二次请求的历史角色顺序是 user → assistant → user（实际 ${JSON.stringify(roles)}）`,
      JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'user']),
    );
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await llm.close();
  }

  finish();
}

runTests('standalone-core-restart', run);
