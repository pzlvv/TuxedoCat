/**
 * 远程 Core daemon 用例（`docs/core-daemon.md` 第 12 节）：
 * - TCP 控制通道第一帧必须是 `auth`，错误 token 回 `authFailed` 并拒绝请求；
 * - 正确 token 回 `authOk` 后才允许业务帧出站；
 * - `listDirectories` 走同一条控制通道，返回远端目录列表（连接后立刻弹选择器的基础）；
 * - 远程 channel 与本地同构：openWorkspace → hello → ready。
 *
 * 用进程内 `net` 假 daemon 冒充远端，跑真实 socket。
 * 运行方式：npm run test:all -- remote-core-daemon
 */

import { createServer, type Server, type Socket } from 'net';
import { CoreDaemon, DirectoryOperationError, tcpDaemonOpener } from '../host/standalone/CoreDaemon';
import { isDaemonToHostFrame } from '../host/standalone/daemonProtocol';
import { createCoreChannelBus } from '../host/standalone/StandaloneEventBus';
import { remoteWorkspaceRef } from '../host/workspaceRef';
import { createChecker, runTests } from './helpers/harness';
import { createRecordingCoreEventHandlers } from './helpers/fixtures';
import type { CoreRequestHandlers } from '../core/AssistantEventBus';

// ==================== 假远端 daemon ====================

interface FakeRemote {
  port: number;
  /** 建立过的连接数 */
  connections: () => number;
  /** 收到的控制帧（按到达顺序） */
  received: () => string[];
  close: () => Promise<void>;
}

/** 进程内假远端：单条控制通道，按 daemon 协议应答 */
function startFakeRemote(token: string): Promise<FakeRemote> {
  let connections = 0;
  const received: string[] = [];
  let nextChannel = 1;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let authed = false;
    const send = (frame: unknown): void => {
      socket.write(`${JSON.stringify(frame)}\n`);
    };
    socket.on('close', () => sockets.delete(socket));
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
        if (frame['kind'] === 'auth') {
          if (frame['token'] === token) {
            authed = true;
            send({ kind: 'authOk' });
          } else {
            send({ kind: 'authFailed', error: 'invalid token' });
            socket.end();
          }
          continue;
        }
        if (!authed) {
          send({ kind: 'authFailed', error: 'auth required' });
          socket.end();
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
        received: () => [...received],
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

const requestHandlers: CoreRequestHandlers = {
  toolPermissionRequested: async () => ({ behavior: 'allow' }),
  userChoice: async () => ({ index: 0 }),
};

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------- 协议校验：新增帧 ----------
  {
    check('authOk 通过校验', isDaemonToHostFrame({ kind: 'authOk' }));
    check('authFailed 通过校验', isDaemonToHostFrame({ kind: 'authFailed', error: 'x' }));
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

  // ---------- 正确 token：列目录 + 打开工作区 ----------
  {
    const fake = await startFakeRemote('secret');
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port, token: 'secret' }),
    });
    const listing = await daemon.listDirectories(null);
    check('列目录返回远端路径', listing.path === '/home/dev');
    check('列目录返回父目录', listing.parent === '/home');
    check('列目录返回子目录', listing.entries.length === 1 && listing.entries[0]?.name === 'repo');
    const first = fake.received()[0] ?? '';
    check('第一帧是 auth', first.includes('"kind":"auth"') && first.includes('"token":"secret"'));

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
      { host: '127.0.0.1', port: fake.port, user: null, auth: { kind: 'token', token: 'secret' } },
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

  // ---------- 错误 token：拒绝并报错 ----------
  {
    const fake = await startFakeRemote('secret');
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port, token: 'wrong' }),
    });
    let message = '';
    try {
      await daemon.listDirectories(null);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('错误 token 的列目录请求失败', message.includes('authentication failed'));
    check('错误 token 时服务端确实收到过 auth', fake.received().some((line) => line.includes('"kind":"auth"')));
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 连接被拒：明确失败，不静默挂起 ----------
  {
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: 1, token: 't' }),
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

  finish();
}

runTests('remote-core-daemon', run);
