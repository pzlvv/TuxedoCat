/**
 * `conversationLoaded` 载荷构建（`src/host/conversationPayload.ts`）。
 *
 * 覆盖点：会话工作模式随加载载荷下发（specs/016 FR-005）——webview 靠它恢复
 * spin 会话的输入框禁用态（运行期变化走 `setWorkMode`）。
 *
 * 运行方式：npm run test:all -- conversationPayload
 */

import { buildConversationLoadedPayload } from '../host/conversationPayload';
import { createChecker, runTests } from './helpers/harness';

runTests('conversationPayload', () => {
  const { check, finish } = createChecker();

  {
    const payload = buildConversationLoadedPayload(
      's1',
      { messages: [], metadata: { sessionId: 's1', workMode: 'spin' } },
      {
        pendingToolUseIds: [],
        hasActiveQuery: false,
        agentMode: 'auto',
        workMode: 'spin',
      },
    ) as { type: string; workMode?: string };
    check('spin 会话的加载载荷带 workMode=spin', payload.workMode === 'spin');
  }
  {
    const payload = buildConversationLoadedPayload(
      's1',
      { messages: [], metadata: { sessionId: 's1' } },
      {
        pendingToolUseIds: [],
        hasActiveQuery: false,
        workMode: 'normal',
      },
    ) as { type: string; workMode?: string };
    check('普通会话的加载载荷带 workMode=normal（必填，不省略）', payload.workMode === 'normal');
  }

  finish();
});
