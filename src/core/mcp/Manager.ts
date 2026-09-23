/**
 * MCP 管理器（进程级单例，引用计数模型）
 *
 * 职责：
 * - 维护每个 MCP server 进程，并以「会话引用集合」决定其生命周期
 * - 会话打开 / 启用列表变化 → acquire（引用 +1，幂等）
 * - 会话关闭 / 删除 → release（引用 -1）
 * - 引用归零后延迟 RECLAIM_GRACE_MS 再真正结束进程，容忍切换抖动与调用乱序
 * - 维护每个服务器的工具列表，并包装成内部 Tool，提供同步的 getTools()
 *
 * 引用绑定的是「会话被打开过」，而不是「会话当前是否活动」：
 * 切换对话不释放引用（VSCode 更是没有关闭对话的概念），只有会话真的消失
 * （Electron 关闭标签页 / 两个宿主删除对话 / 宿主退出）才 release。
 *
 * 所有 acquire / release / sync / prune 串行执行，避免并发造成进程重复启动或状态错乱。
 */

import { isRemoteServer, readMcpServers } from './Config.js';
import { McpStdioClient, type McpCallResult, type McpClient } from './Client.js';
import { McpHttpClient } from './HttpClient.js';
import { buildMcpToolName, createMcpTool } from './McpTool.js';
import type { Tool } from '../tools/Tool.js';
import type { McpServerInfo } from '../webviewTypes.js';
import { logger } from '../Logger.js';

/** 单个 MCP 服务器的运行时状态 */
export interface McpServerRuntimeStatus {
  running: boolean;
  toolCount: number;
  error: string | null;
  /** 当前引用该服务器的会话数 */
  refCount: number;
}

/** 引用归零后延迟回收的宽限期（毫秒） */
const RECLAIM_GRACE_MS = 1500;

/** 单个 MCP server 的运行时条目 */
interface McpServerRuntime {
  name: string;
  client: McpClient | null;
  /** 引用该服务器的会话 ID 集合（替代计数器，天然幂等） */
  refs: Set<string>;
  /** 是否使用远程（HTTP/SSE）传输 */
  remote: boolean;
  /** 期望的启动命令（来自最近一次同步；远程传输为空） */
  command: string[];
  /** 期望的环境变量（来自最近一次同步；远程传输为空） */
  environment: Record<string, string>;
  /** 期望的远程端点（来自最近一次同步；本地传输为空） */
  url: string;
  /** 期望的远程请求头（来自最近一次同步；本地传输为空） */
  headers: Record<string, string>;
  /** 期望的配置签名 */
  desiredSignature: string;
  /** 当前 client 实际对应的配置签名；空串表示尚未成功启动 */
  activeSignature: string;
  /** 启动中的 Promise，避免并发重复 spawn */
  starting: Promise<void> | null;
  /** 引用归零后的延迟回收定时器 */
  reclaimTimer: NodeJS.Timeout | null;
  error: string | null;
}

/** 把 string -> string 映射归一化为可比较的片段（key 排序，避免顺序影响签名） */
function mapSignature(map: Record<string, string>): string {
  return Object.keys(map)
    .sort()
    .map((key) => `${key}=${map[key]}`)
    .join('\u0001');
}

/** 判断两个字符串集合是否相等（元素相同，与顺序无关） */
function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** 把传输类型 + 命令 / 环境 / url / 请求头归一化为可比较的配置签名 */
function buildSignature(
  remote: boolean,
  command: string[],
  environment: Record<string, string>,
  url: string,
  headers: Record<string, string>,
): string {
  const transport = remote ? `remote\u0003${url}\u0003${mapSignature(headers)}` : 'local';
  return `${transport}\u0002${command.join('\u0001')}\u0002${mapSignature(environment)}`;
}

class McpManager {
  private servers = new Map<string, McpServerRuntime>();
  /** sessionId -> 该会话当前持有的 server 名集合，release 时据此精确回退 */
  private sessionRefs = new Map<string, Set<string>>();
  private tools: Tool[] = [];
  /** 暴露工具名 -> 所属 MCP server 名；用于按会话过滤（会话只保留自己启用的 server 的工具） */
  private toolServers = new Map<string, string>();
  /** 上次重建时的工具名签名，用于判断工具集合是否真的变化 */
  private toolsSignature = '';
  /** 所有状态变更串行执行 */
  private opChain: Promise<void> = Promise.resolve();

