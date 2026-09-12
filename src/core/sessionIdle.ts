/**
 * sessionIdle - 空闲对话自动关闭
 *
 * 背景：打开过的对话会常驻内存（QueryEngine 引擎 + 消息缓存；Electron 中每个对话
 * 还有一个完整的渲染进程 WebContentsView）。用户长时间不用的对话没有必要继续占用
 * 这些资源，这里统一在 core 层维护「最后一次活动时间」，超时后交给宿主关闭。
 *
 * 规则：
 *   - 非激活对话在最后一次活动后空闲超过 SESSION_IDLE_CLOSE_MS（2 小时）自动关闭；
 *   - 当前激活的对话永不关闭，且每次巡检都会刷新它的活动时间（视为一直在使用）；
 *   - 正在工作的对话不算空闲：运行中（consumer running）、有后台 Bash 任务、有活跃
 *     子代理、或正在等待用户确认（ask user / 权限确认）时，巡检会把它的活动时间刷新
 *     为当前时间，等它重新空闲后再从头计时（"变为非 idle 时重新计时"）；
 *   - 宿主未注册关闭回调时不关闭任何会话。
 *
 * 关闭动作由宿主决定（core 只负责计时与判定）：
 *   - Electron：销毁该对话的聊天视图（WebContentsView）
 *   - VS Code：没有独立视图，只释放引擎 / 消息缓存 / MCP 引用
 * 两者最终都调用 releaseSessionResources()，磁盘上的对话文件不受影响，
 * 再次打开时会重新从磁盘加载（VS Code：loadConversation；Electron：新建视图）。
 */

import { logger } from './Logger.js';

/** 非激活对话空闲多久后自动关闭（2 小时） */
export const SESSION_IDLE_CLOSE_MS = 2 * 60 * 60 * 1000;

/** 巡检间隔（1 分钟） */
export const SESSION_IDLE_CHECK_INTERVAL_MS = 60 * 1000;

/** sessionId -> 最后一次活动时间戳（毫秒） */
const lastActivityAt = new Map<string, number>();

/** 宿主注册的「关闭对话」回调 */
let closeHandler: ((sessionId: string) => void | Promise<void>) | null = null;

/** 宿主注入的「会话是否正在等待用户输入」判定（ask user / 权限确认） */
let waitingForUserProvider: ((sessionId: string) => boolean) | null = null;

/**
 * 宿主注入的「当前激活会话」判定。
 * 未注入时回退到 core 的 getActiveSessionId()。
 * Electron 需要注入：切换已加载的视图时不会再发 setActiveSessionId，
 * 只有 ChatViewManager 知道当前真正显示的是哪个对话。
 */
let activeSessionProvider: (() => string | null | undefined) | null = null;

let timer: ReturnType<typeof setInterval> | null = null;

/** 临时会话 key（新建对话尚未上报正式 sessionId 前使用），不参与空闲关闭 */
function isTemporarySessionId(sessionId: string): boolean {
  return sessionId.startsWith('new-');
}

/**
 * 记录会话活动：发送消息、开始/结束查询、打开或激活对话时调用。
 * 会重置该会话的空闲计时。
 */
export function noteSessionActivity(sessionId?: string | null): void {
  if (!sessionId || isTemporarySessionId(sessionId)) return;
  lastActivityAt.set(sessionId, Date.now());
}

/** 读取会话的最后活动时间（测试 / 诊断用） */
export function getSessionLastActivity(sessionId: string): number | undefined {
  return lastActivityAt.get(sessionId);
}

/** 会话被删除 / 手动关闭时清理计时状态 */
export function clearSessionIdleState(sessionId?: string | null): void {
  if (!sessionId) return;
  lastActivityAt.delete(sessionId);
}

/** 清空所有计时状态（工作区切换 / 退出等场景） */
export function resetSessionIdleState(): void {
  lastActivityAt.clear();
}

/** 注册「关闭对话」回调（由宿主在启动时注入） */
export function setSessionIdleCloseHandler(
  fn: ((sessionId: string) => void | Promise<void>) | null
): void {
  closeHandler = fn;
}

/** 注册「会话是否正在等待用户输入」判定 */
export function setSessionWaitingForUserProvider(
  fn: ((sessionId: string) => boolean) | null
): void {
  waitingForUserProvider = fn;
}

/** 注册「当前激活会话」判定 */
export function setSessionActiveProvider(
  fn: (() => string | null | undefined) | null
): void {
  activeSessionProvider = fn;
}

async function resolveActiveSessionId(): Promise<string | null> {
  if (activeSessionProvider) {
    try {
      return activeSessionProvider() ?? null;
    } catch {
      return null;
    }
  }
  try {
    const { getActiveSessionId } = await import('./history/Config.js');
    return getActiveSessionId() || null;
  } catch {
    return null;
  }
}

/**
 * 判断会话当前是否「忙」（非空闲）：等待用户确认 / 查询运行中 / 有后台 Bash / 有子代理。
 * 引擎状态无法判定时保守返回 true，避免误关正在工作的对话。
 */
