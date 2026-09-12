/**
 * MCP 服务器配置
 *
 * mcp.json 与 settings.json 同目录（~/<CONFIG_DIR_NAME>/mcp.json），
 * 用于声明可用的 MCP 服务器。声明里不含 enabled —— 启用状态统一记录在
 * settings.json 的 mcp.enabled 列表中，未记录的一律视为 disable。
 *
 * mcp.json 格式：
 * {
 *   "mcp": {
 *     "blender-mcp": {
 *       "type": "local",
 *       "command": ["uvx", "blender-mcp"],
 *       "environment": { "BLENDER_HOST": "localhost", "BLENDER_PORT": "9876" }
 *     },
 *     "parallel-search": {
 *       "type": "remote",
 *       "url": "https://search.parallel.ai/mcp",
 *       "headers": { "Authorization": "Bearer <token>" }
 *     }
 *   }
 * }
 *
 * type 语义：
 *   - local / stdio（默认）：用 command 启动子进程，走 stdio 传输
 *   - remote / http / sse 等：用 url 走远程传输（先试 Streamable HTTP，
 *     失败后回退旧版 HTTP+SSE）；headers 作为附加请求头（如鉴权）
 * 若未写 type 但给了 url，同样按远程处理。
 *
 * 启用状态分两层，与项目其它配置（webSearch / model）保持一致：
 *
 *   1. 全局默认（设置面板「默认配置」写入）：
 *      ~/<CONFIG_DIR_NAME>/settings.json   → { "mcp": { "enabled": [...] } }
 *      作为新对话的默认启用列表。
 *
 *   2. 会话覆盖（输入框菜单写入）：
 *      <sessionId>.meta.json 的 context.mcpEnabled
 *      菜单只写这一层，不触碰全局默认。
 *
 *   生效值 = 会话设置过就用它（空数组表示"该会话全部禁用"），否则回退到全局默认。
 *
 * 关于新对话：meta.json 要等第一条消息落盘时才创建，因此菜单的勾选会先记在
 * 内存里（sessionOverrides，进程内权威），并在查询结束（meta.json 已存在）后
 * 由 flushSessionMcpToMeta() 补写进 meta.json。
 */

import { join } from 'path';
import * as fs from 'fs/promises';
import { logger } from '../Logger.js';
import { getConfigHomeDir, readSettingsJson, updateSettingsJson } from '../history/Config.js';
import { getMetadataPath, updateConversationContext } from '../history/Conversation.js';
import { tryGetProjectRoot } from '../history/Config.js';
import type { McpServerInfo } from '../webviewTypes.js';

/** mcp.json 路径（与全局 settings.json 同目录） */
export function getMcpConfigPath(): string {
  return join(getConfigHomeDir(), 'mcp.json');
}

/** 从任意 settings 对象里取出 mcp.enabled；字段缺失/类型不合法时返回 null */
function extractEnabledList(settings: unknown): string[] | null {
  const enabled = (settings as { mcp?: { enabled?: unknown } } | null | undefined)?.mcp?.enabled;
  if (!Array.isArray(enabled)) return null;
  return enabled.filter((name): name is string => typeof name === 'string');
}

/**
 * 全局默认启用列表（~/<CONFIG_DIR_NAME>/settings.json 的 mcp.enabled）。
 * 未配置时返回空数组。
 */
export async function readDefaultEnabledMcps(): Promise<string[]> {
  try {
    return extractEnabledList(await readSettingsJson()) ?? [];
  } catch {
    return [];
  }
}

/**
 * 进程内的会话级覆盖（权威值）。
 * 新对话的 meta.json 尚未创建时，勾选结果先记在这里。
 */
const sessionOverrides = new Map<string, string[]>();

/**
 * 读取会话覆盖的启用列表。
 * 返回 null 表示该会话**没有**设置过（应回退到全局默认）；
 * 返回空数组表示显式设置为「该会话全部禁用」。
 */
export async function readSessionEnabledMcps(sessionId?: string): Promise<string[] | null> {
  if (!sessionId) return null;

  const cached = sessionOverrides.get(sessionId);
  if (cached) return cached;

  // 从 meta.json 的 context.mcpEnabled 恢复（进程重启后走这条路径）
  const projectPath = tryGetProjectRoot();
  if (!projectPath) return null;
  try {
    const content = await fs.readFile(getMetadataPath(sessionId, projectPath), 'utf-8');
    const metadata = JSON.parse(content) as { context?: { mcpEnabled?: unknown } };
    const enabled = metadata?.context?.mcpEnabled;
    if (!Array.isArray(enabled)) return null;
    const list = enabled.filter((name): name is string => typeof name === 'string');
    sessionOverrides.set(sessionId, list);
    return list;
  } catch {
    return null;
  }
}

/**
 * 生效的启用列表：会话覆盖优先，其次全局默认。
 */
