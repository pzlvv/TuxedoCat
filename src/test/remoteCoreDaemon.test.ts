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
  LINK_SILENCE_DEADLINE_BUDGET_MS,
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
  /** 已写出的 pong 数（沉默判定见到首个 pong 才武装，用例用它确认真的往返过） */
  pongs: () => number;
  close: () => Promise<void>;
}

/**
 * 进程内假远端：单条控制通道，按 daemon 协议应答。
 *
 * `deferCloseAccounting` 把对端 close 的记账推迟 50ms：生产形态里 daemon 是
 * 另一个进程，对端看到 RST 与本端 `kill()` 之间隔着一次网络往返，对端 close 恒晚于宿主侧
 * fatal（`docs/core/core-remote.md` 第 2.5 节）。进程内假远端把两件事压进同一个事件循环，
 * 多数时候同轮派发，只有在调度被打断时才跨轮——用例不能依赖这个巧合。
 */
function startFakeRemote(
  options: { pong?: boolean; deferCloseAccounting?: boolean } = {},
): Promise<FakeRemote> {
  let connections = 0;
  let closedCount = 0;
  let pong = options.pong === true;
  const deferCloseAccounting = options.deferCloseAccounting === true;
  let pongCount = 0;
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
      // 推迟记账：把「对端看到断开」排到宿主侧 fatal 回调之后（真实远端的网络往返等价物）。
      // `setTimeout` 而不是 `setImmediate`：后者常与 close 派发同轮跑完，推迟不到
      // 「fatal 已落地、对端尚未记账」的那个窗口，也就锁不住本缺陷。
      if (deferCloseAccounting) setTimeout(() => { closedCount += 1; }, 50);
      else closedCount += 1;
    });
    // 链路被看门狗 kill 时对端会读到 RST：假远端只是夹具，不因夹具侧错误打断整份用例
    // （被测行为一律由断言表达，不让 socket 错误冒成未捕获异常）
    socket.on('error', () => undefined);
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
          if (pong) {
            pongCount += 1;
            send({ kind: 'pong' });
          }
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
        if (frame['kind'] === 'detachWorkspace') {
          // specs/031：后台运行——Core「留在远端」，只回 detached 关闭帧
          send({ kind: 'workspaceClosed', channel: frame['channel'], reason: 'detached' });
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
        pongs: () => pongCount,
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

/**
 * 给一个 promise 套上限：返回 `null` 表示超时。
 *
 * 残行缺陷的表现就是「请求永远没有应答」，用例必须自己收尾，不能挂在被测实现上。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
    }),
  ]);
}

/** 第 1 条连接断在半个帧上的假 daemon（复现残行跨链路） */
interface TruncatingRemote extends FakeRemote {
  /** 发出过半个帧的连接数 */
  truncatedConnections: () => number;
}

/**
 * 进程内假 daemon：**第 1 条**连接在发出半个帧后断开，之后的连接正常应答。
 *
 * 半个帧是真实场景：TCP 断开可以落在任意字节边界，上一条链路的最后一个 `data`
 * 事件里只有半个 JSON 行。
 */
function startTruncatingRemote(): Promise<TruncatingRemote> {
  let connections = 0;
  let truncated = 0;
  let closedCount = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections += 1;
    const index = connections;
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
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.trim().length === 0) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (index === 1) {
          // 半个帧之后断开：残行留在宿主侧解码器里
          truncated += 1;
          socket.write('{"kind":"pong"');
          setTimeout(() => socket.destroy(), 10);
          continue;
        }
        if (frame['kind'] === 'ping') {
          send({ kind: 'pong' });
          continue;
        }
        if (frame['kind'] === 'listDirectories') {
          const path = typeof frame['path'] === 'string' ? frame['path'] : '/home';
          send({
            kind: 'directoriesListed',
            id: frame['id'],
            path,
            parent: '/',
            entries: [],
          });
        }
      }
    });
  });

  return new Promise<TruncatingRemote>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        connections: () => connections,
        closed: () => closedCount,
        received: () => [],
        setPong: () => undefined,
        // 这条夹具不回 pong（第 1 条连接断在半个帧上），沉默判定因此不会被武装
        pongs: () => 0,
        truncatedConnections: () => truncated,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 同步卡住事件循环 `ms` 毫秒。
 *
 * 用来复现「本进程被调度出去」：`setTimeout` 只保证不早于，迟到量没有上界，
 * 而迟到期间到达的入站字节还没轮到 `link.onData` 回调（specs/defects/
 * silence-recheck-judged-by-stale-timestamp）。故意用忙等而不是 `sleep`——后者会让出
 * 事件循环，到达的 pong 照常被处理，复现不出缺陷。
 */
function blockEventLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 空转：只为占住事件循环
  }
}

// ==================== 慢速大帧假远端（心跳独立通路） ====================

interface SlowFrameRemote {
  port: number;
  /** 建立过的连接数（业务链路 + 心跳链路各一条） */
  connections: () => number;
  /** 大帧已写出的字节数：0 = 还没开始 */
  written: () => number;
  /** 在「没被大帧堵住」的连接上写出的 pong 数——心跳通路的独立存活证据 */
  independentPongs: () => number;
  /** 全部连接上的 pong 总数（沉默判定见到首个 pong 才武装） */
  totalPongs: () => number;
  close: () => Promise<void>;
}

/** 大帧载荷的字节量：远大于任何 socket 发送缓冲，且分块慢写 */
const BIG_FRAME_BYTES = 512 * 1024;
/** 单块大小：模拟「业务帧一帧很大、网络一点点往外吐」 */
const BIG_FRAME_CHUNK = 16 * 1024;
/** 有标记的日志事件：宿主侧用它确认整帧到齐 */
const BIG_FRAME_MARKER = 'big-frame-complete';

/**
 * 模拟真实 daemon 的**有序出站写**：一条连接上一个帧没写完时，排在它后面的
 * `pong` 出不去（这正是缺陷的成因）。
 *
 * - `stall: true`：大帧写到约 1/4 就停住，此后这条连接再也不写任何东西；
 * - `stall: false`：大帧按 `BIG_FRAME_CHUNK` 分块慢速写满，总耗时远超沉默死线。
 *
 * 收到非 `ping` 的帧（`uiEvent`）即开始写这一大帧。心跳链路（另一条连接）上
 * 没有大帧，因此 `pong` 立刻写回。
 */
function startSlowFrameRemote(options: { stall: boolean }): Promise<SlowFrameRemote> {
  let connections = 0;
  let written = 0;
  let independentPongs = 0;
  let totalPongs = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    /** 本连接是否正被大帧占着出站（有序写：期间一切帧排队） */
    let blocked = false;
    const queued: string[] = [];
    const write = (line: string): void => {
      if (blocked) {
        queued.push(line);
        return;
      }
      if (!socket.writable) return;
      socket.write(line);
    };
    const send = (frame: unknown): void => write(`${JSON.stringify(frame)}\n`);
    const sendPong = (): void => {
      totalPongs += 1;
      if (blocked) {
        queued.push(`${JSON.stringify({ kind: 'pong' })}\n`);
        return;
      }
      independentPongs += 1;
      if (socket.writable) socket.write(`${JSON.stringify({ kind: 'pong' })}\n`);
    };
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    const startBigFrame = (channel: number): void => {
      blocked = true;
      // 一帧就是整段会话历史（`conversationLoadRequested` 的应答形态）：行首 + 巨量载荷 + 行尾
      const lineHead = `{"kind":"frame","channel":${channel},"frame":{"kind":"event",`
        + '"event":{"type":"log","message":"';
      const lineTail = `${BIG_FRAME_MARKER}"}}}`;
      const payload = 'x'.repeat(BIG_FRAME_BYTES);
      let offset = 0;
      socket.write(lineHead);
      written += lineHead.length;
      const timer = setInterval(() => {
        if (!socket.writable) {
          clearInterval(timer);
          return;
        }
        if (options.stall && offset >= Math.floor(payload.length / 4)) {
          clearInterval(timer);
          // 停在这里：这条连接再也不写任何字节（业务链路彻底静默）
          return;
        }
        if (offset < payload.length) {
          const chunk = payload.slice(offset, offset + BIG_FRAME_CHUNK);
          socket.write(chunk);
          written += chunk.length;
          offset += chunk.length;
          return;
        }
        clearInterval(timer);
        socket.write(`${lineTail}
`);
        written += lineTail.length;
        // 大帧写完：排队的 pong 这才出去（真实 daemon 的有序写）
        blocked = false;
        for (const line of queued.splice(0, queued.length)) {
          if (socket.writable) socket.write(line);
        }
      }, 6);
      timer.unref();
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame['kind'] === 'ping') {
          // 真实 daemon 对每个 ping 回 pong；但大帧占着出站时它排在大帧后面
          sendPong();
          continue;
        }
        if (frame['kind'] === 'openWorkspace') {
          const channel = 1;
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
          const channel = Number(frame['channel']);
          if (inner?.kind === 'hello') {
            send({ kind: 'frame', channel, frame: { kind: 'ready' } });
            continue;
          }
          if (inner?.kind === 'uiEvent') startBigFrame(channel);
          continue;
        }
        if (frame['kind'] === 'shutdown') {
          socket.end();
        }
      }
    });
  });

  return new Promise<SlowFrameRemote>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        connections: () => connections,
        written: () => written,
        independentPongs: () => independentPongs,
        totalPongs: () => totalPongs,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

