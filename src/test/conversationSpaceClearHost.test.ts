/**
 * 对话空间清空回执的宿主送达测试（DEVELOPMENT.md 第 4.1 / 4.3 节）。
 *
 * webview 设置面板发出 `clearConversationSpace` 后，「删除中」按钮只能靠宿主下发的
 * `conversationSpaceCleared`（成功）或 `conversationSpacesError`（失败）解除。
 * 本文件锁宿主侧的完整送达链：webview 消息 → UiEvent → Core（假 Core，按修复后的
 * 契约回 CoreEvent 回执）→ WebViewUI 映射 → webview 下行消息。
 *
 * 场景按 Electron 的**启动恢复形态**装配：打开集合是上次保存的标签页顺序、活动项是
 * 上次的活动标签页，两者互相独立。假 Core 用环境变量标记身份（远程回执统计 999 /
 * 统计条目 `remote-core-marker`；本地 456 / `local-core-marker`），从而黑盒断言
 * 「统计 / 清空」落到了哪个 Core：
 * - 启动后活动连接必须对齐宿主活动工作区——Connection 按**打开顺序**建立，
 *   「最后建立的」不等于「正显示的标签页」；不对齐时远程标签页的统计 / 清空
 *   会落到本地连接（用户实测：首次连接远程后统计显示本地占用，切 tab 才恢复）；
 * - 切换标签页后路由跟着激活走；
 * - 失败回执经宿主转成 `conversationSpacesError` 下发。
 * Core 侧真实行为由 conversationSpaceClearParity.test.ts 用真实 Rust 产物锁定。
 *
 * 运行方式：npm run test:all -- conversation-space-clear-host
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Socket } from 'net';
import { bootstrapCore, shutdownCore } from '../host/bootstrapCore';
import type { Connection } from '../host/Connection';
import { createCoreChannelBus, createStandaloneCoreBus } from '../host/standalone/StandaloneEventBus';
import { CoreDaemon } from '../host/standalone/CoreDaemon';
import { tcpDaemonOpener } from './helpers/tcpDaemonLink';
import { ConversationManager } from '../host/ConversationManager';
import type { SpinDesign } from '../host/SpinDesign';
import type { ConversationMetadata } from '../core/history/Conversation';
import type { SessionRuntimeState } from '../core/AssistantEventBus';
import { remoteWorkspaceRef, localWorkspaceRef, type WorkspaceEndpoint, type WorkspaceRef } from '../host/workspaceRef';
import { CORE_ENV_VAR } from '../config/project';
import { createChecker, runTests } from './helpers/harness';
import { createTestHost, type TestHost } from './helpers/fixtures';

/** 远程假 Core 的回执统计（与本地 456 区分，用于断言请求落点） */
const REMOTE_REMOVED_BYTES = 999;
const LOCAL_REMOVED_BYTES = 456;

// ==================== 假 Core（按修复后的契约回执，带身份标记） ====================

/**
 * 冒充 Core 的 Node 脚本：hello → ready；收到 hostEnvironmentProvided 后发
 * `coreReady`（Connection 的就绪判据）；应答宿主请求（统计条目带身份 marker）；
 * 收到 conversationSpaceCleared 后按修复后的 Standalone Core 契约回执——成功发
 * `conversationSpaceCleared`（complete）+ `conversationListChanged`，目录名以
 * `fail-` 开头发 error 回执。`FAKE_CORE_MARK=remote` 时统计与回执都是远程口径。
 */
function fakeCoreScript(): string {
  return `
const readline = require('readline');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const isRemote = process.env.FAKE_CORE_MARK === 'remote';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.kind === 'hello') { send({ kind: 'ready' }); return; }
  if (frame.kind === 'uiEvent' && frame.event.type === 'hostEnvironmentProvided') {
    send({ kind: 'event', event: { type: 'coreReady' } });
    return;
  }
  if (frame.kind === 'request') {
    // 与真实 Core 同口径应答宿主请求：否则挂起请求在 shutdown 时被拒绝，
    // 变成调用点（如 ConversationManager.refresh）的未处理 rejection
    const t = frame.request.type;
    let result = null;
    if (t === 'conversationListRequested' || t === 'mcpServersRequested') result = [];
    else if (t === 'skillsRequested') result = { skills: [] };
    else if (t === 'conversationSpacesRequested') {
      result = [{
        dirName: (isRemote ? 'remote' : 'local') + '-core-marker',
        projectPath: '/',
        sizeBytes: 1,
        fileCount: 1,
        conversationCount: 1,
      }];
    }
    send({ kind: 'response', id: frame.id, ok: true, result });
    return;
  }
  if (frame.kind === 'uiEvent' && frame.event.type === 'conversationSpaceCleared') {
    // 回执字段与 CoreEvent 契约同名：dirName（对话空间目录名）
    const dirName = frame.event.dirName;
    if (String(dirName).startsWith('fail-')) {
      send({ kind: 'event', event: {
        type: 'conversationSpaceCleared', dirName,
        result: { status: 'error', message: 'Conversation space not found: ' + dirName },
      } });
    } else {
      send({ kind: 'event', event: {
        type: 'conversationSpaceCleared', dirName,
        result: { status: 'complete', removedFiles: 3, removedBytes: isRemote ? ${REMOTE_REMOVED_BYTES} : ${LOCAL_REMOVED_BYTES} },
      } });
      send({ kind: 'event', event: { type: 'conversationListChanged' } });
    }
    return;
  }
});
`;
}

