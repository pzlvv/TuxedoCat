/**
 * StandaloneEventBus - AssistantEventBus 在帧通道上的实现
 * （见 docs/core/standalone-core.md 第 3、5、6、7 节）。
 *
 * UI 侧的总线：
 * - `emitToCore` → `uiEvent` 帧；
 * - `event` / `request` 帧 → `CoreEvent` / `CoreRequest` 处理器；
 * - `request` 的响应 → `response` 帧；
 * - `requestCore` → `request` 帧（UI → core 方向），`response` 帧回填 Promise。
 *
 * 与内存实现（`src/host/EventBus.ts`）的差异，全部来自进程边界：
 * - 就绪前的 `uiEvent` 在 UI 侧排队，握手完成后按序发出；
 * - 「连接态」事件（`hostEnvironmentProvided`）保留最后一次取值，
 *   每次握手后重放；`conversationOpened` 的会话集合同样重放（`docs/core/standalone-core.md` 第 6.1 节）；
 * - 处理器尚未注册时到达的 `CoreEvent` 先缓存，注册后按序补投；
 * - 未注册 `CoreRequest` 处理器时回 `ok: false` 的响应，而不是让对端永久挂起。
 *
 * core 侧的 UiEvent 消费方在 Core 进程内：本实现不向进程内分发 UiEvent，
 * `request()` 也不由 UI 调用（请求由 Core 发起、UI 应答）。
 *
 * 传输层抽象（`CoreChannelTransport`）：
 * - `CoreProcessTransport`：直接管理一个 Core 进程（单进程形态，测试与回退路径）；
 * - `DaemonChannelTransport`（`CoreDaemon.ts`）：经 daemon 控制通道上的一条 channel。
 * 总线逻辑对两者完全一致。
 */

import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequest,
  CoreRequestHandlers,
  CoreRequestResultMap,
  UiEvent,
  UiRequest,
  UiRequestHandlers,
  UiRequestResultMap,
  Unsubscribe,
} from '../../shared/AssistantEventBus.js';
import {
  CoreProcess,
  type CoreExitInfo,
  type CoreSpawnFunction,
  type RestartPolicy,
} from './CoreProcess.js';
import type { CoreToUiFrame, UiToCoreFrame } from './protocol.js';

/** 连接态事件：保留最后一次取值，每次握手后重放 */
const CONNECTION_SCOPED_EVENT_TYPES: ReadonlySet<UiEvent['type']> = new Set([
  'hostEnvironmentProvided',
]);

export interface StandaloneCoreBus extends AssistantEventBus {
  /** 当前是否已握手 */
  isReady(): boolean;
  /** 等待下一次握手完成（已就绪时立即 resolve） */
  whenReady(): Promise<void>;
  /** 注册「Core 就绪」监听；每次握手成功都触发（含重启） */
  onReady(listener: () => void): Unsubscribe;
  /** 注册「Core 退出」监听 */
  onExit(listener: (info: CoreExitInfo) => void): Unsubscribe;
  /** 注册「重启次数超限」监听 */
  onFatal(listener: (error: Error) => void): Unsubscribe;
  /** 停止 Core 进程（宿主退出路径） */
  shutdown(): Promise<void>;
}

// ==================== 传输层抽象 ====================

/**
 * 帧通道生命周期钩子。
 *
 * 与 `CoreProcessHooks` 同口径：`ready` 帧由传输层消费（握手完成 → `onReady`），
 * 其余帧交给 `onFrame`。
 */
export interface CoreChannelHooks {
  /** 收到一帧合法 Core → UI 帧（`ready` 由传输层消费，不转发） */
  onFrame(frame: CoreToUiFrame): void;
  /** 握手成功（首次连接与每次重置后都会触发） */
  onReady(): void;
  /** 已就绪的连接断开 */
  onNotReady(): void;
  /** 通道终止（不再重启） */
  onExit(info: CoreExitInfo): void;
  /** 诊断输出：标准错误、非法帧、启动失败 */
  onDiagnostic(line: string): void;
  /** 无法恢复（重启次数超限 / 通道关闭且不再重启） */
  onFatal(error: Error): void;
}

