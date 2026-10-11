/**
 * Client - 宿主级唯一实例（`docs/core/client-connection.md`）。
 *
 * 职责：
 * - 维护 `workspaceId → connectionId` 主表与 `sessionId → connectionId` 派生表；
 * - 每个工作区一个 Connection（Embedded 恒一个，工作区仍是会话属性）；
 * - 配置快照是 Client 级的：一份推给所有 Connection；
 * - 就绪门禁与会话路由：UiEvent / requestCore 按会话找到归属 Connection，
 *   查不到归属时报错，不静默丢弃。
 *
 * Client 同时实现 `AssistantEventBus`，作为宿主侧的总线路由器：
 * - `emitToCore` / `requestCore`：按载荷里的 sessionId / workspacePath 路由；
 * - `onCoreEvents` / `onCoreRequests`：登记 UI 处理器，并注册到每个 Connection 的总线。
 *
 * `connectionId` 是内部概念：不进入任何总线载荷，也不向用户展示。
 */

import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequest,
  CoreRequestHandlers,
  CoreRequestResultMap,
  SessionRuntimeState,
  UiEvent,
  UiRequest,
  UiRequestHandlers,
  UiRequestResultMap,
  Unsubscribe,
} from '../core/AssistantEventBus.js';
import { Connection } from './Connection.js';
import type { CoreKind } from './coreKind.js';
import {
  sameWorkspace,
} from './workspacePaths.js';
import {
  isEmptyWorkspaceRef,
  workspaceRefKey,
  type WorkspaceRef,
} from './workspaceRef.js';

/** 已打开的 Core 通道（Standalone：一个工作区一个 Core 进程 / daemon channel） */
export interface OpenedCoreChannel {
  bus: AssistantEventBus;
  /** 释放通道（关闭 Core 进程 / channel） */
  dispose: () => Promise<void>;
}

export interface ClientOptions {
  coreKind: CoreKind;
  log: (...args: unknown[]) => void;
  /**
   * Standalone：为一个工作区打开 Core 通道。
   * Embedded 下不需要（恒一个进程内 Connection）。
   *
   * 允许同步返回：daemon 通道在内部异步建立（帧在 channel 打开前排队），
   * 因此 Client / bootstrap 不需要等待连接建立。
   */
  openChannel?: (ref: WorkspaceRef) => OpenedCoreChannel | Promise<OpenedCoreChannel>;
  /** Embedded：进程内总线；所有工作区复用同一个 Connection */
  embeddedBus?: AssistantEventBus;
  /** 连接建立后推送的宿主环境与配置快照（每次连接建立、每次快照变更） */
  hostEnvironment: () => Extract<UiEvent, { type: 'hostEnvironmentProvided' }>;
  /** Core 非预期退出 / 无法恢复（宿主据此把该连接上的忙会话标记为失败） */
  onConnectionLost?: (connection: Connection, reason: string) => void;
  /** 每次 Connection 就绪（含快照重推与崩溃重启后） */
  onConnectionReady?: (connection: Connection) => void;
}

export class Client implements AssistantEventBus {
  private readonly options: ClientOptions;
  private readonly log: (...args: unknown[]) => void;
  private readonly connections = new Map<string, Connection>();
  /** workspaceRefKey → connectionId */
  private readonly workspaceToConnection = new Map<string, string>();
  /** sessionId → connectionId（派生表；会话 ID 在 Client 范围内唯一） */
  private readonly sessionToConnection = new Map<string, string>();
  private nextConnectionSeq = 1;
  private currentConnectionId: string | null = null;
  private uiCoreEventHandlers: CoreEventHandlers | null = null;
  private uiCoreRequestHandlers: CoreRequestHandlers | null = null;
  /** 进程内 UiEvent / UiRequest 订阅表（Standalone 下消费方在 Core 进程内） */
  private readonly uiEventHandlers = new Map<string, Set<(event: UiEvent) => void>>();
  private uiRequestHandlers: UiRequestHandlers | null = null;
  /** 每个 Connection 最近一次 sessionRuntimeChanged 的快照（聚合给 UI 用） */
  private readonly runtimeStatesByConnection = new Map<string, readonly SessionRuntimeState[]>();

