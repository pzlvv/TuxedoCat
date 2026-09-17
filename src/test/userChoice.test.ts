/**
 * UserChoiceManager.dropSession 单测（DEVELOPMENT.md 第 10.5 节）：
 * - 清掉该会话挂起的用户选择回调，不影响其它会话
 * - diff 快照只在归属该会话时清空
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/userChoice.test.js
 */

import * as assert from 'assert';
import { UserChoiceManager } from '../host/ui/userChoice';

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) { passed++; console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name}`); }
  };

  const manager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: () => undefined,
    closePreview: () => undefined,
    getActiveSessionIdInternal: () => undefined,
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void run();