// ==================== 宽限窗口内到达的 pong（收口早于入站入账） ====================

interface GraceWindowRemote {
  port: number;
  /** 写出的 pong 数 */
  pongs: () => number;
  /** 停止应答 pong：让宿主沉默死线到期、补发探针 */
  silence: () => void;
  /** 恢复应答；首次应答会先写 pong 再同步占住事件循环（宿主被调度出去） */
  resumeWithStall: (stallMs: number) => void;
  /** 首次应答写出 pong 的时刻；`null` = 还没写出 */
  answeredAt: () => number | null;
  close: () => Promise<void>;
}

/**
 * 「宽限窗口内到达的 pong」假远端。
 *
 * 缺陷形态（specs/defects/silence-recheck-runs-before-inbound-drain）：宿主沉默死线到期后
 * 发出探针并武装宽限；对端在**宽限内**写出 `pong`，但宿主此刻被调度出去（同一进程里用
 * 同步忙等模拟），恢复时事件循环的 timers 阶段先跑宽限收口、poll 阶段才读到已到达的字节，
 * 收口看到入站序号没变就把活链路判死。
 *
 * 时间由用例里的「RT-1 宽限内对端写出的 pong 早于宽限到期」断言锁定：pong 必须早于宽限
 * 到期写出，否则这条用例测的就成了「真的没回 pong」。
 */
