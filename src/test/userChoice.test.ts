/**
 * UserChoiceManager.dropSession 单测（docs/hosts/webview-ui.md 第 9 节）：
 * - 清掉该会话挂起的用户选择回调，不影响其它会话
 * - diff 快照只在归属该会话时清空
 * - 清掉已弹出的选择时经总线解除「等待用户」状态
 * 运行方式：npm run test:all -- user-choice
 */

import * as assert from 'assert';
import { setGlobalEventBus, resetGlobalEventBus } from '../shared/AssistantEventBus';
import { UserChoiceManager } from '../host/ui/userChoice';
import { createChecker, runTests } from './helpers/harness';
import { applySettingsSnapshot } from '../shared/settings';
import { resolveSettingsSnapshot } from '../shared/settingsSnapshot';
import { makeTestBus } from './helpers/fixtures';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // UserChoiceManager 经总线上报「等待用户」状态（dropSession 会解除该状态）
  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  // Core 就绪：就绪前只接受 hostEnvironmentProvided（docs/architecture/core-ui-separation.md 第 7 节）。
  // 本用例的总线没有注册 core 侧订阅，因此直接调 core 侧的唯一写入口置位就绪。
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  const manager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: () => undefined,
    closePreview: () => undefined,
    isSessionOpenInternal: () => false,
  });

  // 两个会话各挂一个待答选择回调；s1 拥有 diff 快照
  manager.pendingUserChoices.set('c1', { sessionId: 's1', resolve: () => undefined });
  manager.pendingUserChoices.set('c2', { sessionId: 's2', resolve: () => undefined });
  manager.saveDiffSnapshot('s1', {
    beforeContent: 'before',
    afterContent: 'after',
    contextBefore: ['a'],
    contextAfter: ['b'],
    startLine: 1,
    endLine: 2,
  });

  // 丢弃 s2：只清 s2，不动 s1 的回调与快照
  manager.dropSession('s2');
  assert.equal(manager.hasPendingChoice('s2'), false);
  check('dropSession removes target session pending choice', true);
  assert.equal(manager.hasPendingChoice('s1'), true);
  assert.equal(manager.currentBeforeContent, 'before');
  check('dropSession keeps other session state', true);

  // 丢弃 s1：清掉回调与它拥有的快照
  manager.dropSession('s1');
  assert.equal(manager.hasPendingChoice('s1'), false);
  check('dropSession removes pending choice', true);
  assert.equal(manager.currentBeforeContent, '');
  assert.equal(manager.currentAfterContent, '');
  assert.equal(manager.currentStartLine, undefined);
  assert.equal(manager.currentEndLine, undefined);
  check('dropSession clears owned diff snapshot', true);

  // 快照归属 s2 时丢弃 s1：不应清空
  manager.saveDiffSnapshot('s2', {
    beforeContent: 'b2',
    afterContent: 'a2',
    contextBefore: [],
    contextAfter: [],
  });
  manager.dropSession('s1');
  assert.equal(manager.currentBeforeContent, 'b2');
  check('dropSession does not clear snapshot owned by another session', true);

  resetGlobalEventBus();
  finish();
}

runTests('userChoice', run);
