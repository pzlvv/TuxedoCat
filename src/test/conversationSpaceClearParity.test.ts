/**
 * 对话空间清空回执的对等测试（DEVELOPMENT.md 第 4.3 / 4.1 节）。
 *
 * 设置页的「删除中」按钮靠 core 的完成回执解除：`UiEvent.conversationSpaceCleared`
 * 触发删除后，两套 Core 都必须发回**同名 CoreEvent 回执**（判别联合：
 * `complete` 带删除统计 / `error` 带原因），随后发 `conversationListChanged`。
 * 缺回执时 webview 的删除按钮会永远停在「删除中」（此前 standalone 下的实际缺陷）。
 *
 * 本文件把契约做成可执行断言，同一串 UiEvent 分别喂给：
 * - Embedded Core：进程内 `createEventBus()` + `initializeCoreEvents()`；
 * - Standalone Core：真实 Rust 产物 + stdio 帧通道（**本地连接**形态）；
 * - Standalone Core：真实 Rust 产物 + daemon 通道（**远程连接**形态，
 *   假远端 daemon 把 channel 帧桥接到 Core 进程的 stdio）。
 *
 * 运行方式：npm run test:all -- conversation-space-clear-parity
 * 需要 Standalone Core 产物（先跑 `npm run build:core`）；产物缺失时跳过。
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { Server, Socket } from 'net';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_PROTOCOL_VERSION } from '../host/standalone/protocol';
import { CoreDaemon } from '../host/standalone/CoreDaemon';
import { tcpDaemonOpener } from './helpers/tcpDaemonLink';
import { createCoreChannelBus } from '../host/standalone/StandaloneEventBus';
import { remoteWorkspaceRef, type WorkspaceEndpoint } from '../host/workspaceRef';
import { createEventBus } from '../host/EventBus';
import {
  resetGlobalEventBus,
  setGlobalEventBus,
  type CoreEvent,
  type UiEvent,
} from '../core/AssistantEventBus';
import { initializeCoreEvents } from '../core/initializeCoreEvents';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir, emptySettingsSnapshot } from './helpers/fixtures';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_BINARY = path.join(
  REPO_ROOT,
  'resources',
  CORE_RESOURCE_DIR,
  corePlatformDir('win32', 'x64')!,
  coreBinaryFileName('win32'),
);

// ==================== 回执形状（行为断言用；类型层由 eventTypeParity 锁） ====================

interface SpaceClearReceipt {
  type: 'conversationSpaceCleared';
  dirName: string;
  result:
    | { status: 'complete'; removedFiles: number; removedBytes: number }
    | { status: 'error'; message: string };
}

// ==================== 夹具 ====================

/** 对话空间里的文件（内容与字节数都确定，两侧的删除统计必须完全一致） */
const SPACE_DIR_NAME = 'parity-space';
const JSONL_CONTENT = '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n';
const META_CONTENT = '{"sessionId":"s1","title":"占位标题"}';
const TOOL_RESULT_CONTENT = 'tool-result-payload-bytes';
const WORKSPACE_META_CONTENT = '{"workspacePath":"D:/parity-ws"}';
/** 期望删除的字节数（.jsonl + .meta.json + tool-results/a.bin；workspace.meta.json 保留不计） */
const EXPECTED_REMOVED_BYTES =
  Buffer.byteLength(JSONL_CONTENT) + Buffer.byteLength(META_CONTENT) + Buffer.byteLength(TOOL_RESULT_CONTENT);
const EXPECTED_REMOVED_FILES = 3;

/** 在临时家目录下造一个对话空间：`<home>/<CONFIG_DIR_NAME>/conversations/<dirName>/` */
function makeSpace(home: string, dirName: string): string {
  const dir = path.join(home, CONFIG_DIR_NAME, 'conversations', dirName);
  fs.mkdirSync(path.join(dir, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), JSONL_CONTENT, 'utf8');
  fs.writeFileSync(path.join(dir, 's1.meta.json'), META_CONTENT, 'utf8');
  fs.writeFileSync(path.join(dir, 'tool-results', 'a.bin'), TOOL_RESULT_CONTENT, 'utf8');
  // 空间级清单：清空后必须保留
  fs.writeFileSync(path.join(dir, 'workspace.meta.json'), WORKSPACE_META_CONTENT, 'utf8');
  return dir;
}