  constructor(options: ClientOptions) {
    this.options = options;
    this.log = options.log;
  }

  // ===================== 连接集合 =====================

  /** 已建立的 Connection（按建立顺序） */
  listConnections(): readonly Connection[] {
    return [...this.connections.values()];
  }

  /** 当前活动 Connection（最近打开 / 激活的工作区）；无连接时为 null */
  currentConnection(): Connection | null {
    if (!this.currentConnectionId) return null;
    return this.connections.get(this.currentConnectionId) ?? null;
  }

  /** 激活某个已打开工作区的 Connection（切换活动项；未打开时忽略） */
  activateWorkspace(ref: WorkspaceRef): void {
    const connection = this.connectionForWorkspace(ref);
    if (connection) this.currentConnectionId = connection.id;
  }

  /** 按工作区引用取 Connection（未打开返回 undefined） */
  connectionForWorkspace(ref: WorkspaceRef): Connection | undefined {
    const id = this.workspaceToConnection.get(workspaceRefKey(ref));
    return id ? this.connections.get(id) : undefined;
  }

  /**
   * 按 sessionId 取 Connection。
   *
   * 查不到归属时报错（`docs/core/client-connection.md` 第 6 节：不静默丢弃）。
   * 只有一个 Connection 时（Embedded / 单工作区宿主）把它作为归属并登记——
   * 这是「数量对上层透明」的退路，不改变多连接下的严格路由。
   */
  connectionForSession(sessionId: string): Connection {
    const id = this.sessionToConnection.get(sessionId);
    if (id) {
      const connection = this.connections.get(id);
      if (connection) return connection;
    }
    if (this.connections.size === 1) {
      const only = [...this.connections.values()][0];
      this.sessionToConnection.set(sessionId, only.id);
      only.openSession(sessionId);
      return only;
    }
    throw new Error(
      `No Connection owns session "${sessionId}"; ` +
      'the host must register the session workspace before emitting its events.',
    );
  }

  /** 会话归属的工作区路径（file scheme）；查不到 / 非本地返回 undefined */
  workspacePathForSession(sessionId: string): string | undefined {
    const id = this.sessionToConnection.get(sessionId);
    if (!id) return undefined;
    const connection = this.connections.get(id);
    if (!connection) return undefined;
    const ref = connection.workspaceRef;
    return ref.scheme === 'file' ? ref.path : undefined;
  }

  /**
   * 打开工作区：已存在则激活，不新建 Connection。
   *
   * 同步路径（Embedded、同步通道工厂）直接返回 Connection；通道异步建立时返回
   * Promise（daemon 通道自身在打开前排队帧，上层无需等待）。
   */
  openWorkspace(ref: WorkspaceRef): Connection | Promise<Connection> {
    const key = workspaceRefKey(ref);
    const existingId = this.workspaceToConnection.get(key);
    if (existingId) {
      const existing = this.connections.get(existingId);
      if (existing) {
        this.currentConnectionId = existing.id;
        return existing;
      }
      this.workspaceToConnection.delete(key);
    }

    // Embedded：恒一个 Connection，工作区是会话属性（`docs/core/client-connection.md` 第 3.2 节）
    if (this.options.coreKind === 'embedded') {
      const only = [...this.connections.values()][0];
      if (only) {
        this.workspaceToConnection.set(key, only.id);
        this.currentConnectionId = only.id;
        return only;
      }
      if (!this.options.embeddedBus) {
        throw new Error('Embedded Client requires an embedded bus.');
      }
      return this.createConnection(ref, this.options.embeddedBus, async () => undefined);
    }

    if (!this.options.openChannel) {
      throw new Error('Standalone Client requires an openChannel implementation.');
    }
    // 打开第一个真实工作区：启动期的空引用占位 Connection 完成使命（避免空转的 Core 进程）
    if (!isEmptyWorkspaceRef(ref)) {
      for (const connection of [...this.connections.values()]) {
        if (isEmptyWorkspaceRef(connection.workspaceRef)) {
          void this.closeConnection(connection);
        }
      }
    }
    const channelOrPromise = this.options.openChannel(ref);
    if (channelOrPromise instanceof Promise) {
      return channelOrPromise.then((channel) =>
        this.createConnection(ref, channel.bus, channel.dispose),
      );
    }
    return this.createConnection(ref, channelOrPromise.bus, channelOrPromise.dispose);
  }

