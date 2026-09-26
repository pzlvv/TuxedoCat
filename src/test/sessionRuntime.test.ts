/**
 * sessionRuntime 单测（阶段 3.6 随附）：
 * - idle/waiting 聚合与 diff（无变化不发事件）
 * - 多会话并发状态
 * - dropSessionRuntime 清理
 * - waiting 来源：markSessionWaiting 写入 / isSessionWaiting 读取
 * 运行方式：npm run test:all -- session-runtime
 */

import * as assert from 'assert';
import {
  setGlobalEventBus,
  resetGlobalEventBus,
  type SessionRuntimeState,
} from '../core/AssistantEventBus';
import {
  markQueryRunning,
  markSessionWaiting,
  dropSessionRuntime,
  getSessionRuntimeStates,
  resetSessionRuntime,
  isSessionWaiting,
} from '../core/sessionRuntime';
import { subAgentRegistry } from '../core/tools/agent/SubAgentRegistry';
import { createChecker, runTests } from './helpers/harness';
import { makeTestBus } from './helpers/fixtures';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  resetSessionRuntime();

  /** 最近一次推送的全量快照 */
  const lastStates = (): readonly SessionRuntimeState[] =>
    testBus.last('sessionRuntimeChanged')!.states;

  // 非 idle 变化推全量
  markQueryRunning('s1', true);
  assert.equal(testBus.count('sessionRuntimeChanged'), 1, 'first change emits');
  let states = lastStates();
  assert.equal(states.length, 1);
  assert.equal(states[0].sessionId, 's1');
  assert.equal(states[0].idle, false);
  assert.equal(states[0].waiting, false);
  check('query running pushes idle=false snapshot', true);

  // 同值重复标记不推事件（diff 后才发）
  markQueryRunning('s1', true);
  assert.equal(testBus.count('sessionRuntimeChanged'), 1);
  check('same value does not push', true);

  // 多会话并发
  markQueryRunning('s2', true);
  markQueryRunning('s1', false);
  states = lastStates();
  assert.equal(states.length, 2);
  const s1 = states.find((s) => s.sessionId === 's1');
  const s2 = states.find((s) => s.sessionId === 's2');
  assert.equal(s1?.idle, true);
  assert.equal(s2?.idle, false);
  check('multi-session states aggregated', true);

  // waiting 来源：markSessionWaiting 写入，isSessionWaiting 读取
  assert.equal(isSessionWaiting('s2'), false, 'waiting defaults to false');
  markSessionWaiting('s2', true);
  states = lastStates();
  assert.equal(states.find((s) => s.sessionId === 's2')?.waiting, true);
  assert.equal(isSessionWaiting('s2'), true);
  assert.equal(isSessionWaiting('s1'), false);
  check('waiting propagated', true);

  // waiting 是独立来源：query 开始 / 结束不清掉它
  markQueryRunning('s2', true);
  assert.equal(isSessionWaiting('s2'), true, 'markQueryRunning keeps waiting');
  check('markQueryRunning keeps waiting', true);

  // 无变化不推
  const countBefore = testBus.count('sessionRuntimeChanged');
  markSessionWaiting('s2', true);
  markQueryRunning('s1', false);
  assert.equal(testBus.count('sessionRuntimeChanged'), countBefore);
  check('no-change does not push', true);

  // dropSessionRuntime
  dropSessionRuntime('s2');
  states = lastStates();
  assert.equal(states.find((s) => s.sessionId === 's2'), undefined);
  assert.equal(getSessionRuntimeStates().length, 1);
  check('dropSessionRuntime removes entry', true);

  // 递归子代理：只有「非 idle 的子代理」才让父会话非 idle（已注册但空闲不算）
  subAgentRegistry.register('child-1', {} as never, {} as never, 'parent-1');
  let parent = getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1');
  assert.equal(parent?.idle, true, 'registered but idle sub-agent keeps parent idle');
  markQueryRunning('child-1', true);
  parent = getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1');
  assert.equal(parent?.idle, false, 'running sub-agent makes parent non-idle');
  markQueryRunning('child-1', false);
  parent = getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1');
  assert.equal(parent?.idle, true, 'sub-agent back to idle → parent idle');
  subAgentRegistry.unregister('child-1');
  parent = getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1');
  assert.equal(parent?.idle, true, 'unregistered sub-agent keeps parent idle');
  check('recursive sub-agent idle', true);

  // 清空全部
  resetSessionRuntime();
  assert.equal(getSessionRuntimeStates().length, 0);
  check('resetSessionRuntime clears all', true);

  resetGlobalEventBus();
  finish();
}

runTests('sessionRuntime', run);
