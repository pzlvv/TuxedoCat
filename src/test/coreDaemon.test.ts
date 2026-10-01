/**
 * daemon 客户端与通道总线用例（`docs/core-daemon.md` 第 10 节）：
 * - 控制通道协议编解码与校验；
 * - openWorkspace → channel / 描述符；两个 channel 互不影响；
 * - 内层帧原样转发（hello → ready 握手、uiEvent → CoreEvent）；
 * - Core 崩溃 → channelReset → 同一 channel 重新握手；
 * - 重启超限 → workspaceClosed(failed) → fatal；
 * - 关闭工作区 → workspaceClosed(closed) → 通道退出；
 * - daemon 崩溃 → 该 daemon 上全部 channel fatal；
 * - 真实 Core 产物 smoke（存在时）：daemon 起 Core、握手、hostEnvironmentProvided → coreReady。
 *
 * 用 Node 脚本冒充 daemon（`process.execPath -e <script>`），跑真实管道与真实进程。
 * 运行方式：npm run test:all -- core-daemon
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'child_process';
import { CoreDaemon } from '../host/standalone/CoreDaemon';
import {
  encodeDaemonFrame,
  isDaemonToHostFrame,
} from '../host/standalone/daemonProtocol';
import { createCoreChannelBus } from '../host/standalone/StandaloneEventBus';
import { localWorkspaceRef } from '../host/workspaceRef';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_RESOURCE_DIR } from '../config/project';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers, emptySettingsSnapshot } from './helpers/fixtures';
import type { CoreRequestHandlers } from '../core/AssistantEventBus';

// ==================== 假 daemon ====================

interface FakeDaemonOptions {
  /** openWorkspace 一律回 workspaceFailed */
  failOpen?: boolean;
  /** 收到 hello 不回 ready */
  neverReady?: boolean;
  /** 收到 abortRequested 时回 channelReset（模拟 Core 崩溃重启） */
  resetOnAbort?: boolean;
  /** 收到 abortRequested 时进程退出（模拟 daemon 崩溃） */
  exitOnAbort?: boolean;
  /** 收到 abortRequested 时回 channelReset + workspaceClosed(failed)（模拟重启超限） */
  failAfterAbort?: boolean;
  /** 收到 uiEvent 就回一条同 type 的 log 事件（断言帧确实到了 daemon） */
  echoUiEvents?: boolean;
}

/**
 * 生成冒充 daemon 的 Node 脚本。
 *
 * 不真的起子进程：每个 channel 用一个内存状态模拟 Core 的 hello → ready 行为，
 * 其余内层帧按选项回应。
 */
function fakeDaemonScript(options: FakeDaemonOptions = {}): string {
  return `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let nextChannel = 1;
const channels = new Map();

function openWorkspace(frame) {
  if (${options.failOpen ? 'true' : 'false'}) {
    send({ kind: 'workspaceFailed', id: frame.id, error: 'spawn failed' });
    return;
  }
  const channel = nextChannel++;
  channels.set(channel, { alive: true });
  send({ kind: 'workspaceOpened', id: frame.id, channel, descriptor: { kind: 'multiplexed', channel } });
}

function forwardInner(channel, inner) {
  const state = channels.get(channel);
  if (!state || !state.alive) return;
  if (inner.kind === 'hello') {
    if (!${options.neverReady ? 'true' : 'false'}) {
      send({ kind: 'frame', channel, frame: { kind: 'ready' } });
    }
    return;
  }
  if (inner.kind === 'shutdown') {
    state.alive = false;
    send({ kind: 'workspaceClosed', channel, reason: 'closed' });
    return;
  }
  if (inner.kind === 'uiEvent') {
    const type = inner.event && inner.event.type;
    if (type === 'abortRequested') {
      ${options.exitOnAbort ? 'process.exit(7);' : ''}
      ${
        options.resetOnAbort
          ? "if (!state.resetOnce) { state.resetOnce = true; send({ kind: 'channelReset', channel, reason: 'crashed' }); state.alive = true; return; }"
          : ''
      }
      ${options.failAfterAbort ? "send({ kind: 'channelReset', channel, reason: 'restart limit exceeded' }); send({ kind: 'workspaceClosed', channel, reason: 'failed' }); state.alive = false; return;" : ''}
    }
    if (${options.echoUiEvents ? 'true' : 'false'}) {
      send({ kind: 'frame', channel, frame: { kind: 'event', event: { type: 'log', message: 'ui:' + type } } });
    }
  }
}

rl.on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.kind === 'openWorkspace') return openWorkspace(frame);
  if (frame.kind === 'closeWorkspace') {
    const state = channels.get(frame.channel);
    if (state) state.alive = false;
    send({ kind: 'workspaceClosed', channel: frame.channel, reason: 'closed' });
    return;
  }
  if (frame.kind === 'frame') return forwardInner(frame.channel, frame.frame);
  if (frame.kind === 'shutdown') { process.exit(0); }
});
`;
}

