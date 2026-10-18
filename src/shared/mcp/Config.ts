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

import * as fs from 'fs/promises';
import { logger } from '../Logger.js';
import { getProjectRoot, hasProjectRoot } from '../history/Config.js';
import { getMetadataPath, updateConversationContext } from '../history/Conversation.js';
import { getMcpServerDefinitions, getSettings } from '../settings.js';
import type { McpServerInfo } from '../webviewTypes.js';
import { isPlainObject, type McpServerDefinition } from './parse.js';

// 纯解析与判定住在 `parse.ts`：UI 侧读盘后调同一个解析器，Core 侧从配置快照读结果。
export { isRemoteServer, isRemoteType } from './parse.js';

/**
 * 全局默认启用列表（`settings.json` 的 `mcp.enabled`，经配置快照下发）。
 * 未配置时返回空数组。
 */
export async function readDefaultEnabledMcps(): Promise<string[]> {
  return getSettings().mcp.enabled;
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
  // 宿主未打开工作目录时没有项目目录，视为"未设置过"，返回 null
  if (!hasProjectRoot(sessionId)) return null;
  const projectPath = getProjectRoot(sessionId);
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
 * 整表覆盖某个会话的启用列表（`UiEvent.mcpEnabledListChanged`）。
 *
 * 与 `setSessionMcpEnabled` 的单开关语义不同：这里拿到的是**完整列表**，直接覆盖，
 * 不做增量。内存覆盖在返回前同步写入——调用方（宿主保存默认配置时先把当前对话钉在
 * 它当前的列表上）需要它在同一个 tick 内生效，早于随后的配置写盘与 `syncAllSessions`。
 * 写 meta.json 仍是尽力而为（新对话的 meta.json 尚未创建时由
 * `flushSessionMcpToMeta()` 补写）。
 */
export function setSessionMcpEnabledList(
  sessionId: string | undefined,
  names: readonly string[],
): Promise<void> {
  if (!sessionId || sessionId === 'undefined') return Promise.resolve();
  const next = Array.from(new Set(names.filter((name): name is string => typeof name === 'string' && !!name)));
  sessionOverrides.set(sessionId, next);
  return persistSessionMcp(sessionId, next);
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
 * 构造「把全局默认启用列表覆盖为 names」的 settings.json 修改器
 * （设置面板一次性保存多个勾选项时用）。
 *
 * core 只描述**怎么改**，**写盘由宿主承担**（`UIHost.updateSettingsJson`，
 * 见 ``docs/architecture/layering.md 第 2 节规则 9）。
 */
export function mcpDefaultsMutator(names: readonly string[]): (cfg: Record<string, any>) => void {
  const normalized = Array.from(new Set(names.filter((n): n is string => typeof n === 'string' && !!n)));
  return (cfg) => {
    if (!isPlainObject(cfg.mcp)) cfg.mcp = {};
    cfg.mcp.enabled = normalized;
  };
}

/**
 * MCP 服务器定义（不含启用状态）。
 *
 * 来自配置快照：UI 在连接建立时读一次 `mcp.json`、解析后随
 * `hostEnvironmentProvided` 下发；Core 不感知文件路径，中途修改不通知
 * （`docs/architecture/core-ui-separation.md` 第 4.7 节）。
 */
function readMcpServerDefinitions(): readonly McpServerDefinition[] {
  return getMcpServerDefinitions();
}

/** 按给定的启用名列表给服务器定义打上 enabled 标记 */
function withEnabled(
  servers: readonly McpServerDefinition[],
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