function hostEnvironment(): UiEvent {
  return {
    type: 'hostEnvironmentProvided',
    extensionPath: REPO_ROOT,
    logToConsole: false,
    configDirName: CONFIG_DIR_NAME,
    settings: emptySettingsSnapshot(),
    mcpServers: [],
  };
}

/** 临时切换 USERPROFILE / HOME（两侧都靠它定位配置与对话目录） */
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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** 从 CoreEvent 序列里取对话空间回执（最后一条） */
function receiptOf(received: CoreEvent[]): SpaceClearReceipt | undefined {
  const list = received.filter((event) => (event.type as string) === 'conversationSpaceCleared');
  return list.at(-1) as SpaceClearReceipt | undefined;
}

// ==================== 三条车道 ====================

/** Embedded：进程内总线 + 真实 initializeCoreEvents */
async function runEmbedded(home: string, dirName: string, mode: 'clear' | 'remove' = 'clear'): Promise<CoreEvent[]> {
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
        { get: () => async () => ({ behavior: 'allow' }) as never },
      ) as never,
    );
    initializeCoreEvents(bus);
    // registerHistoryUiEvents 等是异步注册（动态 import），等它们就位
    await new Promise((resolve) => setTimeout(resolve, 200));

    bus.emitToCore(hostEnvironment());
    bus.emitToCore({ type: 'conversationSpaceCleared', dirName, mode });
    await waitFor(() => received.some((event) => (event.type as string) === 'conversationSpaceCleared'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    resetGlobalEventBus();
    return received;
  });
}

