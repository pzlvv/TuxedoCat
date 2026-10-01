/**
 * `mcp.json` 的纯解析：把磁盘上的原始 JSON 规范化为服务器定义列表。
 *
 * 只做纯函数、不做 I/O：文件读取归 UI（`src/host/SettingsStore.ts`），Core 侧从配置
 * 快照读取结果（`docs/core-ui-separation.md` 第 4.7 节）。解析失败一律返回空列表，
 * 不抛错——这是 UI 侧行为，Core 不参与。
 */

/** 一个 MCP 服务器定义（来自 `mcp.json`；不含启用状态与运行时字段） */
export interface McpServerDefinition {
  /** 服务器名（`mcp.json` 中的 key） */
  name: string;
  /** 传输类型，如 local / stdio / remote / http / sse */
  type: string;
  /** 启动命令（统一为数组形式；远程传输时为空数组） */
  command: string[];
  /** 环境变量（仅 local 传输） */
  environment: Record<string, string>;
  /** 远程 MCP 端点（Streamable HTTP 或旧版 SSE 的入口地址；仅 remote 传输） */
  url: string;
  /** 远程请求附带的 HTTP 头（如 Authorization；仅 remote 传输） */
  headers: Record<string, string>;
}

/** 判断是否为普通对象（排除 null / 数组） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意 command 值规范化为字符串数组（兼容 string / string[]） */
function normalizeCommand(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

/** 把任意 environment / headers 值规范化为 string -> string 映射 */
function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    out[key] = typeof val === 'string' ? val : String(val);
  }
  return out;
}

/** 把任意 url 值规范化为去掉首尾空白的字符串 */
function normalizeUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 远程传输的 type 取值集合（大小写不敏感） */
const REMOTE_TYPES = new Set([
  'remote',
  'http',
  'https',
  'sse',
  'http-sse',
  'streamable',
  'streamable-http',
  'streamablehttp',
]);

/** 该 type 是否表示远程传输 */
export function isRemoteType(type: string): boolean {
  return REMOTE_TYPES.has(type.trim().toLowerCase());
}

/**
 * 归一化传输类型。
 * 显式写了远程 type 即为远程；未写 type 但有 url 且没有 command 时也按远程处理。
 */
function normalizeType(value: unknown, url: string, command: string[]): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw) return raw;
  if (url && command.length === 0) return 'remote';
  return 'local';
}

/**
 * 判断某个服务器定义是否使用远程传输。
 * 兼容 `type: "local"` + `url` 这类书写错误：只要没有 command 且有 url 就走远程。
 */
export function isRemoteServer(server: Pick<McpServerDefinition, 'type' | 'url' | 'command'>): boolean {
  if (isRemoteType(server.type)) return true;
  return !!server.url && server.command.length === 0;
}

/**
 * 取出服务器映射：优先 mcp / mcpServers 包裹层，否则把根对象本身当作映射。
 */
function extractServerMap(root: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(root.mcp)) return root.mcp;
  if (isPlainObject(root.mcpServers)) return root.mcpServers;
  return root;
}

/**
 * 解析 `mcp.json` 的根对象为服务器定义列表。
 *
 * 纯函数：输入是已 `JSON.parse` 的原始值，输出是规范化列表；
 * 根不是对象、条目不是对象时跳过该条目，不抛错。
 */
export function parseMcpServerDefinitions(raw: unknown): McpServerDefinition[] {
  if (!isPlainObject(raw)) return [];
  const serverMap = extractServerMap(raw);

  const servers: McpServerDefinition[] = [];
  for (const [name, value] of Object.entries(serverMap)) {
    if (!isPlainObject(value)) continue;
    const command = normalizeCommand(value.command);
    const url = normalizeUrl(value.url ?? value.endpoint ?? value.serverUrl);
    servers.push({
      name,
      type: normalizeType(value.type, url, command),
      command,
      environment: normalizeStringMap(value.environment ?? value.env),
      url,
      headers: normalizeStringMap(value.headers),
    });
  }
  return servers;
}