interface Harness {
  daemon: CoreDaemon;
  transport: ReturnType<CoreDaemon['openChannel']>;
  bus: ReturnType<typeof createCoreChannelBus>;
  recording: ReturnType<typeof createRecordingCoreEventHandlers>;
}

function createHarness(options: FakeDaemonOptions = {}): Harness {
  const script = fakeDaemonScript(options);
  const daemon = new CoreDaemon({
    binaryPath: process.execPath,
    spawnArgs: ['-e', script],
    spawn: (command: string, args: readonly string[], spawnOptions: SpawnOptions) =>
      nodeSpawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams,
    log: () => undefined,
    handshakeTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
  const transport = daemon.openChannel(localWorkspaceRef('D:/repo/a'));
  const bus = createCoreChannelBus(transport, () => undefined);
  const recording = createRecordingCoreEventHandlers();
  bus.onCoreEvents(recording.handlers);
  const requestHandlers: CoreRequestHandlers = {
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  };
  bus.onCoreRequests(requestHandlers);
  return { daemon, transport, bus, recording };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------- 协议编解码 ----------
  {
    const encoded = encodeDaemonFrame({
      kind: 'openWorkspace',
      id: 1,
      workspaceRef: localWorkspaceRef('D:/repo'),
    });
    check('控制帧以换行结尾', encoded.endsWith('\n'));
    const decoded = JSON.parse(encoded.trimEnd());
    check('控制帧使用 camelCase 字段', decoded.kind === 'openWorkspace' && decoded.workspaceRef.path !== undefined);
    check('合法 daemon 帧通过校验', isDaemonToHostFrame({ kind: 'workspaceOpened', id: 1, channel: 1, descriptor: { kind: 'multiplexed', channel: 1 } }));
    check('未知 daemon 帧被拒绝', !isDaemonToHostFrame({ kind: 'nope' }));
    check('缺字段的 daemon 帧被拒绝', !isDaemonToHostFrame({ kind: 'channelReset', channel: 1 }));
  }

  // ---------- 握手与转发 ----------
  {
    const harness = createHarness({ echoUiEvents: true });
    check('openWorkspace 后通道就绪', await waitFor(() => harness.bus.isReady()));
    check('传输层报告已就绪', harness.transport.isReady());

    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('内层帧到达 daemon 并回传事件', await waitFor(() => harness.recording.count('log') >= 1));
    check('回传的是同一帧', harness.recording.last('log')?.message === 'ui:abortRequested');
    await harness.bus.shutdown();
    await harness.daemon.shutdown();
  }

  // ---------- 两个 channel 互不影响 ----------
  {
    const script = fakeDaemonScript({ echoUiEvents: true });
    const daemon = new CoreDaemon({
      binaryPath: process.execPath,
      spawnArgs: ['-e', script],
      spawn: (command, args, spawnOptions) =>
        nodeSpawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams,
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
    });
    const busA = createCoreChannelBus(daemon.openChannel(localWorkspaceRef('D:/repo/a')), () => undefined);
    const busB = createCoreChannelBus(daemon.openChannel(localWorkspaceRef('D:/repo/b')), () => undefined);
    const recordingA = createRecordingCoreEventHandlers();
    const recordingB = createRecordingCoreEventHandlers();
    busA.onCoreEvents(recordingA.handlers);
    busB.onCoreEvents(recordingB.handlers);
    busA.onCoreRequests({ toolPermissionRequested: async () => ({ behavior: 'allow' }), userChoice: async () => ({ index: 0 }) });
    busB.onCoreRequests({ toolPermissionRequested: async () => ({ behavior: 'allow' }), userChoice: async () => ({ index: 0 }) });

    check('两个 channel 都完成握手', await waitFor(() => busA.isReady() && busB.isReady()));
    busA.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('只有对应 channel 收到回传', await waitFor(() => recordingA.count('log') === 1));
    check('另一个 channel 不受影响', recordingB.count('log') === 0);
    await busA.shutdown();
    await busB.shutdown();
    await daemon.shutdown();
  }

  // ---------- Core 崩溃 → channelReset → 同一 channel 重新握手 ----------
  {
    const harness = createHarness({ resetOnAbort: true, echoUiEvents: true });
    await waitFor(() => harness.bus.isReady());
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    // 重置后自动重新握手（hello → ready），总线重新就绪
    check('channelReset 后重新握手成功', await waitFor(() => harness.bus.isReady()));
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('重置后仍可收发', await waitFor(() => harness.recording.count('log') >= 1));
    await harness.bus.shutdown();
    await harness.daemon.shutdown();
  }

  // ---------- 重启超限 → workspaceClosed(failed) → fatal ----------
  {
    const harness = createHarness({ failAfterAbort: true });
    await waitFor(() => harness.bus.isReady());
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('重启超限报告 fatal', await waitFor(() => fatal !== null));
    check('fatal 原因来自 channel 关闭', (fatal as unknown as Error)?.message.includes('failed'));
    await harness.daemon.shutdown();
  }

  // ---------- 关闭工作区 → workspaceClosed(closed) → 通道退出 ----------
  {
    const harness = createHarness();
    await waitFor(() => harness.bus.isReady());
    let exited = false;
    harness.bus.onExit(() => {
      exited = true;
    });
    await harness.bus.shutdown();
    check('关闭后通道报告退出', exited);
    check('关闭后传输层不再就绪', !harness.transport.isReady());
    await harness.daemon.shutdown();
  }

  // ---------- daemon 崩溃 → 全部 channel fatal ----------
  {
    const harness = createHarness({ exitOnAbort: true });
    await waitFor(() => harness.bus.isReady());
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('daemon 崩溃报告 fatal', await waitFor(() => fatal !== null));
  }

  // ---------- openWorkspace 失败 → fatal ----------
  {
    const harness = createHarness({ failOpen: true });
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    check('打开失败报告 fatal', await waitFor(() => fatal !== null));
    check('fatal 带上 daemon 的错误信息', (fatal as unknown as Error)?.message.includes('spawn failed'));
    await harness.daemon.shutdown();
  }

  // ---------- 真实 Core 产物 smoke（存在时）----------
  {
    const repoRoot = path.resolve(__dirname, '../../..');
    const binary = path.join(
      repoRoot,
      'resources',
      CORE_RESOURCE_DIR,
      corePlatformDir('win32', 'x64')!,
      coreBinaryFileName('win32'),
    );
    if (process.platform !== 'win32' || process.arch !== 'x64' || !fs.existsSync(binary)) {
      console.log(`skip real daemon smoke: ${path.relative(repoRoot, binary)} missing`);
    } else {
      const daemon = new CoreDaemon({
        binaryPath: binary,
        log: () => undefined,
        handshakeTimeoutMs: 15_000,
        shutdownTimeoutMs: 5_000,
      });
      const bus = createCoreChannelBus(daemon.openChannel(localWorkspaceRef('D:/repo/a')), () => undefined);
      const recording = createRecordingCoreEventHandlers();
      bus.onCoreEvents(recording.handlers);
      bus.onCoreRequests({ toolPermissionRequested: async () => ({ behavior: 'allow' }), userChoice: async () => ({ index: 0 }) });
      check('真实 daemon 起 Core 并握手', await waitFor(() => bus.isReady(), 20_000));
      bus.emitToCore({
        type: 'hostEnvironmentProvided',
        extensionPath: repoRoot,
        logToConsole: false,
        configDirName: '.tuxedo-cat-test',
        settings: emptySettingsSnapshot(),
        mcpServers: [],
      });
      check('Core 处理快照后回 coreReady', await waitFor(() => recording.count('coreReady') >= 1, 10_000));
      await bus.shutdown();
      await daemon.shutdown();
    }
  }

  finish();
}

runTests('coreDaemon', run);
