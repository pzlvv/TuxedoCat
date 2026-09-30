/**
 * MCP 客户端公共契约 + stdio 客户端
 *
 * stdio 通过子进程的 stdin/stdout，以「每行一个 JSON-RPC 2.0 消息」的方式与
 * MCP 服务器通信；远程传输（Streamable HTTP / 旧版 SSE）见 HttpClient.ts。
 * 两者都实现 McpClient，管理器据此统一驱动。
 *
 * 只实现本项目需要的最小能力集：
 *   - initialize / notifications/initialized 握手
 *   - tools/list（支持 nextCursor 分页）
 *   - tools/call
 *
 * 服务器反向发来的请求（sampling / roots 等）一律以 method-not-found 回绝，
 * 避免服务器因等待响应而阻塞。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../Logger.js';
import { EXTENSION_NAME } from '../../config/project.js';

/** MCP 服务器返回的工具定义 */
export interface McpToolDefinition {
  name: string;
  description?: string;
  /** 参数 JSON Schema（原样透传给 LLM） */
  inputSchema?: Record<string, unknown>;
  /** MCP 工具注解（readOnlyHint / destructiveHint 等） */
  annotations?: Record<string, unknown>;
}

/** tools/call 的结果 */
export interface McpCallResult {
  /** 展平后的文本输出 */
  text: string;
  /** 服务器是否标记为错误 */
  isError: boolean;
}

/** JSON-RPC 错误体 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 一条 JSON-RPC 2.0 消息 */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * MCP 客户端公共契约：stdio 与 HTTP/SSE 传输都实现它，
 * 管理器无需关心底层传输差异。
 */
export interface McpClient {
  readonly name: string;
  /** 连接意外断开时的回调；主动 stop() 不触发 */
  onExit: ((reason: string | null) => void) | null;
  getTools(): McpToolDefinition[];
  isRunning(): boolean;
  getExitReason(): string | null;
  isInitialized(): boolean;
  /** 建立连接并完成 initialize 握手 + tools/list */
  start(): Promise<void>;
  /** 主动断开连接 */
  stop(): void;
  /** 调用某个工具 */
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 与服务器协商的协议版本（stdio 固定使用；HTTP 以服务器返回为准） */
export const PROTOCOL_VERSION = '2024-11-05';
/** 握手 / 列表类请求超时 */
export const CONTROL_TIMEOUT_MS = 30_000;
/** tools/call 超时（工具可能耗时较长） */
export const CALL_TIMEOUT_MS = 300_000;

/** 把一条 JSON-RPC 响应解析为工具列表（含分页），供各传输复用 */
export async function listMcpTools(
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>,
): Promise<McpToolDefinition[]> {
  const collected: McpToolDefinition[] = [];
  let cursor: string | undefined;

  // 分页拉取，最多 50 页防御服务器返回环状 cursor
  for (let page = 0; page < 50; page++) {
    const result = await request('tools/list', cursor ? { cursor } : {}, CONTROL_TIMEOUT_MS);
    const asRecord = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
    const tools = Array.isArray(asRecord.tools) ? asRecord.tools : [];
    for (const raw of tools) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.name !== 'string' || !item.name) continue;
      collected.push({
        name: item.name,
        description: typeof item.description === 'string' ? item.description : undefined,
        inputSchema: item.inputSchema && typeof item.inputSchema === 'object'
          ? (item.inputSchema as Record<string, unknown>)
          : undefined,
        annotations: item.annotations && typeof item.annotations === 'object'
          ? (item.annotations as Record<string, unknown>)
          : undefined,
      });
    }
    const nextCursor = asRecord.nextCursor;
    if (typeof nextCursor !== 'string' || !nextCursor) break;
    cursor = nextCursor;
  }

  return collected;
}