  private createConnection(
    ref: WorkspaceRef,
    bus: AssistantEventBus,
    disposeBus: () => Promise<void>,
  ): Connection {
    const id = `${ref.endpoint ? 'remote' : 'local'}-${this.nextConnectionSeq}`;
    this.nextConnectionSeq += 1;
    const connection = new Connection({
      id,
      workspaceRef: ref,
      bus,
      log: this.log,
      coreEventHandlers: () => {
        if (!this.uiCoreEventHandlers) {
          throw new Error('UI CoreEvent handlers are not registered yet.');
        }
        return this.uiCoreEventHandlers;
      },
      coreRequestHandlers: () => {
        if (!this.uiCoreRequestHandlers) {
          throw new Error('UI CoreRequest handlers are not registered yet.');
        }
        return this.uiCoreRequestHandlers;
      },
      onLost: (lost, reason) => this.options.onConnectionLost?.(lost, reason),
      onReady: (ready) => this.options.onConnectionReady?.(ready),
      mergeRuntimeStates: (connectionId, states) =>
        this.mergeRuntimeStates(connectionId, states),
      onClosed: (closed) => {
        this.connections.delete(closed.id);
        this.runtimeStatesByConnection.delete(closed.id);
        if (this.currentConnectionId === closed.id) this.currentConnectionId = null;
      },
      disposeBus,
    });

    this.connections.set(id, connection);
    this.workspaceToConnection.set(workspaceRefKey(ref), id);
    this.currentConnectionId = id;
    connection.start();
    // 连接建立即推送宿主环境与配置快照（就绪前提；重复推送幂等）
    connection.sendHostEnvironment(this.options.hostEnvironment());
    return connection;
  }

  /** 关闭工作区：销毁 Connection（Standalone 下关闭 Core 进程） */
  async closeWorkspace(ref: WorkspaceRef): Promise<void> {
    const key = workspaceRefKey(ref);
    const id = this.workspaceToConnection.get(key);
    if (!id) return;
    this.workspaceToConnection.delete(key);
    const connection = this.connections.get(id);
    if (!connection) return;
    await this.closeConnection(connection);
  }

