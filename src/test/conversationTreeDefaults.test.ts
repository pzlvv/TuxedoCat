/**
 * 单测：对话树子代理默认展开规则（specs/006 FR-003 / AC-5、AC-6）。
 *
 * webview 对话树与 Electron 原生侧栏对话树共用 `src/host/ui/conversationTreeDefaults.ts`
 * 的阈值——两处各写一份必然漂移，这里锁死边界值（4 展开 / 5 折叠）。
 *
 * 运行方式：npm run test:all -- conversation-tree-defaults
 */

import { createChecker, runTests } from './helpers/harness';
import {
  SUBAGENT_AUTO_EXPAND_LIMIT,
  shouldAutoExpandSubSessions,
} from '../host/ui/conversationTreeDefaults';

function run(): void {
  const { check, finish } = createChecker();

  check('阈值恰为 5', SUBAGENT_AUTO_EXPAND_LIMIT === 5);
  check('0 个子会话默认展开', shouldAutoExpandSubSessions(0));
  check('4 个子会话默认展开（上限前一位）', shouldAutoExpandSubSessions(4));
  check('5 个子会话不默认展开（达到上限）', !shouldAutoExpandSubSessions(5));
  check('6 个子会话不默认展开（超过上限）', !shouldAutoExpandSubSessions(6));

  finish();
}

runTests('conversation-tree-defaults', run);