/** Standalone 本地连接：真实 Rust 产物 + stdio 帧通道 */
async function runStandaloneLocal(home: string, dirName: string, mode: 'clear' | 'remove' = 'clear'): Promise<CoreEvent[]> {
  return withHome(home, async () => {
    const child = child_process.spawn(CORE_BINARY, ['stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    }) as child_process.ChildProcessWithoutNullStreams;
    return driveRealCore(child, dirName, mode);
  });
}

/** 把一帧 JSON 行写进 Core 的 stdin */
type CoreChild = child_process.ChildProcessWithoutNullStreams;

/** 驱动一个已 spawn 的真实 Core：hello → 宿主环境 → 清空事件 → 收回执 → 收尾 */
async function driveRealCore(child: CoreChild, dirName: string, mode: 'clear' | 'remove' = 'clear'): Promise<CoreEvent[]> {
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
          const frame = JSON.parse(line) as { kind: string; event?: CoreEvent };
          if (frame.kind === 'event' && frame.event) received.push(frame.event);
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
  // 帧按序处理：hello → 宿主环境（core 的就绪判据）→ 清空事件。
  // 就绪前发其它 UiEvent 会被 Core 拒绝（docs/core-ui-separation.md 第 7 节）。
  send({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION });
  send({ kind: 'uiEvent', event: hostEnvironment() });
  const ready = await waitFor(() => received.some((event) => event.type === 'coreReady'), 10_000);
  if (!ready) {
    child.kill();
    throw new Error(`core 未就绪（未收到 coreReady），已收到: ${received.map((e) => e.type).join(',')}`);
  }
  send({ kind: 'uiEvent', event: { type: 'conversationSpaceCleared', dirName, mode } });
  const settled = await waitFor(() => received.some((event) => (event.type as string) === 'conversationSpaceCleared'), 10_000);
  if (!settled) {
    // 收不到回执本身就是缺陷现场：杀掉进程后带着已收集的事件失败
    child.kill();
    throw new Error(`core 未回 conversationSpaceCleared 回执（dirName=${dirName}），已收到: ${received.map((e) => e.type).join(',')}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

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
}

// ==================== 假远端 daemon：channel 帧桥接到 Core 进程 stdio ====================

interface FakeRemoteDaemon {
  port: number;
  close: () => Promise<void>;
}

/**
 * 进程内假远端 daemon（协议同 `remoteCoreDaemon.test.ts`）：
 * `openWorkspace` 分配 channel 后，把该 channel 上的帧原样桥接给
 * `spawnCore()` 返回的 Core 进程 stdio——远程形态下的 Core 与本地完全同一份。
 */
function startBridgingFakeRemote(
  spawnCore: () => CoreChild,
): Promise<FakeRemoteDaemon> {
  let nextChannel = 1;
  const cores = new Map<number, CoreChild>();
  const sockets = new Set<Socket>();

  const bridgeToCore = (socket: Socket, channel: number, inner: unknown): void => {
    let core = cores.get(channel);
    if (!core) {
      core = spawnCore();
      cores.set(channel, core);
      core.stdout.setEncoding('utf8');
      let buffer = '';
      core.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line && socket.writable) {
            try {
              socket.write(`${JSON.stringify({ kind: 'frame', channel, frame: JSON.parse(line) })}\n`);
            } catch {
              /* socket 已关 */
            }
          }
          index = buffer.indexOf('\n');
        }
      });
      core.stderr.setEncoding('utf8');
      core.stderr.on('data', () => undefined);
    }
    core.stdin.write(`${JSON.stringify(inner)}\n`);
  };

  const server: Server = net.createServer((socket: Socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
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
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
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
          bridgeToCore(socket, Number(frame['channel']), frame['frame']);
          continue;
        }
        if (frame['kind'] === 'shutdown') {
          socket.end();
        }
      }
    });
  });

  return new Promise<FakeRemoteDaemon>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const core of cores.values()) {
              try {
                core.kill();
              } catch {
                /* 已退出 */
              }
            }
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Standalone 远程连接：真实 Rust 产物，经假远端 daemon 的 channel 桥接 */
async function runStandaloneRemote(home: string, dirName: string, mode: 'clear' | 'remove' = 'clear'): Promise<CoreEvent[]> {
  const spawnCore = (): CoreChild =>
    child_process.spawn(CORE_BINARY, ['stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: home, HOME: home },
      windowsHide: true,
    });
  const fake = await startBridgingFakeRemote(spawnCore);
  try {
    const endpoint: WorkspaceEndpoint = {
      host: '127.0.0.1',
      port: fake.port,
      user: 'root',
      auth: { kind: 'sshPassword', password: 'parity-token' },
    };
    const daemon = new CoreDaemon({
      log: () => undefined,
      handshakeTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
      transport: tcpDaemonOpener({ host: endpoint.host, port: fake.port }),
    });
    const ref = remoteWorkspaceRef(endpoint, '/parity-remote');
    const bus = createCoreChannelBus(daemon.openChannel(ref), () => undefined);
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
    bus.onCoreRequests({
      toolPermissionRequested: async () => ({ behavior: 'allow' }),
      userChoice: async () => ({ index: 0 }),
    });

    const ready = await waitFor(() => bus.isReady(), 10_000);
    if (!ready) throw new Error('远程通道握手未完成');
    // 就绪判据是配置快照（docs/core-ui-separation.md 第 7 节）：先送宿主环境再清空，
    // 否则清空事件会被 Core 的就绪守卫拒绝（与本地 stdio 车道同一口径）。
    bus.emitToCore(hostEnvironment());
    await waitFor(() => received.some((event) => event.type === 'coreReady'), 10_000);
    bus.emitToCore({ type: 'conversationSpaceCleared', dirName, mode });
    const settled = await waitFor(() => received.some((event) => (event.type as string) === 'conversationSpaceCleared'), 10_000);
    if (!settled) {
      throw new Error(`远程 core 未回 conversationSpaceCleared 回执（dirName=${dirName}），已收到: ${received.map((e) => e.type).join(',')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bus.shutdown();
    await daemon.shutdown();
    return received;
  } finally {
    await fake.close();
  }
}

// ==================== 用例 ====================

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  if (process.platform !== 'win32' || !fs.existsSync(CORE_BINARY)) {
    console.log(`skip: ${path.relative(REPO_ROOT, CORE_BINARY)} missing (run npm run build:core)`);
    finish();
    return;
  }

  // ---------- Embedded：回执 + 列表变化 + 文件真的被删 ----------
  {
    const home = makeTempDir('space-clear-embedded');
    const spaceDir = makeSpace(home, SPACE_DIR_NAME);
    const received = await runEmbedded(home, SPACE_DIR_NAME);

    const receipt = receiptOf(received);
    check('Embedded 发出完成回执', receipt?.result.status === 'complete');
    check('Embedded 回执带目录名', receipt?.dirName === SPACE_DIR_NAME);
    check(
      'Embedded 回执统计与实际删除一致',
      receipt?.result.status === 'complete'
        && receipt.result.removedFiles === EXPECTED_REMOVED_FILES
        && receipt.result.removedBytes === EXPECTED_REMOVED_BYTES,
    );
    const receiptIndex = received.findIndex((event) => (event.type as string) === 'conversationSpaceCleared');
    const listIndex = received.findIndex((event) => event.type === 'conversationListChanged');
    check('Embedded 回执后发 conversationListChanged', receiptIndex >= 0 && listIndex > receiptIndex);
    check(
      'Embedded 不再向空间目录名发 phantom message',
      !received.some((event) => event.type === 'message' && event.sessionId === SPACE_DIR_NAME),
    );
    check('Embedded 删除 .jsonl', !fs.existsSync(path.join(spaceDir, 's1.jsonl')));
    check('Embedded 删除 .meta.json', !fs.existsSync(path.join(spaceDir, 's1.meta.json')));
    check('Embedded 删除 tool-results', !fs.existsSync(path.join(spaceDir, 'tool-results')));
    check('Embedded 保留 workspace.meta.json', fs.existsSync(path.join(spaceDir, 'workspace.meta.json')));

    // 失败路径：空间不存在 → error 回执，且不发 conversationListChanged
    const failureReceived = await runEmbedded(makeTempDir('space-clear-embedded-err'), 'no-such-space');
    const failureReceipt = receiptOf(failureReceived);
    check('Embedded 空间不存在时发 error 回执', failureReceipt?.result.status === 'error');
    check(
      'Embedded 失败不发 conversationListChanged',
      failureReceipt?.result.status === 'error'
        && !failureReceived.some((event) => event.type === 'conversationListChanged'),
    );
  }

  // ---------- Standalone 本地连接（真实 Rust 产物 + stdio） ----------
  {
    const home = makeTempDir('space-clear-local');
    const spaceDir = makeSpace(home, SPACE_DIR_NAME);
    const received = await runStandaloneLocal(home, SPACE_DIR_NAME);

    const receipt = receiptOf(received);
    check('Standalone 本地连接发出完成回执', receipt?.result.status === 'complete');
    check('Standalone 本地回执带目录名', receipt?.dirName === SPACE_DIR_NAME);
    check(
      'Standalone 本地回执统计与 Embedded 口径一致',
      receipt?.result.status === 'complete'
        && receipt.result.removedFiles === EXPECTED_REMOVED_FILES
        && receipt.result.removedBytes === EXPECTED_REMOVED_BYTES,
    );
    const receiptIndex = received.findIndex((event) => (event.type as string) === 'conversationSpaceCleared');
    const listIndex = received.findIndex((event) => event.type === 'conversationListChanged');
    check('Standalone 本地回执后发 conversationListChanged', receiptIndex >= 0 && listIndex > receiptIndex);
    check(
      'Standalone 本地不再发 phantom message',
      !received.some((event) => event.type === 'message' && event.sessionId === SPACE_DIR_NAME),
    );
    check('Standalone 本地删除 .jsonl', !fs.existsSync(path.join(spaceDir, 's1.jsonl')));
    check('Standalone 本地保留 workspace.meta.json', fs.existsSync(path.join(spaceDir, 'workspace.meta.json')));

    // 失败路径
    const errHome = makeTempDir('space-clear-local-err');
    makeSpace(errHome, SPACE_DIR_NAME);
    const failureReceived = await runStandaloneLocal(errHome, 'no-such-space');
    const failureReceipt = receiptOf(failureReceived);
    check('Standalone 本地空间不存在时发 error 回执', failureReceipt?.result.status === 'error');
    check(
      'Standalone 本地失败不发 conversationListChanged',
      failureReceipt?.result.status === 'error'
        && !failureReceived.some((event) => event.type === 'conversationListChanged'),
    );
  }

  // ---------- Standalone 远程连接（真实 Rust 产物 + daemon channel） ----------
  {
    const home = makeTempDir('space-clear-remote');
    const spaceDir = makeSpace(home, SPACE_DIR_NAME);
    const received = await runStandaloneRemote(home, SPACE_DIR_NAME);

    const receipt = receiptOf(received);
    check('Standalone 远程连接发出完成回执', receipt?.result.status === 'complete');
    check(
      'Standalone 远程回执统计与本地口径一致',
      receipt?.result.status === 'complete'
        && receipt.result.removedFiles === EXPECTED_REMOVED_FILES
        && receipt.result.removedBytes === EXPECTED_REMOVED_BYTES,
    );
    const receiptIndex = received.findIndex((event) => (event.type as string) === 'conversationSpaceCleared');
    const listIndex = received.findIndex((event) => event.type === 'conversationListChanged');
    check('Standalone 远程回执后发 conversationListChanged', receiptIndex >= 0 && listIndex > receiptIndex);
    check('Standalone 远程删除 .jsonl', !fs.existsSync(path.join(spaceDir, 's1.jsonl')));
    check('Standalone 远程保留 workspace.meta.json', fs.existsSync(path.join(spaceDir, 'workspace.meta.json')));

    // 失败路径
    const errHome = makeTempDir('space-clear-remote-err');
    makeSpace(errHome, SPACE_DIR_NAME);
    const failureReceived = await runStandaloneRemote(errHome, 'no-such-space');
    const failureReceipt = receiptOf(failureReceived);
    check('Standalone 远程空间不存在时发 error 回执', failureReceipt?.result.status === 'error');
  }

  // ---------- remove 模式：整目录删除（三条车道同口径） ----------
  {
    // Embedded
    const embeddedHome = makeTempDir('space-remove-embedded');
    const embeddedDir = makeSpace(embeddedHome, SPACE_DIR_NAME);
    const embeddedReceived = await runEmbedded(embeddedHome, SPACE_DIR_NAME, 'remove');
    check('Embedded remove 整目录删除（含 workspace.meta.json）', !fs.existsSync(embeddedDir));
    check(
      'Embedded remove 回执 complete',
      receiptOf(embeddedReceived)?.result.status === 'complete',
    );

    // Standalone 本地连接
    const localHome = makeTempDir('space-remove-local');
    const localDir = makeSpace(localHome, SPACE_DIR_NAME);
    const localReceived = await runStandaloneLocal(localHome, SPACE_DIR_NAME, 'remove');
    check('Standalone 本地 remove 整目录删除（含 workspace.meta.json）', !fs.existsSync(localDir));
    check(
      'Standalone 本地 remove 回执 complete',
      receiptOf(localReceived)?.result.status === 'complete',
    );

    // Standalone 远程连接
    const remoteHome = makeTempDir('space-remove-remote');
    const remoteDir = makeSpace(remoteHome, SPACE_DIR_NAME);
    const remoteReceived = await runStandaloneRemote(remoteHome, SPACE_DIR_NAME, 'remove');
    check('Standalone 远程 remove 整目录删除（含 workspace.meta.json）', !fs.existsSync(remoteDir));
    check(
      'Standalone 远程 remove 回执 complete',
      receiptOf(remoteReceived)?.result.status === 'complete',
    );
  }

  finish();
}

runTests('conversation-space-clear-parity', run);
