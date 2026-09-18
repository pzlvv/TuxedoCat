/**
 * sessionRuntime 单测（阶段 3.6 随附）：
 * - idle/waiting 聚合与 diff（无变化不发事件）
 * - 多会话并发状态
 * - dropSessionRuntime 清理
 * - waiting provider 接入
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/sessionRuntime.test.js
 */

import * as assert from 'assert';
import { createEventBus } from '../host/EventBus';
import {
  setGlobalEventBus,
  resetGlobalEventBus,
  type SessionRuntimeState,
  type CoreEventHandlers,
  type CoreRequestHandlers,
} from '../core/AssistantEventBus';
import {
  markQueryRunning,
  markSessionWaiting,
  dropSessionRuntime,
  getSessionRuntimeStates,
  resetSessionRuntime,
  setSessionRuntimeWaitingProvider,
} from '../core/sessionRuntime';
import { subAgentRegistry } from '../core/tools/agent/SubAgentRegistry';

function buildBus(): { events: Array<{ type: string; payload: unknown }>; bus: ReturnType<typeof createEventBus> } {
  const events: Array<{ type: string; payload: unknown }> = [];
  const bus = createEventBus();
  const handlers: CoreEventHandlers = {
    message: () => undefined,
    streamMessage: () => undefined,
    streamEnd: () => undefined,
    toolCall: () => undefined,
    toolResult: () => undefined,
    toolArgsUpdated: () => undefined,
    toolProgress: () => undefined,
    aiBegin: () => undefined,
    aiEnd: () => undefined,
    messagesReplaced: () => undefined,
    queryBegin: () => undefined,
    queryEnd: () => undefined,
    titleChanged: () => undefined,
    sessionCreated: () => undefined,
    conversationListChanged: () => undefined,
    sessionRuntimeChanged: (e: { states: readonly SessionRuntimeState[] }) => {
      events.push({ type: 'sessionRuntimeChanged', payload: [...e.states] });
    },
    spinDesignDataChanged: () => undefined,
    highlightLanguagesUsed: () => undefined,
    projectConversationDirReady: () => undefined,
    compactBegin: () => undefined,
    compactEnd: () => undefined,
    commandDispatched: () => undefined,
    sessionConfigChanged: () => undefined,
  };
  bus.onCoreEvents(handlers);
  bus.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  } as CoreRequestHandlers);
  return { events, bus };
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) { passed++; console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name}`); }
  };

  const { events, bus } = buildBus();
  setGlobalEventBus(bus);
  resetSessionRuntime();
  setSessionRuntimeWaitingProvider(null);

  // 非 idle 变化推全量
  markQueryRunning('s1', true);
  assert.equal(events.length, 1, 'first change emits');
  let last = events[events.length - 1].payload as SessionRuntimeState[];
  assert.equal(last.length, 1);
  assert.equal(last[0].sessionId, 's1');
  assert.equal(last[0].idle, false);
  assert.equal(last[0].waiting, false);
  check('query running pushes idle=false snapshot', true);

  // 同值重复标记不推事件（diff 后才发）
  markQueryRunning('s1', true);
  assert.equal(events.length, 1);
  check('same value does not push', true);

  // 多会话并发
  markQueryRunning('s2', true);
  markQueryRunning('s1', false);
  last = events[events.length - 1].payload as SessionRuntimeState[];
  assert.equal(last.length, 2);
  const s1 = last.find((s) => s.sessionId === 's1');
  const s2 = last.find((s) => s.sessionId === 's2');
  assert.equal(s1?.idle, true);
  assert.equal(s2?.idle, false);
  check('multi-session states aggregated', true);

  // waiting provider
  setSessionRuntimeWaitingProvider((sid) => sid === 's2');
  markSessionWaiting('s2', true);
  last = events[events.length - 1].payload as SessionRuntimeState[];
  assert.equal(last.find((s) => s.sessionId === 's2')?.waiting, true);
  check('waiting propagated', true);

  // 无变化不推
  const countBefore = events.length;
  markSessionWaiting('s2', true);
  markQueryRunning('s1', false);
  assert.equal(events.length, countBefore);
  check('no-change does not push', true);

  // dropSessionRuntime
  dropSessionRuntime('s2');
  last = events[events.length - 1].payload as SessionRuntimeState[];
  assert.equal(last.find((s) => s.sessionId === 's2'), undefined);
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

  console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}（${passed} 通过 / ${failed} 失败）`);
  if (failed > 0) process.exitCode = 1;

  resetGlobalEventBus();
}

void run();
