/**
 * daemon 客户端与通道总线用例（`docs/core-daemon.md` 第 10 节）：
 * - 控制通道协议编解码与校验；
 * - openWorkspace → channel / 描述符；两个 channel 互不影响；
 * - 内层帧原样转发（hello → ready 握手、uiEvent → CoreEvent）；
 * - Core 崩溃 → channelReset → 同一 channel 重新握手；
 * - 重启超限 → workspaceClosed(failed) → fatal；
 * - 关闭工作区 → workspaceClosed(closed) → 通道退出；
 * - daemon 断开 → 该 daemon 上全部 channel fatal；
 * - 真实 Core 产物 smoke（存在时）：连真实 daemon、起 Core、握手、coreReady。
 *
 * 冒充 daemon 的是本进程里的真实 TCP server：跑真实 socket 与真实帧编解码。
 * 运行方式：npm run test:all -- core-daemon
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { CoreDaemon, tcpDaemonOpener } from '../host/standalone/CoreDaemon';
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

// ==================== 假 daemon（真实 TCP server）====================

/** 控制帧（假 daemon 只按用到的字段取值） */
type ControlFrame = Record<string, any>;

interface FakeDaemonOptions {
  /** openWorkspace 一律回 workspaceFailed */
  failOpen?: boolean;
  /** 收到 abortRequested 时回 channelReset（模拟 Core 崩溃重启） */
  resetOnAbort?: boolean;
  /** 收到 abortRequested 时断开连接（模拟 daemon 崩溃） */
  dropOnAbort?: boolean;
  /** 收到 abortRequested 时回 channelReset + workspaceClosed(failed)（模拟重启超限） */
  failAfterAbort?: boolean;
  /** 收到 uiEvent 就回一条同 type 的 log 事件（断言帧确实到了 daemon） */
  echoUiEvents?: boolean;
}

interface FakeDaemon {
  port: number;
  /** 收到的全部控制帧（含第一帧 `auth`） */
  readonly received: ControlFrame[];
  /** 关掉 server 与全部连接 */
  close(): Promise<void>;
}

interface ChannelState {
  alive: boolean;
  resetOnce: boolean;
}

/**
 * 起一个冒充 daemon 的 TCP server。
 *
 * 不真的起子进程：每个 channel 用一个内存状态模拟 Core 的 hello → ready 行为，
 * 其余内层帧按选项回应。第一帧必须是 `auth`，token 是 `secret`。
 */
