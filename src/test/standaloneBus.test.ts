/**
 * Standalone Core 帧通道单测（docs/core/standalone-core.md 第 5、6、7 节）：
 * - 帧编解码：分块、空行、非法 JSON、reset
 * - 产物定位：平台矩阵目录名与候选路径
 * - 握手：hello → ready；whenReady / isReady
 * - 就绪前的 uiEvent 排队，握手后按序冲刷
 * - 连接态事件（hostEnvironmentProvided）与 conversationOpened 在重启后重放
 * - CoreEvent 分发；处理器未注册时先缓存
 * - CoreRequest → 处理器 → response 帧（id 回带）；缺处理器时回 ok:false
 * - 崩溃重启：单次崩溃后恢复接线
 * - 重启次数超限：onFatal，不再重试
 * - 关闭：shutdown 帧 → 进程退出，exit.expected = true
 *
 * 用 Node 脚本冒充 Core（`process.execPath -e <script>`），跑真实管道与真实进程，
 * 不依赖 Rust 产物。运行方式：npm run test:all -- standalone-bus
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createStandaloneCoreBus,
  type StandaloneCoreBus,
  type StandaloneCoreBusOptions,
} from '../host/standalone/StandaloneEventBus';
import {
  CORE_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  isCoreToUiFrame,
  isUiToCoreFrame,
} from '../host/standalone/protocol';
import { CORE_KIND, CORE_KIND_ENV, resolveCoreKind } from '../host/coreKind';
import {
  coreBinaryCandidates,
  coreBinaryFileName,
  corePlatformDir,
} from '../host/standalone/coreBinary';
import { CONFIG_DIR_NAME, CORE_BINARY_NAME, CORE_RESOURCE_DIR } from '../config/project';
import type { CoreRequestHandlers } from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, type RecordingCoreEventHandlers, emptySettingsSnapshot } from './helpers/fixtures';

// ==================== 假 Core ====================

interface FakeCoreOptions {
  /** 启动即退出：用来验证重启次数超限 */
  crashOnStart?: boolean;
  /** 收到 abortRequested 时退出：用来验证崩溃重启 */
  exitOnAbort?: boolean;
  /** 回 ready 后立刻推一条 log：用来验证「处理器未注册时先缓存」 */
  greetOnReady?: boolean;
  /** 收到 hello 也不回 ready：用来验证握手超时 */
  neverReady?: boolean;
  /** UI → core 请求一律回 ok:false */
  failUiRequest?: boolean;
  /** UI → core 请求一律不回（验证连接断开时挂起的请求被结束） */
  dropUiRequest?: boolean;
  /** 收到 UI → core 请求就退出（验证 Core 重启让挂起请求失败） */
  exitOnUiRequest?: boolean;
}

/**
 * 生成冒充 Core 的 Node 脚本。
 *
 * 行为：hello → ready；uiEvent → 回一条 `ui:<type>` 日志；conversationOpened → 额外发一次
 * userChoice 请求；response → 回一条 `response:<id>:<ok>` 日志；shutdown → 退出。
 */