  /** 当前已连接 MCP 服务器的工具（同步，供 getAllTools 使用） */
  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * 只返回属于给定 server 集合的 MCP 工具。
   *
   * 进程是全局的（多个会话可能共享同一个 server），但「把哪些 MCP 工具暴露给某个
   * 会话的 LLM」必须按该会话的启用列表决定，否则 A 会话已取消勾选、却因为 B 会话
   * 仍启用而把该 MCP 工具发给 A。
   */
  getToolsForServers(enabledServers: ReadonlySet<string>): Tool[] {
    return this.tools.filter((tool) => {
      const server = this.toolServers.get(tool.name);
      return server !== undefined && enabledServers.has(server);
    });
  }

  /**
   * 会话打开：按该会话当前的启用列表建立引用（幂等）。
   * 重复调用同一 sessionId 不会重复计数。
   */
  acquire(sessionId?: string): Promise<void> {
    return this.enqueue(() => this.syncSessionInternal(sessionId));
  }

  /**
   * 会话启用列表变化（勾选 / 取消 / 默认值变更）：对该会话做差量同步。
   */
  syncSession(sessionId?: string): Promise<void> {
    return this.enqueue(() => this.syncSessionInternal(sessionId));
  }

  /**
   * 会话关闭 / 删除：释放该会话持有的全部引用。
   * 引用归零的 server 会进入延迟回收窗口。
   */
  release(sessionId?: string): Promise<void> {
    if (!sessionId) return Promise.resolve();
    return this.enqueue(() => this.releaseInternal(sessionId));
  }

  /**
   * 重新同步所有已注册会话（全局默认配置变化时使用）。
   */
  syncAllSessions(): Promise<void> {
    return this.enqueue(async () => {
      for (const sessionId of [...this.sessionRefs.keys()]) {
        await this.syncSessionInternal(sessionId);
      }
    });
  }

  /**
   * 启动时清理：不主动启动任何 server，只回收无引用的残留并重新对齐已注册会话。
   */
  prune(): Promise<void> {
    return this.enqueue(() => this.pruneInternal());
  }

  /**
   * @deprecated 旧接口，等价于 syncSession。新代码请使用 acquire / syncSession。
   */
  refresh(sessionId?: string): Promise<void> {
    return this.syncSession(sessionId);
  }

