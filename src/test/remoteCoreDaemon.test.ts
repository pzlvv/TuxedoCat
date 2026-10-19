/**
 * 远程 Core daemon 用例（`docs/core/core-remote.md` 第 2 节）：
 * - `listDirectories` 走控制通道，返回远端目录列表（连接后立刻弹选择器的基础）；
 * - 远程 channel 与本地同构：openWorkspace → hello → ready；
 * - 沉默判定：pong 武装、沉默判死（daemon / 链路死亡 10s 内感知的宿主侧机制），
 *   不回 pong 的对端不武装、不误杀。
 *
 * 用进程内 `net` 假 daemon 冒充远端，跑真实 socket。
 * 运行方式：npm run test:all -- remote-core-daemon
 */

import { createServer, type Server, type Socket } from 'net';
import {
  CoreDaemon,
  DirectoryOperationError,
  type CoreDaemonLink,
  type CoreDaemonLinkOpener,
} from '../host/standalone/CoreDaemon';
import { tcpDaemonOpener } from './helpers/tcpDaemonLink';
import { isDaemonToHostFrame } from '../host/standalone/daemonProtocol';
import { createCoreChannelBus, NOOP_CORE_CHANNEL_HOOKS } from '../host/standalone/StandaloneEventBus';
import { remoteWorkspaceRef } from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers } from './helpers/fixtures';
import type { CoreRequestHandlers } from '../shared/AssistantEventBus';

// ==================== 假远端 daemon ====================

interface FakeRemote {
  port: number;
  /** 建立过的连接数 */
  connections: () => number;
  /** 已关闭的连接数（沉默判死会 kill 链路，这里用于确认链路真的被断开） */
  closed: () => number;
  /** 收到的控制帧（按到达顺序） */
  received: () => string[];
  /** 开 / 关 pong 应答（模拟 daemon 卡死 / 半开断连：socket 不断，帧不再回来） */
  setPong: (enabled: boolean) => void;
  close: () => Promise<void>;
}