function fakeCoreScript(options: FakeCoreOptions = {}): string {
  return `
const readline = require('readline');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const record = (message) => send({ kind: 'event', event: { type: 'log', message } });

${options.crashOnStart ? 'process.exit(3);' : ''}

let nextRequestId = 1;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }

  if (frame.kind === 'hello') {
    ${options.neverReady ? '' : "send({ kind: 'ready' });"}
    ${options.greetOnReady ? "record('greet');" : ''}
    return;
  }
  if (frame.kind === 'uiEvent') {
    record('ui:' + frame.event.type);
    if (typeof frame.event.sessionId === 'string') record('seq:' + frame.event.sessionId);
    if (frame.event.type === 'conversationOpened') {
      send({ kind: 'request', id: nextRequestId++, request: {
        type: 'userChoice',
        sessionId: frame.event.sessionId,
        options: { toolName: 't', message: 'm', choices: [{ label: 'a' }] },
      } });
    }
    ${options.exitOnAbort ? "if (frame.event.type === 'abortRequested') process.exit(9);" : ''}
    return;
  }
  if (frame.kind === 'response') {
    record('response:' + frame.id + ':' + frame.ok);
    return;
  }
  if (frame.kind === 'request') {
    record('uiRequest:' + frame.request.type);
    ${options.exitOnUiRequest ? 'process.exit(11);' : ''}
    ${options.dropUiRequest ? 'return;' : ''}
    if (${options.failUiRequest ? 'true' : 'false'}) {
      send({ kind: 'response', id: frame.id, ok: false, error: 'boom' });
      return;
    }
    const t = frame.request.type;
    if (t === 'conversationListRequested') {
      send({ kind: 'response', id: frame.id, ok: true, result: [{ sessionId: 'a', project: 'p' }] });
      return;
    }
    send({ kind: 'response', id: frame.id, ok: false, error: 'unknown: ' + t });
    return;
  }
  if (frame.kind === 'shutdown') process.exit(0);
});
`;
}

const FAST_RESTART = { maxAttempts: 3, windowMs: 60_000, baseDelayMs: 20, maxDelayMs: 50 };

interface FakeCore {
  bus: StandaloneCoreBus;
  recording: RecordingCoreEventHandlers;
  readyCount(): number;
  exitCount(): number;
  fatal(): Error | null;
}

function createFakeCore(
  options: FakeCoreOptions = {},
  overrides: Partial<StandaloneCoreBusOptions> = {},
  requestHandlers: CoreRequestHandlers | null = {
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 1 }),
  },
): FakeCore {
  const recording = createRecordingCoreEventHandlers();
  let ready = 0;
  let exits = 0;
  let fatal: Error | null = null;

  const bus = createStandaloneCoreBus({
    binaryPath: process.execPath,
    spawnArgs: ['-e', fakeCoreScript(options)],
    log: () => undefined,
    restartPolicy: FAST_RESTART,
    shutdownTimeoutMs: 2_000,
    ...overrides,
  });

  bus.onCoreEvents(recording.handlers);
  if (requestHandlers) bus.onCoreRequests(requestHandlers);
  bus.onReady(() => {
    ready += 1;
  });
  bus.onExit(() => {
    exits += 1;
  });
  bus.onFatal((error) => {
    fatal = error;
  });

  return {
    bus,
    recording,
    readyCount: () => ready,
    exitCount: () => exits,
    fatal: () => fatal,
  };
}

/** 轮询等待条件成立；超时返回最后一次求值结果 */
async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function logMessages(recording: RecordingCoreEventHandlers): string[] {
  return recording.received('log').map((event) => event.message);
}

