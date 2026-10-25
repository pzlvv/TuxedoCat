/**
 * 单测：Client / Connection 连接模型（`docs/core/client-connection.md` 第 11 节）。
 *
 * 覆盖验收要点：
 * 1. 打开一个工作区建立一个 Connection；重复打开只激活已有；
 * 2. 两个工作区对应两个 Connection（两个 Core 进程）；
 * 3. Client 未收到 coreReady 前不发出任何 UiEvent（就绪后按序冲刷）；
 * 4. 一份配置快照推给所有 Connection；
 * 5. connectionId 不出现在任何总线载荷中；
 * 6. 关闭工作区后 Connection 销毁；
 * 7. 会话按 sessionId 路由到正确 Connection，查不到归属时报错。
 *
 * 另覆盖 `bootstrapCore` 的工作区装配与 `shutdownCore` 的关闭路径。
 *
 * 运行方式：npm run test:all -- clientConnection
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createChecker, runTests } from './helpers/harness';
import { bootstrapCore, bootstrapSnapshot, shutdownCore } from '../host/bootstrapCore';
import { Client } from '../host/Client';
import type { Connection } from '../host/Connection';
import { emptyWorkspaceRef, localWorkspaceRef, remoteWorkspaceRef, type WorkspaceRef } from '../host/workspaceRef';
import { createStandaloneCoreBus } from '../host/standalone/StandaloneEventBus';
import { ConversationManager } from '../host/ConversationManager';
import type { SpinDesign } from '../host/SpinDesign';
import type { ConversationMetadata } from '../shared/history/Conversation';
import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequestHandlers,
  SessionRuntimeState,
  UiEvent,
  UiRequest,
} from '../shared/AssistantEventBus';
import { emptySettingsSnapshot, createTestHost } from './helpers/fixtures';
import { CONFIG_DIR_NAME } from '../config/project';

// ==================== 记录型总线（可控就绪） ====================

interface RecordingBus {
  bus: AssistantEventBus;
  /** 收到的 UiEvent（emitToCore 方向） */
  uiEvents: UiEvent[];
  /** 收到的 UI → core 请求 */
  requests: UiRequest[];
  /** 触发 coreReady（Core 处理完 hostEnvironmentProvided 的事实） */
  emitCoreReady(): void;
  /** 触发一条 CoreEvent */
  emitCoreEvent(event: CoreEvent): void;
}

function createRecordingBus(): RecordingBus {
  const uiEvents: UiEvent[] = [];
  const requests: UiRequest[] = [];
  let coreEventHandlers: CoreEventHandlers | null = null;
  const uiEventHandlers = new Map<string, Set<(event: UiEvent) => void>>();

  const bus: AssistantEventBus = {
    emitToUi(event: CoreEvent): void {
      const handler = (coreEventHandlers as Record<string, (e: CoreEvent) => void> | null)?.[
        event.type
      ];
      if (handler) handler(event);
    },
    request: () => Promise.reject(new Error('core → UI request is not used in this test')),
    onCoreEvents(handlers: CoreEventHandlers) {
      coreEventHandlers = handlers;
      return () => {
        coreEventHandlers = null;
      };
    },
    onCoreRequests(handlers: CoreRequestHandlers) {
      void handlers;
    },
    emitToCore(event: UiEvent): void {
      uiEvents.push(event);
      for (const handler of [...(uiEventHandlers.get(event.type) ?? [])]) handler(event);
    },
    onUiEvent<T extends UiEvent['type']>(
      type: T,
      handler: (event: Extract<UiEvent, { type: T }>) => void,
    ) {
      let set = uiEventHandlers.get(type);
      if (!set) {
        set = new Set();
        uiEventHandlers.set(type, set);
      }
      set.add(handler as (event: UiEvent) => void);
      return () => set?.delete(handler as (event: UiEvent) => void);
    },
    requestCore<T extends UiRequest['type']>(request: Extract<UiRequest, { type: T }>) {
      requests.push(request);
      return Promise.resolve(null as never);
    },
    onUiRequests(handlers) {
      void handlers;
    },
  };

  return {
    bus,
    uiEvents,
    requests,
    emitCoreReady: () => bus.emitToUi({ type: 'coreReady' }),
    emitCoreEvent: (event) => bus.emitToUi(event),
  };
}

// ==================== Client 夹具 ====================

interface ClientHarness {
  client: Client;
  channels: RecordingBus[];
  disposed: number;
  /** 让所有 Connection 就绪（模拟 Core 处理完快照） */
  readyAll(): void;
  /** 触发一个 CoreEvent 到指定连接 */
  emitToConnection(index: number, event: CoreEvent): void;
}

