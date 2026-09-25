/**
 * EventBus 单测（阶段 1.6 随附）：
 * - onCoreEvents / onCoreRequests 注册与分发
 * - 重复注册抛错
 * - emitToUi 未注册处理器抛错
 * - emitToCore 无订阅者静默丢弃；订阅后分发
 * - request 类型对应
 * 运行方式：npm run test:all -- event-bus
 */

import { createEventBus } from '../host/EventBus';
import {
  setGlobalEventBus,
  requireEventBus,
  resetGlobalEventBus,
  type UiEvent,
} from '../core/AssistantEventBus';
import { createChecker, runTests } from './helpers/harness';
import { makeTestBus } from './helpers/fixtures';

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---- 注册前 emitToUi 抛错 ----
  const bare = createEventBus();
  check('emitToUi before onCoreEvents throws', throws(() => {
    bare.emitToUi({ type: 'aiBegin', sessionId: 's1' });
  }));

  // ---- 正常分发 ----
  const { bus, received, unsubscribeCoreEvents } = makeTestBus();

  bus.emitToUi({ type: 'message', sessionId: 's1', data: { role: 'user', content: 'hi' } });
  bus.emitToUi({ type: 'titleChanged', sessionId: 's1', title: 'T' });
  check(
    'events dispatched',
    received('message')[0]?.sessionId === 's1' && received('titleChanged')[0]?.title === 'T',
  );

  // ---- 重复注册抛错 ----
  // 重新造一份处理器即可（内容无关，只为触发「已注册」这条路径）
  check('duplicate onCoreEvents throws', throws(() => bus.onCoreEvents(makeTestBus().handlers)));
  check('duplicate onCoreRequests throws', throws(() => bus.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  })));

  // ---- 取消订阅后再发事件抛错 ----
  unsubscribeCoreEvents();
  check('emitToUi after unsubscribe throws', throws(() => {
    bus.emitToUi({ type: 'aiEnd', sessionId: 's1' });
  }));

  // ---- UI → core：无订阅者静默丢弃 ----
  bus.emitToCore({ type: 'abortRequested', sessionId: 's1' } as UiEvent);
  check('emitToCore without subscriber is silent', true);

  // ---- UI → core：订阅后可达 ----
  let delivered: Extract<UiEvent, { type: 'conversationDeleted' }> | undefined;
  const offCore = bus.onUiEvent('conversationDeleted', (e) => { delivered = e; });
  bus.emitToCore({ type: 'conversationDeleted', sessionId: 's9' });
  check('emitToCore reaches subscriber', delivered?.sessionId === 's9');

  // ---- 取消订阅后不再收到 ----
  offCore();
  delivered = undefined;
  bus.emitToCore({ type: 'conversationDeleted', sessionId: 's8' });
  check('unsubscribed UiEvent dropped', delivered === undefined);

  // ---- request 类型对应（makeTestBus 默认：放行 / 选第 0 项） ----
  const permission = await bus.request({
    type: 'toolPermissionRequested',
    sessionId: 's1',
    toolUseId: 't1',
    toolName: 'Bash',
    permResult: { behavior: 'ask' },
    displayArgs: {},
    agentMode: 'manual',
  });
  check('request(toolPermissionRequested) returns PermissionResult', permission.behavior === 'allow');

  const choice = await bus.request({
    type: 'userChoice',
    sessionId: 's1',
    options: { toolName: 'Bash', message: 'm', choices: [] },
  });
  check('request(userChoice) returns index', choice.index === 0);

  // ---- 全局注册 ----
  check('requireEventBus throws before set', throws(() => requireEventBus()));
  setGlobalEventBus(bus);
  check('requireEventBus returns bus after set', requireEventBus() === bus);
  check('duplicate setGlobalEventBus throws', throws(() => setGlobalEventBus(bus)));
  resetGlobalEventBus();
  check('requireEventBus throws after reset', throws(() => requireEventBus()));

  finish();
}

runTests('eventBus', run);
