/**
 * 待答选择投递路径单测（Standalone 的 `CoreRequest.userChoice`）：
 * - 会话未 open（单视图下不是当前会话，典型是子代理发起的提问）时不弹框、保留 pending；
 * - 用户切到该会话（`onSessionLoaded`）后补投 `requestUserChoice`；
 * - 会话已 open 时立即弹框；
 * - 会话释放时挂起的队列项被拒绝（Standalone 的 Core 进程不持有宿主队列，由 dropSession 补齐）。
 * 运行方式：npm run test:all -- user-choice-delivery
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../shared/AssistantEventBus';
import { userChoiceQueue, type UserChoiceOptions, type UserChoiceResult } from '../shared/UserChoiceQueue';
import { UserChoiceManager } from '../host/ui/userChoice';
import { createChecker, runTests } from './helpers/harness';
import { applySettingsSnapshot } from '../shared/settings';
import { resolveSettingsSnapshot } from '../shared/settingsSnapshot';
import { makeTestBus } from './helpers/fixtures';

const options: UserChoiceOptions = {
  kind: 'permission',
  toolName: 'AskUserQuestion',
  message: '选一个',
  choices: [{ label: 'A' }, { label: 'B' }],
};

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  // Core 就绪：就绪前只接受 hostEnvironmentProvided（docs/architecture/core-ui-separation.md 第 7 节）。
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  let activeSession = 'parent';
  const posted: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
  const manager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: (sessionId, message) => posted.push({ sessionId, message }),
    closePreview: () => undefined,
    isSessionOpenInternal: (sessionId) => sessionId === activeSession,
  });
  manager.initUserChoiceQueue();

  const choicePosts = (): Array<{ sessionId: string; message: Record<string, unknown> }> =>
    posted.filter((entry) => entry.message.type === 'requestUserChoice');

  /** 模拟 WebviewMessageHandler.handleRespondUserChoice：队列 resolve + 弹框回调 resolve */
  const respond = (sessionId: string, index: number): void => {
    for (const [choiceId, entry] of manager.pendingUserChoices) {
      if (entry.sessionId !== sessionId) continue;
      manager.pendingUserChoices.delete(choiceId);
      const result: UserChoiceResult = { kind: 'permission', index, reply: null };
      userChoiceQueue.respond(sessionId, result);
      entry.resolve(result);
      return;
    }
    throw new Error(`no pending dialog for ${sessionId}`);
  };

  const permissionIndex = async (promise: Promise<UserChoiceResult>): Promise<number> => {
    const result = await promise;
    assert.equal(result.kind, 'permission');
    return result.kind === 'permission' ? result.index : -1;
  };

  // 1) 子代理会话不在前台：不弹框，保留 pending
  const childRequest = manager.requestUserChoice('child', options);
  assert.equal(choicePosts().length, 0);
  assert.equal(userChoiceQueue.hasPendingChoice('child'), true);
  check('closed session: request deferred, no dialog posted', true);

  // 2) 用户切到该会话：onSessionLoaded 补投到该会话
  activeSession = 'child';
  userChoiceQueue.onSessionLoaded('child');
  const restored = choicePosts();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sessionId, 'child');
  assert.equal(restored[0].message.message, '选一个');
  check('session loaded: pending dialog delivered to that session', true);

  // 3) 用户应答：队列 Promise resolve
  respond('child', 1);
  assert.equal(await permissionIndex(childRequest), 1);
  check('respond resolves the deferred request', true);

  // 4) 会话已 open：立即弹框
  activeSession = 'open-now';
  const openRequest = manager.requestUserChoice('open-now', options);
  const afterOpen = choicePosts();
  assert.equal(afterOpen.length, 2);
  assert.equal(afterOpen[1].sessionId, 'open-now');
  check('open session: dialog posted immediately', true);
  respond('open-now', 0);
  assert.equal(await permissionIndex(openRequest), 0);

  // 5) 会话在等待期间被释放：挂起的队列项被拒绝
  const goneRequest = manager.requestUserChoice('gone', options);
  manager.dropSession('gone');
  let rejected = false;
  await goneRequest.catch(() => {
    rejected = true;
  });
  assert.equal(rejected, true);
  assert.equal(userChoiceQueue.hasPendingChoice('gone'), false);
  check('dropSession rejects the deferred request', true);

  resetGlobalEventBus();
  finish();
}

runTests('userChoiceDelivery', run);
