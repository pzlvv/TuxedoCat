/**
 * sessionResources - core 侧的「会话是否在忙」判定与会话运行时资源释放
 *
 * 空闲计时（最后一次活动时间 / 巡检 / 关闭策略）的 owner 是 VS Code 宿主层的
 * `SingleWebViewConversationManager`（`src/VSCodeConversationManager.ts`）；
 * core 不持有任何计时状态。本模块只提供 core 侧的两类能力：
 *
 *   - `isSessionIdle(sessionId)`：只读事实查询，宿主用它判断「该会话是否空闲」。
 *     非空闲 = 等待用户确认（ask user / 权限确认）/ 引擎消费中 / 正在压缩 /
 *     有后台 Bash 任务 / 有非 idle 子代理（递归）。判定失败时保守返回「非空闲」，
 *     避免误关正在工作的对话。
 *   - `releaseSessionResources(sessionId)`：状态变更，只由 `UiEvent.conversationClosed`
 *     触发（`initializeCoreEvents.ts`），释放引擎 / 消息缓存 / MCP 引用；
 *     磁盘上的对话文件不受影响，再次打开时重新从磁盘加载。
 *
 * 关闭动作由宿主决定（core 只提供「怎么卸」）：
 *   - Electron：销毁该对话的聊天视图（WebContentsView）
 *   - VS Code：没有独立视图，只释放引擎 / 消息缓存 / MCP 引用
 */

/** 宿主注入的「会话是否正在等待用户输入」判定（ask user / 权限确认） */
let waitingForUserProvider: ((sessionId: string) => boolean) | null = null;

/** 临时会话 key（新建对话尚未上报正式 sessionId 前使用），不参与资源管理 */
function isTemporarySessionId(sessionId: string): boolean {
  return sessionId.startsWith('new-');
}

/** 注册「会话是否正在等待用户输入」判定 */
export function setSessionWaitingForUserProvider(
  fn: ((sessionId: string) => boolean) | null
): void {
  waitingForUserProvider = fn;
}

/**
 * 取「会话是否正在等待用户输入」判定；未注入时抛错。
 *
 * 接线缺失属于启动错误（bootstrap 必定注入），不用可选链静默降级成「没有等待用户」——
 * 那会让等待用户确认的会话被判定为空闲。
 */
export function requireSessionWaitingForUserProvider(): (sessionId: string) => boolean {
  if (!waitingForUserProvider) {
    throw new Error(
      'Session waiting-for-user provider is not configured. ' +
      'Call setSessionWaitingForUserProvider() during bootstrap.'
    );
  }
  return waitingForUserProvider;
}

/** 「会话是否正在等待用户输入」判定是否已注入（启动自检用） */
export function hasSessionWaitingForUserProvider(): boolean {
  return waitingForUserProvider !== null;
}

/**
 * 判断会话当前是否「空闲」。
 *
 * **这是「是否空闲」的唯一判定入口**：宿主空闲回收、手动压缩的是否延后都调它，
 * 语义与 `sessionRuntime` 推给 UI 的 `idle` 快照一致（同一批事实）。
 * 判定为「非空闲」（返回 false）的情形（任一为真）：
 * - 正在压缩上下文（会整体替换消息数组）
 * - 自己或某个递归子代理正在等待用户确认（ask user / 权限确认）
 * - 有运行中的后台 Bash 任务
 * - 有非 idle 的子代理（递归）
 * - 引擎消费循环在运行
 *
 * 只读：不修改任何状态。引擎状态无法判定时保守返回 false（视为非空闲）。
 * 前置条件：「等待用户」读取器由共享骨架注入（`requireSessionWaitingForUserProvider`），
 * 未注入时直接抛错——接线缺失属于启动错误，不静默降级成「没有等待用户」。
 */