  /** 转发一次工具调用到对应服务器（进程崩溃后若仍有引用会自动重启） */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.servers.get(serverName)?.client?.isRunning()) {
      await this.enqueue(async () => {
        const runtime = this.servers.get(serverName);
        if (!runtime || runtime.refs.size === 0) return;
        if (runtime.client?.isRunning()) return;
        await this.ensureStarted();
        if (this.rebuildTools()) await this.invalidatePromptCaches();
      });
    }

    const client = this.servers.get(serverName)?.client ?? null;
    if (!client?.isRunning()) {
      const error = this.servers.get(serverName)?.error;
      throw new Error(`MCP server "${serverName}" 未运行${error ? `（${error}）` : ''}`);
    }
    return client.callTool(toolName, args);
  }

  /** 各服务器的运行时状态，供 UI 展示 */
  getServerStatus(): Map<string, McpServerRuntimeStatus> {
    const status = new Map<string, McpServerRuntimeStatus>();
    for (const [name, runtime] of this.servers) {
      status.set(name, {
        running: runtime.client?.isRunning() ?? false,
        toolCount: runtime.client?.getTools().length ?? 0,
        error: runtime.error,
        refCount: runtime.refs.size,
      });
    }
    return status;
  }

  /** 停止所有 MCP 进程（宿主退出时调用） */
  shutdown(): void {
    for (const [, runtime] of this.servers) {
      if (runtime.reclaimTimer) {
        clearTimeout(runtime.reclaimTimer);
        runtime.reclaimTimer = null;
      }
      runtime.client?.stop();
      runtime.client = null;
    }
    this.servers.clear();
    this.sessionRefs.clear();
    this.tools = [];
    this.toolServers.clear();
    this.toolsSignature = '';
  }

  // ── 内部实现 ────────────────────────────────────────────────

  /** 把一次状态变更排入串行链，保证不并发 */
  private enqueue(task: () => Promise<void> | void): Promise<void> {
    const run = async (): Promise<void> => {
      await task();
    };
    const next = this.opChain.then(run, run);
    // 保持链条不因单次失败而中断
    this.opChain = next.catch(() => {});
    return next;
  }

  /** 按该会话当前配置，差量调整其引用集合 */
  private async syncSessionInternal(sessionId?: string): Promise<void> {
    // 过滤空值与历史遗留的字符串 'undefined'，避免建立无效引用导致无法回收
    if (!sessionId || sessionId === 'undefined') return;

    let servers: McpServerInfo[];
    try {
      servers = await readMcpServers(sessionId);
    } catch (err) {
      logger.error('McpManager', `读取 MCP 配置失败: ${err}`);
      return;
    }

    const enabled = servers.filter((server) => server.enabled);
    const desired = new Map(enabled.map((server) => [server.name, server] as const));
    const prev = this.sessionRefs.get(sessionId) ?? new Set<string>();

    // 1. 释放该会话不再启用的 server
    for (const name of prev) {
      if (!desired.has(name)) this.detachRef(name, sessionId);
    }

    // 2. 新增 / 更新该会话启用的 server（含配置变更检测）
    for (const [name, info] of desired) {
      this.attachRef(name, sessionId, info);
    }

    // 该会话的启用集合是否发生变化：MCP 工具是「按会话」暴露给 LLM 的，
    // 即使进程因其它会话仍存活（全局工具集合不变），本会话也必须重新组装
    // prompt / 工具列表，否则会继续把已取消勾选的 MCP 工具发出去。
    const next = new Set(desired.keys());
    const sessionChanged = !sameStringSet(prev, next);
    this.sessionRefs.set(sessionId, next);

    // 3. 确保所有仍有引用的 server 都已启动
    await this.ensureStarted();

    // 4. 重建工具列表；只有工具集合真的变化时才清空 prompt 缓存
    if (this.rebuildTools()) {
      await this.invalidatePromptCaches();
    }

    // 5. 本会话启用集合变化：单独失效该会话的 prompt / 工具缓存。
    //    必须放在 rebuildTools 之外，因为进程可能被其它会话继续引用（全局工具未变）。
    if (sessionChanged) {
      await this.invalidateSessionPromptCache(sessionId);
    }
  }

  /** 释放该会话持有的全部引用 */
  private releaseInternal(sessionId: string): void {
    const refs = this.sessionRefs.get(sessionId);
    this.sessionRefs.delete(sessionId);
    if (!refs || refs.size === 0) return;

    logger.info('McpManager', `释放会话 ${sessionId} 的 ${refs.size} 个 MCP 引用`);
    for (const name of refs) {
      this.detachRef(name, sessionId);
    }
  }

  /** 给某会话增加对某个 server 的引用，并更新期望配置 */
  private attachRef(name: string, sessionId: string, info: McpServerInfo): void {
    const remote = isRemoteServer(info);
    const signature = buildSignature(remote, info.command, info.environment, info.url, info.headers);
    let runtime = this.servers.get(name);

    if (!runtime) {
      runtime = {
        name,
        client: null,
        refs: new Set<string>(),
        remote,
        command: info.command,
        environment: info.environment,
        url: info.url,
        headers: info.headers,
        desiredSignature: signature,
        activeSignature: '',
        starting: null,
        reclaimTimer: null,
        error: null,
      };
      this.servers.set(name, runtime);
    } else {
      runtime.remote = remote;
      runtime.command = info.command;
      runtime.environment = info.environment;
      runtime.url = info.url;
      runtime.headers = info.headers;
      runtime.desiredSignature = signature;
    }

    // 宽限期内被重新引用：取消回收
    if (runtime.reclaimTimer) {
      clearTimeout(runtime.reclaimTimer);
      runtime.reclaimTimer = null;
      logger.info('McpManager', `MCP "${name}" 在回收宽限期内被重新引用，保留进程`);
    }

    runtime.refs.add(sessionId);
  }

  /** 移除某会话对某个 server 的引用，归零时安排延迟回收 */
  private detachRef(name: string, sessionId: string): void {
    const runtime = this.servers.get(name);
    if (!runtime) return;

    runtime.refs.delete(sessionId);
    if (runtime.refs.size === 0) {
      this.scheduleReclaim(name);
    }
  }

  /** 引用归零：延迟 RECLAIM_GRACE_MS 后回收，容忍切换抖动 */
  private scheduleReclaim(name: string): void {
    const runtime = this.servers.get(name);
    if (!runtime) return;

    if (runtime.reclaimTimer) clearTimeout(runtime.reclaimTimer);
    logger.info('McpManager', `MCP "${name}" 引用归零，${RECLAIM_GRACE_MS}ms 后回收`);
    runtime.reclaimTimer = setTimeout(() => {
      runtime.reclaimTimer = null;
      void this.enqueue(() => this.reclaimInternal(name)).catch(() => {});
    }, RECLAIM_GRACE_MS);
  }

  /** 真正停止引用归零的 server 进程 */
  private async reclaimInternal(name: string): Promise<void> {
    const runtime = this.servers.get(name);
    if (!runtime) return;
    // 宽限期内又被引用：不回收
    if (runtime.refs.size > 0) return;

    // 仍在启动中：等它结束（可能刚启动完就被释放）
    if (runtime.starting) {
      await runtime.starting.catch(() => {});
      if (runtime.refs.size > 0) return;
    }

    if (runtime.client) {
      logger.info('McpManager', `停止 MCP "${name}"（引用归零）`);
      runtime.client.stop();
      runtime.client = null;
    }
    runtime.activeSignature = '';
    runtime.error = null;
    this.servers.delete(name);

    if (this.rebuildTools()) {
      await this.invalidatePromptCaches();
    }
  }

  /** 启动所有仍有引用但尚未运行的 server */
  private async ensureStarted(): Promise<void> {
    for (const runtime of [...this.servers.values()]) {
      if (runtime.refs.size === 0) continue;

      if (runtime.starting) {
        await runtime.starting.catch(() => {});
        continue;
      }

      if (runtime.client?.isRunning() && runtime.activeSignature === runtime.desiredSignature) {
        continue;
      }

      await this.startRuntime(runtime);
    }
  }

  /** 启动单个 server；配置变化或进程已退出时会先停掉旧进程再重启 */
  private async startRuntime(runtime: McpServerRuntime): Promise<void> {
    if (runtime.client) {
      runtime.client.stop();
      runtime.client = null;
    }
    runtime.activeSignature = '';
    // 新一轮启动开始：清掉上一次的失败信息，让 UI 显示「连接中」而不是旧的「连接失败」
    runtime.error = null;

    // 记录本次启动实际使用的配置签名：启动期间 desiredSignature 可能被后续同步改写，
    // 若直接读 runtime.desiredSignature 会把「用旧配置启动的进程」误标为新配置。
    const startSignature = runtime.desiredSignature;

    const client: McpClient = runtime.remote
      ? new McpHttpClient(runtime.name, runtime.url, runtime.headers)
      : new McpStdioClient(runtime.name, runtime.command, runtime.environment);
    // 连接意外断开时保留引用集合，等待下次 ensureStarted / callTool 重启
    client.onExit = (reason) => {
      logger.info(
        'McpManager',
        `MCP "${runtime.name}" 连接已断开${reason ? `（${reason}）` : ''}，保留 ${runtime.refs.size} 个引用`,
      );
    };
    runtime.client = client;

    const task = (async (): Promise<void> => {
      try {
        await client.start();
        runtime.activeSignature = startSignature;
        runtime.error = null;
        logger.info('McpManager', `MCP "${runtime.name}" 已连接，发现 ${client.getTools().length} 个工具`);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        runtime.error = message;
        logger.error('McpManager', `MCP "${runtime.name}" 启动失败: ${message}`);
        client.stop();
        if (runtime.client === client) runtime.client = null;
        runtime.activeSignature = '';
      }
    })();

    runtime.starting = task;
    try {
      await task;
    } finally {
      if (runtime.starting === task) runtime.starting = null;
    }
  }

  /** 启动时清理：重新对齐已注册会话，并回收无引用的残留 */
  private async pruneInternal(): Promise<void> {
    for (const sessionId of [...this.sessionRefs.keys()]) {
      await this.syncSessionInternal(sessionId);
    }

    for (const [name, runtime] of [...this.servers]) {
      if (runtime.refs.size > 0 || runtime.starting || runtime.reclaimTimer) continue;
      this.scheduleReclaim(name);
    }
  }

  /**
   * 清空各会话引擎的 system prompt / 工具缓存。
   *
   * 用动态 import 引入 QueryEngine，避免 Manager 与 QueryEngine 之间形成
   * 模块初始化环（QueryEngine -> tools/index -> Manager）。
   */
  private async invalidatePromptCaches(): Promise<void> {
    try {
      const { invalidateAllPromptCaches } = await import('../QueryEngine.js');
      invalidateAllPromptCaches();
    } catch (err) {
      logger.error('McpManager', `清空 prompt 缓存失败: ${err}`);
    }
  }

  /**
   * 只清空指定会话引擎的 system prompt / 工具缓存。
   * 用于「该会话的 MCP 启用列表变化，但进程被其它会话继续引用」的场景。
   */
  private async invalidateSessionPromptCache(sessionId: string): Promise<void> {
    try {
      const { invalidateSessionPromptCache } = await import('../QueryEngine.js');
      invalidateSessionPromptCache(sessionId);
    } catch (err) {
      logger.error('McpManager', `清空会话 ${sessionId} 的 prompt 缓存失败: ${err}`);
    }
  }

  /** 重建工具列表；返回工具集合是否发生变化 */
  private rebuildTools(): boolean {
    const tools: Tool[] = [];
    const toolServers = new Map<string, string>();
    const routes = new Map<string, { server: string; tool: string }>();

    for (const [serverName, runtime] of this.servers) {
      const client = runtime.client;
      if (!client?.isRunning()) continue;
      for (const def of client.getTools()) {
        const exposedName = buildMcpToolName(serverName, def.name);
        if (routes.has(exposedName)) {
          logger.warn('McpManager', `工具名冲突，跳过 ${exposedName}`);
          continue;
        }
        routes.set(exposedName, { server: serverName, tool: def.name });
        toolServers.set(exposedName, serverName);
        tools.push(
          createMcpTool(serverName, exposedName, def, (toolName, args) =>
            this.callTool(serverName, toolName, args),
          ),
        );
      }
    }

    const signature = tools.map((tool) => tool.name).join('|');
    const changed = signature !== this.toolsSignature;
    this.tools = tools;
    this.toolServers = toolServers;
    this.toolsSignature = signature;
    return changed;
  }
}

let manager: McpManager | null = null;

/** 获取 MCP 管理器单例 */
export function getMcpManager(): McpManager {
  if (!manager) {
    manager = new McpManager();
  }
  return manager;
}

/**
 * 同步获取当前已连接的 MCP 工具。
 * 管理器尚未创建（从未 acquire）时返回空数组，避免无谓的初始化。
 */
export function getMcpTools(): Tool[] {
  return manager ? manager.getTools() : [];
}

/**
 * 同步获取「某个会话启用的 server」对应的 MCP 工具。
 *
 * 与 getMcpTools 的区别：后者返回进程内全部已连接 MCP 工具（全局），
 * 本函数按会话启用集合过滤，供 QueryEngine / Query 组装某会话的请求时使用，
 * 避免把别的会话启用的 MCP 工具发给当前会话。
 */
export function getMcpToolsForServers(enabledServers: ReadonlySet<string>): Tool[] {
  return manager ? manager.getToolsForServers(enabledServers) : [];
}
