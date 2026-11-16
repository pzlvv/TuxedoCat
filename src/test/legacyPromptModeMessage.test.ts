/**
 * 旧版宿主 / 旧版 webview 发来的已删除消息按未知消息忽略
 * （specs/049-bash-restricted-and-prompt-mode-removal FR-007 / AC-18）。
 *
 * `setPromptMode` 已从 `WebviewToHostMessage` 联合类型删除：老版本 webview 仍可能发它，
 * 宿主必须**静默忽略**——不翻译成任何 `UiEvent`（因此不会写 `meta.json`）、不回执、
 * 不落 `settings.json`。本用例锁的是「删了 wire 类型之后，运行期不会因为旧消息炸掉
 * 或产生副作用」。
 *
 * 运行方式：npm run test:unit -- legacyPromptModeMessage
 */

import { createChecker, runTests } from './helpers/harness';
import { createTestHost, makeTestBus } from './helpers/fixtures';
import { UserChoiceManager } from '../host/ui/userChoice';
import { WebviewMessageHandler } from '../host/ui/webviewMessageHandler';
import type { UiEvent } from '../shared/AssistantEventBus';
import { applySettingsSnapshot } from '../shared/settings';
import { resolveSettingsSnapshot } from '../shared/settingsSnapshot';
import { resetGlobalEventBus, setGlobalEventBus } from '../shared/AssistantEventBus';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const { bus } = makeTestBus();
  setGlobalEventBus(bus);
  // Core 就绪：就绪前只接受 hostEnvironmentProvided（docs/architecture/core-ui-separation.md 第 7 节）
  applySettingsSnapshot(resolveSettingsSnapshot({}), []);

  // 记录所有经过总线的 UiEvent：任何翻译都会在这里留下痕迹
  const uiEvents: UiEvent[] = [];
  const watched: UiEvent['type'][] = [
    'agentModeChanged',
    'webSearchChanged',
    'mcpEnabledChanged',
    'mcpEnabledListChanged',
    'modelChanged',
  ];
  for (const type of watched) {
    bus.onUiEvent(type, (event) => {
      uiEvents.push(event as UiEvent);
    });
  }

  let settingsWrites = 0;
  const host = createTestHost({
    updateSettingsJson: async () => {
      settingsWrites += 1;
    },
  });
  const posted: unknown[] = [];
  const handler = new WebviewMessageHandler({
    host,
    postToWebview: (_sessionId, message) => {
      posted.push(message);
    },
    postConversationLoaded: () => undefined,
    setTitle: () => undefined,
    userChoiceManager: new UserChoiceManager({
      outputChannel: undefined,
      postToWebview: () => undefined,
      closePreview: () => undefined,
      isSessionOpenInternal: () => false,
    }),
  });

  // 旧版 webview 的载荷形态（字段已从联合类型删除，运行期原样到达）
  const legacy = { type: 'setPromptMode', sessionId: 's-legacy', mode: 'minimal' };
  let threw = false;
  try {
    await handler.handleWebviewMessage(legacy as unknown as { type: 'setPromptMode' });
  } catch {
    threw = true;
  }

  check('未知消息不抛错（按未知消息忽略）', !threw);
  check('未知消息不翻译成任何 UiEvent（因此不写 meta.json）', uiEvents.length === 0);
  check('未知消息不回执 webview', posted.length === 0);
  check('未知消息不落 settings.json', settingsWrites === 0);

  resetGlobalEventBus();
  finish();
}

runTests('legacyPromptModeMessage', run);