async function isSessionBusy(sessionId: string): Promise<boolean> {
  try {
    if (waitingForUserProvider?.(sessionId)) return true;
  } catch {
    // 判定失败按「不忙」处理，交给后面的引擎检查
  }
  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    const engine = sessionEngines.get(sessionId);
    if (!engine) return false;
    if (engine.isConsumerRunning) return true;
    if (!(await engine.isIdle())) return true;
  } catch {
    return true;
  }
  // 该会话创建的子代理正在等待用户确认时也不能关闭创建者：
  // 子代理处理完需要 Reply 回创建者，创建者引擎被释放会导致投递失败。
  try {
    const { subAgentRegistry } = await import('./tools/agent/SubAgentRegistry.js');
    for (const subId of subAgentRegistry.listForCreator(sessionId)) {
      if (waitingForUserProvider?.(subId)) return true;
    }
  } catch {
    // 子代理状态无法判定时不影响判定结果
  }
  return false;
}

/** 关闭前等待未落盘消息写入磁盘，避免丢失 */
async function flushSession(sessionId: string): Promise<void> {
  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    await sessionEngines.get(sessionId)?.flush();
  } catch {
    // 落盘失败不阻塞关闭
  }
}

/**
 * 释放会话的运行时资源：中止查询 → 落盘 → 移出引擎池 → 移除消息缓存 → 释放 MCP 引用。
 * 不删除磁盘上的对话数据；再次打开时从磁盘重新加载（并重建引擎）。
 * 幂等：对不存在的会话调用无副作用。
 */
export async function releaseSessionResources(sessionId: string): Promise<void> {
  if (!sessionId || isTemporarySessionId(sessionId)) return;

  // 1. 中止：可能仍有后台 Bash 任务 / 子代理在跑（幂等）
  try {
    const { abortCurrentQuery } = await import('./Integration.js');
    abortCurrentQuery(sessionId);
  } catch {
    // 中止失败不阻塞关闭
  }

  // 2. 等待落盘后移出引擎池（消息缓存随之可被 GC）
  await flushSession(sessionId);
  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    sessionEngines.delete(sessionId);
  } catch {
    // 引擎池清理失败不影响其余释放
  }

  // 3. 移除消息内存缓存，下次打开从磁盘重新加载
  try {
    const { removeConversationFromCache } = await import('./history/Conversation.js');
    removeConversationFromCache(sessionId);
  } catch {
    // 缓存清理失败不影响其余释放
  }

  // 4. 释放 MCP 引用（引用归零的 server 由 McpManager 延迟回收）
  try {
    const { clearSessionMcpOverride } = await import('./mcp/Config.js');
    const { getMcpManager } = await import('./mcp/Manager.js');
    clearSessionMcpOverride(sessionId);
    await getMcpManager().release(sessionId);
  } catch {
    // 释放失败不影响关闭
  }

  clearSessionIdleState(sessionId);
}

/**
 * 巡检一次：关闭所有满足条件的空闲会话，返回被关闭的 sessionId 列表。
 * 导出以便测试与手动触发（默认每 SESSION_IDLE_CHECK_INTERVAL_MS 自动执行）。
 */
export async function sweepIdleSessions(now: number = Date.now()): Promise<string[]> {
  if (!closeHandler) return [];

  let candidates: string[];
  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    candidates = [...new Set([...lastActivityAt.keys(), ...sessionEngines.keys()])];
  } catch (err) {
    logger.warn('SessionIdle', `Failed to collect sessions for idle check: ${err}`);
    return [];
  }

  const closed: string[] = [];
  const activeSessionId = await resolveActiveSessionId();

  for (const sessionId of candidates) {
    if (!sessionId || isTemporarySessionId(sessionId)) continue;

    const last = lastActivityAt.get(sessionId);
    if (last === undefined) {
      // 没有活动记录（例如刚被引擎池收编）：从现在开始计时，不立即关闭
      lastActivityAt.set(sessionId, now);
      continue;
    }
    // 当前激活的对话永不关闭，并持续刷新空闲计时
    if (activeSessionId && sessionId === activeSessionId) {
      lastActivityAt.set(sessionId, now);
      continue;
    }
    if (now - last < SESSION_IDLE_CLOSE_MS) continue;

    // 仍在工作 / 等待用户确认：重新计时
    if (await isSessionBusy(sessionId)) {
      lastActivityAt.set(sessionId, now);
      continue;
    }

    // 上面的 await 期间状态可能已变化（重新激活 / 开始新查询）：关闭前再确认一次
    if ((await resolveActiveSessionId()) === sessionId) {
      lastActivityAt.set(sessionId, now);
      continue;
    }
    if (await isSessionBusy(sessionId)) {
      lastActivityAt.set(sessionId, now);
      continue;
    }

    try {
      await flushSession(sessionId);
      await closeHandler(sessionId);
      lastActivityAt.delete(sessionId);
      closed.push(sessionId);
      logger.info(
        'SessionIdle',
        `Closed idle session ${sessionId} (idle ${Math.round((now - last) / 60000)}min)`
      );
    } catch (err) {
      logger.warn('SessionIdle', `Failed to close idle session ${sessionId}: ${err}`);
    }
  }

  return closed;
}

/** 启动空闲巡检（幂等；宿主在启动时调用一次） */
export function startSessionIdleMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepIdleSessions().catch((err) => {
      logger.warn('SessionIdle', `Idle sweep failed: ${err}`);
    });
  }, SESSION_IDLE_CHECK_INTERVAL_MS);
  // Node 环境下不要因为该定时器阻止进程退出
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** 停止空闲巡检（扩展停用 / 应用退出时调用） */
export function stopSessionIdleMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
