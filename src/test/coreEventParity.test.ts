/**
 * CoreEvent 对等测试（TODO.md M8-318）。
 *
 * 规格第 9 节：**两种实现对同一串 `UiEvent` 产生同一串 `CoreEvent`**。
 * 本文件把这条判据做成可执行断言：同一串脚本化的 `UiEvent`
 * （宿主环境 → 活动工作目录 → 新建会话 → 用户消息）分别喂给
 *
 * - Embedded Core：进程内 `createEventBus()` + `initializeCoreEvents()`；
 * - Standalone Core：真实 Rust 产物 + 帧通道（`hello` / `uiEvent`）；
 *
 * 两边都指向同一个本地假 LLM（OpenAI Chat Completions SSE），最后比较
 * **CoreEvent 的 type 序列**（以及会话生命周期事件的 sessionId 归属）。
 *
 * 比较口径（有意排除的差异）：
 * - `log`：日志条数是实现细节（Standalone Core 会报自己的就绪日志），不进契约；
 * - `streamMessage` / `streamEnd` 的**载荷**：token 统计与分块边界依赖 HTTP 分块，
 *   这里只比 type 序列与顺序；
 * - 时间戳 / uuid 等数据字段：两侧各自生成，不做逐字比较。
 *
 * 运行方式：npm run test:all -- core-event-parity
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { createEventBus } from '../host/EventBus';
import {
  resetGlobalEventBus,
  setGlobalEventBus,
  type CoreEvent,
  type UiEvent,
} from '../core/AssistantEventBus';
import { initializeCoreEvents } from '../core/initializeCoreEvents';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';
import { resolveSettingsSnapshot, type SettingsSnapshot } from '../core/settingsSnapshot';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

/** 一轮 queryEnd 之后的收集窗口：吸收异步到达的事件（MCP 同步等） */
const SETTLE_MS = 500;

/**
 * 脚本化的 UiEvent 序列；`sessionId` 由场景给出（同进程里多个场景必须用不同
 * sessionId，否则进程内的引擎 / MCP 引用池会命中上一个场景的残留）。
 *
 * `settings` 是配置快照——配置归 UI，Core 侧只消费快照，不读 `settings.json`；
 * 两个实现收到的是同一份，因此必须由本函数显式传入。
 * `content` / `deferEcho` 与宿主 `handleUserMessage` 的真实载荷一致：`/` 开头的
 * 命令消息延迟回显（`deferEcho`），普通消息由宿主立即回显。
 */
function scriptedUiEvents(
  workspacePath: string,
  settings: SettingsSnapshot,
  sessionId: string,
  content: string,
  deferEcho: boolean,
): UiEvent[] {
  return [
    {
      type: 'hostEnvironmentProvided',
      extensionPath: REPO_ROOT,
      logToConsole: false,
      configDirName: CONFIG_DIR_NAME,
      settings,
      mcpServers: [],
    },
    { type: 'sessionWorkspaceAssigned', sessionId, workspacePath },
    { type: 'conversationStarted', sessionId, workspacePath },
    { type: 'conversationOpened', sessionId },
    {
      type: 'userMessageSubmitted',
      sessionId,
      content,
      uuid: 'user-parity-1',
      workspacePath,
      deferEcho: deferEcho || undefined,
    },
  ];
}

/**
 * 只保留契约事件（日志条数是实现细节）。
 *
 * `sessionRuntimeChanged` 是**全量快照**事件：载荷是「所有会话的 idle/waiting」，
 * 重复推送不携带新信息，且它的触发点是「内部 diff 后发现变化」——而两边看到
 * 「会话开始忙」的时机不同（见文件头与 `DEVELOPMENT.md` 第 13.3.4 节）。因此比较时把它
 * 单独摘出来，只断言它存在、且最后的快照是空闲。
 */
function contractTypes(events: CoreEvent[]): string[] {
  return events.map((event) => event.type).filter((type) => type !== 'log');
}

/** 摘掉快照型事件后的序列（用于诊断输出） */
function orderedTypes(events: CoreEvent[]): string[] {
  return contractTypes(events).filter((type) => type !== 'sessionRuntimeChanged');
}

/** 事件类型多重集（顺序无关） */
function typeMultiset(types: string[]): string {
  return JSON.stringify([...types].sort());
}

/**
 * 查询生命周期子序列：这些事件的**相对顺序**是契约的一部分
 * （UI 靠它驱动流式渲染、工具卡片与 abort 按钮）。
 */
function lifecycleSubsequence(types: string[]): string[] {
  const tracked = new Set([
    'queryBegin',
    'aiBegin',
    'streamMessage',
    'streamEnd',
    'aiEnd',
    'queryEnd',
  ]);
  return types.filter((type) => tracked.has(type));
}

