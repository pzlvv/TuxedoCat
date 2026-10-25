/**
 * Transfer 轮次的真实二进制集成（specs/028 FR-002）：
 * 宿主回守卫错误后，工具结果必须进入下一轮 LLM 请求（模型看得到 'use Bash'），
 * 不得静默丢弃形成「无 tool_result 的悬挂 tool_use」死循环。
 *
 * 运行方式：npm run test:all -- standaloneTransfer（前置 `npm run build:core:host`）
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
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
const SESSION_ID = 'sess-transfer-loop';

interface Frame {
  kind: string;
  id?: number;
  request?: { type?: string; permResult?: { behavior?: string } };
  event?: { type: string; [key: string]: unknown };
}

/** 假 LLM：首轮发 Transfer（两端缺省 = 同工作区守卫错误），记录每轮请求的 messages */
function startFakeLlm(): Promise<{
  url: string;
  requests: Array<Array<{ role?: string; content?: unknown }>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Array<{ role?: string; content?: unknown }>> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => {
      let payload: { messages?: Array<{ role?: string; content?: unknown }> } = {};
      try { payload = JSON.parse(body); } catch { /* 忽略 */ }
      requests.push(payload.messages ?? []);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const isFirst = requests.length === 1;
      if (isFirst) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_transfer_1',
                      function: {
                        name: 'Transfer',
                        arguments: JSON.stringify({
                          sourcePath: path.join(REPO_ROOT, 'a.txt'),
                          targetPath: path.join(REPO_ROOT, 'copy.txt'),
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise<{ url: string; requests: Array<Array<{ role?: string; content?: unknown }>>; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function run(): Promise<void> {
  const { check, finish, markSkipped } = createChecker();
  if (!fs.existsSync(CORE_BINARY)) {
    markSkipped(`真实 Core 集成：${path.relative(REPO_ROOT, CORE_BINARY)} 缺失（npm run build:core:host）`);
    return;
  }

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-transfer-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const llm = await startFakeLlm();
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
            baseURL: llm.url,
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

  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });
  const frames: Frame[] = [];
  const send = (frame: unknown): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(20);
    }
    return predicate();
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
          if (frame.kind === 'request' && typeof frame.id === 'number') {
            if (frame.request?.type === 'toolPermissionRequested') {
              // auto 模式下宿主按原样回传 permResult（ask 由 core 的 agentMode 加工）
              send({
                kind: 'response',
                id: frame.id,
                ok: true,
                result: frame.request.permResult ?? { behavior: 'allow' },
              });
            } else if (frame.request?.type === 'userChoice') {
              send({ kind: 'response', id: frame.id, ok: true, result: { index: 0 } });
            } else if (frame.request?.type === 'crossWorkspaceTransferRequested') {
              // 守卫错误：两端都是发起会话所属工作区（specs/028 FR-002）
              send({
                kind: 'response',
                id: frame.id,
                ok: true,
                result: {
                  error:
                    'transfer requires two different workspaces; for copies inside a single workspace use Bash (cp / mv) instead',
                },
              });
            }
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => undefined);

  try {
    send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    if (!(await waitFor(() => frames.some((frame) => frame.kind === 'ready')))) {
      check('core ready', false);
      return;
    }
    send({
      kind: 'uiEvent',
      event: {
        type: 'hostEnvironmentProvided',
        extensionPath: REPO_ROOT,
        logToConsole: false,
        configDirName: CONFIG_DIR_NAME,
        settings: settingsSnapshotFromHome(homeDir),
        mcpServers: [],
        crossWorkspaceAgent: true,
        crossWorkspaceTransfer: true,
      },
    });
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: SESSION_ID, workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: SESSION_ID } });
    send({
      kind: 'uiEvent',
      event: { type: 'userMessageSubmitted', sessionId: SESSION_ID, content: '复制一下', uuid: 'user_transfer_1' },
    });
    await waitFor(() =>
      frames.some((frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd'),
    );

    check('Transfer 轮次至少发起两次 LLM 请求', llm.requests.length >= 2);
    const second = llm.requests[1] ?? [];
    const serialized = JSON.stringify(second);
    check(
      '守卫错误进入下一轮 LLM 请求（模型看得到 use Bash）',
      serialized.includes('use Bash (cp / mv)'),
    );
    check(
      '下一轮请求包含工具结果（无悬挂 tool_use）',
      serialized.includes('tool') || serialized.includes('Transfer'),
    );
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

  finish();
}

runTests('standaloneTransfer', run);