/** 一条 Core 帧通道的传输层实现 */
export interface CoreChannelTransport {
  /** 总线在 `start()` 之前赋值 */
  hooks: CoreChannelHooks;
  start(): void;
  send(frame: UiToCoreFrame): void;
  stop(): Promise<void>;
  /**
   * 后台运行（specs/031）：终止与宿主的控制关系但让 Core 侧继续执行。
   * 远程实现是向 daemon 发 `detachWorkspace`；本地进程没有「后台」可去
   * （specs/031 非目标），语义就是现行终止。
   */
  detach(): Promise<void>;
  /**
   * 只断链（specs/031 AC-19：弹不出确认链的退出口径）：不发 closeWorkspace /
   * detachWorkspace，控制链的断开交给 daemon.disconnect()——daemon 的断开收尾
   * 按默认策略分叉（非 idle 孤儿化、idle 终止）。本地进程语义同现行终止。
   */
  disconnectOnly(): Promise<void>;
  isReady(): boolean;
  isStopped(): boolean;
}

/** 空钩子（总线赋值前到达的事件只记录诊断） */
export const NOOP_CORE_CHANNEL_HOOKS: CoreChannelHooks = {
  onFrame: () => undefined,
  onReady: () => undefined,
  onNotReady: () => undefined,
  onExit: () => undefined,
  onDiagnostic: () => undefined,
  onFatal: () => undefined,
};

export interface StandaloneCoreBusOptions {
  /** Standalone Core 可执行文件路径 */
  binaryPath: string;
  log: (...args: unknown[]) => void;
  restartPolicy?: RestartPolicy;
  /** 命令行参数（必给：动作是裸词，漏掉就会落到缺省动作上；测试用它跑假 Core） */
  spawnArgs: readonly string[];
  /** 测试注入的 spawn */
  spawn?: CoreSpawnFunction;
  shutdownTimeoutMs?: number;
  /** 握手超时（毫秒） */
  handshakeTimeoutMs?: number;
  now?: () => number;
}

/** 直接管理一个 Core 进程的传输层（单进程形态） */
class CoreProcessTransport implements CoreChannelTransport {
  hooks: CoreChannelHooks = NOOP_CORE_CHANNEL_HOOKS;
  private readonly process: CoreProcess;

  constructor(options: StandaloneCoreBusOptions) {
    this.process = new CoreProcess({
      binaryPath: options.binaryPath,
      spawnArgs: options.spawnArgs,
      restartPolicy: options.restartPolicy,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      spawn: options.spawn,
      now: options.now,
      hooks: {
        onFrame: (frame) => this.hooks.onFrame(frame),
        onReady: () => this.hooks.onReady(),
        onNotReady: () => this.hooks.onNotReady(),
        onExit: (info) => this.hooks.onExit(info),
        onDiagnostic: (line) => this.hooks.onDiagnostic(line),
        onFatal: (error) => this.hooks.onFatal(error),
      },
    });
  }

  start(): void {
    this.process.start();
  }

  send(frame: UiToCoreFrame): void {
    this.process.send(frame);
  }

  stop(): Promise<void> {
    return this.process.stop();
  }

  detach(): Promise<void> {
    // 本地进程没有 daemon、没有孤儿语义可去（specs/031 非目标）：后台运行的
    // 选项只对远程工作区出现，这里等同现行终止
    return this.process.stop();
  }

  disconnectOnly(): Promise<void> {
    // 本地无 daemon：只断链即终止（无「默认策略」可接管）
    return this.process.stop();
  }

  isReady(): boolean {
    return this.process.isReady();
  }

  isStopped(): boolean {
    return this.process.isStopped();
  }
}

/** 创建「一个 Core 进程 + 帧通道总线」（单进程形态） */
export function createStandaloneCoreBus(
  options: StandaloneCoreBusOptions,
): StandaloneCoreBus {
  return createCoreChannelBus(new CoreProcessTransport(options), options.log);
}

/**
 * 在任意传输层上装配帧通道总线。
 *
 * 两种装配（单进程 / daemon channel）共用同一套排队、重放、请求应答逻辑；
 * 差异只在 `CoreChannelTransport` 的实现上。
 */