export async function readEnabledMcps(sessionId?: string): Promise<string[]> {
  const session = await readSessionEnabledMcps(sessionId);
  if (session !== null) return session;
  return readDefaultEnabledMcps();
}

/**
 * 把某个 MCP 的启用状态写入**当前会话**（输入框菜单用）。
 *
 * 同时更新内存覆盖并尽力写入 meta.json；若该会话的 meta.json 还不存在
 * （新对话尚未发消息），写入会静默跳过，等查询结束后由
 * flushSessionMcpToMeta() 补写。
 */
export async function setSessionMcpEnabled(
  sessionId: string | undefined,
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!sessionId || !name) return;

  const current = (await readSessionEnabledMcps(sessionId))
    ?? (await readDefaultEnabledMcps());
  const set = new Set(current);
  if (enabled) set.add(name);
  else set.delete(name);

  const next = Array.from(set);
  sessionOverrides.set(sessionId, next);
  await persistSessionMcp(sessionId, next);
}

/**
 * 把内存中的会话级 MCP 选择补写进 meta.json。
 * 查询结束时调用 —— 此时第一条消息已落盘，meta.json 一定存在。
 */
export async function flushSessionMcpToMeta(sessionId: string): Promise<void> {
  const pending = sessionOverrides.get(sessionId);
  if (pending === undefined) return;
  await persistSessionMcp(sessionId, pending);
}

async function persistSessionMcp(sessionId: string, enabled: string[]): Promise<void> {
  try {
    await updateConversationContext(sessionId, { mcpEnabled: enabled });
  } catch (err) {
    // meta.json 不存在时 updateConversationContext 会跳过，属于预期情况
    logger.info('McpConfig', `会话 ${sessionId} 的 MCP 设置暂未写入 meta.json: ${err}`);
  }
}

/** 会话被删除时清理内存覆盖，避免泄漏 */
export function clearSessionMcpOverride(sessionId: string): void {
  sessionOverrides.delete(sessionId);
}

/**
 * 直接覆盖全局默认启用列表（设置面板一次性保存多个勾选项时用）。
 */
export async function setDefaultEnabledMcps(names: string[]): Promise<void> {
  const normalized = Array.from(new Set(names.filter((n): n is string => typeof n === 'string' && !!n)));
  await updateSettingsJson((cfg) => {
    if (!isPlainObject(cfg.mcp)) cfg.mcp = {};
    cfg.mcp.enabled = normalized;
  });
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
export function isRemoteServer(server: Pick<McpServerInfo, 'type' | 'url' | 'command'>): boolean {
  if (isRemoteType(server.type)) return true;
  return !!server.url && server.command.length === 0;
}

/** 判断是否为普通对象（排除 null / 数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 取出服务器映射：优先 mcp / mcpServers 包裹层，否则把根对象本身当作映射。
 */
function extractServerMap(root: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(root.mcp)) return root.mcp;
  if (isPlainObject(root.mcpServers)) return root.mcpServers;
  return root;
}

/** 读取并解析 mcp.json 中的服务器定义（不含启用状态） */
async function readMcpServerDefinitions(): Promise<Omit<McpServerInfo, 'enabled'>[]> {
  let raw: unknown;
  try {
    const content = await fs.readFile(getMcpConfigPath(), 'utf-8');
    raw = JSON.parse(content);
  } catch (err: any) {
    // 文件不存在是正常情况（用户尚未配置任何 MCP）
    if (err?.code !== 'ENOENT') {
      logger.error('McpConfig', `读取 mcp.json 失败: ${err}`);
    }
    return [];
  }

  if (!isPlainObject(raw)) return [];
  const serverMap = extractServerMap(raw);

  const servers: Omit<McpServerInfo, 'enabled'>[] = [];
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

/** 按给定的启用名列表给服务器定义打上 enabled 标记 */
function withEnabled(
  servers: Omit<McpServerInfo, 'enabled'>[],
  enabledNames: string[],
): McpServerInfo[] {
  const enabledSet = new Set(enabledNames);
  return servers.map((server) => ({ ...server, enabled: enabledSet.has(server.name) }));
}

/**
 * 读取 mcp.json，并合并**生效**的启用状态（会话覆盖优先，其次全局默认）。
 * 供输入框菜单与 MCP 管理器使用。
 * 文件不存在 / 解析失败 / 无服务器时返回空数组（不抛错）。
 *
 * @param sessionId 当前会话 ID；不传则只用全局默认
 */
export async function readMcpServers(sessionId?: string): Promise<McpServerInfo[]> {
  return withEnabled(await readMcpServerDefinitions(), await readEnabledMcps(sessionId));
}

/**
 * 读取 mcp.json，并合并**全局默认**的启用状态。
 * 供设置面板编辑「默认配置」使用。
 */
export async function readMcpServersForDefaults(): Promise<McpServerInfo[]> {
  return withEnabled(await readMcpServerDefinitions(), await readDefaultEnabledMcps());
}
