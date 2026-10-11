/**
 * releaseConversation 对临时 `new-` key 的处理（docs/webview-ui.md 第 1 节）：
 *
 * 新建对话在 webview 上报正式 sessionId 前用 `new-<timestamp>` 临时 key。
 * core 从未拥有这样的会话（releaseSessionResources 对它本就是 no-op），
 * 所以「卸内存」不能给它发 `conversationClosed`——多连接宿主里 Client 按会话
 * 路由查不到归属会直接抛错（`docs/client-connection.md` 第 6 节），实测在
 * 「多个工作区标签 + 未发消息的新对话」下关工作区崩主进程。
 *
 * 运行方式：npm run test:all -- release-conversation-temp-key
 */

import * as assert from 'assert';
import { createEventBus } from '../host/EventBus';
import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequest,
  CoreRequestHandlers,
  CoreRequestResultMap,
  UiEvent,
  UiRequest,
  UiRequestHandlers,
  UiRequestResultMap,
  Unsubscribe,
} from '../core/AssistantEventBus';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import type { ConversationMetadata } from '../core/history/Conversation';
import type { SessionRuntimeState } from '../core/AssistantEventBus';
import { WebViewUI } from '../host/WebViewUI';
import { ConversationManager } from '../host/ConversationManager';
import { UserChoiceManager } from '../host/ui/userChoice';
import { applyTestSettings, createTestHost, type TestHost } from './helpers/fixtures';
import { createChecker, runTests } from './helpers/harness';

/** 记录 UI → core 事件的包装总线：只观察 emitToCore，其余全部转调 */
class RecordingBus implements AssistantEventBus {
  readonly emittedUiEvents: UiEvent[] = [];
  constructor(private readonly inner: AssistantEventBus) {}
  emitToUi(event: CoreEvent): void {
    this.inner.emitToUi(event);
  }
  request<T extends CoreRequest['type']>(
    request: Extract<CoreRequest, { type: T }>,
  ): Promise<CoreRequestResultMap[T]> {
    return this.inner.request(request);
  }
  onCoreEvents(handlers: CoreEventHandlers): Unsubscribe {
    return this.inner.onCoreEvents(handlers);
  }
  onCoreRequests(handlers: CoreRequestHandlers): void {
    this.inner.onCoreRequests(handlers);
  }
  emitToCore(event: UiEvent): void {
    this.emittedUiEvents.push(event);
    this.inner.emitToCore(event);
  }
  onUiEvent<T extends UiEvent['type']>(
    type: T,
    handler: (event: Extract<UiEvent, { type: T }>) => void,
  ): Unsubscribe {
    return this.inner.onUiEvent(type, handler);
  }
  requestCore<T extends UiRequest['type']>(
    request: Extract<UiRequest, { type: T }>,
  ): Promise<UiRequestResultMap[T]> {
    return this.inner.requestCore(request);
  }
  onUiRequests(handlers: UiRequestHandlers): void {
    this.inner.onUiRequests(handlers);
  }
  closedOf(type: UiEvent['type']): UiEvent[] {
    return this.emittedUiEvents.filter((e) => e.type === type);
  }
}

/** ConversationManager 的空实现：本测试只走 releaseConversation，不分发列表 / 状态 */
class StubConversations extends ConversationManager {
  protected async dispatchList(_list: readonly ConversationMetadata[]): Promise<void> {}
  protected dispatchStates(_states: readonly SessionRuntimeState[]): void {}
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const bus = new RecordingBus(createEventBus());
  setGlobalEventBus(bus);
  try {
    const host: TestHost = createTestHost();
    const ui = WebViewUI.create(host, bus, {
      open: async () => undefined,
      refresh: async () => undefined,
    }, new StubConversations(host), {
      createUserChoiceManager: (post, closePreview) =>
        new UserChoiceManager({
          outputChannel: undefined,
          postToWebview: post,
          closePreview,
          isSessionOpenInternal: () => false,
        }),
      log: () => undefined,
    });

    // 临时 new- key：不发 conversationClosed（core 从未拥有该会话）
    ui.releaseConversation('new-1791084932126-5');
    assert.strictEqual(bus.closedOf('conversationClosed').length, 0);
    check('temp new- key emits no conversationClosed', true);

    // core 就绪门禁的判据是「配置快照已应用」（docs/core-ui-separation.md 第 7 节）
    applyTestSettings({});
    bus.emittedUiEvents.length = 0;

    // 正式 sessionId：照发 conversationClosed（core 卸内存）
    ui.releaseConversation('real-session-id');
    const closed = bus.closedOf('conversationClosed');
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(
      (closed[0] as { sessionId: string }).sessionId,
      'real-session-id',
    );
    check('real sessionId still emits conversationClosed', true);
  } finally {
    resetGlobalEventBus();
  }
  finish();
}

runTests('release-conversation-temp-key', run);
