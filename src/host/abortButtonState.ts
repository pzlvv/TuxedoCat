/**
 * abort 按钮三态的推导（`docs/features/abort-button.md` FR-001）。
 *
 * core 只描述运行时根事实（`SessionRuntimeState`，``docs/core/session-runtime.md`）；颜色与可点性属于表现，
 * 由这里的纯函数从根事实推导（``docs/architecture/principles.md` 第 6 / 8 节）。webview 与测试共用这一份实现，
 * 不在组件里另写一遍 `if`。
 */

/** abort 按钮状态：红（前台查询运行中）/ 黄（spin 模式或只剩后台与子代理）/ 灰（空闲） */
export type AbortButtonState = 'query' | 'background' | 'none';

/** 工作模式（core `SessionState.work_mode` 的事实；spin = `/spin` 执行或恢复出的 spin 态） */
export type WorkMode = 'normal' | 'spin';

/**
 * 推导所需的根事实。`SessionRuntimeState` 结构上满足前四项——这里刻意不 import core 类型，
 * 让本模块零依赖（与 `host/types.ts` 同风格）；`workMode` 单独注入（runtime 快照
 * 不携带工作模式，specs/016 FR-004）。
 */
export interface AbortButtonFacts {
  queryRunning: boolean;
  compacting: boolean;
  backgroundRunning: boolean;
  subAgentRunning: boolean;
  workMode: WorkMode;
}

/**
 * 由根事实推导按钮状态：
 * - spin 模式 → `background`（黄）。父会话的消费循环被 SpinLoop 占用，快照里的
 *   `queryRunning` 为真，但跑的**不是** query engine；按钮只用于中止 spin 的子代理，
 *   不表达「中止查询」。spin 单向：循环停下后会话仍保持 spin（空闲时点击为空操作）；
 * - 前台有工作（查询 / 压缩）→ `query`（红）；
 * - 前台空闲但仍有后台 Bash 任务或非 idle 子代理 → `background`（黄）；
 * - 都为空 → `none`（灰，不可点）。
 */
export function resolveAbortButtonState(facts: AbortButtonFacts): AbortButtonState {
  if (facts.workMode === 'spin') return 'background';
  if (facts.queryRunning || facts.compacting) return 'query';
  if (facts.backgroundRunning || facts.subAgentRunning) return 'background';
  return 'none';
}