/** 假 Core 进程（本地 stdio 与远程 daemon 桥接共用同一段脚本，用环境变量区分身份） */
function spawnFakeCore(mark: 'remote' | undefined): child_process.ChildProcessWithoutNullStreams {
  return child_process.spawn(process.execPath, ['-e', fakeCoreScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // 只给远程桥接的进程打标记；本地 stdio 的 spawn 不带（保持 local 口径）
    env: mark === 'remote' ? { ...process.env, FAKE_CORE_MARK: 'remote' } : process.env,
    windowsHide: true,
  }) as child_process.ChildProcessWithoutNullStreams;
}

// ==================== 假远端 daemon（协议同 remoteCoreDaemon.test.ts） ====================

interface FakeRemote {
  port: number;
  close: () => Promise<void>;
}

/** channel 帧桥接到假 Core 进程的进程内假远端 */
function startBridgingFakeRemote(): Promise<FakeRemote> {
  let nextChannel = 1;
  const cores = new Set<child_process.ChildProcessWithoutNullStreams>();
  const sockets = new Set<Socket>();

  const server = net.createServer((socket: Socket) => {
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
          const channel = Number(frame['channel']);
          const core = spawnFakeCore('remote');
          cores.add(core);
          core.stdout.setEncoding('utf8');
          let coreBuffer = '';
          core.stdout.on('data', (out: string) => {
            coreBuffer += out;
            let outIndex = coreBuffer.indexOf('\n');
            while (outIndex >= 0) {
              const outLine = coreBuffer.slice(0, outIndex).trim();
              coreBuffer = coreBuffer.slice(outIndex + 1);
              if (outLine && socket.writable) {
                try {
                  socket.write(`${JSON.stringify({ kind: 'frame', channel, frame: JSON.parse(outLine) })}\n`);
                } catch {
                  /* socket 已关 */
                }
              }
              outIndex = coreBuffer.indexOf('\n');
            }
          });
          core.stderr.setEncoding('utf8');
          core.stderr.on('data', () => undefined);
          core.stdin.write(`${JSON.stringify(frame['frame'])}\n`);
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
        close: () =>
          new Promise<void>((done) => {
            for (const core of cores) {
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

// ==================== 装配 ====================

class StubConversationManager extends ConversationManager {
  protected async dispatchList(_list: readonly ConversationMetadata[]): Promise<void> {
    /* 桩：不分发 */
  }

  protected dispatchStates(_states: readonly SessionRuntimeState[]): void {
    /* 桩：不分发 */
  }
}

const stubSpinDesign: SpinDesign = {
  open: async () => undefined,
  refresh: async () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 家目录指向临时目录：宿主 settings.json 与本地 Core 进程的数据目录都隔离
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-space-clear-host-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env[CORE_ENV_VAR] = 'standalone';

  const fake = await startBridgingFakeRemote();
  const remoteEndpoint: WorkspaceEndpoint = {
    host: '127.0.0.1',
    port: fake.port,
    user: 'root',
    auth: { kind: 'sshPassword', password: 'host-token' },
  };
  const remoteDaemon = new CoreDaemon({
    log: () => undefined,
    handshakeTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
    transport: tcpDaemonOpener({ host: remoteEndpoint.host, port: fake.port }),
  });
  const localRef = localWorkspaceRef('D:/parity-local');
  const remoteRef = remoteWorkspaceRef(remoteEndpoint, '/parity-remote');

  // Electron 启动恢复的真实形态：打开集合按上次保存的标签页顺序（远程在前），
  // 活动项是上次的活动标签页（远程）——两者独立，活动项不一定是集合最后一项
  let activeRef: WorkspaceRef = remoteRef;
  const openedRefs: WorkspaceRef[] = [remoteRef, localRef];
  // 持有器规避 TS 控制流收窄（赋值发生在回调里，调用点会被误判为恒 null）
  const workspaceEvents: {
    listener: ((change: { type: 'opened' | 'closed' | 'activated'; ref: WorkspaceRef }) => void) | null;
  } = { listener: null };

  const host: TestHost = createTestHost({
    getWorkspacePath: () => activeRef.path,
    getWorkspaceRef: () => activeRef,
    getOpenWorkspaceRefs: () => [...openedRefs],
    onWorkspaceChanged: (listener) => {
      workspaceEvents.listener = listener;
      return () => {
        workspaceEvents.listener = null;
      };
    },
  });

  try {
    const { client, ui } = bootstrapCore(host, stubSpinDesign, new StubConversationManager(host), {
      locale: 'en-US',
      log: () => undefined,
      logToConsole: false,
      extensionPath: path.resolve(__dirname, '../..'),
      openStandaloneChannel: (ref) => {
        if (!ref.endpoint) {
          // 本地连接：stdio 起假 Core 进程（无标记 → local 口径）
          const bus = createStandaloneCoreBus({
            binaryPath: process.execPath,
            spawnArgs: ['-e', fakeCoreScript()],
            log: () => undefined,
          });
          return { bus, dispose: () => bus.shutdown() };
        }
        // 远程连接：daemon 控制通道上开 channel（假远端桥接带 remote 标记的假 Core）
        const bus = createCoreChannelBus(remoteDaemon.openChannel(ref), () => undefined);
        return { bus, dispose: () => bus.shutdown() };
      },
    });

    const remoteConnection = (): Connection | undefined =>
      client.listConnections().find((connection) => connection.workspaceRef.path === remoteRef.path);
    const localConnection = (): Connection | undefined =>
      client.listConnections().find((connection) => connection.workspaceRef.endpoint === null);

    check('两个连接都已建立', remoteConnection() !== undefined && localConnection() !== undefined);
    check('远程连接完成握手', await waitFor(() => remoteConnection()?.isReady() === true));
    check('本地连接完成握手', await waitFor(() => localConnection()?.isReady() === true));

    // ---------- bug 2：启动对齐（活动连接 = 宿主活动工作区） ----------
    check(
      '启动后活动连接对齐宿主活动工作区（远程），而不是最后建立的连接',
      client.currentConnection()?.workspaceRef.path === remoteRef.path,
    );

    // 用户实测症状：启动后直接点统计，拿到的是本地占用
    await ui.handleWebviewMessage({ type: 'requestConversationSpaces' });
    const statsArrived = await waitFor(() =>
      host.sent.some((message) => message.type === 'conversationSpacesData'),
    );
    const statsPayload = statsArrived
      ? (host.sent.filter((message) => message.type === 'conversationSpacesData').at(-1) as {
          spaces: Array<{ dirName: string }>;
        })
      : undefined;
    check(
      '启动后直接点统计：数据来自远程 Core',
      statsPayload?.spaces?.[0]?.dirName === 'remote-core-marker',
    );

    // 远程标签页上清空：请求与回执都应来自远程 Core
    await ui.handleWebviewMessage({ type: 'clearConversationSpace', dirName: 'space-a', mode: 'clear' });
    const remoteReceipt = await waitFor(() =>
      host.sent.some((message) =>
        message.type === 'conversationSpaceCleared'
        && (message as { dirName?: string }).dirName === 'space-a',
      ),
    );
    const remoteReceiptPayload = remoteReceipt
      ? (host.sent.filter(
          (message) =>
            message.type === 'conversationSpaceCleared'
            && (message as { dirName?: string }).dirName === 'space-a',
        ).at(-1) as { removedBytes: number })
      : undefined;
    check(
      `远程标签页的清空回执来自远程 Core（统计 ${REMOTE_REMOVED_BYTES}）`,
      remoteReceiptPayload?.removedBytes === REMOTE_REMOVED_BYTES,
    );

    // ---------- 切换标签页：路由跟激活走 ----------
    activeRef = localRef;
    workspaceEvents.listener?.({ type: 'activated', ref: localRef });

    await ui.handleWebviewMessage({ type: 'requestConversationSpaces' });
    const localStats = await waitFor(() =>
      host.sent.some(
        (message) =>
          message.type === 'conversationSpacesData'
          && (message as { spaces?: Array<{ dirName: string }> }).spaces?.[0]?.dirName
            === 'local-core-marker',
      ),
    );
    check('切到本地标签页后统计来自本地 Core', localStats);

    await ui.handleWebviewMessage({ type: 'clearConversationSpace', dirName: 'space-b' });
    const localReceipt = await waitFor(() =>
      host.sent.some((message) =>
        message.type === 'conversationSpaceCleared'
        && (message as { dirName?: string }).dirName === 'space-b'
        && (message as { removedBytes?: number }).removedBytes === LOCAL_REMOVED_BYTES,
      ),
    );
    check(`本地标签页的清空回执来自本地 Core（统计 ${LOCAL_REMOVED_BYTES}）`, localReceipt);

    // ---------- 失败路径：error 回执经宿主转成 conversationSpacesError 下发 ----------
    await ui.handleWebviewMessage({ type: 'clearConversationSpace', dirName: 'fail-space-c' });
    const localError = await waitFor(() =>
      host.sent.some((message) =>
        message.type === 'conversationSpacesError'
        && String((message as { error?: string }).error ?? '').includes('fail-space-c'),
      ),
    );
    check('失败时 webview 收到错误并解除「删除中」', localError);
  } finally {
    await shutdownCore();
    await remoteDaemon.shutdown();
    await fake.close();
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }

  finish();
}

runTests('conversation-space-clear-host', run);
