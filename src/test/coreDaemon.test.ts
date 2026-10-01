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
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
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

  // ---------- 控制通道背压：write 返回 false 的帧必须出队，不能反复重写 ----------
  //
  // `net.Socket.write` 对**超过 highWaterMark** 的帧恒返回 false（数据仍被接受、稍后照常写出）。
  // 若此时不把该帧移出出站队列，drain 回调会把同一帧一遍遍重写：帧被无限复制，且排在它
  // 后面的帧永远写不出去——表现为对端（Core）收不到后续应答而卡死（Edit 的 permResult
  // 携带整份文件内容，帧体积远超水位，最容易触发）。
  {
    const BIG_FRAME_CHARS = 20_000;
    const written: string[] = [];
    const stdinEmitter = new EventEmitter();
    const childEmitter = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // 只放行一次 drain：修复后足够把排在后面的帧写出去；未修复时同一帧会被重写第二次，
    // 断言随之失败（而不是陷入无界重写）。
    let drainBudget = 1;
    // 冒充 daemon：内层帧原样回应握手，其余帧只记录
    const respond = (line: string): void => {
      let frame: { kind?: string; id?: number; channel?: number; frame?: { kind?: string } };
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.kind === 'openWorkspace') {
        stdout.write(
          `${JSON.stringify({ kind: 'workspaceOpened', id: frame.id, channel: 1, descriptor: { kind: 'multiplexed', channel: 1 } })}\n`,
        );
      } else if (frame.kind === 'frame' && frame.frame?.kind === 'hello') {
        stdout.write(`${JSON.stringify({ kind: 'frame', channel: 1, frame: { kind: 'ready' } })}\n`);
      } else if (frame.kind === 'closeWorkspace') {
        stdout.write(
          `${JSON.stringify({ kind: 'workspaceClosed', channel: frame.channel, reason: 'closed' })}\n`,
        );
      }
    };
    const childState = { exitCode: null as number | null };
    const emitExit = (): void => {
      childState.exitCode = 0;
      childEmitter.emit('exit');
      childEmitter.emit('close');
    };
    const fakeChild = {
      pid: 4242,
      get exitCode(): number | null {
        return childState.exitCode;
      },
      signalCode: null,
      stdin: {
        write(chunk: string): boolean {
          written.push(chunk);
          // 真 daemon 的应答经管道异步到达；同步应答会在 flushOutbox 内部重入
          setImmediate(() => respond(chunk));
          if (chunk.includes('"kind":"shutdown"')) {
            setImmediate(emitExit);
            return true;
          }
          // 超过水位：返回 false，但数据已被接受
          const accepted = chunk.length < BIG_FRAME_CHARS;
          if (!accepted && drainBudget > 0) {
            drainBudget -= 1;
            setImmediate(() => stdinEmitter.emit('drain'));
          }
          return accepted;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => stdinEmitter.on(event, listener),
        once: (event: string, listener: (...args: unknown[]) => void) => stdinEmitter.once(event, listener),
      },
      stdout,
      stderr,
      on: (event: string, listener: (...args: unknown[]) => void) => childEmitter.on(event, listener),
      kill: emitExit,
    };
    const daemon = new CoreDaemon({
      binaryPath: 'fake',
      spawn: () => fakeChild as unknown as ChildProcessWithoutNullStreams,
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      // 关闭等待上限压到最小，避免假 daemon 的应答延迟拖慢用例
      shutdownTimeoutMs: 200,
    });
    const transport = daemon.openChannel(localWorkspaceRef('D:/repo/a'));
    const bus = createCoreChannelBus(transport, () => undefined);
    bus.onCoreEvents(createRecordingCoreEventHandlers().handlers);
    bus.onCoreRequests({
      toolPermissionRequested: async () => ({ behavior: 'allow' }),
      userChoice: async () => ({ index: 0 }),
    });
    check('背压用例完成握手', await waitFor(() => bus.isReady()));
    const bigEvent = { type: 'abortRequested', sessionId: 's1', padding: 'x'.repeat(BIG_FRAME_CHARS) };
    const smallEvent = { type: 'abortRequested', sessionId: 's2' };
    transport.send({ kind: 'uiEvent', event: bigEvent } as never);
    transport.send({ kind: 'uiEvent', event: smallEvent } as never);
    const innerFrames = (): Array<{ kind?: string; event?: { sessionId?: string } }> =>
      written
        .map((line) => {
          try {
            return JSON.parse(line) as { kind?: string; frame?: { kind?: string; event?: { sessionId?: string } } };
          } catch {
            return {};
          }
        })
        .filter((frame) => frame.kind === 'frame')
        .map((frame) => frame.frame ?? {});
    check(
      '背压下大帧之后的帧仍能写出',
      await waitFor(() => innerFrames().some((frame) => frame.event?.sessionId === 's2')),
    );
    check(
      '背压下大帧只写一次（不因 drain 反复重写）',
      innerFrames().filter((frame) => frame.event?.sessionId === 's1').length === 1,
    );
    // 关闭也设上限：未修复时出站队列卡死会让 shutdown 的等待计时器（unref）永不触发，
    // 进程会「无 pending handle」静默退出、丢掉失败退出码。
    const settle = async (promise: Promise<void>): Promise<void> => {
      await Promise.race([
        promise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    };
    await settle(bus.shutdown());
    await settle(daemon.shutdown());
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