/** 进程内假远端：单条控制通道，按 daemon 协议应答 */
function startFakeRemote(options: { pong?: boolean } = {}): Promise<FakeRemote> {
  let connections = 0;
  let closedCount = 0;
  let pong = options.pong === true;
  const received: string[] = [];
  let nextChannel = 1;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const send = (frame: unknown): void => {
      socket.write(`${JSON.stringify(frame)}\n`);
    };
    socket.on('close', () => {
      sockets.delete(socket);
      closedCount += 1;
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        received.push(line);
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame['kind'] === 'ping') {
          // 真实 daemon 对每个 ping 回 pong（Host 靠它武装沉默判定）
          if (pong) send({ kind: 'pong' });
          continue;
        }
        if (frame['kind'] === 'listDirectories') {
          send({
            kind: 'directoriesListed',
            id: frame['id'],
            path: '/home/dev',
            parent: '/home',
            entries: [{ name: 'repo', path: '/home/dev/repo' }],
          });
          continue;
        }
        if (frame['kind'] === 'createDirectory') {
          send({ kind: 'directoryCreated', id: frame['id'], path: frame['path'] });
          continue;
        }
        if (frame['kind'] === 'renameDirectory') {
          send({
            kind: 'directoryRenamed',
            id: frame['id'],
            path: String(frame['path']).replace(/[^/]+$/, String(frame['name'])),
          });
          continue;
        }
        if (frame['kind'] === 'deleteDirectory') {
          // 与真实 daemon 同口径：非空且没要求递归时回 directoryFailed + reason
          if (String(frame['path']).endsWith('/full') && frame['recursive'] !== true) {
            send({
              kind: 'directoryFailed',
              id: frame['id'],
              error: 'directory is not empty',
              reason: 'notEmpty',
            });
          } else {
            send({ kind: 'directoryDeleted', id: frame['id'], path: frame['path'] });
          }
          continue;
        }
        if (frame['kind'] === 'openWorkspace') {
          const channel = nextChannel;
          nextChannel += 1;
          send({
            kind: 'workspaceOpened',
            id: frame['id'],
            channel,
            descriptor: { kind: 'multiplexed', channel },
          });
          continue;
        }
        if (frame['kind'] === 'frame') {
          const inner = frame['frame'] as { kind?: string };
          if (inner?.kind === 'hello') {
            send({ kind: 'frame', channel: frame['channel'], frame: { kind: 'ready' } });
          }
          continue;
        }
        if (frame['kind'] === 'shutdown') {
          socket.end();
        }
      }
    });
  });

  return new Promise<FakeRemote>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        connections: () => connections,
        closed: () => closedCount,
        received: () => [...received],
        setPong: (enabled: boolean) => {
          pong = enabled;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const requestHandlers: CoreRequestHandlers = {
  toolPermissionRequested: async () => ({ behavior: 'allow' }),
  userChoice: async () => ({ index: 0 }),
};

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------- 协议校验 ----------
  {
    check('pong 通过校验', isDaemonToHostFrame({ kind: 'pong' }));
    check(
      'directoriesListed 通过校验',
      isDaemonToHostFrame({
        kind: 'directoriesListed',
        id: 1,
        path: '/home',
        parent: null,
        entries: [{ name: 'a', path: '/home/a' }],
      }),
    );
    check(
      'directoriesListed 缺 entries 字段被拒绝',
      !isDaemonToHostFrame({ kind: 'directoriesListed', id: 1, path: '/home', parent: null }),
    );
    check(
      'directoryFailed 通过校验',
      isDaemonToHostFrame({ kind: 'directoryFailed', id: 1, error: 'x', reason: 'notEmpty' }),
    );
    check(
      'directoryFailed 缺 reason 被拒绝',
      !isDaemonToHostFrame({ kind: 'directoryFailed', id: 1, error: 'x' }),
    );
    check(
      'directoryCreated 通过校验',
      isDaemonToHostFrame({ kind: 'directoryCreated', id: 1, path: '/home/new' }),
    );
    check(
      'directoryDeleted 通过校验',
      isDaemonToHostFrame({ kind: 'directoryDeleted', id: 1, path: '/home/old' }),
    );
    check(
      'directoryRenamed 通过校验',
      isDaemonToHostFrame({ kind: 'directoryRenamed', id: 1, path: '/home/new' }),
    );
    check(
      'directoryCreated 缺 path 字段被拒绝',
      !isDaemonToHostFrame({ kind: 'directoryCreated', id: 1 }),
    );
  }

  // ---------- 列目录 + 打开工作区 ----------
  {
    const fake = await startFakeRemote();
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    const listing = await daemon.listDirectories(null);
    check('列目录返回远端路径', listing.path === '/home/dev');
    check('列目录返回父目录', listing.parent === '/home');
    check('列目录返回子目录', listing.entries.length === 1 && listing.entries[0]?.name === 'repo');
    const first = fake.received()[0] ?? '';
    check('第一帧是 listDirectories', first.includes('"kind":"listDirectories"'));

    check('新建目录返回实际路径', (await daemon.createDirectory('/home/dev/new')) === '/home/dev/new');
    check(
      '重命名返回新路径',
      (await daemon.renameDirectory('/home/dev/old', 'new')) === '/home/dev/new',
    );
    check(
      '删除空目录返回实际路径',
      (await daemon.deleteDirectory('/home/dev/new', false)) === '/home/dev/new',
    );
    let notEmpty = '';
    try {
      await daemon.deleteDirectory('/home/dev/full', false);
    } catch (error) {
      notEmpty = error instanceof DirectoryOperationError ? error.reason : 'not-a-directory-error';
    }
    check('非空目录回 reason=notEmpty', notEmpty === 'notEmpty');
    check(
      '递归删除非空目录成功',
      (await daemon.deleteDirectory('/home/dev/full', true)) === '/home/dev/full',
    );

    const ref = remoteWorkspaceRef(
      { host: '127.0.0.1', port: fake.port, user: 'root', auth: { kind: 'sshPassword', password: 'secret' } },
      '/home/dev/repo',
    );
    const bus = createCoreChannelBus(daemon.openChannel(ref), () => undefined);
    const recording = createRecordingCoreEventHandlers();
    bus.onCoreEvents(recording.handlers);
    bus.onCoreRequests(requestHandlers);
    check('远程 channel 完成握手', await waitFor(() => bus.isReady()));
    await bus.shutdown();
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 连接被拒：明确失败，不静默挂起 ----------
  {
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: 1 }),
    });
    let failed = false;
    try {
      await daemon.listDirectories(null);
    } catch {
      failed = true;
    }
    check('连不上远端时请求失败', failed);
    await daemon.shutdown();
  }

  // ---------- 沉默判定：pong 武装、沉默判死 ----------
  {
    const fake = await startFakeRemote({ pong: true });
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      // 注入短节奏：机制与默认 1s / 2.5s / 400ms 等价，只把时钟拨快约 25 倍
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 60,
      silenceRecheckMs: 40,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    const ref = remoteWorkspaceRef(
      { host: '127.0.0.1', port: fake.port, user: 'root', auth: { kind: 'sshPassword', password: 'secret' } },
      '/home/dev/repo',
    );
    const transport = daemon.openChannel(ref);
    // fatal 在回调里赋值：用持有对象绕开 TS 对「仅回调赋值变量」的收窄失效
    const failure: { error: Error | null } = { error: null };
    transport.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error: Error) => {
        failure.error = error;
      },
    };
    transport.start();
    check('pong 流量下链路就绪且保持存活', await waitFor(() => transport.isReady()));
    // 等 pong 真正武装沉默判定：至少一个 ping 已发出、再过一个心跳周期让 pong 落地
    // （ready 是 hello 的应答，会先于首个 pong 到达——直接静默会赶上武装之前）
    check('心跳 ping 已发出', await waitFor(() => fake.received().some((line) => line.includes('"kind":"ping"'))));
    await sleep(100);
    const silenceAt = Date.now();
    // 模拟 daemon 死 / 网络半开：socket 不断（等不到 EOF/RST），帧不再回来
    fake.setPong(false);
    const fatalArrived = await waitFor(() => failure.error !== null, 2_000);
    check('沉默超过死线 + 宽限后判死 fatal', fatalArrived && failure.error !== null);
    check('fatal 文案指明沉默判死', failure.error !== null && /silent for/.test(failure.error.message));
    check('判死在死线 + 宽限的量级内完成', Date.now() - silenceAt < 1_000);
    check('判死确实断开了链路', fake.closed() >= 1);
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 默认常数下的判死时限（断连 10s 内感知的端到端锚点） ----------
  {
    const fake = await startFakeRemote({ pong: true });
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    const ref = remoteWorkspaceRef(
      { host: '127.0.0.1', port: fake.port, user: 'root', auth: { kind: 'sshPassword', password: 'secret' } },
      '/home/dev/repo',
    );
    const transport = daemon.openChannel(ref);
    const failure: { error: Error | null } = { error: null };
    transport.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error: Error) => {
        failure.error = error;
      },
    };
    transport.start();
    check('默认常数：链路就绪', await waitFor(() => transport.isReady()));
    // 等首个 ping 发出 + 一个心跳周期（1s）让 pong 落地武装沉默判定
    check('心跳 ping 已发出', await waitFor(() => fake.received().some((line) => line.includes('"kind":"ping"'))));
    await sleep(1_200);
    const silenceAt = Date.now();
    fake.setPong(false);
    const fatalArrived = await waitFor(() => failure.error !== null, 11_000);
    // 判死上限 = 死线 9s + 宽限 0.9s，加定时器松弛后必须落在 10s 量级内
    check('默认常数下沉默判死发生', fatalArrived && failure.error !== null
      && /silent for/.test(failure.error.message));
    check('默认常数判死 ≤ 10.5s（10s 指标 + 定时器松弛）', Date.now() - silenceAt < 10_500);
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- daemon 不回 pong：沉默判定不武装，长静默不误杀 ----------
  {
    const fake = await startFakeRemote(); // 不回 pong
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 60,
      silenceRecheckMs: 40,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    check('不回 pong：建链后列目录可用', (await daemon.listDirectories(null)).path === '/home/dev');
    await sleep(400); // 远超注入的判死上限（死线 + 宽限 = 100ms）
    check('长静默不误杀：请求仍可用', (await daemon.listDirectories(null)).path === '/home/dev');
    check('沉默期间链路未被斩断', fake.closed() === 0);
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 沉默判死后重连：重开必须走全新连接（specs/defects/remote-reconnect-reuses-dead-ssh-link） ----------
  {
    // 模拟 SSH opener 的连接复用语义（sshTransport.ts / sshClient.ts）：底层连接
    // 只有一条，SshClient.connect() 幂等——链路死了但没人 dispose 时，下一次
    // open() 仍在「同一条连接」上，返回写得出、永远没有回帧、也不会 close 的
    // 僵尸链路；dispose 之后 open() 才建新连接。
    const fake = await startFakeRemote({ pong: true });
    const tcp = tcpDaemonOpener({ host: '127.0.0.1', port: fake.port });
    let liveLink = false;
    let disposed = true;
    const zombieLink: CoreDaemonLink = {
      write: () => true,
      onceDrain: () => undefined,
      end: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      onClose: () => undefined,
    };
    const sshLikeOpener: CoreDaemonLinkOpener = {
      open: () => {
        if (!liveLink) {
          // 底层连接不存在（首次 / 上次已被 dispose）：建新连接
          disposed = false;
          liveLink = true;
          return tcp.open();
        }
        // 底层连接还在（上次链路死了没人 dispose）：复用它——已是僵尸
        return Promise.resolve(disposed ? tcp.open() : zombieLink);
      },
      // TCP 直连没有远端准备步骤（socket 连上即就绪）：no-op 是设计允许的形态
      prepare: async () => undefined,
      dispose: () => {
        if (liveLink) {
          liveLink = false;
          disposed = true;
        }
      },
    };
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 500,
      shutdownTimeoutMs: 300,
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 60,
      silenceRecheckMs: 40,
      transport: sshLikeOpener,
    });
    const ref = remoteWorkspaceRef(
      { host: '127.0.0.1', port: fake.port, user: 'root', auth: { kind: 'sshPassword', password: 'secret' } },
      '/home/dev/repo',
    );
    const first = daemon.openChannel(ref);
    const firstFailure: { error: Error | null } = { error: null };
    first.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error) => {
        firstFailure.error = error;
      },
    };
    first.start();
    check('沉默判死后重连：首次建链就绪', await waitFor(() => first.isReady()));
    check('沉默判死后重连：心跳 ping 已发出', await waitFor(() => fake.received().some((line) => line.includes('"kind":"ping"'))));
    await sleep(100);
    fake.setPong(false);
    check('沉默判死后重连：沉默判死 fatal', await waitFor(() => firstFailure.error !== null, 2_000));
    // 网络恢复（pong 恢复），用户点「重新连接」：registry 里同一 CoreDaemon 重开 channel
    fake.setPong(true);
    const second = daemon.openChannel(ref);
    const secondFailure: { error: Error | null } = { error: null };
    second.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error) => {
        secondFailure.error = error;
      },
    };
    second.start();
    check('沉默判死后重连：重开 channel 重新就绪', await waitFor(() => second.isReady(), 3_000));
    check('沉默判死后重连：重开未再 fatal', secondFailure.error === null);
    check('沉默判死后重连：重开是全新连接', fake.connections() === 2);
    await daemon.shutdown();
    await fake.close();
  }

  finish();
}

runTests('remote-core-daemon', run);
