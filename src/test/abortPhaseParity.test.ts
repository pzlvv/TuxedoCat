/**
 * abort 两阶段对等测试（Embedded ↔ Standalone，`docs/abort-button.md` 第 1.2 节）。
 *
 * abort 按钮点一次发一条 `UiEvent.abortRequested`，core 依据该会话的运行时事实
 * 决定中止范围：
 * - 前台有工作（`queryRunning` / `compacting`）→ 只中止前台查询；
 * - 前台空闲但仍有后台 Bash 任务或子代理 → 中止它们（含递归子代理）。
 *
 * 本文件用假引擎断言 `Integration.abortCurrentQuery` 的两阶段范围，并顺带断言
 * 「按钮状态」与「core 阶段」同源：`resolveAbortButtonState` 给 `query` 时命中
 * 第一阶段，给 `background` 时命中第二阶段。Standalone 侧对应用例在
 * `core-rs/src/engine_tests.rs::abort_request_stops_foreground_before_background`
 * 与 `emit_runtime_reports_root_facts_and_busy_subagents`。
 *
 * 运行方式：npm run test:all -- abort-phase-parity
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import {
  getSessionRuntimeState,
  markQueryRunning,
  resetSessionRuntime,
} from '../core/sessionRuntime';
import { abortCurrentQuery } from '../core/Integration';
import { sessionEngines } from '../core/QueryEngine';
import { subAgentRegistry } from '../core/tools/agent/SubAgentRegistry';
import { resolveAbortButtonState } from '../host/abortButtonState';
import { createChecker, runTests } from './helpers/harness';
import { makeTestBus } from './helpers/fixtures';

/** 轮询直到条件成立（动态 import 的收尾是异步的） */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  resetSessionRuntime();

  /** 假引擎记录被调用的方法（`interruptForeground` = 只停前台，`interrupt` = 整棵树） */
  const calls: string[] = [];
  const makeEngine = (id: string) => ({
    interruptForeground: () => { calls.push(`${id}:foreground`); },
    interrupt: () => { calls.push(`${id}:all`); },
  });
  const parentEngine = makeEngine('parent');
  const childEngine = makeEngine('child');
  sessionEngines.set('parent-1', parentEngine as never);
  sessionEngines.set('child-1', childEngine as never);
  subAgentRegistry.register('child-1', childEngine as never, {} as never, 'parent-1');

  try {
    // ---- 前台在跑 + 子代理在跑：按钮红色，点击只中止前台 ----
    markQueryRunning('parent-1', true);
    markQueryRunning('child-1', true);
    const busyState = getSessionRuntimeState('parent-1');
    assert.ok(busyState);
    assert.equal(busyState.queryRunning, true);
    assert.equal(busyState.subAgentRunning, true);
    assert.equal(
      resolveAbortButtonState(busyState),
      'query',
      '前台在跑时按钮为红色',
    );

    abortCurrentQuery('parent-1');
    assert.equal(calls.join(','), 'parent:foreground', '第一阶段只中止前台查询');
    check('前台在跑：只中止前台，子代理保留', calls.join(',') === 'parent:foreground');

    // ---- 前台停下、子代理仍在跑：按钮黄色，点击中止后台与子代理 ----
    markQueryRunning('parent-1', false);
    const settlingState = getSessionRuntimeState('parent-1');
    assert.ok(settlingState);
    assert.equal(settlingState.queryRunning, false);
    assert.equal(settlingState.subAgentRunning, true);
    assert.equal(
      resolveAbortButtonState(settlingState),
      'background',
      '前台停下但子代理在跑时按钮为黄色',
    );

    calls.length = 0;
    abortCurrentQuery('parent-1');
    const aborted = await waitFor(() => calls.includes('child:all'));
    check('收尾中：递归中止子代理', aborted && calls.includes('parent:all'));

    // ---- 都停下：按钮灰色，点击无事可做 ----
    markQueryRunning('child-1', false);
    const idleState = getSessionRuntimeState('parent-1');
    assert.ok(idleState);
    assert.equal(idleState.subAgentRunning, false);
    assert.equal(resolveAbortButtonState(idleState), 'none', '都停下时按钮为灰色');
    calls.length = 0;
    abortCurrentQuery('parent-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    check('空闲：点击不产生任何中止', calls.length === 0);
  } finally {
    sessionEngines.delete('parent-1');
    sessionEngines.delete('child-1');
    subAgentRegistry.unregister('child-1');
    resetSessionRuntime();
    resetGlobalEventBus();
  }

  finish();
}

runTests('abortPhaseParity', run);