async function startFakeDaemon(options: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const expectedToken = 'secret';
  const received: ControlFrame[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));

    let authed = false;
    let buffer = '';
    let nextChannel = 1;
    const channels = new Map<number, ChannelState>();
    const send = (frame: unknown): void => {
      socket.write(`${JSON.stringify(frame)}\n`);
    };

    const openWorkspace = (frame: ControlFrame): void => {
      if (options.failOpen) {
        send({ kind: 'workspaceFailed', id: frame.id, error: 'spawn failed' });
        return;
      }
      const channel = nextChannel;
      nextChannel += 1;
      channels.set(channel, { alive: true, resetOnce: false });
      send({
        kind: 'workspaceOpened',
        id: frame.id,
        channel,
        descriptor: { kind: 'multiplexed', channel },
      });
    };

    const forwardInner = (channel: number, inner: ControlFrame): void => {
      const state = channels.get(channel);
      if (!state || !state.alive) return;
      if (inner.kind === 'hello') {
        send({ kind: 'frame', channel, frame: { kind: 'ready' } });
        return;
      }
      if (inner.kind === 'shutdown') {
        state.alive = false;
        send({ kind: 'workspaceClosed', channel, reason: 'closed' });
        return;
      }
      if (inner.kind === 'uiEvent') {
        const type = inner.event?.type;
        if (type === 'abortRequested') {
          if (options.dropOnAbort) {
            socket.destroy();
            return;
          }
          if (options.resetOnAbort && !state.resetOnce) {
            state.resetOnce = true;
            send({ kind: 'channelReset', channel, reason: 'crashed' });
            return;
          }
          if (options.failAfterAbort) {
            send({ kind: 'channelReset', channel, reason: 'restart limit exceeded' });
            send({ kind: 'workspaceClosed', channel, reason: 'failed' });
            state.alive = false;
            return;
          }
        }
        if (options.echoUiEvents) {
          send({
            kind: 'frame',
            channel,
            frame: { kind: 'event', event: { type: 'log', message: `ui:${type}` } },
          });
        }
      }
    };

    const handle = (frame: ControlFrame): void => {
      switch (frame.kind) {
        case 'openWorkspace':
          openWorkspace(frame);
          return;
        case 'closeWorkspace': {
          const state = channels.get(frame.channel);
          if (state) state.alive = false;
          send({ kind: 'workspaceClosed', channel: frame.channel, reason: 'closed' });
          return;
        }
        case 'frame':
          forwardInner(frame.channel, frame.frame);
          return;
        case 'shutdown':
          // 对端发完 shutdown 就 half-close；这里跟着关，客户端才会收到 close
          socket.end();
          return;
        default:
          return;
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim().length === 0) continue;
        let frame: ControlFrame;
        try {
          frame = JSON.parse(line) as ControlFrame;
        } catch {
          continue;
        }
        received.push(frame);
        if (!authed) {
          if (frame.kind === 'auth' && frame.token === expectedToken) {
            authed = true;
            send({ kind: 'authOk' });
          } else {
            send({ kind: 'authFailed', error: 'bad token' });
            socket.end();
          }
          continue;
        }
        handle(frame);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/** 建一条连到假 daemon 的 CoreDaemon */
function connectFakeDaemon(port: number): CoreDaemon {
  return new CoreDaemon({
    transport: tcpDaemonOpener({ host: '127.0.0.1', port, token: 'secret' }),
    log: () => undefined,
    handshakeTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
  });
}

/** 给一条 channel 接上总线与请求处理 */
function openBus(daemon: CoreDaemon, path: string) {
  const transport = daemon.openChannel(localWorkspaceRef(path));
  const bus = createCoreChannelBus(transport, () => undefined);
  const recording = createRecordingCoreEventHandlers();
  bus.onCoreEvents(recording.handlers);
  const requestHandlers: CoreRequestHandlers = {
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  };
  bus.onCoreRequests(requestHandlers);
  return { transport, bus, recording };
}

interface Harness {
  daemon: CoreDaemon;
  fake: FakeDaemon;
  transport: ReturnType<CoreDaemon['openChannel']>;
  bus: ReturnType<typeof createCoreChannelBus>;
  recording: ReturnType<typeof createRecordingCoreEventHandlers>;
}

async function createHarness(options: FakeDaemonOptions = {}): Promise<Harness> {
  const fake = await startFakeDaemon(options);
  const daemon = connectFakeDaemon(fake.port);
  const { transport, bus, recording } = openBus(daemon, 'D:/repo/a');
  return { daemon, fake, transport, bus, recording };
}

/** 一条用例的收尾：关总线、关 daemon、关假 server */
async function dispose(harness: Harness): Promise<void> {
  await harness.bus.shutdown();
  await harness.daemon.shutdown();
  await harness.fake.close();
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ==================== 真实产物 smoke ====================

/**
 * 读真实 daemon 启动输出里的连接串（`<IP>:<端口>#<token>`；读不到就在超时后 reject）。
 *
 * 连接串单独占一行，提示行里不含该形态，按行匹配即可。
 *
 * 子进程以 `stdio: ['ignore', 'pipe', 'pipe']` 启动（daemon 不读 stdin），
 * 因此类型是 `ChildProcessByStdio<null, Readable, Readable>` 而不是 `ChildProcessWithoutNullStreams`。
 */
function readConnectionString(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ host: string; port: number; token: string }> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`connection string timeout: ${text}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      const match = /^([^#\s]+):(\d+)#(\S+)$/m.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve({ host: match[1], port: Number(match[2]), token: match[3] });
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}`));
    });
  });
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
    const harness = await createHarness({ echoUiEvents: true });
    check('openWorkspace 后通道就绪', await waitFor(() => harness.bus.isReady()));
    check('传输层报告已就绪', harness.transport.isReady());
    check('控制通道第一帧是 auth', harness.fake.received[0]?.kind === 'auth');

    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('内层帧到达 daemon 并回传事件', await waitFor(() => harness.recording.count('log') >= 1));
    check('回传的是同一帧', harness.recording.last('log')?.message === 'ui:abortRequested');
    await dispose(harness);
  }

  // ---------- 鉴权失败 → 连接不可用 ----------
  {
    const fake = await startFakeDaemon();
    const daemon = new CoreDaemon({
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port, token: 'wrong' }),
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
    });
    const { bus } = openBus(daemon, 'D:/repo/a');
    let fatal: Error | null = null;
    bus.onFatal((error) => {
      fatal = error;
    });
    check('错误 token 报告 fatal', await waitFor(() => fatal !== null));
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 两个 channel 互不影响 ----------
  {
    const fake = await startFakeDaemon({ echoUiEvents: true });
    const daemon = connectFakeDaemon(fake.port);
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
    await fake.close();
  }

  // ---------- Core 崩溃 → channelReset → 同一 channel 重新握手 ----------
  {
    const harness = await createHarness({ resetOnAbort: true, echoUiEvents: true });
    await waitFor(() => harness.bus.isReady());
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    // 重置后自动重新握手（hello → ready），总线重新就绪
    check('channelReset 后重新握手成功', await waitFor(() => harness.bus.isReady()));
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('重置后仍可收发', await waitFor(() => harness.recording.count('log') >= 1));
    await dispose(harness);
  }

  // ---------- 重启超限 → workspaceClosed(failed) → fatal ----------
  {
    const harness = await createHarness({ failAfterAbort: true });
    await waitFor(() => harness.bus.isReady());
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('重启超限报告 fatal', await waitFor(() => fatal !== null));
    check('fatal 原因来自 channel 关闭', (fatal as unknown as Error)?.message.includes('failed'));
    await dispose(harness);
  }

  // ---------- 关闭工作区 → workspaceClosed(closed) → 通道退出 ----------
  {
    const harness = await createHarness();
    await waitFor(() => harness.bus.isReady());
    let exited = false;
    harness.bus.onExit(() => {
      exited = true;
    });
    await harness.bus.shutdown();
    check('关闭后通道报告退出', exited);
    check('关闭后传输层不再就绪', !harness.transport.isReady());
    await dispose(harness);
  }

  // ---------- daemon 崩溃 → 全部 channel fatal ----------
  {
    const harness = await createHarness({ dropOnAbort: true });
    await waitFor(() => harness.bus.isReady());
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    harness.bus.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('daemon 崩溃报告 fatal', await waitFor(() => fatal !== null));
    await harness.daemon.shutdown();
    await harness.fake.close();
  }

  // ---------- openWorkspace 失败 → fatal ----------
  {
    const harness = await createHarness({ failOpen: true });
    let fatal: Error | null = null;
    harness.bus.onFatal((error) => {
      fatal = error;
    });
    check('打开失败报告 fatal', await waitFor(() => fatal !== null));
    check('fatal 带上 daemon 的错误信息', (fatal as unknown as Error)?.message.includes('spawn failed'));
    await dispose(harness);
  }

  // ---------- 控制通道背压：write 返回 false 的帧必须出队，不能反复重写 ----------
  //
  // `net.Socket.write` 对**超过 highWaterMark** 的帧恒返回 false（数据仍被接受、稍后照常写出）。
  // 若此时不把该帧移出出站队列，drain 回调会把同一帧一遍遍重写：帧被无限复制，且排在它
  // 后面的帧永远写不出去——表现为对端（Core）收不到后续应答而卡死（Edit 的 permResult
  // 携带整份文件内容，帧体积远超水位，最容易触发）。
  {
    const BIG_FRAME_CHARS = 200_000;
    const fake = await startFakeDaemon();
    const daemon = connectFakeDaemon(fake.port);
    const { transport, bus } = openBus(daemon, 'D:/repo/a');
    check('背压用例完成握手', await waitFor(() => bus.isReady()));
    const innerFrames = (): ControlFrame[] =>
      fake.received.filter((frame) => frame.kind === 'frame').map((frame) => frame.frame);
    transport.send({
      kind: 'uiEvent',
      event: { type: 'abortRequested', sessionId: 's1', padding: 'x'.repeat(BIG_FRAME_CHARS) },
    } as never);
    transport.send({
      kind: 'uiEvent',
      event: { type: 'abortRequested', sessionId: 's2' },
    } as never);
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
    await fake.close();
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
      // 真实 daemon（`start-daemon`）：状态文件写到临时 HOME，别碰用户自己的 daemon
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-cat-daemon-'));
      const child = spawn(
        binary,
        ['start-daemon', '--host', '127.0.0.1', '--port', '0', '--token', 'smoke-token'],
        {
          env: { ...process.env, HOME: home, USERPROFILE: home },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      try {
        const connection = await readConnectionString(child);
        check(
          `真实 daemon 打印连接串 ${connection.host}:${connection.port}`,
          connection.host === '127.0.0.1' && connection.port > 0,
        );
        check('连接串带上生效的 token', connection.token === 'smoke-token');
        const port = connection.port;
        check('真实 daemon 落盘状态文件', fs.existsSync(path.join(home, '.tuxedo-cat', 'core-daemon.json')));

        const daemon = new CoreDaemon({
          transport: tcpDaemonOpener({ host: '127.0.0.1', port, token: 'smoke-token' }),
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
      } finally {
        child.kill();
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }

  finish();
}

runTests('coreDaemon', run);
