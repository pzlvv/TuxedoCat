/**
 * Connection - 宿主与一个 Core 之间的一对一连接（`docs/core/client-connection.md`）。
 *
 * Connection 是总线、就绪状态与生命周期的**作用域**：
 * - 总线（`AssistantEventBus`）1:1 属于 Connection；总线载荷不带 connectionId；
 * - 就绪状态机 `connecting → ready → closed`，就绪判据是 Core 处理完
 *   `hostEnvironmentProvided` 后发出的 `CoreEvent.coreReady`；
 * - 该工作区的会话集合（Client 据此做 `sessionId → Connection` 路由）。
 *
 * 门禁在宿主侧：未就绪前的 `UiEvent` 排队、`requestCore` 挂起（不发出），
 * 就绪后按序冲刷；Core 侧对应地做硬断言（就绪前收到 UiEvent 抛错），
 * 两边共同把顺序错误变成启动期错误。
 *
 * 重连不在本规格范围内：Core 崩溃后的重启由总线适配器承担（同一 Connection
 * 内重新握手），超过重启上限时总线报 fatal，Connection 保持 closed 前的最后状态，
 * 由 Client / 宿主决定清理。
 */

import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequestHandlers,
  SessionRuntimeState,
  UiEvent,
  UiRequest,
  UiRequestResultMap,
  Unsubscribe,
} from '../shared/AssistantEventBus.js';
import type { StandaloneCoreBus } from './standalone/StandaloneEventBus.js';
import type { WorkspaceRef } from './workspaceRef.js';
import { workspaceRefDisplayPath } from './workspaceRef.js';

/** Connection 生命周期状态（`docs/core/client-connection.md` 第 7 节） */
export type ConnectionState = 'connecting' | 'ready' | 'closed';

/** Core 非预期退出 / 无法恢复时的回调（宿主据此把受影响的忙会话标记为失败） */
export type ConnectionLostHandler = (connection: Connection, reason: string) => void;

export interface ConnectionOptions {
  /** 内部标识（`local-1` / `remote-2`）；不进总线载荷，也不向用户展示 */
  id: string;
  workspaceRef: WorkspaceRef;
  /** 该 Connection 独占的总线 */
  bus: AssistantEventBus;
  log: (...args: unknown[]) => void;
  /** UI 侧处理器表（Client 持有的同一份；Connection 负责包一层 coreReady 门禁） */
  coreEventHandlers: () => CoreEventHandlers;
  coreRequestHandlers: () => CoreRequestHandlers;
  /** Core 非预期退出 / 无法恢复 */
  onLost: ConnectionLostHandler;
  /** 每次收到 coreReady（含快照重推与崩溃重启后）；首次触发时状态转为 ready */
  onReady?: (connection: Connection) => void;
  /**
   * 会话运行时状态聚合：Core 只推自己进程内的会话，多 Connection 下由 Client
   * 合并成一份全量快照再交给 UI（否则后到的 Connection 会覆盖先到的状态）。
   */
  mergeRuntimeStates?: (
    connectionId: string,
    states: readonly SessionRuntimeState[],
  ) => readonly SessionRuntimeState[];
  /** Connection 关闭后回调（Client 维护映射表） */
  onClosed?: (connection: Connection) => void;
  /** 释放总线（终止 Core 进程） */
  disposeBus: () => Promise<void>;
}

export class Connection {
  readonly id: string;
  readonly workspaceRef: WorkspaceRef;
  readonly bus: AssistantEventBus;

  private state: ConnectionState = 'connecting';
  private readonly log: (...args: unknown[]) => void;
  private readonly options: ConnectionOptions;
  /** 就绪前排队的 UiEvent（保持发出顺序） */
  private readonly queuedEvents: UiEvent[] = [];
  /** 就绪前发起的 requestCore；就绪后按序执行 */
  private readonly queuedRequests: Array<{
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  /** 该 Connection 上已打开的会话（Client 路由用） */
  private readonly sessions = new Set<string>();
  private coreEventUnsubscribe: Unsubscribe | null = null;
  private exitUnsubscribe: Unsubscribe | null = null;
  private fatalUnsubscribe: Unsubscribe | null = null;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.id = options.id;
    this.workspaceRef = options.workspaceRef;
    this.bus = options.bus;
    this.log = options.log;
  }

  getState(): ConnectionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  /** 工作区展示路径（日志用；远程带 scheme://host 前缀） */
  displayPath(): string {
    return workspaceRefDisplayPath(this.workspaceRef);
  }

  // ===================== 会话集合 =====================

