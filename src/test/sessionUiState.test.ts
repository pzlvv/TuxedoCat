/**
 * SessionUiState 单测（DEVELOPMENT.md 第 10 节）：
 * - `isQueryActive` 只认本会话**自己的**查询（queryBegin/queryEnd 计数）；
 * - 回归用例：后台子代理让 `sessionRuntime` 的父会话非空闲（idle=false），
 *   但父会话自己的查询判定仍为 false——`conversationLoaded.hasActiveQuery` 必须
 *   用前者之外的这份事实，否则重新加载父会话会误恢复 thinking 动画。
 * 运行方式：npm run test:all -- session-ui-state
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { SessionUiState } from '../host/SessionUiState';
import { markQueryRunning, getSessionRuntimeStates, resetSessionRuntime } from '../core/sessionRuntime';
import { subAgentRegistry } from '../core/tools/agent/SubAgentRegistry';
import { createChecker, runTests } from './helpers/harness';
import { makeTestBus } from './helpers/fixtures';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  resetSessionRuntime();

  const ui = new SessionUiState();

  // 1) begin → active，end → inactive
  assert.equal(ui.isQueryActive('s1'), false);
  ui.beginQuery('s1');
  assert.equal(ui.isQueryActive('s1'), true);
  ui.endQuery('s1');
  assert.equal(ui.isQueryActive('s1'), false);
  check('isQueryActive follows beginQuery / endQuery', true);

  // 2) 嵌套 begin/end：最后一层结束前都算 active
  ui.beginQuery('s1');
  ui.beginQuery('s1');
  ui.endQuery('s1');
  assert.equal(ui.isQueryActive('s1'), true, 'nested begin keeps active');
  ui.endQuery('s1');
  assert.equal(ui.isQueryActive('s1'), false);
  check('nested begin/end stays active until the last end', true);

  // 3) 回归：后台子代理让 sessionRuntime 的父会话非空闲，但不改变父会话自己的查询判定
  markQueryRunning('parent-1', true);
  markQueryRunning('parent-1', false); // 父会话自己这一轮已跑完
  subAgentRegistry.register('child-1', {} as never, {} as never, 'parent-1');
  markQueryRunning('child-1', true); // 子代理还在跑 / 等用户
  const parentRuntime = getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1');
  assert.equal(parentRuntime?.idle, false, 'running sub-agent keeps the parent non-idle');
  assert.equal(ui.isQueryActive('parent-1'), false, 'own query is not active');
  check('background sub-agent does not mark the parent own query active', true);

  // 4) 父会话自己的查询在跑时，两边都为「在跑」
  ui.beginQuery('parent-1');
  assert.equal(ui.isQueryActive('parent-1'), true);
  assert.equal(
    getSessionRuntimeStates().find((s) => s.sessionId === 'parent-1')?.idle,
    false,
  );
  check('own active query is reflected by both facts', true);
  ui.endQuery('parent-1');

  subAgentRegistry.unregister('child-1');
  resetSessionRuntime();
  resetGlobalEventBus();
  finish();
}

runTests('sessionUiState', run);