export function createCoreChannelBus(
  transport: CoreChannelTransport,
  log: (...args: unknown[]) => void,
): StandaloneCoreBus {
  let coreEventHandlers: CoreEventHandlers | null = null;
  let coreRequestHandlers: CoreRequestHandlers | null = null;
  /** Core 侧的 UI 请求处理器；Standalone 下请求经帧通道发往 Core，本表只作登记 */
  let uiRequestHandlers: UiRequestHandlers | null = null;
  /** 处理器未注册时到达的 CoreEvent；注册后补投 */
  const pendingCoreEvents: CoreEvent[] = [];
  /**
   * 已发出、尚未收到应答的 UI → core 请求。
   *
   * 与 `CoreRequest` 相反方向：UI 是发起方、Core 是应答方。连接世代变化
   * （Core 重启）时全部以错误结束——Core 侧的重启会丢掉内存中的请求上下文，
   * 让调用点挂到天荒地老不如让它立刻失败。
   */
  const pendingUiRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextUiRequestId = 1;
  /** 就绪前发出的非连接态 UiEvent */
  const queuedUiEvents: UiEvent[] = [];
  /** 连接态 UiEvent 的最后取值（按首次出现顺序） */
  const connectionScopedEvents = new Map<UiEvent['type'], UiEvent>();
  /** 宿主已打开的会话：重启后重放 `conversationOpened` */
  const openSessions = new Set<string>();
  const uiEventHandlers = new Map<string, Set<(event: UiEvent) => void>>();

  const readyListeners = new Set<() => void>();
  const exitListeners = new Set<(info: CoreExitInfo) => void>();
  const fatalListeners = new Set<(error: Error) => void>();
  let readyResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  let ready = false;
  let stopped = false;
  let terminalError: Error | null = null;
  /**
   * 连接世代。每次握手 +1，断连也 +1。
   * CoreRequest 的应答只在「发起它的那个连接」仍然是当前连接时才发回，
   * 避免 Core 重启后 request id 复用导致旧弹窗的答案套用到新请求上。
   */
  let connectionEpoch = 0;

  transport.hooks = {
    onFrame: (frame) => handleFrame(frame),
    onReady: () => handleReady(),
    onNotReady: () => {
      ready = false;
      // 旧连接上未决的 CoreRequest 应答全部作废
      connectionEpoch += 1;
      // 旧连接上未决的 UI → core 请求同样作废（Core 重启会丢掉请求上下文）
      failPendingUiRequests(new Error('Standalone Core connection lost before responding.'));
      log('[core] connection lost');
    },
    onExit: (info) => {
      for (const listener of [...exitListeners]) {
        try {
          listener(info);
        } catch (error) {
          log(`[core] exit listener error: ${String(error)}`);
        }
      }
    },
    onDiagnostic: (line) => log(line),
    onFatal: (error) => {
      log(`[core] fatal: ${error.message}`);
      failPendingReady(error);
      failPendingUiRequests(error);
      for (const listener of [...fatalListeners]) {
        try {
          listener(error);
        } catch (listenerError) {
          log(`[core] fatal listener error: ${String(listenerError)}`);
        }
      }
    },
  };

  // ==================== Core → UI ====================

  function handleFrame(frame: CoreToUiFrame): void {
    switch (frame.kind) {
      case 'event':
        dispatchCoreEvent(frame.event);
        return;
      case 'request':
        handleCoreRequest(frame.id, frame.request);
        return;
      case 'response':
        settleUiRequest(frame);
        return;
      default:
        log(`[core] unexpected frame: ${JSON.stringify(frame)}`);
    }
  }

  function dispatchCoreEvent(event: CoreEvent): void {
    if (!coreEventHandlers) {
      pendingCoreEvents.push(event);
      return;
    }
    const handler = (coreEventHandlers as Record<string, (e: CoreEvent) => void>)[event.type];
    if (!handler) {
      // `docs/core/standalone-core.md` 第 5 节：未知事件类型视为契约漂移，丢弃并记录
      log(`[core] unknown CoreEvent type: ${String((event as { type?: unknown }).type)}`);
      return;
    }
    try {
      handler(event);
    } catch (error) {
      // 单个处理器失败不能变成未捕获异常（会顺着 stdout 的 data 事件冒泡）
      log(`[core] CoreEvent handler error (${event.type}): ${String(error)}`);
    }
  }

  function handleCoreRequest(id: number, request: CoreRequest): void {
    if (!coreRequestHandlers) {
      sendFrame({
        kind: 'response',
        id,
        ok: false,
        error: `No core request handlers registered for request(${request.type}).`,
      });
      return;
    }
    const handler = (coreRequestHandlers as Record<string, (r: CoreRequest) => Promise<unknown>>)[
      request.type
    ];
    if (!handler) {
      sendFrame({
        kind: 'response',
        id,
        ok: false,
        error: `No handler registered for core request ${request.type}.`,
      });
      return;
    }
    // 把 handler 的调用放进 promise 链：同步抛错也会走 reject 分支回 ok:false，
    // 而不是冒泡到 FrameDecoder 被误报成 malformed frame（那会让对端一直等）。
    const epoch = connectionEpoch;
    Promise.resolve()
      .then(() => handler(request))
      .then(
        (result) => {
          if (epoch === connectionEpoch) sendFrame({ kind: 'response', id, ok: true, result });
          else log(`[core] dropped stale response for request ${id} (connection changed)`);
        },
        (error: unknown) => {
          if (epoch === connectionEpoch) {
            sendFrame({
              kind: 'response',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            log(`[core] dropped stale failure for request ${id} (connection changed)`);
          }
        },
      );
  }

  /** UI → core 请求的应答（`CoreToUiFrame.response`） */
  function settleUiRequest(frame: { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }): void {
    const pending = pendingUiRequests.get(frame.id);
    if (!pending) {
      // 连接世代变化时旧请求已被就地结束；迟到 / 重复的应答只记录
      log(`[core] response for unknown UI request id ${frame.id}`);
      return;
    }
    pendingUiRequests.delete(frame.id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error));
  }

  /** 连接断开 / 关闭时结束全部挂起的 UI → core 请求，避免调用点永久悬挂 */
  function failPendingUiRequests(error: Error): void {
    const pending = [...pendingUiRequests.values()];
    pendingUiRequests.clear();
    for (const entry of pending) entry.reject(error);
  }

  // ==================== 握手 ====================

  function handleReady(): void {
    ready = true;
    connectionEpoch += 1;
    log('[core] ready');
    // 重放顺序：连接态事实（locale / 扩展路径 / 工作目录）→ 已打开会话 → 就绪前排队的动作。
    // 连接态事实描述的是「Core 侧消费任何动作之前必须知道的环境」，所以排在最前；
    // 它们在每次握手后都会重放，不进入队列，因此不会重复。
    for (const event of connectionScopedEvents.values()) sendUiEvent(event);
    for (const sessionId of openSessions) {
      sendUiEvent({ type: 'conversationOpened', sessionId });
    }
    const queued = queuedUiEvents.splice(0, queuedUiEvents.length);
    for (const event of queued) sendUiEvent(event);

    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const resolver of resolvers) resolver.resolve();
    for (const listener of [...readyListeners]) {
      try {
        listener();
      } catch (error) {
        log(`[core] ready listener error: ${String(error)}`);
      }
    }
  }

  /** fatal / shutdown 时让 `whenReady()` 的等待者失败，而不是永久悬挂 */
  function failPendingReady(error: Error): void {
    terminalError = error;
    const resolvers = readyResolvers;
    readyResolvers = [];
    for (const resolver of resolvers) resolver.reject(error);
  }

  // ==================== 发送 ====================

  function sendFrame(frame: UiToCoreFrame): void {
    if (stopped) {
      log(`[core] dropped ${frame.kind} frame: bus is shut down`);
      return;
    }
    transport.send(frame);
  }

  function sendUiEvent(event: UiEvent): void {
    sendFrame({ kind: 'uiEvent', event });
  }

  // ==================== 总线接口 ====================

  const bus: StandaloneCoreBus = {
    emitToUi(event: CoreEvent): void {
      dispatchCoreEvent(event);
    },

    request<T extends CoreRequest['type']>(
      request: Extract<CoreRequest, { type: T }>,
    ): Promise<CoreRequestResultMap[T]> {
      // 请求由 Core 发起、UI 应答：Core 侧经 `request` 帧到达 handleCoreRequest，
      // UI 侧不调用本方法。
      return Promise.reject(
        new Error(
          `request(${request.type}) is issued by the core side; ` +
          'the UI side answers through onCoreRequests().',
        ),
      );
    },

    onCoreEvents(handlers: CoreEventHandlers): Unsubscribe {
      if (coreEventHandlers) {
        throw new Error('Core event handlers already registered. onCoreEvents() must be called once.');
      }
      coreEventHandlers = handlers;
      const pending = pendingCoreEvents.splice(0, pendingCoreEvents.length);
      for (const event of pending) dispatchCoreEvent(event);
      return () => {
        if (coreEventHandlers === handlers) coreEventHandlers = null;
      };
    },

    onCoreRequests(handlers: CoreRequestHandlers): void {
      if (coreRequestHandlers) {
        throw new Error(
          'Core request handlers already registered. onCoreRequests() must be called once.',
        );
      }
      coreRequestHandlers = handlers;
    },

    requestCore<T extends UiRequest['type']>(
      request: Extract<UiRequest, { type: T }>,
    ): Promise<UiRequestResultMap[T]> {
      if (stopped) {
        return Promise.reject(new Error('Standalone Core bus has been shut down.'));
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      const id = nextUiRequestId;
      nextUiRequestId += 1;
      return new Promise<UiRequestResultMap[T]>((resolve, reject) => {
        pendingUiRequests.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        sendFrame({ kind: 'request', id, request });
      });
    },

    onUiRequests(handlers: UiRequestHandlers): void {
      // Standalone 下 UI 请求的应答方在 Core 进程内；UI 侧只登记（与 onUiEvent 同理）
      if (uiRequestHandlers) {
        throw new Error('UI request handlers already registered. onUiRequests() must be called once.');
      }
      uiRequestHandlers = handlers;
    },

    emitToCore(event: UiEvent): void {
      if (stopped) {
        log(`[core] dropped ${event.type} after shutdown`);
        return;
      }

      // 会话集合由 openSessions 统一维护并在每次握手后重放；
      // 因此 opened / closed 不进 queuedUiEvents，避免首次握手重放两次。
      if (event.type === 'conversationOpened') {
        openSessions.add(event.sessionId);
        if (ready) sendUiEvent(event);
        return;
      }
      if (event.type === 'conversationClosed') {
        openSessions.delete(event.sessionId);
        if (ready) sendUiEvent(event);
        return;
      }

      if (CONNECTION_SCOPED_EVENT_TYPES.has(event.type)) {
        connectionScopedEvents.set(event.type, event);
        if (ready) sendUiEvent(event);
        return;
      }
      if (!ready) {
        queuedUiEvents.push(event);
        return;
      }
      sendUiEvent(event);
    },

    onUiEvent<T extends UiEvent['type']>(
      type: T,
      handler: (event: Extract<UiEvent, { type: T }>) => void,
    ): Unsubscribe {
      // Standalone 下 UiEvent 的消费方在 Core 进程内；UI 侧订阅保留为本地注册表
      let set = uiEventHandlers.get(type);
      if (!set) {
        set = new Set();
        uiEventHandlers.set(type, set);
      }
      const wrapped = handler as (event: UiEvent) => void;
      set.add(wrapped);
      return () => {
        const current = uiEventHandlers.get(type);
        if (!current) return;
        current.delete(wrapped);
        if (current.size === 0) uiEventHandlers.delete(type);
      };
    },

    // ==================== 扩展 ====================

    isReady: () => ready,

    whenReady: () => {
      if (ready) return Promise.resolve();
      if (terminalError) return Promise.reject(terminalError);
      return new Promise<void>((resolve, reject) => {
        readyResolvers.push({ resolve, reject });
      });
    },

    onReady(listener: () => void): Unsubscribe {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },

    onExit(listener: (info: CoreExitInfo) => void): Unsubscribe {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },

    onFatal(listener: (error: Error) => void): Unsubscribe {
      fatalListeners.add(listener);
      return () => fatalListeners.delete(listener);
    },

    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      const shutdownError = new Error('Standalone Core bus has been shut down.');
      failPendingReady(shutdownError);
      failPendingUiRequests(shutdownError);
      await transport.stop();
    },
  };

  transport.start();
  return bus;
}
