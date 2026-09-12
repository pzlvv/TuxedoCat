/**
 * MCP 远程客户端（HTTP 传输）
 *
 * 支持两种远程传输，二者共用同一个 JSON-RPC 能力集：
 *
 *   1. Streamable HTTP（协议 2025-03-26 / 2025-06-18）
 *      - 每个 JSON-RPC 请求都是一次独立的 POST
 *      - 响应可能是 application/json，也可能是 text/event-stream（SSE）
 *      - initialize 的响应头 Mcp-Session-Id 需在后续请求中回传
 *      - 握手后的请求需带 MCP-Protocol-Version 头
 *
 *   2. 旧版 HTTP+SSE（协议 2024-11-05）
 *      - 先 GET 建立 SSE 长连接，服务器以 `event: endpoint` 下发 POST 地址
 *      - 请求经 POST 发出，响应从 SSE 长连接上回流
 *
 * 连接时先按 Streamable HTTP 握手，失败后自动回退旧版 SSE —— 用户只需在
 * mcp.json 里写 `"type": "remote"` + `"url"`，无需关心服务器实现哪一版。
 */

import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import {
  CALL_TIMEOUT_MS,
  CONTROL_TIMEOUT_MS,
  PROTOCOL_VERSION,
  listMcpTools,
  normalizeMcpCallResult,
  type JsonRpcMessage,
  type McpCallResult,
  type McpClient,
  type McpToolDefinition,
} from './Client.js';
import { logger } from '../Logger.js';

/** 一次待响应的请求（旧版 SSE 模式下响应从长连接回流） */
interface PendingRequest {
  resolve: (value: JsonRpcMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** 解析出的 SSE 事件 */
interface SseEvent {
  event: string;
  data: string;
}

/** 拆出完整的 SSE 事件块（以空行分隔），返回事件列表与残留 buffer */
function drainSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let index = buffer.indexOf('\n\n');
  while (index >= 0) {
    const block = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    const event = parseSseBlock(block);
    if (event) events.push(event);
    index = buffer.indexOf('\n\n');
  }
  return { events, rest: buffer };
}

/** 解析单个 SSE 事件块（多行 data 用 \n 拼接） */
function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 把 SSE 的 data 字段解析为 JSON-RPC 消息，非 JSON 时返回 null */
function parseSseData(data: string): JsonRpcMessage | null {
  const text = data.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as JsonRpcMessage;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export class McpHttpClient implements McpClient {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  private tools: McpToolDefinition[] = [];
  private running = false;
  private initialized = false;
  /** initialize 是否已完成（决定后续请求是否回传协议版本头） */
  private handshakeDone = false;
  private exitReason: string | null = null;

  /** 实际协商到的协议版本（initialize 响应为准） */
  private protocolVersion = PROTOCOL_VERSION;
  /** Streamable HTTP 会话 ID（initialize 响应头下发） */
  private sessionId: string | null = null;
  /** 旧版 SSE 模式下用于发送请求的端点（endpoint 事件下发） */
  private legacyEndpoint: string | null = null;
  /** 旧版 SSE 长连接的中止控制器 */
  private sseAbort: AbortController | null = null;
  /** 等待 endpoint 事件期间的 resolve / reject（跨方法共享） */
  private endpointResolve: ((endpoint: string) => void) | null = null;
  private endpointReject: ((err: Error) => void) | null = null;
  /** 进行中的请求（仅旧版 SSE 模式使用；Streamable 模式为独立 POST） */
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  /** 传输模式，connect() 期间确定 */
  private mode: 'streamable' | 'legacy' = 'streamable';

  /**
   * 连接意外断开（SSE 长连接中断等）时的回调。
   * 主动 stop() 不会触发；上层据此保留引用集合，等待下次重启。
   */
  onExit: ((reason: string | null) => void) | null = null;

  constructor(name: string, url: string, headers: Record<string, string> = {}) {
    this.name = name;
    this.url = url;
    this.headers = headers;
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

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 建立连接并完成 initialize 握手 + tools/list。
   * 先试 Streamable HTTP，失败后回退旧版 SSE；两种都失败则抛错。
   */
  async start(): Promise<void> {
    if (this.running) return;

    if (!this.url) {
      throw new Error(`MCP server "${this.name}" 缺少 url`);
    }
    try {
      // 提前校验，避免非法地址在 fetch 阶段抛出难以理解的错误
      new URL(this.url);
    } catch {
      throw new Error(`MCP server "${this.name}" 的 url 非法: ${this.url}`);
    }

    this.exitReason = null;
    this.running = true;
    this.initialized = false;

    let streamableError: Error | null = null;
    try {
      await this.connectStreamable();
      this.mode = 'streamable';
      this.initialized = true;
      return;
    } catch (err) {
      streamableError = err instanceof Error ? err : new Error(String(err));
      logger.info(
        'McpHttpClient',
        `[${this.name}] Streamable HTTP 握手失败，回退旧版 SSE: ${streamableError.message}`,
      );
      this.resetTransientState();
    }

    try {
      await this.connectLegacy();
      this.mode = 'legacy';
      this.initialized = true;
    } catch (err) {
      const legacyError = err instanceof Error ? err : new Error(String(err));
      this.stop();
      throw new Error(
        `启动 MCP server "${this.name}" (${this.url}) 失败: `
        + `Streamable HTTP: ${streamableError.message}；旧版 SSE: ${legacyError.message}`,
      );
    }
  }

  /** 主动断开连接（中止 SSE 长连接、拒绝所有在途请求） */
  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    this.initialized = false;

    if (this.sseAbort) {
      try {
        this.sseAbort.abort();
      } catch {
        // 忽略
      }
      this.sseAbort = null;
    }
    this.handshakeDone = false;
    this.endpointResolve = null;
    this.endpointReject = null;
    this.rejectAllPending(new Error(`MCP server "${this.name}" 已停止`));

    // Streamable HTTP 建议用 DELETE 主动结束会话，best-effort 即可
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.legacyEndpoint = null;
    if (wasRunning && sessionId) {
      void this.deleteSession(sessionId).catch(() => {});
    }
  }

  /** 调用某个工具 */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.running) {
      throw new Error(`MCP server "${this.name}" 未运行${this.exitReason ? `（${this.exitReason}）` : ''}`);
    }
    const result = await this.rpc('tools/call', { name: toolName, arguments: args }, CALL_TIMEOUT_MS);
    return normalizeMcpCallResult(result);
  }