function startGraceWindowRemote(): Promise<GraceWindowRemote> {
  let pongs = 0;
  let replying = true;
  let answeredAt: number | null = null;
  let stallMs = 0;
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const send = (frame: unknown): void => {
      if (socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
    };
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame['kind'] === 'ping') {
          if (!replying) continue;
          pongs += 1;
          send({ kind: 'pong' });
          // 只让「恢复应答后的第一帧」带动占住：握手阶段的 pong 不该占住事件循环
          if (stallMs > 0 && answeredAt === null) {
            answeredAt = Date.now();
            // 宽限内先写出 pong、再占住事件循环：这条 pong 只可能落到宿主的 socket 缓冲里，
            // 等到 poll 阶段才被读——而宽限收口跑在它前面的 timers 阶段
            blockEventLoop(stallMs);
          }
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
        if (frame['kind'] === 'openWorkspace') {
          const channel = 1;
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
        if (frame['kind'] === 'shutdown') socket.end();
      }
    });
  });

  return new Promise<GraceWindowRemote>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        pongs: () => pongs,
        silence: () => {
          replying = false;
        },
        resumeWithStall: (ms: number) => {
          stallMs = ms;
          replying = true;
        },
        answeredAt: () => answeredAt,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const requestHandlers: CoreRequestHandlers = {
  toolPermissionRequested: async () => ({ behavior: 'allow' }),
  userChoice: async () => ({ kind: 'permission', index: 0, reply: null }),
  crossWorkspaceAgentRequested: async () => ({ error: 'not supported' }),
  crossWorkspaceTransferRequested: async () => ({ error: 'not supported' }),
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
    // 推迟对端 close 记账：把「宿主侧 fatal 已上报、对端还没记账」的时序固定下来。
    // 生产形态（daemon 在另一个进程）对端 close 恒晚于 fatal，用例不能依赖进程内
    // 两根 socket 恰好同轮派发这一巧合（specs/defects/daemon-close-assertion-races-fatal-callback）。
    const fake = await startFakeRemote({ pong: true, deferCloseAccounting: true });
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
    // 断链是「kill 之后对端最终看到断开」，不是 kill 的同步结果：对端 close 由另一根
    // socket 异步派发，生产形态下还隔着一次网络往返，恒晚于宿主侧 fatal
    // （specs/defects/daemon-close-assertion-races-fatal-callback）
    check('判死确实断开了链路', await waitFor(() => fake.closed() >= 1, 2_000));
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 默认常数下的判死时限（断连 10s 内感知的对外指标） ----------
  //
  // 这里断言**常量**而不是再跑一遍端到端：上一段的真实链路用例（注入 60ms / 40ms）
  // 已经把「到期 → 补发探针 → 再宽限 → fatal → 断开链路」整条链走通，那段与常数取值
  // 无关；剩下的自由度只有「默认常数之和够不够 10s」。真跑一遍要白等 9s + 1.2s，
  // 而它验证的关系完全由两个常量决定。
  {
    check(
      '默认常数：死线 + 宽限 ≤ 10s（断连 10s 内感知的对外指标）',
      LINK_SILENCE_DEADLINE_BUDGET_MS <= 10_000,
    );
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
      // 心跳链路在同一个「底层连接」上也走僵尸 / 新建语义：本用例只验证业务链路的
      // 复用与 dispose，心跳链路的建链不是被测对象
      openHeartbeat: () => (disposed ? tcp.openHeartbeat() : Promise.resolve(zombieLink)),
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

  // ---------- 探针宽限按「有没有新入站」判，而不是按「时间差」
  // ---------- （specs/defects/silence-recheck-judged-by-stale-timestamp）----------
  //
  // 本进程被调度出去（CI 的 2 核 runner 同时跑 4 个测试文件、GC、内核把 socket 数据排
  // 在内核缓冲里）时，宽限定时器会迟到；迟到期间到达的 pong 还没轮到 `link.onData` 回调，
  // 而 `lastInboundAt` 只在那里前移。判据若拿「现在 - lastInboundAt」跟宽限比，就等于用
  // 陈旧时间戳判死一条一直在回 pong 的链路。`docs/core/core-remote.md` 第 2.5 节要求
  // 宽限吸收的正是「本进程卡顿」。
  //
  // 复现形态：链路完全健康（心跳链路的 pong 秒回），只是反复同步卡住事件循环。
  {
    const fake = await startFakeRemote({ pong: true });
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      // 与 RT-1 同一组注入窗口：死线 + 宽限 = 100ms
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
    const failure: { error: Error | null } = { error: null };
    transport.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error: Error) => {
        failure.error = error;
      },
    };
    transport.start();
    check('卡顿用例完成握手', await waitFor(() => transport.isReady()));
    // 必须等 pong 真往返过：沉默判定见到首个 pong 才武装，只看「ping 已发出」会在
    // 武装之前就进入卡顿，那测的是另一条路径
    check('卡顿用例心跳已往返（沉默判定武装）', await waitFor(() => fake.pongs() > 0));
    await sleep(100);
    // 三次「卡住 50ms + 放开 20ms」：每次卡顿都超过宽限（40ms），而 pong 一直在回。
    // 卡顿期间内核缓冲里的 pong 来不及进回调，正是缺陷现场。
    for (let i = 0; i < 3; i += 1) {
      blockEventLoop(50);
      await sleep(20);
    }
    check(
      '探针宽限期间事件循环停顿超过宽限，回来的 pong 仍算活（不判死）',
      failure.error === null,
    );
    // 反面对照：卡顿结束后链路仍可用，说明上面判的不是「链路早就死了只是没上报」
    check('卡顿结束后请求仍可用', (await daemon.listDirectories(null)).path === '/home/dev');
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 心跳独立通路：大帧传输期间不判死（specs/defects/remote-heartbeat-starved-by-large-frame）----------
  //
  // 真实形态：`conversationLoadRequested` 的应答是整段会话历史一帧（8MB 量级），
  // 慢带宽下要传几十秒；业务链路的出站严格有序，`pong` 排在大帧后面，而 Host 的
  // 沉默看门狗只看「有没有入站帧」。心跳若与业务帧共用出站队列，「正在传大帧」就会
  // 被判成「对端已死」。
  {
    const fake = await startSlowFrameRemote({ stall: true });
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 80,
      // 宽限必须显著大于调度噪声：CI 上（2 核跑 4 个测试文件）用例与假远端共用一条事件
      // 循环，进程被调度出去时心跳 pong 送不进来，宽限窗口整个被吃掉就会误判死。空闲机
      // 上实测心跳 pong 间隔已达 38ms，40ms 的宽限没有余量；这里留约 6 倍。
      // 灵敏度不降：心跳若真被大帧饿死（本缺陷的形态）两条通路都没有入站，仍会在
      // 死线 + 宽限（80 + 250）判死，落在下面的观察窗内
      // （specs/defects/silence-recheck-runs-before-inbound-drain 的 RT-3）。
      silenceRecheckMs: 250,
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
    check('RT-1 大帧用例完成握手', await waitFor(() => transport.isReady()));
    // 缺陷形态是「链路已就绪、心跳往返正常，然后打开一个大对话」：先让至少一个 pong
    // 落地武装沉默判定，再触发大帧——否则测的是「武装之前」的另一条路径
    check('RT-1 心跳已往返（沉默判定武装）', await waitFor(() => fake.totalPongs() > 0));
    await sleep(60);
    // 触发大帧（真话务里是 request → response，这里是同方向的一帧）
    transport.send({
      kind: 'uiEvent',
      event: { type: 'conversationOpened', sessionId: 's1' },
    } as never);
    check('RT-1 大帧开始下传（字节已流动，但没有完整帧）', await waitFor(() => fake.written() > 0));
    const startedAt = Date.now();
    // 观察窗覆盖「死线 + 宽限」（80 + 250 = 330ms）再加余量：大帧停在中途、业务链路此后
    // 不再有字节，若心跳真被大帧饿死，判死会落在窗内而让断言变红——灵敏度不靠掐紧窗口
    const OBSERVE_MS = 600;
    await sleep(OBSERVE_MS);
    check(
      'RT-1 大帧停顿期间心跳独立通路保活（不判死）',
      failure.error === null && Date.now() - startedAt >= OBSERVE_MS,
    );
    // 判死不等于「饿死」：只有沉默判死的文案才算心跳被业务大帧拖垮。这条把「不判死」
    // 收窄到本缺陷的形态，避免任意 fatal（建链 / 心跳链路中断等）都让上一条通过
    check(
      'RT-1 未以沉默判死收场',
      failure.error === null || !/silent for/.test(failure.error.message),
    );
    check('RT-1 心跳链路的 pong 独立往返', fake.independentPongs() > 0);
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 宽限期内到达的 pong 不因收口早于入站入账被判死
  // ---------- （specs/defects/silence-recheck-runs-before-inbound-drain）----------
  //
  // 判据是入站序号，而 `noteInbound` 只在 socket `data` 回调（poll 阶段）里前移；
  // 宽限收口是 `setTimeout` 回调（timers 阶段）。宿主被调度出去超过宽限时，恢复后
  // 一轮迭代里 timers 恒先于 poll：收口先看到「序号没变」，紧接着才读到宽限内早就
  // 到达的 pong。`docs/core/core-remote.md` 第 2.5 节要求宽限吸收的正是「本进程卡顿」
  // 这一类情形。
  {
    const fake = await startGraceWindowRemote();
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      // 死线 150ms / 宽限 600ms：三段时序各留足余量，不依赖 runner 的调度精度——
      // 「死线到期」在 150ms，对端在 250ms 写出 pong，宽限到 750ms 才到期，
      // 随后 700ms 的占住把「宽限到期」推到 950ms，跨过到期时刻。
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 150,
      silenceRecheckMs: 600,
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
    check('RT-1 宽限用例完成握手', await waitFor(() => transport.isReady()));
    check('RT-1 宽限用例心跳已往返（沉默判定武装）', await waitFor(() => fake.pongs() > 0));
    // 武装后停止应答：死线 150ms 到期时宿主补发探针并武装 600ms 宽限
    const silenceAt = Date.now();
    fake.silence();
    await sleep(250);
    // 宽限中段恢复应答：对端立刻写 pong（此后字节只在宿主 socket 缓冲里），
    // 随后同步占住事件循环 700ms，把「宽限到期」压进这段占住里。
    fake.resumeWithStall(700);
    const answered = await waitFor(() => fake.answeredAt() !== null, 3_000);
    const answeredAt = fake.answeredAt();
    check('RT-1 宽限内对端写出的 pong 早于宽限到期', answered
      && answeredAt !== null
      && answeredAt - silenceAt < 150 + 600);
    // 占住 700ms + 收口本身，留足余量让收口跑完
    await sleep(1_200);
    check(
      'RT-1 宽限期内到达的 pong 不因收口早于入站入账被判死',
      failure.error === null,
    );
    // 反面对照：链路仍可用，说明上面判的不是「早就死了只是没上报」
    check('RT-1 宽限用例结束后请求仍可用', (await daemon.listDirectories(null)).path === '/home/dev');
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 慢速大帧按字节判活（存活判据不再要求完整帧）----------
  {
    const fake = await startSlowFrameRemote({ stall: false });
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      heartbeatIntervalMs: 20,
      silenceDeadlineMs: 80,
      silenceRecheckMs: 40,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    const ref = remoteWorkspaceRef(
      { host: '127.0.0.1', port: fake.port, user: 'root', auth: { kind: 'sshPassword', password: 'secret' } },
      '/home/dev/repo',
    );
    const transport = daemon.openChannel(ref);
    const failure: { error: Error | null } = { error: null };
    const messages: string[] = [];
    transport.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFrame: (frame) => {
        if (frame.kind === 'event' && frame.event.type === 'log') messages.push(frame.event.message);
      },
      onFatal: (error: Error) => {
        failure.error = error;
      },
    };
    transport.start();
    check('RT-2 慢速大帧用例完成握手', await waitFor(() => transport.isReady()));
    check('RT-2 心跳已往返（沉默判定武装）', await waitFor(() => fake.totalPongs() > 0));
    await sleep(60);
    transport.send({
      kind: 'uiEvent',
      event: { type: 'conversationOpened', sessionId: 's1' },
    } as never);
    // 512KB / 16KB × 6ms ≈ 190ms 的总传输时长，远超死线 + 宽限（120ms）
    const arrived = await waitFor(() => messages.some((m) => m.includes(BIG_FRAME_MARKER)), 5_000);
    check('RT-2 慢速大帧完整到达', arrived);
    check('RT-2 慢速大帧期间未被判死', failure.error === null);
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 心跳链路建不起来 = 接线缺陷，不降级回单通路 ----------
  //
  // 「只在业务链路上心跳」正是本缺陷的形态：一旦心跳与业务帧共用出站队列，
  // 大帧就会把存活探测饿死。因此心跳链路打不开必须直接失败，不能静默退回。
  {
    const fake = await startFakeRemote({ pong: true });
    const tcp = tcpDaemonOpener({ host: '127.0.0.1', port: fake.port });
    const opener: CoreDaemonLinkOpener = {
      open: () => tcp.open(),
      openHeartbeat: () => Promise.reject(new Error('heartbeat forward refused')),
      prepare: async () => undefined,
      dispose: () => undefined,
    };
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      transport: opener,
    });
    let message = '';
    try {
      await daemon.listDirectories(null);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('心跳链路建不起来直接失败（不降级）', message.includes('heartbeat forward refused'));
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 心跳链路中途断掉 → 按链路退出收尾，不退回单通路 ----------
  {
    const fake = await startFakeRemote({ pong: true });
    const heartbeatLinks: CoreDaemonLink[] = [];
    const tcp = tcpDaemonOpener({ host: '127.0.0.1', port: fake.port });
    const opener: CoreDaemonLinkOpener = {
      open: () => tcp.open(),
      openHeartbeat: async () => {
        const link = await tcp.openHeartbeat();
        heartbeatLinks.push(link);
        return link;
      },
      prepare: async () => undefined,
      dispose: () => undefined,
    };
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      transport: opener,
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
    check('心跳链路中断用例完成握手', await waitFor(() => transport.isReady()));
    // 只断心跳链路：业务链路仍能收发，但存活探测已失去独立通路
    heartbeatLinks[0]?.kill();
    check('心跳链路中断 → 链路按退出收尾', await waitFor(() => failure.error !== null, 2_000));
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- 残行不跨链路（specs/defects/daemon-decoder-keeps-stale-partial-line）----------
  {
    // 上一条链路在任意字节边界断开（TCP 断开可以落在半个帧里）：残行若留在解码器里，
    // 新链路的第一帧会被拼在它后面，得到一个永远不成立的 JSON 前缀——这一整条连接上
    // 每一帧都解析失败，请求方挂到自己的超时（心跳照发，链路看起来还活着）。
    const fake = await startTruncatingRemote();
    const logs: string[] = [];
    const daemon = new CoreDaemon({
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      handshakeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      transport: tcpDaemonOpener({ host: '127.0.0.1', port: fake.port }),
    });
    let firstFailed = false;
    try {
      await daemon.listDirectories('/home');
    } catch {
      firstFailed = true;
    }
    check('残行：第 1 条链路断开时请求失败', firstFailed);
    check('残行：第 1 条链路确实断在半个帧上', fake.truncatedConnections() === 1);

    const second = await withTimeout(daemon.listDirectories('/home'), 3_000);
    check('残行：第 2 条链路的请求拿到应答', second?.path === '/home');
    check('残行：第 2 条链路上没有 malformed frame', !logs.some((line) => line.includes('malformed frame')));
    const third = await withTimeout(daemon.listDirectories('/home'), 3_000);
    check('残行：第 2 条链路上的后续请求仍可用', third?.path === '/home');
    await daemon.shutdown();
    await fake.close();
  }

  // ---------- specs/031：detach（后台运行）----------
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
    let exited = false;
    transport.hooks = {
      ...NOOP_CORE_CHANNEL_HOOKS,
      onFatal: (error: Error) => {
        failure.error = error;
      },
      onExit: () => {
        exited = true;
      },
    };
    transport.start();
    check('detach 用例完成握手', await waitFor(() => transport.isReady()));
    const detachPromise = transport.detach();
    check('detach 发出 detachWorkspace 帧', await waitFor(() =>
      fake.received().some((line) => line.includes('"detachWorkspace"'))));
    check('detach 不发 closeWorkspace 帧', !fake.received().some((line) => line.includes('"closeWorkspace"')));
    await detachPromise;
    check('detach 等到 workspaceClosed(detached) 后收尾', transport.isStopped());
    // detached 是宿主主动选择的后台运行：onExit 按预期退出上报，不触发 fatal
    //（Core 仍在 daemon 孤儿表里跑，报 fatal 会把忙会话标记成失败）
    check('detached 不触发 fatal', failure.error === null);
    check('detached 按预期退出上报', exited);
    await daemon.shutdown();
    await fake.close();
  }

  finish();
}

runTests('remote-core-daemon', run);
