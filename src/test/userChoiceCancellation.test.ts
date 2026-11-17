/**
 * userChoice 作废宣告的宿主侧收敛（specs/050 FR-002）。
 *
 * 覆盖：按请求标识拒答队列、reject 已弹出的 Promise、投递收框消息、且**不**补发
 * `userChoicePendingChanged`（`waiting` 的写入点是 Core，宿主重复发就是第二个写入点）。
 *
 * 运行方式：npm run test:unit -- user-choice-cancellation
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../shared/AssistantEventBus';
import { userChoiceQueue, type UserChoiceOptions } from '../shared/UserChoiceQueue';
import { UserChoiceManager } from '../host/ui/userChoice';
import { createChecker, runTests } from './helpers/harness';
import { applySettingsSnapshot } from '../shared/settings';
import { resolveSettingsSnapshot } from '../shared/settingsSnapshot';
import { makeTestBus } from './helpers/fixtures';

const options = (choiceRequestId: string): UserChoiceOptions => ({
  kind: 'permission',
  choiceRequestId,
  toolName: 'Bash',
  message: '确认执行',
  choices: [{ label: '允许' }, { label: '拒绝' }],
});

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  const posted: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const manager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: (sessionId, message) => posted.push({ sessionId, message }),
    closePreview: () => undefined,
    isSessionOpenInternal: () => true,
  });
  manager.initUserChoiceQueue();

  // 记录宿主发往 core 的 UiEvent（userChoicePendingChanged 的通道）
  testBus.bus.onUiEvent('userChoicePendingChanged', (event) => {
    emitted.push(event as unknown as Record<string, unknown>);
  });

  const cancelPosts = (): Array<Record<string, unknown>> =>
    posted.filter((entry) => entry.message.type === 'userChoiceCanceled').map((e) => e.message);

  // ---------- 1) 已弹出的请求被作废：Promise reject + 收框消息 ----------
  const issued = manager.requestUserChoice('s1', options('req-1'));
  assert.equal(manager.pendingUserChoices.size, 1, '弹出后应有 pending 条目');

  manager.cancelUserChoice('s1', 'req-1');

  let rejected = false;
  await issued.catch(() => {
    rejected = true;
  });
  check('作废宣告：reject 掉已弹出的 Promise', rejected);
  check('作废宣告：队列 pending 已清空', userChoiceQueue.hasPendingChoice('s1') === false);
  check('作废宣告：manager 不再持有该条目', manager.pendingUserChoices.size === 0);

  const cancels = cancelPosts();
  check('作废宣告：投递了一条 userChoiceCanceled', cancels.length === 1);
  check(
    '作废宣告：收框消息带同一个 choiceRequestId',
    cancels[0]?.['choiceRequestId'] === 'req-1',
  );

  // `waiting` 由 Core 置位：宿主不补发 false，避免双记账（铁律 4）
  const pendingFalse = emitted.filter((e) => e['pending'] === false);
  check('作废宣告：宿主不补发 userChoicePendingChanged(false)', pendingFalse.length === 0);

  // ---------- 2) 按标识匹配：同会话的新请求不被误杀 ----------
  const first = manager.requestUserChoice('s2', options('req-old'));
  const second = manager.requestUserChoice('s2', options('req-new'));
  await first.catch(() => undefined); // 新请求顶替旧请求，旧的以「被顶替」结束

  // 用旧标识作废：新请求必须仍在
  manager.cancelUserChoice('s2', 'req-old');
  check(
    '按标识匹配：旧标识不误杀同会话的新请求',
    manager.pendingUserChoices.size === 1 &&
      [...manager.pendingUserChoices.values()][0].choiceRequestId === 'req-new',
  );

  // 再用正确标识作废
  manager.cancelUserChoice('s2', 'req-new');
  await second.catch(() => undefined);
  check('按标识匹配：正确标识能作废', manager.pendingUserChoices.size === 0);

  // ---------- 3) 幂等：重复 / 未知标识是 no-op ----------
  const beforeCount = posted.length;
  manager.cancelUserChoice('s1', 'req-1');
  manager.cancelUserChoice('s3', 'req-unknown');
  const extraCancels = posted
    .slice(beforeCount)
    .filter((entry) => entry.message.type === 'userChoiceCanceled');
  check(
    '幂等：重复 / 未知标识仍会发收框消息但不动状态',
    extraCancels.length === 2 && manager.pendingUserChoices.size === 0,
  );

  resetGlobalEventBus();
  finish();
}

runTests('userChoiceCancellation', run);