  // ── 连接流程 ────────────────────────────────────────────────

  /** Streamable HTTP：POST initialize → POST initialized 通知 → tools/list */
  private async connectStreamable(): Promise<void> {
    this.mode = 'streamable';
    const initResult = await this.rpc('initialize', this.initializeParams(), CONTROL_TIMEOUT_MS);
    this.applyInitializeResult(initResult);
    this.handshakeDone = true;
    await this.notify('notifications/initialized');
    this.tools = await listMcpTools((m, p, t) => this.rpc(m, p, t));
  }

  /** 旧版 SSE：GET 建流拿 endpoint → POST initialize → 通知 → tools/list */
  private async connectLegacy(): Promise<void> {
    this.mode = 'legacy';
    this.legacyEndpoint = await this.openLegacySse();
    const initResult = await this.rpc('initialize', this.initializeParams(), CONTROL_TIMEOUT_MS);
    this.applyInitializeResult(initResult);
    this.handshakeDone = true;
    await this.notify('notifications/initialized');
    this.tools = await listMcpTools((m, p, t) => this.rpc(m, p, t));
  }

  private initializeParams(): Record<string, unknown> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tuxedo-cat', version: '1.0.0' },
    };
  }

  private applyInitializeResult(result: unknown): void {
    const info = (result ?? {}) as { protocolVersion?: unknown };
    if (typeof info.protocolVersion === 'string' && info.protocolVersion) {
      this.protocolVersion = info.protocolVersion;
    }
  }

  /** 切换传输前清理上一轮尝试留下的状态 */
  private resetTransientState(): void {
    this.sessionId = null;
    this.legacyEndpoint = null;
    this.handshakeDone = false;
    this.endpointResolve = null;
    this.endpointReject = null;
    this.rejectAllPending(new Error(`MCP server "${this.name}" 传输回退`));
    if (this.sseAbort) {
      try {
        this.sseAbort.abort();
      } catch {
        // 忽略
      }
      this.sseAbort = null;
    }
  }

  // ── JSON-RPC 收发 ────────────────────────────────────────────

  /** 发送带 id 的请求，返回 result（error 时抛错） */
  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const response = this.mode === 'legacy'
      ? await this.requestLegacy(message, timeoutMs)
      : await this.requestStreamable(message, timeoutMs);

    if (!response) {
      throw new Error(`MCP server "${this.name}" 对 ${method} 未返回响应`);
    }
    if (response.error) {
      throw new Error(`MCP 错误 ${response.error.code}: ${response.error.message}`);
    }
    return response.result;
  }

  /** 发送通知（无 id，服务器不返回结果体） */
  private async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    if (this.mode === 'legacy') {
      await this.postLegacy(message);
    } else {
      await this.requestStreamable(message, CONTROL_TIMEOUT_MS);
    }
  }

  /** Streamable HTTP：独立 POST，响应可能直接是 JSON，也可能是 SSE 流 */
  private async requestStreamable(message: JsonRpcMessage, timeoutMs: number): Promise<JsonRpcMessage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await undiciFetch(this.url, {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      return await this.readStreamableResponse(response, message.id ?? null);
    } catch (err) {
      throw this.wrapNetworkError(err, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStreamableResponse(
    response: UndiciResponse,
    expectId: number | string | null,
  ): Promise<JsonRpcMessage | null> {
    // 202 Accepted：通知已受理，没有响应体
    if (response.status === 202 || response.status === 204) return null;

    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
      return await this.readSseForResponse(response, expectId);
    }

    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as JsonRpcMessage;
    } catch {
      throw new Error(`无法解析 MCP 响应: ${text.slice(0, 300)}`);
    }
  }

  /** 读取 POST 返回的 SSE 流，取到 id 匹配的消息后即可返回 */
  private async readSseForResponse(
    response: UndiciResponse,
    expectId: number | string | null,
  ): Promise<JsonRpcMessage | null> {
    const body = response.body;
    if (!body) return null;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        const { events, rest } = drainSseEvents(buffer);
        buffer = rest;
        for (const event of events) {
          const message = parseSseData(event.data);
          if (!message) continue;
          if (expectId === null) return message;
          if (String(message.id) === String(expectId)) return message;
        }
      }
    } catch (err) {
      throw this.wrapNetworkError(err, 0);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 流可能已结束，忽略
      }
    }
    return null;
  }

  /** 旧版 SSE：POST 到 endpoint，等待长连接回流的响应 */
  private requestLegacy(message: JsonRpcMessage, timeoutMs: number): Promise<JsonRpcMessage> {
    const id = message.id as number;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.name}" 请求 ${message.method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      void this.postLegacy(message).catch((err: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** 旧版 SSE：把消息 POST 到 endpoint（结果走长连接，不在此处读取） */
  private async postLegacy(message: JsonRpcMessage): Promise<void> {
    const endpoint = this.legacyEndpoint;
    if (!endpoint) {
      throw new Error(`MCP server "${this.name}" 的 SSE endpoint 尚未就绪`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
    try {
      const response = await undiciFetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
      }
      // 通知类请求（无 id）服务器可能返回 202 空体，直接丢弃响应体
      try {
        await response.body?.cancel();
      } catch {
        // 忽略
      }
    } catch (err) {
      throw this.wrapNetworkError(err, CONTROL_TIMEOUT_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 构造 Streamable HTTP 请求头 */
  private buildHeaders(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (json) headers['Content-Type'] = 'application/json';
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    // 2025-03-26 起要求 initialize 之后的请求回传协议版本；旧版服务器不认识该头，直接不发
    if (this.handshakeDone && !this.protocolVersion.startsWith('2024')) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }
    return headers;
  }

  /** 尽力结束 Streamable HTTP 会话，失败不影响调用方 */
  private async deleteSession(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      await undiciFetch(this.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': sessionId, ...this.headers },
        signal: controller.signal,
      });
    } catch {
      // 服务器不支持 DELETE 时会返回 405 或直接断连，忽略
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 旧版 SSE 长连接 ──────────────────────────────────────────

  /** 建立 SSE 长连接，返回服务器下发的 POST endpoint */
  private async openLegacySse(): Promise<string> {
    const controller = new AbortController();
    this.sseAbort = controller;

    const endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
    const timer = setTimeout(() => {
      this.endpointReject?.(
        new Error(`MCP server "${this.name}" 未在 ${CONTROL_TIMEOUT_MS}ms 内下发 SSE endpoint 事件`),
      );
    }, CONTROL_TIMEOUT_MS);

    try {
      const response = await undiciFetch(this.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...this.headers },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new Error(`SSE 连接失败: HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      void this.consumeLegacySse(response);
      return await endpointPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 后台消费 SSE 长连接：endpoint 事件 → 就绪；message 事件 → 派发响应 */
  private async consumeLegacySse(response: UndiciResponse): Promise<void> {
    const body = response.body;
    if (!body) return;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');

        const { events, rest } = drainSseEvents(buffer);
        buffer = rest;
        for (const event of events) this.handleLegacySseEvent(event);
      }
      if (this.running && this.mode === 'legacy') {
        this.failLegacy('SSE 连接已关闭');
      }
    } catch (err) {
      if (!this.running) return;
      const message = err instanceof Error ? err.message : String(err);
      this.failLegacy(`SSE 连接中断: ${message}`);
    }
  }

  private handleLegacySseEvent(event: SseEvent): void {
    if (event.event === 'endpoint') {
      const raw = event.data.trim();
      if (!raw) return;
      let endpoint: string;
      try {
        endpoint = new URL(raw, this.url).toString();
      } catch {
        this.failLegacy(`SSE endpoint 非法: ${raw}`);
        return;
      }
      this.legacyEndpoint = endpoint;
      this.endpointResolve?.(endpoint);
      this.endpointResolve = null;
      this.endpointReject = null;
      return;
    }

    const message = parseSseData(event.data);
    if (!message) return;

    // 服务器反向请求：回绝，避免其一直等待
    if (message.method && message.id !== undefined && message.id !== null) {
      void this.postLegacy({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      }).catch(() => {});
      return;
    }

    // 通知：无需处理
    if (message.id === undefined || message.id === null) return;

    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  /** SSE 连接不可用：标记退出并回调上层 */
  private failLegacy(reason: string): void {
    this.endpointReject?.(new Error(reason));
    this.endpointResolve = null;
    this.endpointReject = null;

    const wasRunning = this.running;
    this.exitReason = reason;
    this.running = false;
    this.initialized = false;
    this.handshakeDone = false;
    this.rejectAllPending(new Error(`MCP server "${this.name}" ${reason}`));
    if (wasRunning) {
      try {
        this.onExit?.(reason);
      } catch (err) {
        logger.error('McpHttpClient', `[${this.name}] onExit 回调失败: ${err}`);
      }
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** 把 fetch 抛出的网络/超时错误整理成可读信息 */
  private wrapNetworkError(err: unknown, timeoutMs: number): Error {
    if (err instanceof Error) {
      if (err.name === 'AbortError' || /aborted/i.test(err.message)) {
        return timeoutMs > 0
          ? new Error(`MCP server "${this.name}" 请求超时（${timeoutMs}ms）`)
          : new Error(`MCP server "${this.name}" 请求已被中止`);
      }
      return new Error(`MCP server "${this.name}" 网络错误: ${err.message}`);
    }
    return new Error(`MCP server "${this.name}" 网络错误: ${String(err)}`);
  }
}