export async function isSessionIdle(sessionId: string, visited: Set<string> = new Set()): Promise<boolean> {
  if (!sessionId || visited.has(sessionId)) return true;
  visited.add(sessionId);

  // 压缩中：会整体替换消息数组，此时释放资源会让压缩结果落不下来
  try {
    const { isCompacting } = await import('./compact/state.js');
    if (isCompacting(sessionId)) return false;
  } catch {
    // 判定失败继续走后面的检查
  }

  // 等待用户：接线缺失属于启动错误，直接抛（不吞掉）；判定本身异常才按「不忙」继续
  const waitingForUser = requireSessionWaitingForUserProvider();
  try {
    if (waitingForUser(sessionId)) return false;
  } catch {
    // 判定失败按「不忙」处理，交给后面的检查
  }

  // 后台 Bash 任务可能在前台查询结束后继续运行，此时会话仍然不是空闲的
  try {
    const { getRunningBackgroundTasksForSession } = await import('./tools/bash/LocalShellTask.js');
    if (getRunningBackgroundTasksForSession(sessionId).length > 0) return false;
  } catch {
    // 后台任务状态无法判定时不影响其它检查
  }

  // 子代理递归：子代理自己也可能有后台任务 / 更下层的子代理。
  // 子代理在等用户确认时创建者也不能关闭——子代理处理完需要 Reply 回创建者。
  try {
    const { subAgentRegistry } = await import('./tools/agent/SubAgentRegistry.js');
    for (const subId of subAgentRegistry.listForCreator(sessionId)) {
      if (!(await isSessionIdle(subId, visited))) return false;
    }
  } catch {
    // 子代理状态无法判定时不影响其它检查
  }

  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    const engine = sessionEngines.get(sessionId);
    if (engine?.isConsumerRunning) return false;
  } catch {
    return false;
  }
  return true;
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
 * 释放会话的运行时资源：中止查询 → 拒绝挂起选择 → 落盘 → 移出引擎池 → 丢弃待压缩标记
 * → 移除消息缓存 → 释放 MCP 引用 → 丢弃 sessionRuntime 状态。
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

  // 1.5 拒绝该会话挂起的用户选择：会话已释放，等待方（RunTools / AskUserQuestion）
  //     不应继续挂起，也避免队列在会话关闭后仍尝试弹出该会话的选择框
  try {
    const { userChoiceQueue } = await import('./UserChoiceQueue.js');
    userChoiceQueue.rejectPending(
      sessionId,
      new Error(`Session ${sessionId} closed before user choice was answered`),
    );
  } catch {
    // 拒绝失败不阻塞关闭
  }

  // 2. 等待落盘后移出引擎池（消息缓存随之可被 GC）
  await flushSession(sessionId);
  try {
    const { sessionEngines } = await import('./QueryEngine.js');
    sessionEngines.delete(sessionId);
  } catch {
    // 引擎池清理失败不影响其余释放
  }

  // 2.5 丢弃"待压缩"标记：会话已释放，之前排队的手动压缩不应在重新打开后突然执行
  try {
    const { unmarkPendingCompact } = await import('./compact/state.js');
    unmarkPendingCompact(sessionId);
  } catch {
    // 状态清理失败不影响其余释放
  }

  // 3. 移除消息内存缓存，下次打开从磁盘重新加载
  try {
    const { removeConversationFromCache } = await import('./history/Conversation.js');
    removeConversationFromCache(sessionId);
  } catch {
    // 缓存清理失败不影响其余释放
  }

  // 4. 释放 MCP 引用（MCPHost 管生命周期；引用归零的 server 由 McpManager 延迟回收）
  try {
    const { clearSessionMcpOverride } = await import('./mcp/Config.js');
    const { getMCPHost } = await import('./mcp/MCPHost.js');
    clearSessionMcpOverride(sessionId);
    await getMCPHost().onSessionClosed(sessionId);
  } catch {
    // 释放失败不影响关闭
  }

  // 5. 丢弃该会话的运行时状态（idle / waiting）：会话已关闭，侧栏黄灯 / 托盘状态点
  //    不应再残留。若后台任务 / 子代理稍后重新 mark，会按新事实重建（幂等）。
  try {
    const { dropSessionRuntime } = await import('./sessionRuntime.js');
    dropSessionRuntime(sessionId);
  } catch {
    // 状态清理失败不影响关闭
  }
}