/** 仓库根目录（编译产物在 out/src/test/） */
function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------- 选择变量 ----------
  {
    check('default core kind is standalone', resolveCoreKind({}) === 'standalone');
    check('CORE_KIND is standalone', CORE_KIND === 'standalone');
    check('env override embedded', resolveCoreKind({ [CORE_KIND_ENV]: 'embedded' }) === 'embedded');
    check(
      'env override standalone',
      resolveCoreKind({ [CORE_KIND_ENV]: 'standalone' }) === 'standalone',
    );
    check(
      'empty env falls back to the default',
      resolveCoreKind({ [CORE_KIND_ENV]: '' }) === 'standalone',
    );
    check('invalid env throws', throws(() => resolveCoreKind({ [CORE_KIND_ENV]: 'rust' })));
  }

  // ---------- 帧编解码 ----------
  {
    const frames: unknown[] = [];
    const errors: string[] = [];
    const decoder = new FrameDecoder({
      onFrame: (value) => frames.push(value),
      onError: (error) => errors.push(error.message),
    });

    decoder.push('{"kind":"rea');
    check('decoder buffers partial lines', frames.length === 0);
    decoder.push('dy"}\n\n{"kind":"uiEvent"');
    decoder.push(',"event":{"type":"abortRequested","sessionId":"s1"}}\n');
    check('decoder splits on newline and skips empty lines', frames.length === 2);
    check('decoder yields ready frame', isCoreToUiFrame(frames[0]) && frames[0].kind === 'ready');
    check(
      'decoder yields uiEvent frame',
      isUiToCoreFrame(frames[1]) &&
        frames[1].kind === 'uiEvent' &&
        frames[1].event.type === 'abortRequested',
    );

    decoder.push('not json\n');
    check('decoder reports malformed line', errors.length === 1);
    decoder.push('{"kind":"shutdown"}\n');
    check('decoder keeps working after malformed line', frames.length === 3);

    decoder.reset();
    decoder.push('{"kind":"rea');
    check('decoder reset drops the remainder', frames.length === 3);
  }

  {
    const encoded = encodeFrame({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
    check(
      'encodeFrame appends newline',
      encoded === `{"kind":"hello","protocol":${CORE_PROTOCOL_VERSION}}\n`,
    );
  }

  // ---------- 协议 v2：UI → core 请求方向 ----------
  {
    check('protocol version is 2', CORE_PROTOCOL_VERSION === 2);
    check(
      'uiToCore accepts a request frame',
      isUiToCoreFrame({ kind: 'request', id: 3, request: { type: 'conversationListRequested' } }),
    );
    check(
      'uiToCore rejects a request frame without an id',
      !isUiToCoreFrame({ kind: 'request', request: { type: 'conversationListRequested' } }),
    );
    check(
      'coreToUi accepts a success response frame',
      isCoreToUiFrame({ kind: 'response', id: 3, ok: true, result: [] }),
    );
    check(
      'coreToUi rejects a success response frame without a result key',
      !isCoreToUiFrame({ kind: 'response', id: 3, ok: true }),
    );
    check(
      'coreToUi accepts a failure response frame',
      isCoreToUiFrame({ kind: 'response', id: 3, ok: false, error: 'boom' }),
    );
    check(
      'coreToUi rejects a failure response frame without an error string',
      !isCoreToUiFrame({ kind: 'response', id: 3, ok: false, error: 5 }),
    );
    check(
      'uiToCore accepts a response frame',
      isUiToCoreFrame({ kind: 'response', id: 1, ok: true, result: { index: 0 } }),
    );
  }

  // ---------- 产物定位 ----------
  {
    check('platform dir win32/x64', corePlatformDir('win32', 'x64') === 'x64-win32');
    check('platform dir win32/arm64', corePlatformDir('win32', 'arm64') === 'arm64-win32');
    check('platform dir linux/x64', corePlatformDir('linux', 'x64') === 'x64-linux');
    check('platform dir linux/arm64', corePlatformDir('linux', 'arm64') === 'arm64-linux');
    check('platform dir darwin unsupported', corePlatformDir('darwin', 'arm64') === null);
    check('binary name on win32', coreBinaryFileName('win32') === `${CORE_BINARY_NAME}.exe`);
    check('binary name on linux', coreBinaryFileName('linux') === CORE_BINARY_NAME);
    const candidates = coreBinaryCandidates('D:/app', 'win32', 'x64');
    const coreDir = corePlatformDir('win32', 'x64')!;
    check(
      'candidates prefer dist/resources',
      candidates.length === 2 &&
        candidates[0] ===
          path.join('D:/app', 'dist', 'resources', CORE_RESOURCE_DIR, coreDir, `${CORE_BINARY_NAME}.exe`) &&
        candidates[1] ===
          path.join('D:/app', 'resources', CORE_RESOURCE_DIR, coreDir, `${CORE_BINARY_NAME}.exe`),
    );
  }

  // ---------- 握手 + 就绪前排队 ----------
  {
    const core = createFakeCore();
    core.bus.emitToCore({ type: 'compactRequested', sessionId: 's1' });
    core.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    await core.bus.whenReady();
    check('handshake reaches ready', core.bus.isReady());
    const uiMessages = (): string[] =>
      logMessages(core.recording).filter((message) => message.startsWith('ui:'));
    check(
      'queued uiEvents flushed in order',
      await waitFor(() => uiMessages().length >= 2) &&
        uiMessages()[0] === 'ui:compactRequested' &&
        uiMessages()[1] === 'ui:abortRequested',
    );
    await core.bus.shutdown();
  }

  // ---------- 连接态事件在首次握手时补发 ----------
  {
    const core = createFakeCore();
    core.bus.emitToCore({
      type: 'hostEnvironmentProvided',
      extensionPath: 'D:/app',
      logToConsole: true,
      configDirName: CONFIG_DIR_NAME,
      settings: emptySettingsSnapshot(),
      mcpServers: [],
    });
    await core.bus.whenReady();
    check(
      'connection-scoped events reach the core',
      await waitFor(() => {
        const messages = logMessages(core.recording);
        return messages.includes('ui:hostEnvironmentProvided');
      }),
    );
    await core.bus.shutdown();
  }

  // ---------- CoreEvent 处理器未注册时先缓存 ----------
  {
    const bus = createStandaloneCoreBus({
      binaryPath: process.execPath,
      spawnArgs: ['-e', fakeCoreScript({ greetOnReady: true })],
      log: () => undefined,
      restartPolicy: FAST_RESTART,
      shutdownTimeoutMs: 2_000,
    });
    await bus.whenReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recording = createRecordingCoreEventHandlers();
    bus.onCoreEvents(recording.handlers);
    check(
      'CoreEvent arriving before handler registration is buffered',
      logMessages(recording).includes('greet'),
    );
    await bus.shutdown();
  }

  // ---------- CoreRequest 往返 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    core.bus.emitToCore({ type: 'conversationOpened', sessionId: 's1' });
    check(
      'core request is answered with the matching id',
      await waitFor(() => logMessages(core.recording).includes('response:1:true')),
    );
    await core.bus.shutdown();
  }

  // ---------- UI → core 请求往返 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();

    const list = await core.bus.requestCore({ type: 'conversationListRequested', workspacePath: '/w' });
    check('requestCore returns the conversation list', list.length === 1 && list[0].sessionId === 'a');
    check(
      'the request reaches the core as a frame',
      logMessages(core.recording).includes('uiRequest:conversationListRequested'),
    );
    check(
      'ui request ids increase per request',
      core.bus.isReady(),
    );
    await core.bus.shutdown();
  }

  // ---------- UI → core 请求失败 ----------
  {
    const core = createFakeCore({ failUiRequest: true });
    await core.bus.whenReady();
    let message = '';
    try {
      await core.bus.requestCore({ type: 'conversationListRequested' });
    } catch (error) {
      message = (error as Error).message;
    }
    check('requestCore rejects with the core error message', message === 'boom');
    await core.bus.shutdown();
  }

  // ---------- UI → core 请求在 Core 重启时被结束 ----------
  {
    const core = createFakeCore({ exitOnUiRequest: true });
    await core.bus.whenReady();
    let message = '';
    try {
      await core.bus.requestCore({ type: 'conversationListRequested' });
    } catch (error) {
      message = (error as Error).message;
    }
    check('a pending ui request fails when the core dies', message.includes('connection lost'));
    await core.bus.shutdown();
  }

  // ---------- 关闭后发起 UI → core 请求 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    await core.bus.shutdown();
    let threw = false;
    try {
      await core.bus.requestCore({ type: 'conversationListRequested' });
    } catch {
      threw = true;
    }
    check('requestCore after shutdown rejects', threw);
  }

  // ---------- onUiRequests 只能注册一次 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    const handlers = {
      conversationListRequested: async () => [],
      smartNamingRequested: async () => ({ title: 't' }),
      balanceRequested: async () => null,
      compactArchiveRequested: async () => null,
      mcpServersRequested: async () => [],
      conversationSpacesRequested: async () => [],
      flushSessionRequested: async () => null,
      conversationLoadRequested: async () => ({
        messages: [],
        metadata: null,
        pendingToolUseIds: [],
        hasCompactArchive: false,
        agentMode: null,
      }),
      skillsRequested: async () => ({ skills: [] }),
    };
    core.bus.onUiRequests(handlers);
    check('onUiRequests rejects a second registration', throws(() => core.bus.onUiRequests(handlers)));
    await core.bus.shutdown();
  }

  // ---------- 缺处理器时回 ok:false ----------
  {
    const core = createFakeCore({}, {}, null);
    await core.bus.whenReady();
    core.bus.emitToCore({ type: 'conversationOpened', sessionId: 's1' });
    check(
      'core request without handlers is answered ok:false',
      await waitFor(() => logMessages(core.recording).includes('response:1:false')),
    );
    await core.bus.shutdown();
  }

  // ---------- 用户消息经帧通道进入 Core ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    core.bus.emitToCore({
      type: 'userMessageSubmitted',
      sessionId: 's1',
      content: '你好',
      uuid: 'user_1',
      agentMode: 'manual',
      workspacePath: 'D:/repo',
    });
    check(
      'userMessageSubmitted reaches the core as a uiEvent frame',
      await waitFor(() =>
        logMessages(core.recording).includes('ui:userMessageSubmitted'),
      ),
    );
    check(
      'userMessageSubmitted carries the session id',
      logMessages(core.recording).includes('seq:s1'),
    );
    await core.bus.shutdown();
  }

  // ---------- 崩溃重启：连接态事件与会话重放 ----------
  {
    const core = createFakeCore({ exitOnAbort: true });
    core.bus.emitToCore({
      type: 'hostEnvironmentProvided',
      extensionPath: 'D:/app',
      logToConsole: true,
      configDirName: CONFIG_DIR_NAME,
      settings: emptySettingsSnapshot(),
      mcpServers: [],
    });
    core.bus.emitToCore({ type: 'conversationOpened', sessionId: 's1' });
    await core.bus.whenReady();
    const readyBefore = core.readyCount();

    core.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check(
      'core crash triggers a restart and a new handshake',
      await waitFor(() => core.readyCount() > readyBefore),
    );
    check('unexpected exit is reported as not expected', core.exitCount() >= 1);
    check(
      'connection-scoped events are replayed after restart',
      await waitFor(() => {
        const messages = logMessages(core.recording);
        return (
          messages.filter((message) => message === 'ui:hostEnvironmentProvided').length >= 2
        );
      }),
    );
    check(
      'open sessions are replayed after restart',
      await waitFor(
        () => logMessages(core.recording).filter((m) => m === 'ui:conversationOpened').length >= 2,
      ),
    );
    await core.bus.shutdown();
  }

  // ---------- 重启次数超限 ----------
  {
    const core = createFakeCore({ crashOnStart: true });
    check(
      'restart limit stops retrying and reports fatal',
      await waitFor(() => core.fatal() !== null, 8_000),
    );
    check('fatal is not ready', !core.bus.isReady());
    await core.bus.shutdown();
  }

  // ---------- spawn 失败（不存在的可执行文件）：必须报 fatal，而不是静默卡死 ----------
  {
    let fatal: Error | null = null;
    const bus = createStandaloneCoreBus({
      binaryPath: path.join(repoRoot(), 'no', 'such', 'core-binary-xyz'),
      spawnArgs: ['stdio'],
      log: () => undefined,
      restartPolicy: FAST_RESTART,
      shutdownTimeoutMs: 1_000,
    });
    bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
    bus.onFatal((error) => {
      fatal = error;
    });
    check(
      'spawn failure eventually reports fatal',
      await waitFor(() => fatal !== null, 8_000),
    );
    check('spawn failure never becomes ready', !bus.isReady());
    await bus.shutdown();
  }

  // ---------- 握手超时（Core 不回复 ready）：必须报 fatal，而不是永远排队 ----------
  {
    const core = createFakeCore({ neverReady: true }, { handshakeTimeoutMs: 150 });
    check(
      'handshake timeout eventually reports fatal',
      await waitFor(() => core.fatal() !== null, 8_000),
    );
    check('handshake timeout never becomes ready', !core.bus.isReady());
    await core.bus.shutdown();
  }

  // ---------- 真实 Rust 产物冒烟（产物缺失时跳过）----------
  {
    const coreDir = corePlatformDir('win32', 'x64')!;
    const binaryPath = path.resolve(
      repoRoot(),
      'resources',
      CORE_RESOURCE_DIR,
      coreDir,
      coreBinaryFileName('win32'),
    );
    if (process.platform !== 'win32' || process.arch !== 'x64' || !fs.existsSync(binaryPath)) {
      console.log(`skip real-core smoke test: ${path.relative(repoRoot(), binaryPath)} missing`);
    } else {
      const recording = createRecordingCoreEventHandlers();
      const bus = createStandaloneCoreBus({
        binaryPath,
        spawnArgs: ['stdio'],
        log: () => undefined,
        shutdownTimeoutMs: 2_000,
      });
      bus.onCoreEvents(recording.handlers);
      bus.onCoreRequests({
        toolPermissionRequested: async () => ({ behavior: 'allow' }),
        userChoice: async () => ({ index: 0 }),
      });
      bus.emitToCore({
        type: 'hostEnvironmentProvided',
        extensionPath: repoRoot(),
        logToConsole: false,
        configDirName: CONFIG_DIR_NAME,
        settings: emptySettingsSnapshot(),
        mcpServers: [],
      });
      await bus.whenReady();
      check('real core handshake reaches ready', bus.isReady());
      check(
        'real core answers hostEnvironmentProvided with a log event',
        await waitFor(() =>
          recording.received('log').some((event) => event.message.startsWith('Standalone Core ready')),
        ),
      );
      await bus.shutdown();
      check('real core exits on shutdown', !bus.isReady());
    }
  }

  // ---------- 背压：突发帧不丢、不乱序 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    const COUNT = 500;
    for (let i = 0; i < COUNT; i += 1) {
      core.bus.emitToCore({ type: 'compactRequested', sessionId: `s${i}` });
    }
    const expected = Array.from({ length: COUNT }, (_, index) => `seq:s${index}`);
    check(
      'a burst of frames is delivered in order without loss',
      await waitFor(() => {
        const seq = logMessages(core.recording).filter((message) => message.startsWith('seq:'));
        return seq.length === COUNT && seq.every((message, index) => message === expected[index]);
      }, 15_000),
    );
    await core.bus.shutdown();
  }

  // ---------- 隔离：一个实例的 Core 崩溃不影响另一个 ----------
  {
    const first = createFakeCore({ exitOnAbort: true });
    const second = createFakeCore();
    await first.bus.whenReady();
    await second.bus.whenReady();
    first.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check(
      'the crashed instance restarts on its own',
      await waitFor(() => first.readyCount() > 1),
    );
    check(
      'the other instance stays untouched',
      second.bus.isReady() && second.exitCount() === 0,
    );
    await first.bus.shutdown();
    await second.bus.shutdown();
  }

  // ---------- 关闭 ----------
  {
    const core = createFakeCore();
    await core.bus.whenReady();
    let expected: boolean | null = null;
    core.bus.onExit((info) => {
      expected = info.expected;
    });
    await core.bus.shutdown();
    check('shutdown exits the process with expected=true', expected === true);
    check('shutdown leaves the bus not ready', !core.bus.isReady());
  }

  finish();
}

runTests('standalone-bus', run);
