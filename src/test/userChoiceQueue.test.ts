/**
 * UserChoiceQueue 投递语义单测（open 判定）：
 * - 会话 open：enqueue 立即投递（onShowUserChoice）
 * - 会话未 open：只登记 pending，等会话 open（onSessionLoaded）时再投递
 * - 同会话新请求替换旧请求：旧 Promise 被 reject
 * - respond 移除 pending 并 resolve
 * 运行方式：npm run test:all -- user-choice-queue
 */

import * as assert from 'assert';
import { userChoiceQueue, type UserChoiceOptions } from '../shared/UserChoiceQueue';
import { createChecker, runTests } from './helpers/harness';

const options: UserChoiceOptions = {
  toolName: 'Bash',
  message: '确认执行',
  choices: [{ label: '允许' }, { label: '拒绝' }],
};

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const shown: string[] = [];
  const restored: string[] = [];
  let open = false;

  userChoiceQueue.setCallbacks({
    onShowUserChoice: (sessionId) => shown.push(sessionId),
    onSessionLoaded: (sessionId) => restored.push(sessionId),
    isSessionOpen: () => open,
  });

  // 1) 会话未 open：只登记 pending，不投递
  const p1 = userChoiceQueue.enqueue('s1', options);
  assert.equal(shown.length, 0);
  check('closed session: not shown on enqueue', true);
  assert.equal(userChoiceQueue.hasPendingChoice('s1'), true);
  check('closed session: pending registered', true);

  // 2) 会话 open（宿主在视图创建 / 切换到该会话后调用 onSessionLoaded）：通知宿主投递
  userChoiceQueue.onSessionLoaded('s1');
  assert.deepEqual(restored, ['s1']);
  check('session loaded: dispatches pending choice', true);

  const r1 = userChoiceQueue.respond('s1', { index: 1 });
  assert.equal(r1, true);
  assert.equal((await p1).index, 1);
  check('respond resolves pending choice', true);

  // 3) 已 open 的会话：enqueue 立即投递
  open = true;
  const p2 = userChoiceQueue.enqueue('s2', options);
  assert.deepEqual(shown, ['s2']);
  check('open session: shown immediately', true);

  const r2 = userChoiceQueue.respond('s2', { index: 0 });
  assert.equal(r2, true);
  assert.equal((await p2).index, 0);
  assert.equal(userChoiceQueue.hasPendingChoice('s2'), false);
  check('respond clears pending state', true);

  // 4) 同会话新请求替换旧请求：旧 Promise 被 reject
  const p3 = userChoiceQueue.enqueue('s3', options);
  const p4 = userChoiceQueue.enqueue('s3', options);
  let replacedRejected = false;
  await p3.catch(() => {
    replacedRejected = true;
  });
  assert.equal(replacedRejected, true);
  assert.equal(userChoiceQueue.hasPendingChoice('s3'), true);
  check('replacement rejects the replaced pending choice', true);

  userChoiceQueue.rejectPending('s3', new Error('session closed'));
  let rejectedReason = '';
  await p4.catch((err: Error) => {
    rejectedReason = err.message;
  });
  assert.equal(rejectedReason, 'session closed');
  assert.equal(userChoiceQueue.hasPendingChoice('s3'), false);
  check('rejectPending rejects and clears pending state', true);

  // 5) 没有 pending 的会话调用 onSessionLoaded：不通知宿主
  const restoredBefore = restored.length;
  userChoiceQueue.onSessionLoaded('s4');
  assert.equal(restored.length, restoredBefore);
  check('no pending: onSessionLoaded does not dispatch', true);

  userChoiceQueue.clear();
  finish();
}

runTests('userChoiceQueue', run);