function createClientHarness(): ClientHarness {
  const channels: RecordingBus[] = [];
  let disposed = 0;
  const client = new Client({
    log: () => undefined,
    hostEnvironment: () => ({
      type: 'hostEnvironmentProvided',
      extensionPath: '/tmp/ext',
      logToConsole: false,
      configDirName: CONFIG_DIR_NAME,
      settings: emptySettingsSnapshot(),
      mcpServers: [],
      crossWorkspaceAgent: false,
      crossWorkspaceTransfer: false,
    }),
    openChannel: () => {
      const channel = createRecordingBus();
      channels.push(channel);
      return {
        bus: channel.bus,
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  });
  // 模拟 WebViewUI：先登记 UI 处理器，再打开工作区
  client.onCoreEvents({
    coreReady: () => undefined,
    message: () => undefined,
    streamMessage: () => undefined,
    streamEnd: () => undefined,
    toolCall: () => undefined,
    toolResult: () => undefined,
    toolArgsUpdated: () => undefined,
    toolProgress: () => undefined,
    aiBegin: () => undefined,
    aiEnd: () => undefined,
    messagesReplaced: () => undefined,
    queryBegin: () => undefined,
    queryEnd: () => undefined,
    titleChanged: () => undefined,
    sessionCreated: () => undefined,
    conversationListChanged: () => undefined,
    conversationSpaceCleared: () => undefined,
    sessionRuntimeChanged: () => undefined,
    todosChanged: () => undefined,
    workspaceFileChanged: () => undefined,
    spinDesignDataChanged: () => undefined,
    workModeChanged: () => undefined,
    highlightLanguagesUsed: () => undefined,
    compactBegin: () => undefined,
    compactEnd: () => undefined,
    commandDispatched: () => undefined,
    sessionConfigChanged: () => undefined,
    notice: () => undefined,
    log: () => undefined,
    crossWorkspaceAgentReplyRequested: () => undefined,
    crossWorkspaceAgentAbortRequested: () => undefined,
    crossWorkspaceAgentEnded: () => undefined,
  });
  client.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ kind: 'permission', index: 0, reply: null }),
    crossWorkspaceAgentRequested: async () => ({ error: 'not supported' }),
    crossWorkspaceTransferRequested: async () => ({ error: 'not supported' }),
  });

  return {
    client,
    channels,
    get disposed() {
      return disposed;
    },
    readyAll: () => {
      for (const channel of channels) {
        channel.emitCoreReady();
      }
    },
    emitToConnection: (index, event) => {
      channels[index]?.emitCoreEvent(event);
    },
  } as ClientHarness;
}

