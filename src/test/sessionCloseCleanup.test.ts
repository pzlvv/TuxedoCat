/**
 * 单测（TODO #12）：会话关闭 / 删除时清理 core 的 `sessionRuntime` 状态，
 * 避免侧栏黄灯 / 托盘状态点在会话消失后残留。
 *
 * - `sessionResources.releaseSessionResources`（`conversationClosed` 消费方）
 * - `history.deleteConversation`（`conversationDeleted` 消费方）
 *
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/sessionCloseCleanup.test.js
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEventBus } from '../host/EventBus';
import {
  setGlobalEventBus,
  resetGlobalEventBus,
  type CoreEventHandlers,
  type SessionRuntimeState,
} from '../core/AssistantEventBus';
import {
  markQueryRunning,
  getSessionRuntimeStates,
  resetSessionRuntime,
} from '../core/sessionRuntime';
import { releaseSessionResources } from '../core/sessionResources';
import { setProjectRootProvider } from '../core/history/index';

function buildBus(): ReturnType<typeof createEventBus> {
  const bus = createEventBus();
  const noop = (): void => undefined;
  const handlers: CoreEventHandlers = {
    message: noop,
    streamMessage: noop,
    streamEnd: noop,
    toolCall: noop,
    toolResult: noop,
    toolArgsUpdated: noop,
    toolProgress: noop,
    aiBegin: noop,
    aiEnd: noop,
    messagesReplaced: noop,
    queryBegin: noop,
    queryEnd: noop,
    titleChanged: noop,
    sessionCreated: noop,
    conversationListChanged: noop,
    sessionRuntimeChanged: (_e: { states: readonly SessionRuntimeState[] }) => undefined,
    spinDesignDataChanged: noop,
    highlightLanguagesUsed: noop,
    projectConversationDirReady: noop,
    compactBegin: noop,
    compactEnd: noop,
    commandDispatched: noop,
    sessionConfigChanged: noop,
  };
  bus.onCoreEvents(handlers);
  bus.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  });
  return bus;
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) { passed++; console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name}`); }
  };

  // 需要一个可写的工作区，deleteConversation 会读写项目对话目录
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-session-cleanup-'));
  setProjectRootProvider(() => projectRoot);

  const bus = buildBus();
  setGlobalEventBus(bus);
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
  fs.rmSync(projectRoot, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}（${passed} 通过 / ${failed} 失败）`);
  if (failed > 0) process.exitCode = 1;
}

void run();
