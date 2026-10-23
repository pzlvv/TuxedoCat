/**
 * 会话运行时状态的宿主侧派生工具。
 *
 * 会话运行时事实（idle / waiting / queryRunning 等）的 owner 是 Core 进程：
 * Core 经 `CoreEvent.sessionRuntimeChanged` 全量推送，宿主只缓存与派生，
 * 不在宿主进程内维护任何运行时登记表。
 *
 * 本模块**零 import**：入参用结构化类型（字段集合对齐 shared `SessionRuntimeState`
 * 契约，`src/host/abortButtonState.ts` 同款先例）——webview 的构建图不含 node
 * 类型链，一旦从这里 import `AssistantEventBus`，其类型依赖（settingsSnapshot →
 * fileLock / configDir）会把 node 模块拉进 webview 的 tsc 程序导致编译失败。
 * 消费方（host / webview / 测试）各自传自己的运行时状态类型，结构相容即可。
 */

/**
 * 会话忙闲的单一派生：`waiting`（等用户）> `running`（任一活动）> `idle`。
 *
 * 流水灯（标签页 / 侧栏）、托盘状态点、关闭前的二次确认都消费这一个函数——
 * 此前三处各写一遍判定且口径互相矛盾（「等用户但空闲」的会话，关闭对话不问、
 * 关闭工作区却问）。`idle === true` 但 `waiting === true` 的会话是 busy 的：
 * 引擎已空闲但有一件事必须用户拍板。
 */
export function sessionBusyLevel(
  state: { idle: boolean; waiting: boolean },
): 'idle' | 'waiting' | 'running' {
  if (state.waiting) return 'waiting';
  return state.idle ? 'idle' : 'running';
}

/**
 * 容器（跨工作区占位父对话）行的忙闲级别（specs/024 FR-001）：聚合**直接子代理**的
 * 运行级别，`waiting` > `running` > `idle`（与 `sessionBusyLevel` 同一优先级语义）。
 *
 * 子代理集合由调用方按列表父子树选出——容器的父子关系在 meta 的 `parentSessionId`
 * （指向 `ph_` 容器），而运行时快照里的 `parentSessionId` 指向真实发起方会话
 * （子代理注册表链路，跨工作区场景下不在本进程快照里），两条链不能混用。
 * 子代理不在状态快照里视为空闲——状态缺失是等待态，不猜值。容器自身没有运行时事实，
 * 这是子代理运行时的只读投影；侧栏 / 测试共用。
 */
export function deriveContainerBusyLevel(
  childrenStates: readonly { idle: boolean; waiting: boolean }[],
): 'idle' | 'waiting' | 'running' {
  let running = false;
  for (const state of childrenStates) {
    const level = sessionBusyLevel(state);
    if (level === 'waiting') return 'waiting';
    if (level === 'running') running = true;
  }
  return running ? 'running' : 'idle';
}

/** 运行中子代理条目（specs/019 FR-002）：abort 按钮悬停明细的「子代理」组逐项展示 */
export interface RunningSubAgentBrief {
  sessionId: string;
  description: string | null;
}

/**
 * 当前会话运行中的子代理清单（specs/019 FR-001）：直接子代理（`parentSessionId`
 * 指向该会话）中 `idle === false` 的条目，递归展开下层非空闲子代理，深先序、
 * 同层按 states 数组顺序（core 的 `session_order` 即创建序，宿主与 webview 的
 * Map 都保序）。只经非空闲节点下钻——core 的 `idle` 本就是递归合取，空闲节点
 * 的下层不可能在跑。
 *
 * 唯一实现，webview 与测试共用（`docs/architecture/principles.md` 第 8 节）；
 * 子代理身份不在快照里二次聚合，靠 `parentSessionId` 在客户端纯派生（同一事实只写一处）。
 */
export function collectRunningSubAgents(
  states: readonly {
    sessionId: string;
    idle: boolean;
    parentSessionId: string | null;
    subAgentDescription: string | null;
  }[],
  sessionId: string,
): RunningSubAgentBrief[] {
  const childrenByParent = new Map<string, { sessionId: string; idle: boolean; subAgentDescription: string | null }[]>();
  for (const state of states) {
    const parent = state.parentSessionId;
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(state);
    else childrenByParent.set(parent, [{ sessionId: state.sessionId, idle: state.idle, subAgentDescription: state.subAgentDescription }]);
  }
  const result: RunningSubAgentBrief[] = [];
  const visit = (parent: string): void => {
    for (const state of childrenByParent.get(parent) ?? []) {
      if (state.idle) continue;
      result.push({ sessionId: state.sessionId, description: state.subAgentDescription ?? null });
      visit(state.sessionId);
    }
  };
  visit(sessionId);
  return result;
}