  openSession(sessionId: string): void {
    this.sessions.add(sessionId);
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  sessionIds(): readonly string[] {
    return [...this.sessions];
  }

  // ===================== 生命周期 =====================

  /**
   * 注册总线处理器并进入 connecting。
   *
   * `coreReady` 被包一层：先完成本 Connection 的就绪转换（冲刷队列），
   * 再把事件交给 UI 处理器。总线要求处理器表穷尽，因此这里基于 UI 的表拷贝。
   */
  start(): void {
    if (this.state !== 'connecting' || this.coreEventUnsubscribe) {
      throw new Error(`Connection ${this.id} has already been started.`);
    }
    const uiHandlers = this.options.coreEventHandlers();
    const handlers: CoreEventHandlers = {
      ...uiHandlers,
      coreReady: (event: Extract<CoreEvent, { type: 'coreReady' }>) => {
        this.markReady();
        uiHandlers.coreReady(event);
      },
      sessionRuntimeChanged: (event) => {
        const merge = this.options.mergeRuntimeStates;
        uiHandlers.sessionRuntimeChanged(
          merge ? { ...event, states: merge(this.id, event.states) } : event,
        );
      },
    };
    this.coreEventUnsubscribe = this.bus.onCoreEvents(handlers);
    this.bus.onCoreRequests(this.options.coreRequestHandlers());

    // Core 崩溃 / 无法恢复时报告宿主
    const standalone = this.bus as Partial<StandaloneCoreBus>;
    if (typeof standalone.onExit === 'function') {
      this.exitUnsubscribe = standalone.onExit((info) => {
        if (info.expected) return; // 主动关闭不算失败
        this.options.onLost(this, 'Core 进程已退出，本轮请求失败；宿主正在重启 Core。');
      });
    }
    if (typeof standalone.onFatal === 'function') {
      this.fatalUnsubscribe = standalone.onFatal((error) => {
        this.options.onLost(this, `Core 进程无法恢复：${error.message}`);
      });
    }
  }

  /** 推送宿主环境与配置快照（连接建立时一次；状态重推走同一入口） */
  sendHostEnvironment(event: Extract<UiEvent, { type: 'hostEnvironmentProvided' }>): void {
    this.emitToCore(event);
  }

  private markReady(): void {
    if (this.state !== 'connecting') return;
    this.state = 'ready';
    this.log(`[client] connection ${this.id} ready (${this.displayPath() || 'no workspace'})`);

    const events = this.queuedEvents.splice(0, this.queuedEvents.length);
    for (const event of events) this.bus.emitToCore(event);
    const requests = this.queuedRequests.splice(0, this.queuedRequests.length);
    for (const request of requests) {
      request.run().then(request.resolve, request.reject);
    }

    const resolvers = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const resolver of resolvers) resolver.resolve();

    try {
      this.options.onReady?.(this);
    } catch (error) {
      this.log(`[client] ready listener error: ${String(error)}`);
    }
  }

  // ===================== 总线接口 =====================

  /**
   * 发送 UiEvent（门禁在宿主侧）。
   * - `closed`：丢弃并记录；
   * - `connecting`：排队，就绪后按序发出（`hostEnvironmentProvided` 例外：立即发出，
   *   它是就绪的前提）；
   * - `ready`：直接发出。
   */
  emitToCore(event: UiEvent): void {
    if (this.state === 'closed') {
      this.log(`[client] dropped ${event.type}: connection ${this.id} is closed`);
      return;
    }
    if (event.type === 'hostEnvironmentProvided' || this.state === 'ready') {
      this.bus.emitToCore(event);
      return;
    }
    this.queuedEvents.push(event);
  }

  /** 发起 UI → core 请求（门禁同上：未就绪时挂起，不发请求） */
  requestCore<T extends UiRequest['type']>(
    request: Extract<UiRequest, { type: T }>,
  ): Promise<UiRequestResultMap[T]> {
    if (this.state === 'closed') {
      return Promise.reject(new Error(`Connection ${this.id} is closed.`));
    }
    if (this.state === 'ready') {
      return this.bus.requestCore(request);
    }
    return new Promise<UiRequestResultMap[T]>((resolve, reject) => {
      this.queuedRequests.push({
        run: () => this.bus.requestCore(request),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  /** 直接投递 core 侧事件（宿主把「Core 已退出」这类宿主自己产生的事实推给 UI） */
  emitToUi(event: CoreEvent): void {
    this.bus.emitToUi(event);
  }

  /** 等待本 Connection 就绪（已就绪立即返回；关闭后拒绝） */
  whenReady(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(new Error(`Connection ${this.id} is closed.`));
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  private readonly readyResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  /** 关闭 Connection：拒绝未完成的请求，终止总线（Standalone 下即关闭 Core 进程） */
  async dispose(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const error = new Error(`Connection ${this.id} has been closed.`);
    const requests = this.queuedRequests.splice(0, this.queuedRequests.length);
    for (const request of requests) request.reject(error);
    const readyResolvers = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const resolver of readyResolvers) resolver.reject(error);
    this.queuedEvents.length = 0;

    this.coreEventUnsubscribe?.();
    this.exitUnsubscribe?.();
    this.fatalUnsubscribe?.();
    this.coreEventUnsubscribe = null;
    this.exitUnsubscribe = null;
    this.fatalUnsubscribe = null;

    try {
      await this.options.disposeBus();
    } catch (disposeError) {
      this.log(`[client] connection ${this.id} dispose failed: ${String(disposeError)}`);
    }
    this.options.onClosed?.(this);
  }
}
