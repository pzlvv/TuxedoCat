/**
 * Standalone Core 引擎端到端（docs/standalone-core.md 第 5、7 节）：
 * 直接驱动 Rust 产物跑完一轮真实对话——
 * `hello` → `ready` → 宿主环境 / 工作目录 → 新建会话 → 用户消息 → 流式回复 → 落盘。
 *
 * LLM 用本地 HTTP 服务器冒充（OpenAI Chat Completions 的 SSE），不发真实请求。
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 *
 * 运行方式：npm run test:all -- standalone-core-engine
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

interface Frame {
  kind: string;
  event?: { type: string; [key: string]: unknown };
  request?: { type: string; [key: string]: unknown };
  id?: number;
}

/** 冒充 OpenAI Chat Completions 的流式响应；传入数组时按请求次数依次返回 */
function startFakeLlm(replies: string | string[]): Promise<{
  url: string;
  close: () => Promise<void>;
  hits: () => number;
  bodies: () => Array<{ messages?: Array<{ role?: string; content?: unknown }> }>;
  raw: () => string[];
}> {
  const sequence = Array.isArray(replies) ? replies : [replies];
  const state = { hits: 0, raw: [] as string[], bodies: [] as Array<{ messages?: Array<{ role?: string; content?: unknown }> }> };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      state.hits += 1;
      try {
        state.bodies.push(JSON.parse(body));
        state.raw.push(body);
      } catch {
        state.bodies.push({});
        state.raw.push(body);
      }
      const reply = sequence[Math.min(state.hits - 1, sequence.length - 1)] ?? '';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = reply.match(/[\s\S]{1,8}/g) ?? [];
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      );
      for (const chunk of chunks) {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } })}\n\n`,
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
        hits: () => state.hits,
        bodies: () => state.bodies,
        raw: () => state.raw,
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

interface Harness {
  send: (frame: unknown) => void;
  frames: Frame[];
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;
  close: () => Promise<void>;
}

function startCore(homeDir: string): Harness {
  const child = spawn(CORE_BINARY, [], {
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
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(String.fromCharCode(10))) {
      if (line.trim()) frames.push({ kind: 'stderr', event: { type: 'stderr', message: line } });
    }
  });

  return {
    send: (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`),
    frames,
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return predicate();
    },
    close: () =>
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

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  // ---------- 静态守卫：Core 侧每个子进程都要隐藏控制台窗口 ----------
  // 不加 CREATE_NO_WINDOW 时，每次查询 spawn git / bash / rg 都会闪一个窗口。
  // 两条合法写法：`util::hide_console`（只设 CREATE_NO_WINDOW）与
  // `util::hide_console_with`（与额外标志位一次给全，如 daemon 的脱离终端）。
  // 只扫产品代码：`*_tests.rs` 与 `test_support.rs` 不进产物，它们 spawn 的
  // git / cmd 属于测试自身的环境准备。
  {
    const srcDir = path.join(REPO_ROOT, 'core-rs', 'src');
    const offenders = fs
      .readdirSync(srcDir)
      .filter((name) => name.endsWith('.rs'))
      .filter((name) => !name.endsWith('_tests.rs') && name !== 'test_support.rs')
      .map((name) => ({ name, text: fs.readFileSync(path.join(srcDir, name), 'utf8') }))
      .filter(({ text }) => {
        const spawns = text.match(/Command::new\(/g)?.length ?? 0;
        const hidden = text.match(/hide_console(_with)?\(/g)?.length ?? 0;
        return spawns > hidden;
      })
      .map(({ name }) => name);
    check(
      `Core 侧每个 spawn 都隐藏控制台窗口（hide_console / hide_console_with）（未覆盖：${offenders.join(', ') || '无'}）`,
      offenders.length === 0,
    );
  }

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-core-'));
  const workspace = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# demo\n', 'utf8');

  const reply = 'Hello from the Standalone Core.';
  const llm = await startFakeLlm(reply);
  writeSettings(homeDir, llm.url);

  const core = startCore(homeDir);
  const sessionId = 'sess-e2e';

  try {
    core.send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    check('握手返回 ready', await core.waitFor(() => core.frames.some((f) => f.kind === 'ready')));

    core.send({
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
    core.send({
      kind: 'uiEvent',
      event: { type: 'sessionWorkspaceAssigned', sessionId, workspacePath: workspace },
    });
    core.send({
      kind: 'uiEvent',
      event: { type: 'conversationStarted', sessionId, workspacePath: workspace },
    });
    // 对齐 Embedded：`conversationStarted` 只登记工作目录（内存态），不建档、不广播。
    // `meta.json` / `.jsonl` 只在第一条消息持久化时创建。
    // 先等会话运行时状态上报（Core 确实处理了这条事件），再断言「没有 sessionCreated」。
    check(
      '新会话上报运行时状态',
      await core.waitFor(() =>
        core.frames.some(
          (frame) => frame.kind === 'event' && frame.event?.type === 'sessionRuntimeChanged',
        ),
      ),
    );
    const conversationsDir = path.join(homeDir, CONFIG_DIR_NAME, 'conversations');
    check(
      '新会话不预建会话文件',
      !fs.existsSync(conversationsDir) ||
        fs
          .readdirSync(conversationsDir)
          .filter((name) => fs.statSync(path.join(conversationsDir, name)).isDirectory()).length === 0,
    );
    check(
      '新会话不上报 sessionCreated',
      !core.frames.some(
        (frame) => frame.kind === 'event' && frame.event?.type === 'sessionCreated',
      ),
    );

    core.send({
      kind: 'uiEvent',
      event: {
        type: 'userMessageSubmitted',
        sessionId,
        content: '你好',
        uuid: 'user_e2e_1',
      },
    });

    check(
      '流式回复到达 UI',
      await core.waitFor(() =>
        core.frames.some(
          (frame) =>
            frame.kind === 'event' &&
            frame.event?.type === 'streamMessage' &&
            (frame.event.data as { accumulated?: string } | undefined)?.accumulated === reply,
        ),
      ),
    );
    check(
      '流结束带用量',
      await core.waitFor(() =>
        core.frames.some((frame) => {
          if (frame.kind !== 'event' || frame.event?.type !== 'streamEnd') return false;
          const data = frame.event.data as { usage?: { output_tokens?: number } } | undefined;
          return data?.usage?.output_tokens === 22;
        }),
      ),
    );
    check(
      'streamEnd 分块粒度：block_stop 一条（usage 缺省）+ message_delta 一条（带 usage），共用块级 streamId',
      await core.waitFor(() => {
        const ends = core.frames
          .filter((frame) => frame.kind === 'event' && frame.event?.type === 'streamEnd')
          .map(
            (frame) =>
              frame.event!.data as {
                role?: string;
                accumulated?: string;
                usage?: { output_tokens?: number };
                streamId?: string;
              },
          );
        if (ends.length < 2) return false;
        const [blockStop, messageDelta] = ends;
        return (
          blockStop.role === 'assistant' &&
          blockStop.accumulated === reply &&
          blockStop.usage === undefined &&
          messageDelta.role === 'assistant' &&
          messageDelta.accumulated === reply &&
          messageDelta.usage?.output_tokens === 22 &&
          typeof blockStop.streamId === 'string' &&
          blockStop.streamId.startsWith('blk_') &&
          blockStop.streamId === messageDelta.streamId
        );
      }),
    );
    check(
      '轮次结束上报 queryEnd',
      await core.waitFor(() =>
        core.frames.some((frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd'),
      ),
    );
    check('LLM 被调用一次', llm.hits() === 1);

    // 落盘：meta.json + jsonl
    const projectDir = path.join(homeDir, CONFIG_DIR_NAME, 'conversations');
    const projectDirs = fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [];
    check('项目对话目录已建立', projectDirs.length === 1);
    const sessionDir = projectDirs.length === 1 ? path.join(projectDir, projectDirs[0]) : '';
    const messagesFile = path.join(sessionDir, `${sessionId}.jsonl`);
    const metaFile = path.join(sessionDir, `${sessionId}.meta.json`);
    check('消息文件已落盘', fs.existsSync(messagesFile));
    check('元数据文件已落盘', fs.existsSync(metaFile));

    if (fs.existsSync(messagesFile)) {
      const lines = fs
        .readFileSync(messagesFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const records = lines.map((line) => JSON.parse(line) as { message?: { type?: string } });
      check(
        '落盘包含用户 / 助手两条消息',
        records.filter((record) => record.message?.type === 'user').length >= 1 &&
          records.filter((record) => record.message?.type === 'assistant').length >= 1,
      );
    }
    if (fs.existsSync(metaFile)) {
      const metadata = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { title?: string };
      check('标题由首条用户消息生成', metadata.title === '你好');
    }
    if (sessionDir) {
      // 项目清单由 Core 自己写（docs/core-ui-separation.md 第 4.1 节）：宿主不参与写盘。
      const manifestFile = path.join(sessionDir, 'workspace.meta.json');
      const manifest = fs.existsSync(manifestFile)
        ? (JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { workspacePath?: string })
        : {};
      check('项目清单 workspace.meta.json 由 Core 写入 workspacePath', manifest.workspacePath === workspace);
    }

    // ---- 配置写入归宿主：Core 不写 settings.json，也不接受「改配置」的事件 ----
    // Core 只消费 `hostEnvironmentProvided` 下发的快照（docs/core-ui-separation.md 第 4 节），
    // 因此这里断言「Core 没碰过宿主写的全局配置」。
    const globalSettingsFile = path.join(homeDir, CONFIG_DIR_NAME, 'settings.json');
    const readGlobalSettings = (): Record<string, any> => {
      try {
        return JSON.parse(fs.readFileSync(globalSettingsFile, 'utf8')) as Record<string, any>;
      } catch {
        return {};
      }
    };
    const settingsBefore = readGlobalSettings();
    // 契约里已经没有「宿主请 Core 改配置」这条事件（settingsJsonUpdateRequested 已删除）；
    // 即使发过来，Core 也不认识、不落盘——全局配置的写入口只有宿主。
    core.send({
      kind: 'uiEvent',
      event: { type: 'settingsJsonUpdateRequested', patch: { uiLanguage: 'en', llm: { webSearch: false } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(
      'Core 不写全局 settings.json',
      JSON.stringify(readGlobalSettings()) === JSON.stringify(settingsBefore),
    );

    // ---- 第二轮：历史必须从磁盘载入并进入上下文 ----
    core.send({
      kind: 'uiEvent',
      event: { type: 'conversationOpened', sessionId },
    });
    core.send({
      kind: 'uiEvent',
      event: {
        type: 'userMessageSubmitted',
        sessionId,
        content: '第二轮',
        uuid: 'user_e2e_2',
      },
    });
    check(
      '第二轮上报 queryEnd',
      await core.waitFor(
        () =>
          core.frames.filter(
            (frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd',
          ).length >= 2,
      ),
    );
    const secondBody = llm.bodies()[1];
    check(
      '第二轮上下文包含第一轮的助手回复',
      (secondBody?.messages ?? []).some(
        (message) => message.role === 'assistant' && String(message.content ?? '').includes(reply),
      ),
    );
    check(
      '第二轮上下文包含第二轮用户消息',
      (secondBody?.messages ?? []).some(
        (message) => message.role === 'user' && String(message.content ?? '').includes('第二轮'),
      ),
    );

    // ---- 第三轮：崩溃恢复补出的 tool_result 必须落盘（对齐 persistUnpersistedMessages） ----
    if (sessionDir) {
      const recoverSession = 'sess-recover';
      const recoverFile = path.join(sessionDir, `${recoverSession}.jsonl`);
      const recoverMetaFile = path.join(sessionDir, `${recoverSession}.meta.json`);
      // 磁盘上只有 assistant 的 tool_use、没有 tool_result（进程崩溃现场）
      fs.writeFileSync(
        recoverFile,
        `${JSON.stringify({
          uuid: 'a-recover',
          parentUuid: null,
          timestamp: Date.now(),
          message: {
            type: 'assistant',
            uuid: 'a-recover',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_orphan', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
        })}\n`,
        'utf8',
      );
      fs.writeFileSync(
        recoverMetaFile,
        JSON.stringify({ sessionId: recoverSession, project: workspace, title: 'recover', messageCount: 1 }),
        'utf8',
      );

      core.send({
        kind: 'uiEvent',
        event: { type: 'conversationOpened', sessionId: recoverSession },
      });
      core.send({
        kind: 'uiEvent',
        event: {
          type: 'userMessageSubmitted',
          sessionId: recoverSession,
          content: '继续',
          uuid: 'user_recover_1',
        },
      });
      check(
        '崩溃恢复会话上报 queryEnd',
        await core.waitFor(
          () =>
            core.frames.filter(
              (frame) => frame.kind === 'event' && frame.event?.type === 'queryEnd',
            ).length >= 3,
        ),
      );

      const recoverRecords = fs
        .readFileSync(recoverFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { uuid?: string; parentUuid?: string | null; message?: { type?: string } },
        );
      const recoveredUuid = recoverRecords[1]?.uuid ?? '';
      check(
        '恢复结果先于新用户消息落盘',
        recoverRecords[0]?.uuid === 'a-recover' &&
          recoveredUuid.startsWith('tool_recovered_') &&
          recoverRecords[2]?.uuid === 'user_recover_1',
      );
      check('恢复结果 parentUuid 指向 assistant', recoverRecords[1]?.parentUuid === 'a-recover');
      check('新用户消息接在恢复结果之后', recoverRecords[2]?.parentUuid === recoveredUuid);
      const recoverMetadata = JSON.parse(fs.readFileSync(recoverMetaFile, 'utf8')) as {
        messageCount?: number;
      };
      check('恢复结果计入 messageCount', recoverMetadata.messageCount === 4);
    }

    // ===== 事件粒度：queryBegin / queryEnd 是「消费循环级」 =====
    // Embedded 的 `submitMessage` 在启动 consumer 时发一次 queryBegin，
    // `finalizeIdle` 在队列彻底排空时发一次 queryEnd；一轮用户消息内部的多个 LLM
    // 轮次（这里是「以冒号结尾 → reminder 追问」）同属一次 consumer，只应有一对。
    {
      const reminderHome = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-core-reminder-'));
      const reminderWorkspace = path.join(reminderHome, 'workspace');
      fs.mkdirSync(reminderWorkspace, { recursive: true });
      const reminderLlm = await startFakeLlm(['让我先读一下这个文件：', '读完了']);
      writeSettings(reminderHome, reminderLlm.url);
      const reminderCore = startCore(reminderHome);
      const reminderSession = 'sess-reminder';
      try {
        reminderCore.send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
        await reminderCore.waitFor(() => reminderCore.frames.some((f) => f.kind === 'ready'));
        reminderCore.send({
          kind: 'uiEvent',
          event: {
            type: 'hostEnvironmentProvided',
            extensionPath: REPO_ROOT,
            logToConsole: false,
            configDirName: CONFIG_DIR_NAME,
            settings: settingsSnapshotFromHome(reminderHome),
            mcpServers: [],
          },
        });
        reminderCore.send({
          kind: 'uiEvent',
          event: { type: 'sessionWorkspaceAssigned', sessionId: reminderSession, workspacePath: reminderWorkspace },
        });
        reminderCore.send({
          kind: 'uiEvent',
          event: { type: 'conversationStarted', sessionId: reminderSession, workspacePath: reminderWorkspace },
        });
        reminderCore.send({
          kind: 'uiEvent',
          event: {
            type: 'userMessageSubmitted',
            sessionId: reminderSession,
            content: '看看',
            uuid: 'user_reminder_1',
          },
        });

        check(
          '冒号结尾触发 reminder 第二轮 LLM',
          await reminderCore.waitFor(() => reminderLlm.hits() >= 2, 20_000),
        );
        check(
          'reminder 轮次结束上报 queryEnd',
          await reminderCore.waitFor(
            () =>
              reminderCore.frames.some((f) => f.kind === 'event' && f.event?.type === 'queryEnd'),
            20_000,
          ),
        );
        const queryBeginCount = reminderCore.frames.filter(
          (f) => f.kind === 'event' && f.event?.type === 'queryBegin',
        ).length;
        const queryEndCount = reminderCore.frames.filter(
          (f) => f.kind === 'event' && f.event?.type === 'queryEnd',
        ).length;
        check(
          'reminder 追问只有一对 queryBegin/queryEnd',
          queryBeginCount === 1 && queryEndCount === 1,
        );

        const reminderConversations = path.join(reminderHome, CONFIG_DIR_NAME, 'conversations');
        const projectDirName = fs
          .readdirSync(reminderConversations)
          .find((name) => fs.statSync(path.join(reminderConversations, name)).isDirectory());
        const reminderRecords = fs
          .readFileSync(
            path.join(reminderConversations, projectDirName ?? '', `${reminderSession}.jsonl`),
            'utf8',
          )
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as { message?: { message?: { content?: unknown } } });
        check(
          'reminder 追问已落盘',
          reminderRecords.some(
            (record) =>
              typeof record.message?.message?.content === 'string' &&
              record.message.message.content.startsWith('<reminder>'),
          ),
        );
      } finally {
        reminderCore.send({ kind: 'shutdown' });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await reminderCore.close();
        await reminderLlm.close();
        fs.rmSync(reminderHome, { recursive: true, force: true });
      }
    }

    core.send({ kind: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await core.close();
    await llm.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }

  finish();
}

runTests('standalone-core-engine', run);
