/**
 * 单测（TODO #11）：webview 的 `updateConversationContext` 消息翻译为
 * `UiEvent.conversationContextUpdated` 走总线，而不是直接调 core 的
 * `history.updateConversationContext`。
 *
 * - 扁平字段 → `changes` 数组的映射
 * - 未携带的字段不进入 changes（保持 meta.json 原值）
 *
 * 运行方式：npm run test:all -- conversation-context-event
 */

import * as assert from 'assert';
import { createEventBus } from '../host/EventBus';
import {
  setGlobalEventBus,
  resetGlobalEventBus,
  type UiEvent,
} from '../core/AssistantEventBus';
import type { UIHost } from '../host/UIHost';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import { createChecker, runTests } from './helpers/harness';
import { applySettingsSnapshot } from '../core/settings';
import { resolveSettingsSnapshot } from '../core/settingsSnapshot';

type ContextUpdated = Extract<UiEvent, { type: 'conversationContextUpdated' }>;

function buildHandler(): { handler: WebviewMessageHandler; received: ContextUpdated[]; bus: ReturnType<typeof createEventBus> } {
  const bus = createEventBus();
  setGlobalEventBus(bus);
  const received: ContextUpdated[] = [];
  bus.onUiEvent('conversationContextUpdated', (e) => received.push(e));
  // Core 就绪：就绪前只接受 hostEnvironmentProvided（docs/core-ui-separation.md 第 7 节）。
  // 本用例的总线没有注册 core 侧订阅，因此直接调 core 侧的唯一写入口置位就绪。
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  const userChoiceManager = new UserChoiceManager({
    outputChannel: undefined,
    postToWebview: () => undefined,
    closePreview: () => undefined,
    isSessionOpenInternal: () => false,
  });

  const handler = new WebviewMessageHandler({
    host: { log: () => undefined } as unknown as UIHost,
    postToWebview: () => undefined,
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager,
  });

  return { handler, received, bus };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // 全字段：currentFile + selectedLines + totalContextTokens
  {
    const { handler, received } = buildHandler();
    await handler.handleWebviewMessage({
      type: 'updateConversationContext',
      sessionId: 's1',
      currentFile: 'a.ts',
      selectedLines: { start: 3, end: 8 },
      totalContextTokens: 1234,
    });
    assert.equal(received.length, 1, 'emits one UiEvent');
    assert.deepEqual(received[0], {
      type: 'conversationContextUpdated',
      sessionId: 's1',
      changes: [
        { key: 'currentFile', value: 'a.ts' },
        { key: 'selectedLines', value: { start: 3, end: 8 } },
        { key: 'totalContextTokens', value: 1234 },
      ],
    });
    check('flat fields mapped to changes array', true);
    resetGlobalEventBus();
  }

  // 部分字段：只带 currentFile，其余不进入 changes
  {
    const { handler, received } = buildHandler();
    await handler.handleWebviewMessage({
      type: 'updateConversationContext',
      sessionId: 's2',
      currentFile: 'b.ts',
    });
    assert.deepEqual(received[0].changes, [{ key: 'currentFile', value: 'b.ts' }]);
    check('absent fields stay out of changes', true);
    resetGlobalEventBus();
  }

  // 清空语义：显式 null 进入 changes（totalContextTokens 为 0 也保留）
  {
    const { handler, received } = buildHandler();
    await handler.handleWebviewMessage({
      type: 'updateConversationContext',
      sessionId: 's3',
      currentFile: null,
      selectedLines: null,
      totalContextTokens: 0,
    });
    assert.deepEqual(received[0].changes, [
      { key: 'currentFile', value: null },
      { key: 'selectedLines', value: null },
      { key: 'totalContextTokens', value: 0 },
    ]);
    check('explicit null / zero are preserved', true);
    resetGlobalEventBus();
  }

  finish();
}

runTests('conversationContextEvent', run);