/**
 * 对等场景：同一条用户消息分别喂给两种实现。
 *
 * - `/commit`：命令消息延迟回显（`deferEcho`），进入上下文时由 core 补发用户
 *   `message`；同时走「注入 Skill tool_use」这条独立路径（`injectSkillToolUse` ↔
 *   `inject_skill_tool_use`），必须产生同一组 CoreEvent——`toolCall`（授权 / 执行
 *   各一次）、`toolResult`、用户 `message`，以及每条落盘消息一次的
 *   `conversationListChanged`。缺 `toolCall` 时 UI 不会上架 Skill 卡片，表现为
 *   Standalone 下 `/<skill>`「不触发」。
 * - `/spin`：内置命令就地执行、消息被丢弃，因此**不该**补发用户 `message`（否则
 *   Standalone 会留下一个刷新后消失的「幽灵」气泡，与 Embedded 不一致）。
 */
const SCENARIOS: ReadonlyArray<{
  id: string;
  name: string;
  sessionId: string;
  content: string;
  deferEcho: boolean;
}> = [
  { id: 'plain', name: '普通消息', sessionId: 'parity-plain', content: '你好', deferEcho: false },
  { id: 'skill', name: '/commit 技能命令', sessionId: 'parity-skill', content: '/commit', deferEcho: true },
  { id: 'builtin', name: '/spin 内置命令', sessionId: 'parity-builtin', content: '/spin', deferEcho: true },
];

// ==================== 假 LLM ====================

