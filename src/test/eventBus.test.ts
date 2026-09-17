/**
 * EventBus 单测（阶段 1.6 随附）：
 * - onCoreEvents / onCoreRequests 注册与分发
 * - 重复注册抛错
 * - emitToUi 未注册处理器抛错
 * - emitToCore 无订阅者静默丢弃；订阅后分发
 * - request 类型对应
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/eventBus.test.js
 */

import { createEventBus } from '../host/EventBus';
import { setGlobalEventBus, requireEventBus, resetGlobalEventBus, type CoreEventHandlers, type UiEvent } from '../core/AssistantEventBus';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function buildHandlers(): { handlers: CoreEventHandlers; seen: string[] } {
  const seen: string[] = [];
  const handlers: CoreEventHandlers = {
    message: (e: { sessionId: string }) => { seen.push(`message:${e.sessionId}`); },
    streamMessage: (_e: unknown) => { seen.push('streamMessage'); },
    streamEnd: (_e: unknown) => { seen.push('streamEnd'); },
    toolCall: (_e: unknown) => { seen.push('toolCall'); },
    toolResult: (_e: unknown) => { seen.push('toolResult'); },
    toolArgsUpdated: (_e: unknown) => { seen.push('toolArgsUpdated'); },
    toolProgress: (_e: unknown) => { seen.push('toolProgress'); },
    aiBegin: (_e: unknown) => { seen.push('aiBegin'); },
    aiEnd: (_e: unknown) => { seen.push('aiEnd'); },
    messagesReplaced: (_e: unknown) => { seen.push('messagesReplaced'); },
    queryBegin: (_e: unknown) => { seen.push('queryBegin'); },
    queryEnd: (_e: unknown) => { seen.push('queryEnd'); },
    titleChanged: (e: { title: string }) => { seen.push(`titleChanged:${e.title}`); },
    sessionCreated: (_e: unknown) => { seen.push('sessionCreated'); },
    conversationListChanged: (_e: unknown) => { seen.push('conversationListChanged'); },
    sessionRuntimeChanged: (_e: unknown) => { seen.push('sessionRuntimeChanged'); },
    spinDesignDataChanged: (_e: unknown) => { seen.push('spinDesignDataChanged'); },
    highlightLanguagesUsed: (_e: unknown) => { seen.push('highlightLanguagesUsed'); },
    projectConversationDirReady: (_e: unknown) => { seen.push('projectConversationDirReady'); },
    compactBegin: (_e: unknown) => { seen.push('compactBegin'); },
    compactEnd: (_e: unknown) => { seen.push('compactEnd'); },
    commandDispatched: (_e: unknown) => { seen.push('commandDispatched'); },
    sessionConfigChanged: (_e: unknown) => { seen.push('sessionConfigChanged'); },
  };
  return { handlers, seen };
}

async function run(): Promise<void> {
  const bus = createEventBus();

  // ---- 注册前 emitToUi 抛错 ----
  check('emitToUi before onCoreEvents throws', throws(() => {
    bus.emitToUi({ type: 'aiBegin', sessionId: 's1' });
  }));

  // ---- 正常分发 ----
  const { handlers, seen } = buildHandlers();
  const off = bus.onCoreEvents(handlers);

  bus.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  });

  bus.emitToUi({ type: 'message', sessionId: 's1', data: { role: 'user', content: 'hi' } });
  bus.emitToUi({ type: 'titleChanged', sessionId: 's1', title: 'T' });
  check('events dispatched', seen.includes('message:s1') && seen.includes('titleChanged:T'));

  // ---- 重复注册抛错 ----
  check('duplicate onCoreEvents throws', throws(() => bus.onCoreEvents(buildHandlers().handlers)));
  check('duplicate onCoreRequests throws', throws(() => bus.onCoreRequests({
    toolPermissionRequested: async () => ({ behavior: 'allow' }),
    userChoice: async () => ({ index: 0 }),
  })));

  // ---- 取消订阅后再发事件抛错 ----
  off();
  check('emitToUi after unsubscribe throws', throws(() => {
    bus.emitToUi({ type: 'aiEnd', sessionId: 's1' });
  }));

  // ---- UI → core：无订阅者静默丢弃 ----
  bus.emitToCore({ type: 'abortRequested', sessionId: 's1' } as UiEvent);
  check('emitToCore without subscriber is silent', true);

  // ---- UI → core：订阅后可达 ----
  let received: UiEvent | undefined;
  const offCore = bus.onUiEvent('conversationDeleted', (e) => { received = e; });
  bus.emitToCore({ type: 'conversationDeleted', sessionId: 's9' });
  check('emitToCore reaches subscriber', (received as any)?.sessionId === 's9');

  // ---- 取消订阅后不再收到 ----
  offCore();
  received = undefined;
  bus.emitToCore({ type: 'conversationDeleted', sessionId: 's8' });
  check('unsubscribed UiEvent dropped', received === undefined);

  // ---- request 类型对应 ----
  const p = await handle(bus.request({ type: 'toolPermissionRequested', sessionId: 's1', toolUseId: 't1', toolName: 'Bash', permResult: { behavior: 'ask' }, displayArgs: {}, agentMode: 'manual' }));
  check('request(toolPermissionRequested) returns PermissionResult', (p as { behavior: string }).behavior === 'allow');

  const choice = await handle(bus.request({ type: 'userChoice', sessionId: 's1', options: { toolName: 'Bash', message: 'm', choices: [] } }));
  check('request(userChoice) returns index', (choice as { index: number }).index === 0);

  // ---- 全局注册 ----
  check('requireEventBus throws before set', throws(() => requireEventBus()));
  setGlobalEventBus(bus);
  check('requireEventBus returns bus after set', requireEventBus() === bus);
  check('duplicate setGlobalEventBus throws', throws(() => setGlobalEventBus(bus)));
  resetGlobalEventBus();
  check('requireEventBus throws after reset', throws(() => requireEventBus()));

  console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}（${passed} 通过 / ${failed} 失败）`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

function handle<T>(p: Promise<T>): Promise<T> {
  return p;
}

void run();
