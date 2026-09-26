/**
 * 单测（TODO #12）：会话关闭 / 删除时清理 core 的 `sessionRuntime` 状态，
 * 避免侧栏黄灯 / 托盘状态点在会话消失后残留。
 *
 * - `sessionResources.releaseSessionResources`（`conversationClosed` 消费方）
 * - `history.deleteConversation`（`conversationDeleted` 消费方）
 *
 * 运行方式：npm run test:all -- session-close-cleanup
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import {
  markQueryRunning,
  getSessionRuntimeStates,
  resetSessionRuntime,
} from '../core/sessionRuntime';
import { releaseSessionResources } from '../core/sessionResources';
import { setActiveWorkspace } from '../core/history/index';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir, makeTestBus } from './helpers/fixtures';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 需要一个可写的工作区，deleteConversation 会读写项目对话目录
  const projectRoot = makeTempDir('session-cleanup');
  setActiveWorkspace(projectRoot);

  setGlobalEventBus(makeTestBus().bus);
  resetSessionRuntime();

  // releaseSessionResources：conversationClosed 的消费方
  markQueryRunning('s1', true);
  assert.equal(getSessionRuntimeStates().length, 1);
  await releaseSessionResources('s1');
  assert.equal(
    getSessionRuntimeStates().find((s) => s.sessionId === 's1'),
    undefined,
    'releaseSessionResources drops sessionRuntime state',
  );
  check('releaseSessionResources drops sessionRuntime state', true);

  // deleteConversation：conversationDeleted 的消费方
  const { deleteConversation } = await import('../core/history/index');
  markQueryRunning('s2', true);
  assert.equal(getSessionRuntimeStates().find((s) => s.sessionId === 's2')?.idle, false);
  await deleteConversation('s2');
  assert.equal(
    getSessionRuntimeStates().find((s) => s.sessionId === 's2'),
    undefined,
    'deleteConversation drops sessionRuntime state',
  );
  check('deleteConversation drops sessionRuntime state', true);

  resetSessionRuntime();
  resetGlobalEventBus();

  finish();
}

runTests('sessionCloseCleanup', run);