function startFakeLlm(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '你好，我是助手。' } }] })}\n\n`,
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
      });
    });
  });
}

/** 在 `<home>/<CONFIG_DIR_NAME>/settings.json` 写一份指向假 LLM 的配置 */
function writeSettings(homeDir: string, baseUrl: string): SettingsSnapshot {
  const configDir = path.join(homeDir, CONFIG_DIR_NAME);
  fs.mkdirSync(configDir, { recursive: true });
  const raw = {
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
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');
  // Core 侧从快照取值：由同一份原始配置解析出快照，喂给两个实现
  return resolveSettingsSnapshot(raw);
}

/** 临时切换 USERPROFILE / HOME（两侧都靠它定位 settings.json 与对话目录） */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prevProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

// ==================== 两侧驱动 ====================

/** Embedded：进程内总线，跑完整个序列后返回 CoreEvent 序列 */
async function runEmbedded(home: string, events: UiEvent[]): Promise<CoreEvent[]> {
  return withHome(home, async () => {
    resetGlobalEventBus();
    const bus = createEventBus();
    setGlobalEventBus(bus);
    const received: CoreEvent[] = [];
    bus.onCoreEvents(
      new Proxy(
        {},
        {
          get: (_target, prop: string) => (event: CoreEvent) => {
            if (event.type === prop) received.push(event);
          },
        },
      ) as never,
    );
    bus.onCoreRequests(
      new Proxy(
        {},
        {
          get: () => async () => ({ behavior: 'allow' }) as never,
        },
      ) as never,
    );
    initializeCoreEvents(bus);
    // `registerIntegrationUiEvents` 等是异步注册（动态 import），等它们就位
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const event of events) bus.emitToCore(event);
    // 等这一轮跑完（落盘 + streamEnd）
    await waitFor(() => received.some((event) => event.type === 'queryEnd'), 15_000);
    // MCP 的 `sessionConfigChanged(mcpEnabled)` 是会话打开后的异步同步产物，
    // 到达时刻可能晚于 queryEnd；多留一小段收集窗口，避免它变成时序竞态。
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    resetGlobalEventBus();
    return received;
  });
}

/** Standalone：真实 Rust 产物 + 帧通道 */
async function runStandalone(home: string, events: UiEvent[]): Promise<CoreEvent[]> {
  return withHome(home, async () => {
    const child = spawn(CORE_BINARY, ['stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
    const received: CoreEvent[] = [];
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
              event?: CoreEvent;
              request?: { type: string };
            };
            if (frame.kind === 'event' && frame.event) received.push(frame.event);
            // Core 的 `toolPermissionRequested`（工具授权 / 上架工具卡片）：
            // 与 Embedded 侧 `onCoreRequests` 的桩一致，一律回 allow。
            if (frame.kind === 'request' && typeof frame.id === 'number') {
              child.stdin.write(
                `${JSON.stringify({ kind: 'response', id: frame.id, ok: true, result: { behavior: 'allow' } })}\n`,
              );
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

    const send = (frame: unknown): void => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    };
    send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    await waitFor(() => received.some((event) => event.type === 'queryBegin' || event.type === 'log'), 5_000);
    for (const event of events) send({ kind: 'uiEvent', event });
    await waitFor(() => received.some((event) => event.type === 'queryEnd'), 15_000);
    // 与 Embedded 侧同一口径：多留一小段收集窗口，吸收异步的 MCP 同步事件。
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    await new Promise<void>((resolve) => {
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
    });
    return received;
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  const llm = await startFakeLlm();

  try {
    for (const scenario of SCENARIOS) {
      const embeddedHome = makeTempDir(`parity-embedded-${scenario.id}`);
      const standaloneHome = makeTempDir(`parity-standalone-${scenario.id}`);
      const embeddedSettings = writeSettings(embeddedHome, llm.url);
      const standaloneSettings = writeSettings(standaloneHome, llm.url);
      const embeddedWorkspace = path.join(embeddedHome, 'workspace');
      const standaloneWorkspace = path.join(standaloneHome, 'workspace');
      fs.mkdirSync(embeddedWorkspace, { recursive: true });
      fs.mkdirSync(standaloneWorkspace, { recursive: true });

      const embeddedEvents = await runEmbedded(
        embeddedHome,
        scriptedUiEvents(
          embeddedWorkspace,
          embeddedSettings,
          scenario.sessionId,
          scenario.content,
          scenario.deferEcho,
        ),
      );
      const standaloneEvents = await runStandalone(
        standaloneHome,
        scriptedUiEvents(
          standaloneWorkspace,
          standaloneSettings,
          scenario.sessionId,
          scenario.content,
          scenario.deferEcho,
        ),
      );
      const embedded = contractTypes(embeddedEvents);
      const standalone = contractTypes(standaloneEvents);

      check(`${scenario.name}：Embedded 跑出了完整一轮（${embedded.length} 个事件）`, embedded.length > 0);
      check(`${scenario.name}：Standalone 跑出了完整一轮（${standalone.length} 个事件）`, standalone.length > 0);

      // 1. 同一串 UiEvent 产生同一**组** CoreEvent（不多不少）。
      //    快照型事件（`sessionRuntimeChanged`）单列在第 3 条断言里：它推几次取决于
      //    「内部 diff 的观察点」，多推一次不携带新信息。
      const embeddedFacts = orderedTypes(embeddedEvents);
      const standaloneFacts = orderedTypes(standaloneEvents);
      check(
        `${scenario.name}：两种实现产生同一组 CoreEvent\n     embedded  = ${typeMultiset(embeddedFacts)}\n     standalone= ${typeMultiset(standaloneFacts)}`,
        typeMultiset(embeddedFacts) === typeMultiset(standaloneFacts),
      );

      // 2. 查询生命周期的相对顺序一致
      check(
        `${scenario.name}：查询生命周期顺序一致\n     embedded  = ${JSON.stringify(lifecycleSubsequence(embedded))}\n     standalone= ${JSON.stringify(lifecycleSubsequence(standalone))}`,
        JSON.stringify(lifecycleSubsequence(embedded)) ===
          JSON.stringify(lifecycleSubsequence(standalone)),
      );

      // 3. 两边都推了会话运行时快照，且收尾时是空闲
      for (const [label, events] of [
        ['embedded', embeddedEvents],
        ['standalone', standaloneEvents],
      ] as const) {
        const snapshots = events.filter((event) => event.type === 'sessionRuntimeChanged');
        check(`${scenario.name}：${label} 推送了 sessionRuntimeChanged`, snapshots.length > 0);
        const last = snapshots[snapshots.length - 1] as unknown as {
          states?: Array<{ sessionId: string; idle: boolean }>;
        };
        const mine = last.states?.find((state) => state.sessionId === scenario.sessionId);
        check(`${scenario.name}：${label} 收尾时会话回到空闲`, mine?.idle === true);
      }

      // 4. 摘掉快照事件后两边的交错仍然不同：这是已知且有意保留的差异
      //    （Embedded 的落盘是 fire-and-forget 的 `startPersist`，Rust 在调 LLM
      //    之前同步落盘，见 `DEVELOPMENT.md` 第 13.3.4 节）。这里显式打印，便于将来对照。
      console.log(
        `  · ${scenario.name} 摘掉快照后的序列\n     embedded  = ${JSON.stringify(orderedTypes(embeddedEvents))}\n     standalone= ${JSON.stringify(orderedTypes(standaloneEvents))}`,
      );
    }
  } finally {
    await llm.close();
  }

  finish();
}

runTests('core-event-parity', run);