const WS_A: WorkspaceRef = localWorkspaceRef('D:/repo/a');
const WS_B: WorkspaceRef = localWorkspaceRef('D:/repo/b');

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ── 1. 一个工作区一个 Connection；重复打开只激活已有 ──
  {
    const harness = createClientHarness();
    const first = harness.client.openWorkspace(WS_A) as Connection;
    check('打开工作区建立 Connection', first instanceof Object && typeof first.id === 'string');
    check('通道只打开一次', harness.channels.length === 1);
    const again = harness.client.openWorkspace(WS_A) as Connection;
    check('重复打开复用同一个 Connection', again === first);
    check('重复打开不新建通道', harness.channels.length === 1);
    check(
      '连接建立即推送宿主环境与配置快照',
      harness.channels[0].uiEvents.filter((event) => event.type === 'hostEnvironmentProvided').length === 1,
    );
    await harness.client.closeAll();
  }

  // ── 2. 两个工作区 → 两个 Connection ──
  {
    const harness = createClientHarness();
    const a = harness.client.openWorkspace(WS_A) as Connection;
    const b = harness.client.openWorkspace(WS_B) as Connection;
    check('两个工作区建立两个 Connection', harness.client.listConnections().length === 2);
    check('两个 Connection 不是同一个', a !== b);
    check('两个 Connection 各自持有总线', a.bus !== b.bus);
    check('打开两个工作区各建一个通道', harness.channels.length === 2);

    // 一份配置快照推给所有 Connection
    harness.client.emitToCore({
      type: 'hostEnvironmentProvided',
      extensionPath: '/tmp/ext',
      logToConsole: false,
      configDirName: CONFIG_DIR_NAME,
      settings: emptySettingsSnapshot(),
      mcpServers: [],
      crossWorkspaceAgent: false,
      crossWorkspaceTransfer: false,
    });
    check(
      '配置快照推给每个 Connection',
      harness.channels.every(
        (channel) => channel.uiEvents.filter((event) => event.type === 'hostEnvironmentProvided').length === 2,
      ),
    );

    // connectionId 不出现在任何总线载荷里
    const payloads = JSON.stringify(harness.channels.flatMap((channel) => channel.uiEvents));
    check('connectionId 不出现在载荷里', !payloads.includes(a.id) && !payloads.includes(b.id));
    await harness.client.closeAll();
  }

  // ── 3. 就绪门禁：coreReady 前不发出 UiEvent，就绪后按序冲刷 ──
  {
    const harness = createClientHarness();
    const a = harness.client.openWorkspace(WS_A) as Connection;
    harness.client.assignSession('s1', WS_A);
    harness.client.emitToCore({ type: 'userMessageSubmitted', sessionId: 's1', content: 'hi', uuid: 'u1' });
    harness.client.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check(
      '未就绪时不发出 UiEvent',
      harness.channels[0].uiEvents.every((event) => event.type === 'hostEnvironmentProvided'),
    );

    // 未就绪时的 requestCore 也不发出，就绪后执行
    let requestResolved = false;
    void harness.client
      .requestCore({ type: 'conversationListRequested', workspacePath: WS_A.path })
      .then(() => {
        requestResolved = true;
      });
    check('未就绪时不发起 requestCore', harness.channels[0].requests.length === 0);

    harness.readyAll();
    check('Connection 就绪', a.isReady());
    const types = harness.channels[0].uiEvents.map((event) => event.type);
    check(
      '就绪后按序冲刷排队的 UiEvent',
      types.join(',') === 'hostEnvironmentProvided,userMessageSubmitted,abortRequested',
    );
    await Promise.resolve();
    await Promise.resolve();
    check('就绪后发起排队的 requestCore', harness.channels[0].requests.length === 1);
    check('requestCore 已回填', requestResolved);
    await harness.client.closeAll();
  }

  // ── 5. 会话按 sessionId 路由；未知会话报错 ──
  {
    const harness = createClientHarness();
    harness.client.openWorkspace(WS_A);
    harness.client.openWorkspace(WS_B);
    harness.readyAll();
    harness.client.assignSession('s1', WS_A);
    harness.client.emitToCore({ type: 'abortRequested', sessionId: 's1' });
    check('事件路由到会话归属的 Connection', harness.channels[0].uiEvents.some((e) => e.type === 'abortRequested'));
    check('不广播到其它 Connection', !harness.channels[1].uiEvents.some((e) => e.type === 'abortRequested'));

    let threw = false;
    try {
      harness.client.emitToCore({ type: 'abortRequested', sessionId: 'unknown' });
    } catch {
      threw = true;
    }
    check('未知会话报错，不静默丢弃', threw);
    await harness.client.closeAll();
  }

  // ── 5b. 远程工作区：按工作区路径登记归属（file-only 匹配会漏掉远程） ──
  {
    const harness = createClientHarness();
    const remoteRef = remoteWorkspaceRef(
      { host: '10.0.0.7', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'pw' } },
      '/home/pz/proj',
    );
    harness.client.openWorkspace(WS_A);
    harness.client.openWorkspace(remoteRef);
    harness.readyAll();
    // 宿主按来源视图登记会话归属：远程路径必须能命中远程 Connection，
    // 否则两个 Connection 下 `userMessageSubmitted` 会因「查不到归属」直接抛错。
    harness.client.emitToCore({
      type: 'sessionWorkspaceAssigned',
      sessionId: 's-remote',
      workspacePath: '/home/pz/proj',
    });
    harness.client.emitToCore({
      type: 'userMessageSubmitted',
      sessionId: 's-remote',
      content: 'hi',
      uuid: 'u-remote',
      workspacePath: '/home/pz/proj',
    });
    check(
      '远程会话的 UiEvent 路由到远程 Connection',
      harness.channels[1].uiEvents.some((e) => e.type === 'userMessageSubmitted'),
    );
    check(
      '远程会话的 UiEvent 不落到本地 Connection',
      !harness.channels[0].uiEvents.some((e) => e.type === 'userMessageSubmitted'),
    );
    // 远程路径逐字比较：大小写不同的另一个目录不是同一个工作区
    check(
      '远程路径大小写不同不匹配',
      harness.client.connectionForWorkspace(
        remoteWorkspaceRef(
          { host: '10.0.0.7', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'pw' } },
          '/home/pz/Proj',
        ),
      ) === undefined,
    );
    await harness.client.closeAll();
  }

  // ── 5c. 会话归属的只读查找（workspaceRefForSession）──
  // 宿主 UI 聚合（标签页流水灯 / 关闭确认）在自有索引未命中时按路由表兜底：
  // 跨工作区子代理会话由目标工作区 Core 在后台创建，宿主索引要等该工作区被激活
  // 才补上，派发时刻（assignSession）这里就要查得到归属（specs/023 FR-002）。
  {
    const harness = createClientHarness();
    const remoteRef = remoteWorkspaceRef(
      { host: '10.0.0.7', port: 22, user: 'pz', auth: { kind: 'sshPassword', password: 'pw' } },
      '/home/pz/proj',
    );
    harness.client.openWorkspace(WS_A);
    harness.client.openWorkspace(remoteRef);
    harness.readyAll();
    harness.client.assignSession('s-a', WS_A);
    harness.client.assignSession('s-remote', remoteRef);

    check('已登记会话查得到本地归属', harness.client.workspaceRefForSession('s-a')?.path === WS_A.path);
    check(
      '已登记会话查得到远程归属（远程不是 file-only）',
      harness.client.workspaceRefForSession('s-remote')?.path === '/home/pz/proj',
    );
    check('未登记会话返回 undefined', harness.client.workspaceRefForSession('unknown') === undefined);

    // 关闭工作区后路由残留清空：归属随 Connection 一起消失
    await harness.client.closeWorkspace(WS_A);
    check('关闭工作区后归属不再可查', harness.client.workspaceRefForSession('s-a') === undefined);
    await harness.client.closeAll();
  }

  // ── 6. 关闭工作区销毁 Connection ──
  {
    const harness = createClientHarness();
    harness.client.openWorkspace(WS_A);
    harness.client.openWorkspace(WS_B);
    await harness.client.closeWorkspace(WS_A);
    check('关闭工作区后 Connection 销毁', harness.client.listConnections().length === 1);
    check('关闭工作区释放通道', harness.disposed === 1);
    check('已关闭的工作区不再有 Connection', harness.client.connectionForWorkspace(WS_A) === undefined);
    await harness.client.closeAll();
  }

  // ── 6b. 启动期空引用占位 Connection：打开真实工作区时销毁 ──
  {
    const harness = createClientHarness();
    const placeholder = harness.client.openWorkspace(emptyWorkspaceRef()) as Connection;
    check('无工作区时建立占位 Connection', harness.client.listConnections().length === 1);
    check('占位 Connection 未就绪', !placeholder.isReady());

    harness.client.openWorkspace(WS_A);
    await new Promise((resolve) => setTimeout(resolve, 0));
    check('打开真实工作区后占位 Connection 销毁', harness.client.listConnections().length === 1);
    check('占位 Connection 释放了通道', harness.disposed === 1);
    check('当前连接指向真实工作区', harness.client.currentConnection() !== placeholder);
    await harness.client.closeAll();
  }

  // ── 6c. 关闭流程中的 Connection 不再是路由目标 ──
  // 空态视图（无工作目录）在启动时生成的会话走「唯一连接」退路登记到占位 Connection；
  // 打开第一个真实工作区时占位 Connection 进入异步销毁（dispose 要等 Core 退出），
  // 此刻销毁空态视图会发 conversationClosed——连接表里若还留着垂死连接，数量判定
  // 失效，这个「无归属」事件会直接抛错（桌面端启动期实测）。
  {
    const harness = createClientHarness();
    harness.client.openWorkspace(emptyWorkspaceRef());
    harness.client.emitToCore({ type: 'conversationStarted', sessionId: 's-empty' });
    check('空态会话登记到占位 Connection', harness.client.workspacePathForSession('s-empty') === '');

    harness.client.openWorkspace(WS_A);
    check('关闭中的占位 Connection 立即摘除', harness.client.listConnections().length === 1);
    let threw = false;
    try {
      harness.client.emitToCore({ type: 'conversationClosed', sessionId: 's-empty' });
    } catch {
      threw = true;
    }
    check('销毁空态视图不抛「查不到归属」', !threw);
    check('空态会话改挂到唯一存活的 Connection', harness.client.workspacePathForSession('s-empty') === WS_A.path);
    check('占位 Connection 仍被释放', harness.disposed === 1);
    await harness.client.closeAll();
  }

  // ── 6d. 空引用占位不与「宿主当前目录」工作区撞键 ──
  // 占位引用的 path 是空串：去重键若跑本地规范化会得到宿主进程的当前目录，
  // 打开该目录时会被当成「重复打开」直接返回占位 Connection（那个工作区没有自己的 Core）。
  {
    const harness = createClientHarness();
    const placeholder = harness.client.openWorkspace(emptyWorkspaceRef()) as Connection;
    const cwdRef = localWorkspaceRef(process.cwd());
    const opened = harness.client.openWorkspace(cwdRef) as Connection;
    check('当前目录工作区新建 Connection', opened !== placeholder);
    check('当前目录工作区可路由', harness.client.connectionForWorkspace(cwdRef) === opened);
    check('占位 Connection 让位销毁', !harness.client.listConnections().includes(placeholder));
    await harness.client.closeAll();
  }

  // ── 7. bootstrapCore 按工作区装配 + 工作区打开 / 关闭事件 + shutdownCore ──
  {
      const fakeCoreScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const frame = JSON.parse(line);
        if (frame.kind === 'hello') process.stdout.write(JSON.stringify({ kind: 'ready' }) + '\\n');
        if (frame.kind === 'shutdown') process.exit(0);
      });
    `;
    let spawnCount = 0;
    const openedRefs: WorkspaceRef[] = [WS_A, WS_B];
    const workspaceEvents: {
      listener: ((change: { type: 'opened' | 'closed' | 'activated'; ref: WorkspaceRef }) => void) | null;
    } = { listener: null };
    const host = createTestHost({
      getWorkspacePath: () => openedRefs[0]?.path,
      getWorkspaceRef: () => openedRefs[0],
      getOpenWorkspaceRefs: () => [...openedRefs],
      onWorkspaceChanged: (listener) => {
        workspaceEvents.listener = listener;
        return () => {
          workspaceEvents.listener = null;
        };
      },
    });
    class StubConversationManager extends ConversationManager {
      protected async dispatchList(_list: readonly ConversationMetadata[]): Promise<void> {}
      protected dispatchStates(_states: readonly SessionRuntimeState[]): void {}
    }
    const stubSpinDesign: SpinDesign = { open: async () => undefined, refresh: async () => undefined };

    const result = bootstrapCore(host, stubSpinDesign, new StubConversationManager(host), {
      locale: 'en-US',
      log: () => undefined,
      logToConsole: false,
      extensionPath: '/tmp/ext',
      crossWorkspaceAgent: false,
      crossWorkspaceTransfer: false,
      openStandaloneChannel: () => {
        const bus = createStandaloneCoreBus({
          binaryPath: process.execPath,
          spawnArgs: ['-e', fakeCoreScript],
          spawn: (command, args, options) => {
            spawnCount += 1;
            return nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;
          },
          log: () => undefined,
        });
        return { bus, dispose: () => bus.shutdown() };
      },
    });
    void result;
    check('bootstrap 为每个打开的工作区建立 Connection', bootstrapSnapshot().connectionCount === 2);
    check('两个工作区启动两个 Core 进程', spawnCount === 2);

    // 打开第三个工作区：Client 新建 Connection 与 Core 进程
    openedRefs.push(localWorkspaceRef('D:/repo/c'));
    workspaceEvents.listener?.({ type: 'opened', ref: localWorkspaceRef('D:/repo/c') });
    check('工作区打开事件建立新 Connection', bootstrapSnapshot().connectionCount === 3 || result.client.listConnections().length === 3);
    check('新工作区启动新 Core 进程', spawnCount === 3);

    // 关闭工作区：Connection 销毁
    await result.client.closeWorkspace(localWorkspaceRef('D:/repo/c'));
    check('工作区关闭事件销毁 Connection', result.client.listConnections().length === 2);

    await shutdownCore();
    check('shutdownCore 关闭全部 Connection', result.client.listConnections().length === 0);
  }

  // ── watch / unwatch 按 workspacePath 路由（specs/018 FR-003）──
  {
    const harness = createClientHarness();
    harness.client.openWorkspace(WS_A);
    harness.client.openWorkspace(WS_B);
    harness.readyAll();
    await harness.client.requestCore({
      type: 'watchWorkspaceFileRequested',
      watchId: 'w1',
      workspacePath: WS_B.path,
      path: '/repo/b/README.md',
    });
    check(
      'watch 请求路由到工作区 B 的 Connection',
      harness.channels[1].requests.some(
        (request) => request.type === 'watchWorkspaceFileRequested' && request.watchId === 'w1',
      ),
    );
    check('watch 请求没有发到工作区 A', harness.channels[0].requests.length === 0);
    await harness.client.requestCore({
      type: 'unwatchWorkspaceFileRequested',
      watchId: 'w1',
      workspacePath: WS_B.path,
    });
    check(
      'unwatch 请求路由到工作区 B 的 Connection',
      harness.channels[1].requests.some(
        (request) => request.type === 'unwatchWorkspaceFileRequested' && request.watchId === 'w1',
      ),
    );
    await harness.client.closeAll();
  }

  finish();
}

runTests('clientConnection', run);
