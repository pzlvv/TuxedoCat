/**
 * Standalone Core 权限预览端到端（对齐 Embedded `PermissionPolicy` + `ToolHandler`）：
 *
 * 假 LLM 先调一次 Read（允许）再调一次 Edit（manual 确认），验证：
 * - **允许**的工具也会发 `toolPermissionRequested`（UI 借此上架工具卡片），
 *   `permResult` 带 `updatedInput`，`displayArgs.file_path` 展开为绝对路径；
 * - Edit 的 `permResult` 带 `beforeContent` / `afterContent` / 上下文 / 行号 /
 *   换行符类型（宿主据此写 tool_use 的 `_meta`）；
 * - Edit 的 `displayArgs` 带 old/new/replace_all 与 diff 字段；
 * - 用户允许后文件真的被修改。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 * 运行方式：npm run test:all -- standalone-core-permission-preview
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

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

interface LlmTurn {
  text?: string;
  tool?: { id: string; name: string; input: Record<string, unknown> };
}

/** 冒充 OpenAI Chat Completions：按脚本逐轮返回 */
function startFakeLlm(turns: LlmTurn[]): Promise<{ url: string; close: () => Promise<void> }> {
  const state = { hits: 0 };
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const turn = turns[Math.min(state.hits, turns.length - 1)];
      state.hits += 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (turn.tool) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: turn.tool.id,
                      function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.input) },
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
        for (const chunk of (turn.text ?? '').match(/[\s\S]{1,8}/g) ?? []) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
          );
        }
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
      defaultAgentMode: 'manual',
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

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-permission-preview-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

  const llm = await startFakeLlm([
    { tool: { id: 'call_read', name: 'Read', input: { file_path: 'a.txt' } } },
    {
      tool: {
        id: 'call_edit',
        name: 'Edit',
        input: { file_path: 'a.txt', old_string: 'beta', new_string: 'BETA' },
      },
    },
    { text: 'done' },
  ]);
  writeSettings(homeDir, llm.url);

  const child = spawn(CORE_BINARY, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });
  const frames: Array<{ kind: string; id?: number; request?: any; event?: any }> = [];
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
          const frame = JSON.parse(line) as { kind: string; id?: number; request?: any };
          frames.push(frame);
          // 模拟真实 UI 的 ToolHandler：原样回传 permResult（allow 直接放行；
          // ask 再由 userChoice 弹确认框，这里选「允许」）
          if (frame.kind === 'request' && typeof frame.id === 'number') {
            const type = frame.request?.type;
            if (type === 'toolPermissionRequested') {
              send({ kind: 'response', id: frame.id, ok: true, result: frame.request.permResult });
            } else if (type === 'userChoice') {
              send({ kind: 'response', id: frame.id, ok: true, result: { index: 0 } });
            } else {
              send({ kind: 'response', id: frame.id, ok: false, error: `unexpected request ${type}` });
            }
          }
        } catch {
          /* 忽略非法行 */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  const stderrLines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(String.fromCharCode(10))) {
      if (line.trim()) stderrLines.push(line.trim());
    }
  });

  const send = (frame: unknown): void => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };
  const permissionRequest = (toolName: string): any =>
    frames.find(
      (frame) =>
        frame.kind === 'request' &&
        frame.request?.type === 'toolPermissionRequested' &&
        frame.request?.toolName === toolName,
    )?.request;

  try {
    send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    await waitFor(() => frames.some((frame) => frame.kind === 'ready'));
    send({
      kind: 'uiEvent',
      event: {
        type: 'hostEnvironmentProvided',
        locale: 'zh-CN',
        extensionPath: REPO_ROOT,
        logToConsole: false,
        configDirName: CONFIG_DIR_NAME,
      },
    });
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: 'sess-preview', workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: 'sess-preview' } });
    send({
      kind: 'uiEvent',
      event: {
        type: 'userMessageSubmitted',
        sessionId: 'sess-preview',
        content: '看一下再改',
        uuid: 'user_preview_1',
      },
    });

    check(
      '允许的 Read 也发一次 toolPermissionRequested',
      await waitFor(() => permissionRequest('Read') !== undefined),
    );
    const readRequest = permissionRequest('Read');
    check('Read permResult 为 allow', readRequest?.permResult?.behavior === 'allow');
    check(
      'Read permResult 带 updatedInput（默认 checkPermissions 产物）',
      readRequest?.permResult?.updatedInput?.file_path === 'a.txt',
    );
    check(
      'Read displayArgs.file_path 展开为绝对路径',
      readRequest?.displayArgs?.file_path === path.join(workspace, 'a.txt'),
    );

    check(
      'Edit 发 toolPermissionRequested 且带 diff 预览',
      await waitFor(() => permissionRequest('Edit')?.permResult?.beforeContent !== undefined),
    );
    const editRequest = permissionRequest('Edit');
    const perm = editRequest?.permResult ?? {};
    check('Edit permResult 为 ask', perm.behavior === 'ask');
    check('Edit permResult.beforeContent 为规范化 LF 内容', perm.beforeContent === 'alpha\nbeta\ngamma\n');
    check('Edit permResult.afterContent 为替换后内容', perm.afterContent === 'alpha\nBETA\ngamma\n');
    check('Edit permResult.contextBefore', JSON.stringify(perm.contextBefore) === JSON.stringify(['alpha']));
    check('Edit permResult.contextAfter', JSON.stringify(perm.contextAfter) === JSON.stringify(['gamma']));
    check('Edit permResult.startLine / endLine', perm.startLine === 2 && perm.endLine === 2);
    check('Edit permResult.lineEndings', perm.lineEndings === 'LF');

    const display = editRequest?.displayArgs ?? {};
    check('Edit displayArgs.file_path 展开为绝对路径', display.file_path === path.join(workspace, 'a.txt'));
    check('Edit displayArgs.old_string / new_string', display.old_string === 'beta' && display.new_string === 'BETA');
    check('Edit displayArgs.replace_all', display.replace_all === false);
    check(
      'Edit displayArgs 带 diff 字段（webview 回退计算 diffHunks）',
      display.beforeContent === 'alpha\nbeta\ngamma\n'
        && display.afterContent === 'alpha\nBETA\ngamma\n'
        && display.startLine === 2
        && display.endLine === 2,
    );

    check(
      'Edit 执行成功并写盘',
      await waitFor(() => fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8') === 'alpha\nBETA\ngamma\n'),
    );
    check(
      '轮次结束上报 queryEnd',
      await waitFor(() => frames.some((frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd')),
    );
    check(`Core stderr 无异常（${stderrLines.slice(0, 2).join(' | ')}）`, !stderrLines.some((line) => line.includes('panic')));

    send({ kind: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    try {
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

runTests('standalone-core-permission-preview', run);