  /** 关闭全部 Connection（宿主退出路径） */
  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()];
    for (const connection of connections) {
      await this.closeConnection(connection);
    }
  }

  private async closeConnection(connection: Connection): Promise<void> {
    for (const [sessionId, id] of [...this.sessionToConnection]) {
      if (id === connection.id) this.sessionToConnection.delete(sessionId);
    }
    for (const [key, id] of [...this.workspaceToConnection]) {
      if (id === connection.id) this.workspaceToConnection.delete(key);
    }
    await connection.dispose();
  }

  /**
   * 登记会话归属（`sessionWorkspaceAssigned` 的落点，也供宿主显式登记）。
   * 同一会话重复登记到不同 Connection 时报错，不静默覆盖。
   */
  assignSession(sessionId: string, ref: WorkspaceRef): Connection {
    const connection = this.connectionForWorkspace(ref);
    if (!connection) {
      throw new Error(
        `Cannot assign session "${sessionId}": workspace is not open ` +
        `(${ref.scheme}:${ref.path}).`,
      );
    }
    this.assignSessionToConnection(sessionId, connection);
    return connection;
  }

  private assignSessionToConnection(sessionId: string, connection: Connection): void {
    const existingId = this.sessionToConnection.get(sessionId);
    if (existingId && existingId !== connection.id) {
      throw new Error(
        `Session "${sessionId}" is already assigned to connection ${existingId}; ` +
        `refusing to reassign to ${connection.id}.`,
      );
    }
    this.sessionToConnection.set(sessionId, connection.id);
    connection.openSession(sessionId);
  }

  // ===================== 总线接口（AssistantEventBus）=====================

  /** core → UI 单向事件：广播给所有 Connection（宿主自产事实，非 core 帧） */
  emitToUi(event: CoreEvent): void {
    for (const connection of this.connections.values()) {
      connection.emitToUi(event);
    }
  }

  request<T extends CoreRequest['type']>(
    request: Extract<CoreRequest, { type: T }>,
  ): Promise<CoreRequestResultMap[T]> {
    // 请求由 Core 发起、UI 应答；宿主侧的 Client 不发起这类请求
    return Promise.reject(
      new Error(
        `request(${request.type}) is issued by the core side; ` +
        'the UI side answers through onCoreRequests().',
      ),
    );
  }

  /**
   * 登记 UI 侧 core 事件处理器。
   *
   * 必须在打开任何工作区之前调用：Connection 建立时把这份表（包一层 coreReady
   * 门禁）注册到自己的总线上；注册后再打开的 Connection 复用同一份表。
   */
  onCoreEvents(handlers: CoreEventHandlers): Unsubscribe {
    if (this.uiCoreEventHandlers) {
      throw new Error('Core event handlers already registered. onCoreEvents() must be called once.');
    }
    this.uiCoreEventHandlers = handlers;
    return () => {
      this.uiCoreEventHandlers = null;
    };
  }

  onCoreRequests(handlers: CoreRequestHandlers): void {
    if (this.uiCoreRequestHandlers) {
      throw new Error(
        'Core request handlers already registered. onCoreRequests() must be called once.',
      );
    }
    this.uiCoreRequestHandlers = handlers;
  }

  /**
   * UI → core：按载荷路由。
   * - `hostEnvironmentProvided`：推给所有 Connection（配置快照是 Client 级的）；
   * - `sessionWorkspaceAssigned`：按 workspacePath 找归属并登记会话，已有登记时以
   *   已登记的 Connection 为准（多工作区宿主里会话归属由宿主登记决定）；
   * - 其余带 sessionId 的事件：按会话路由。
   */
  emitToCore(event: UiEvent): void {
    if (event.type === 'hostEnvironmentProvided') {
      for (const connection of this.connections.values()) {
        connection.sendHostEnvironment(event);
      }
      return;
    }
    if (event.type === 'sessionWorkspaceAssigned') {
      const connection = this.routeSessionWorkspaceAssigned(event.sessionId, event.workspacePath);
      connection.emitToCore(event);
      return;
    }
    if (event.type === 'conversationSpaceCleared') {
      // 这个事件的 `sessionId` 是**对话空间目录名**，不是会话 id（`conversationSpaceCleared`
      // 的载荷约定，docs/architecture/events.md 第 2.3 节），
      // 不能走会话路由：目录名永远不是已登记的会话，多连接下 routeSession 会抛
      // 「查不到归属」。清空目标跟随**当前活动连接**——面板的空间统计就来自它
      // （`requestConversationSpaces` 同为无会话路由），两边看到的是同一个 core 的数据目录。
      const current = this.currentConnection();
      if (!current) {
        throw new Error('No Connection is open; cannot emit UiEvent.conversationSpaceCleared.');
      }
      current.emitToCore(event);
      return;
    }
    if ('sessionId' in event && typeof event.sessionId === 'string') {
      const connection = this.routeSession(event.sessionId);
      connection.emitToCore(event);
      if (event.type === 'conversationClosed') connection.closeSession(event.sessionId);
      return;
    }
    // 不带会话的事件（当前契约只有 hostEnvironmentProvided，已在上方处理）
    const current = this.currentConnection();
    if (!current) {
      throw new Error(`No Connection is open; cannot emit UiEvent.${event.type}.`);
    }
    current.emitToCore(event);
  }

  requestCore<T extends UiRequest['type']>(
    request: Extract<UiRequest, { type: T }>,
  ): Promise<UiRequestResultMap[T]> {
    const connection = this.connectionForRequest(request);
    if (!connection) {
      return Promise.reject(
        new Error(`No Connection can serve request(${request.type}).`),
      );
    }
    return connection.requestCore(request);
  }

  onUiEvent<T extends UiEvent['type']>(
    type: T,
    handler: (event: Extract<UiEvent, { type: T }>) => void,
  ): Unsubscribe {
    // Standalone 下 UiEvent 的消费方在 Core 进程内；这里保留本地注册表，
    // 与 StandaloneEventBus 的 onUiEvent 同一语义。
    let set = this.uiEventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.uiEventHandlers.set(type, set);
    }
    const wrapped = handler as (event: UiEvent) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  onUiRequests(handlers: UiRequestHandlers): void {
    if (this.uiRequestHandlers) {
      throw new Error('UI request handlers already registered. onUiRequests() must be called once.');
    }
    this.uiRequestHandlers = handlers;
  }

  // ===================== 路由内部 =====================

  private routeSession(sessionId: string): Connection {
    return this.connectionForSession(sessionId);
  }

  /**
   * `sessionWorkspaceAssigned` 的路由：会话已有归属时沿用（宿主按来源视图登记的
   * 归属优先于「当前活动工作目录」），否则按 workspacePath 找 Connection 并登记。
   */
  private routeSessionWorkspaceAssigned(
    sessionId: string,
    workspacePath: string | null,
  ): Connection {
    const existingId = this.sessionToConnection.get(sessionId);
    const existing = existingId ? this.connections.get(existingId) : undefined;
    if (existing) {
      if (
        workspacePath
        && existing.workspaceRef.scheme === 'file'
        && existing.workspaceRef.path
        && !sameWorkspace(existing.workspaceRef.path, workspacePath)
      ) {
        this.log(
          `[client] session ${sessionId} stays on connection ${existing.id} ` +
          `(${existing.displayPath()}); ignoring workspace assignment ${workspacePath}`,
        );
      }
      return existing;
    }
    if (workspacePath) {
      const byWorkspace = this.connectionForWorkspacePath(workspacePath);
      if (byWorkspace) {
        this.assignSessionToConnection(sessionId, byWorkspace);
        return byWorkspace;
      }
    }
    return this.connectionForSession(sessionId);
  }

  /**
   * 按工作区路径找 Connection（未打开返回 undefined）。
   *
   * 本地路径按宿主口径判等（大小写 / 尾分隔符）；远程路径是**目标机器上的字符串**，
   * 逐字比较——对远程路径跑本地规范化会把 `/home/pz/a` 变成 `D:\home\pz\a`，
   * 也可能把大小写不同的两个目录误判成同一个（`docs/core/client-connection.md` 第 4 节）。
   */
  private connectionForWorkspacePath(path: string): Connection | undefined {
    for (const connection of this.connections.values()) {
      const ref = connection.workspaceRef;
      if (!ref.path) continue;
      if (ref.scheme === 'file' ? sameWorkspace(ref.path, path) : ref.path === path) {
        return connection;
      }
    }
    return undefined;
  }

  /** requestCore 的路由：按请求携带的会话 / 工作区找归属，否则落到当前 Connection */
  private connectionForRequest(request: UiRequest): Connection | null {
    const sessionId = (request as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') {
      return this.connectionForSessionOrNull(sessionId);
    }
    if (request.type === 'conversationListRequested') {
      const workspacePath = request.workspacePath;
      if (workspacePath) {
        return this.connectionForWorkspacePath(workspacePath) ?? null;
      }
    }
    return this.currentConnection();
  }

  /**
   * 合并各 Connection 的会话运行时状态快照（按 Connection 建立顺序拼接）。
   *
   * Core 只推自己进程内的会话；多 Connection 下必须在这里合成一份全量，
   * 否则每个 Connection 的推送都会把 UI 缓存覆盖成只含自己那一份。
   */
  private mergeRuntimeStates(
    connectionId: string,
    states: readonly SessionRuntimeState[],
  ): readonly SessionRuntimeState[] {
    this.runtimeStatesByConnection.set(connectionId, states);
    const merged: SessionRuntimeState[] = [];
    for (const connection of this.connections.values()) {
      const connectionStates = this.runtimeStatesByConnection.get(connection.id);
      if (connectionStates) merged.push(...connectionStates);
    }
    return merged;
  }

  private connectionForSessionOrNull(sessionId: string): Connection | null {
    const id = this.sessionToConnection.get(sessionId);
    if (id) return this.connections.get(id) ?? null;
    if (this.connections.size === 1) {
      const only = [...this.connections.values()][0];
      this.sessionToConnection.set(sessionId, only.id);
      only.openSession(sessionId);
      return only;
    }
    return null;
  }
}