/** 把 tools/call 的返回展平为文本，供各传输复用 */
export function normalizeMcpCallResult(result: unknown): McpCallResult {
  const asRecord = (result ?? {}) as { content?: unknown; isError?: unknown };
  const isError = asRecord.isError === true;
  const blocks = Array.isArray(asRecord.content) ? asRecord.content : [];
  const parts: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push(`[image ${typeof item.mimeType === 'string' ? item.mimeType : 'unknown'}]`);
    } else if (item.type === 'resource') {
      const resource = item.resource as Record<string, unknown> | undefined;
      if (resource && typeof resource.text === 'string') parts.push(resource.text);
      else parts.push(`[resource ${typeof resource?.uri === 'string' ? resource.uri : 'unknown'}]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }

  // 没有标准 content 时兜底序列化整个结果，避免返回空内容触发上游 "empty content" 报错
  const text = parts.length > 0 ? parts.join('\n') : JSON.stringify(result ?? null);
  return { text, isError };
}

/**
 * Windows cmd 下对单个参数加引号。
 *
 * Node 在 shell:true 时把参数直接拼接后交给 cmd.exe，含空格的路径（如
 * C:\Program Files\...）必须自行加引号，否则会被拆成多个参数。
 */
export function quoteWindowsArg(value: string): string {
  if (value === '') return '""';
  if (!/[\s"&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export class McpStdioClient implements McpClient {
  readonly name: string;
  private readonly command: string[];
  private readonly environment: Record<string, string>;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private tools: McpToolDefinition[] = [];
  private running = false;
  private initialized = false;
  /** 进程退出原因，供上层展示 */
  private exitReason: string | null = null;

  /**
   * 进程意外退出（崩溃 / 被 kill）时的回调。
   * 主动 stop() 不会触发；上层据此保留引用集合，等待下次重启。
   */
  onExit: ((reason: string | null) => void) | null = null;

  constructor(name: string, command: string[], environment: Record<string, string> = {}) {
    this.name = name;
    this.command = command;
    this.environment = environment;
  }

  getTools(): McpToolDefinition[] {
    return this.tools;
  }

  isRunning(): boolean {
    return this.running;
  }

  getExitReason(): string | null {
    return this.exitReason;
  }

  /**
   * 启动子进程并完成 initialize 握手 + tools/list。
   * 任一步失败都会清理进程并抛错。
   */
  async start(): Promise<void> {
    if (this.running) return;

    const [cmd, ...args] = this.command;
    if (!cmd) {
      throw new Error(`MCP server "${this.name}" 的 command 为空`);
    }

    this.exitReason = null;

    const spawnEnv = { ...process.env, ...this.environment };

    // Windows 下 uvx / npx 等常见是 .cmd 包装脚本，必须经 shell 才能解析。
    // 这里传入拼接好的单条命令字符串（而不是 shell:true + args 数组）：
    //   - 避免 Node 对「shell + args」组合的 DEP0190 弃用警告
    //   - 由 quoteWindowsArg 负责含空格路径的引号
    // 非 Windows 直接 exec，不做 shell 解释。
    const child = (process.platform === 'win32'
      ? spawn(this.command.map(quoteWindowsArg).join(' '), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv,
          shell: true,
          windowsHide: true,
        })
      : spawn(cmd, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv,
          windowsHide: true,
        })) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.running = true;
    this.initialized = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) logger.info('McpClient', `[${this.name}] stderr: ${text}`);
    });

    child.on('error', (err) => {
      logger.error('McpClient', `[${this.name}] 进程错误: ${err.message}`);
      this.exitReason = err.message;
      this.handleExit();
    });

    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      logger.info('McpClient', `[${this.name}] 进程退出 (${reason})`);
      if (this.running) this.exitReason = reason;
      this.handleExit();
    });

    try {
      await this.initialize();
      this.tools = await this.listTools();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stop();
      // 带上 command，便于用户在菜单里直接看出是哪个 MCP 起不来
      throw new Error(`启动 MCP server "${this.name}" (${this.command.join(' ')}) 失败: ${message}`);
    }
  }

  /** 停止子进程。Windows 下连同子进程树一起结束，避免留下孤儿进程 */
  stop(): void {
    this.running = false;
    this.initialized = false;
    const child = this.child;
    this.child = null;
    this.rejectAllPending(new Error(`MCP server "${this.name}" 已停止`));

    if (!child || child.killed) return;

    if (process.platform === 'win32' && typeof child.pid === 'number') {
      try {
        // shell:true 时 child 是 cmd.exe，直接 kill 不会结束真正的服务器进程
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch (err) {
        logger.error('McpClient', `[${this.name}] taskkill 失败: ${err}`);
      }
    }

    try {
      child.kill();
    } catch {
      // 进程可能已退出，忽略
    }
  }

  /** 调用某个工具 */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.running) {
      throw new Error(`MCP server "${this.name}" 未运行${this.exitReason ? `（${this.exitReason}）` : ''}`);
    }
    const result = await this.sendRequest('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT_MS);
    return normalizeMcpCallResult(result);
  }

  // ── 内部实现 ────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    await this.sendRequest(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: EXTENSION_NAME, version: '1.0.0' },
      },
      CONTROL_TIMEOUT_MS,
    );
    // 握手完成的确认通知（无 id，不需要响应）
    this.sendNotification('notifications/initialized');
    this.initialized = true;
  }

  private listTools(): Promise<McpToolDefinition[]> {
    return listMcpTools((method, params, timeoutMs) => this.sendRequest(method, params, timeoutMs));
  }

  private sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.name}" 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error(`MCP server "${this.name}" 的 stdin 不可写`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      logger.info('McpClient', `[${this.name}] 忽略非 JSON 输出: ${line.slice(0, 200)}`);
      return;
    }

    // 服务器反向请求：回绝，避免其一直等待
    if (message.method && message.id !== undefined && message.id !== null) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
      return;
    }

    // 通知：无需处理
    if (message.method && (message.id === undefined || message.id === null)) {
      return;
    }

    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(`MCP 错误 ${message.error.code}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleExit(): void {
    const wasRunning = this.running;
    this.running = false;
    this.initialized = false;
    this.child = null;
    if (wasRunning) {
      this.rejectAllPending(new Error(`MCP server "${this.name}" 进程已退出`));
      try {
        this.onExit?.(this.exitReason);
      } catch (err) {
        logger.error('McpClient', `[${this.name}] onExit 回调失败: ${err}`);
      }
    }
  }

  /** 是否已完成 initialize 握手 */
  isInitialized(): boolean {
    return this.initialized;
  }
}
