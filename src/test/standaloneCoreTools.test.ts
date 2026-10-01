/**
 * Standalone Core 工具往返（docs/standalone-core.md 第 5、7 节）：
 * 假 LLM 先回一次工具调用，Core 执行工具并把结果回填，再回最终文本。
 *
 * 重点验证：
 * - 工具事件（`toolCall` / `toolArgsUpdated` / `toolResult`）按契约上报；
 * - Windows 上 Bash 工具落到 **bash**（而不是 cmd）——`$BASH_VERSION` 被真正展开；
 * - 工具结果进入下一轮上下文。
 *
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 * 运行方式：npm run test:all -- standalone-core-tools
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
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

interface LlmTurn {
  /** 纯文本回复 */
  text?: string;
  /** 一次工具调用 */
  tool?: { id: string; name: string; input: Record<string, unknown> };
}

/** 冒充 OpenAI Chat Completions：按脚本逐轮返回，最后一轮之后重复最后一条 */
function startFakeLlm(turns: LlmTurn[]): Promise<{
  url: string;
  close: () => Promise<void>;
  bodies: () => Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
}> {
  const state = { hits: 0, bodies: [] as Array<{ messages?: Array<{ role?: string; content?: unknown }> }> };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const turn = turns[Math.min(state.hits, turns.length - 1)];
      state.hits += 1;
      try {
        state.bodies.push(JSON.parse(body));
      } catch {
        state.bodies.push({});
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (turn.tool) {
        const argumentsText = JSON.stringify(turn.tool.input);
        // 参数分片到达，验证 Core 侧拼接
        const half = Math.ceil(argumentsText.length / 2);
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: turn.tool.id,
                      function: { name: turn.tool.name, arguments: argumentsText.slice(0, half) },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(half) } }],
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
        bodies: () => state.bodies,
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

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-tools-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'line-one\nline-two\n', 'utf8');

  const llm = await startFakeLlm([
    {
      tool: {
        id: 'call_bash',
        name: 'Bash',
        // touch 不是只读命令 → 走确认链路；cmd 会把 $BASH_VERSION 原样打印，bash 会展开
        input: {
          command: 'touch marker.txt && echo marker=$BASH_VERSION',
          description: 'Create a marker file and print the bash version',
        },
      },
    },
    {
      tool: {
        id: 'call_read',
        name: 'Read',
        input: { file_path: 'sample.txt' },
      },
    },
    {
      // 后台 Bash：立刻返回 taskId，命令跑完后 Core 把完成通知注入上下文
      tool: {
        id: 'call_bash_background',
        name: 'Bash',
        input: {
          command: 'echo background-output',
          description: 'Say something from the background',
          run_in_background: true,
        },
      },
    },
    { text: '工具执行完毕。' },
  ]);

  writeSettings(homeDir, llm.url);

  const child = spawn(CORE_BINARY, ['stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: homeDir, HOME: homeDir },
    windowsHide: true,
  });
  const frames: Array<{
    kind: string;
    id?: number;
    request?: { type: string; toolName?: string };
    event?: { type: string; [key: string]: unknown };
  }> = [];
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
          const frame = JSON.parse(line) as {
            kind: string;
            id?: number;
            request?: { type: string; toolName?: string };
          };
          frames.push(frame);
          // 模拟真实 UI：toolPermissionRequested 只上架卡片并**原样回传**权限结果；
          // 结果保持 ask 时，Core 会再发一次 userChoice 弹确认框。
          if (frame.kind === 'request' && typeof frame.id === 'number') {
            const type = (frame as { request?: { type?: string } }).request?.type;
            if (type === 'toolPermissionRequested') {
              send({ kind: 'response', id: frame.id, ok: true, result: { behavior: 'ask' } });
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
  const events = (type: string): Array<{ type: string; [key: string]: unknown }> =>
    frames.filter((frame) => frame.kind === 'event' && frame.event?.type === type).map((f) => f.event!);

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
    send({ kind: 'uiEvent', event: { type: 'sessionWorkspaceAssigned', sessionId: 'sess-tools', workspacePath: workspace } });
    send({ kind: 'uiEvent', event: { type: 'conversationStarted', sessionId: 'sess-tools' } });
    send({
      kind: 'uiEvent',
      event: {
        type: 'userMessageSubmitted',
        sessionId: 'sess-tools',
        content: '跑一下工具',
        uuid: 'user_tools_1',
      },
    });

    check(
      '权限结果保持 ask 时再弹用户选择框',
      await waitFor(() =>
        frames.some(
          (frame) => frame.kind === 'request' && frame.request?.type === 'userChoice',
        ),
      ),
    );
    check(
      '非只读工具先发权限确认',
      await waitFor(() =>
        frames.some(
          (frame) =>
            frame.kind === 'request' &&
            frame.request?.type === 'toolPermissionRequested' &&
            frame.request?.toolName === 'Bash',
        ),
      ),
    );
    check(
      '工具调用上报 toolCall',
      await waitFor(() => events('toolCall').length >= 2),
    );
    check(
      '工具调用带 toolArgsUpdated',
      await waitFor(() => events('toolArgsUpdated').length >= 2),
    );
    // 对齐 Embedded：授权前 / 执行前各发一次 toolCall，因此不能只等 toolCall 计数
    // （Bash 一个工具就能凑够 2 条），要等两个工具的 toolResult 都到齐再断言内容。
    check(
      '两个工具都返回结果',
      await waitFor(() => events('toolResult').length >= 2),
    );

    const results = events('toolResult');
    const bashResult = results.find((result) => result.toolName === 'Bash');
    const readResult = results.find((result) => result.toolName === 'Read');

    check('Bash 工具返回成功', bashResult?.status === 'success');
    const bashOutput = String(bashResult?.output ?? '');
    check(`Bash 工具落到 bash 而非 cmd（输出：${bashOutput.trim().slice(0, 60)}）`,
      bashOutput.includes('marker=') && !bashOutput.includes('$BASH_VERSION'));

    check('Read 工具返回文件内容', String(readResult?.output ?? '').includes('line-two'));
    check('Read 工具输出带 1-based 行号', /^1\|/m.test(String(readResult?.output ?? '')));

    check(
      '轮次结束上报 queryEnd',
      await waitFor(() => events('queryEnd').length >= 1),
    );

    // 第二轮上下文包含工具结果
    const secondBody = llm.bodies()[1];
    check(
      '工具结果进入下一轮上下文',
      (secondBody?.messages ?? []).some((message) => message.role === 'tool'),
    );
    check('最终文本回复到达 UI', await waitFor(() => events('streamEnd').length >= 1));

    // ==================== 后台 Bash（run_in_background） ====================
    check(
      '后台 Bash 返回结果',
      await waitFor(() => events('toolResult').length >= 3),
    );
    const backgroundResult = events('toolResult').find(
      (result) => result.toolName === 'Bash' && String(result.output ?? '').includes('background'),
    );
    const backgroundOutput = String(backgroundResult?.output ?? '');
    check('后台 Bash 状态为 success', backgroundResult?.status === 'success');
    check(
      `后台 Bash 立刻返回 taskId（输出：${backgroundOutput.trim().slice(0, 80)}）`,
      /Command running in background with ID: bg-/.test(backgroundOutput),
    );
    check(
      '后台 Bash 提示输出文件路径',
      backgroundOutput.includes('You will be notified automatically when it completes.'),
    );

    // 命令跑完后 Core 把完成通知作为 `origin='bash'` 的 user 消息上报 UI
    check(
      '后台任务完成通知上报 UI',
      await waitFor(() =>
        events('message').some(
          (event) =>
            (event as { data?: { origin?: string; content?: string } }).data?.origin === 'bash' &&
            String((event as { data?: { content?: string } }).data?.content ?? '').includes(
              'Background task completed',
            ),
        ),
      ),
    );
    const notification = events('message').find(
      (event) => (event as { data?: { origin?: string } }).data?.origin === 'bash',
    ) as { data?: { content?: string } } | undefined;
    check(
      '完成通知带任务 ID 与输出预览',
      String(notification?.data?.content ?? '').includes('Task: bg-') &&
        String(notification?.data?.content ?? '').includes('background-output'),
    );

    // 通知会唤醒消费循环：模型再被调用一次，上下文里带上这条通知
    check(
      '完成通知进入下一轮上下文',
      await waitFor(() =>
        llm
          .bodies()
          .some((body) =>
            (body.messages ?? []).some(
              (message) =>
                message.role === 'user' &&
                typeof message.content === 'string' &&
                message.content.includes('Background task completed'),
            ),
          ),
      ),
    );

    // 工具 schema 对等：`run_in_background` 已在 Bash 的 input_schema 里
    const bashTool = (
      (llm.bodies()[0] as { tools?: Array<{ function?: { name?: string; parameters?: unknown } }> })
        .tools ?? []
    ).find((tool) => tool.function?.name === 'Bash') as
      | { function?: { parameters?: { properties?: Record<string, unknown> } } }
      | undefined;
    check(
      'Bash schema 暴露 run_in_background',
      !!bashTool?.function?.parameters?.properties?.run_in_background,
    );
    // 子代理工具（Agent / Reply）也已随内置工具下发
    const toolNames = (
      (llm.bodies()[0] as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name);
    check(
      `内置工具含 Agent / Reply / Skill（实际：${toolNames.join(',')}）`,
      toolNames.includes('Agent') && toolNames.includes('Reply') && toolNames.includes('Skill'),
    );
    // `Skill` 必须末位（对齐 Embedded `DEFAULT_TOOLS` 的运行时不变式）
    check(
      `内置工具末位是 Skill（实际：${toolNames[toolNames.length - 1]}）`,
      toolNames[toolNames.length - 1] === 'Skill',
    );

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

runTests('standalone-core-tools', run);
