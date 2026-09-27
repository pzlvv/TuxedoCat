/**
 * 单测：压缩摘要的用户输入历史上限 + 子代理 agent mode 继承。
 *
 * 验证：
 * - `selectUserInputHistory`（src/core/compact/prompt.ts）：
 *   不超过上限原样返回；超过时只保留最早 HEAD 条 + 最后 TAIL 条（默认 4 + 8 = 12）。
 * - `inheritAgentMode` / `inheritAgentModeFrom`（src/core/tools/PermissionPolicy.ts）：
 *   子会话完整继承父会话的 manual / risk / auto；父值缺失时回退 risk。
 *
 * 运行方式：npm run test:all -- compactAgentMode
 */

import { createChecker, runTests } from './helpers/harness';
import type { UserMessage } from '../core/types';
import { selectUserInputHistory } from '../core/compact/prompt';
import {
  inheritAgentMode,
  inheritAgentModeFrom,
  setSessionAgentMode,
  getStoredSessionAgentMode,
} from '../core/tools/PermissionPolicy';

/** 用 uuid 标记原始下标；selectUserInputHistory 不读内容，只做切片 */
function fakeUserMessages(count: number): UserMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'user' as const,
    message: { role: 'user' as const, content: `msg-${i}` },
    uuid: `u${i}`,
    timestamp: i,
  }));
}

function markers(messages: UserMessage[]): string {
  return messages.map((m) => m.uuid).join(',');
}

runTests('compactAgentMode', () => {
  const { check, finish } = createChecker();

  // ── 用户输入历史上限 ──
  const twelve = fakeUserMessages(12);
  check('恰好 12 条原样返回', selectUserInputHistory(twelve) === twelve);

  const eleven = fakeUserMessages(11);
  check('不足 12 条原样返回', selectUserInputHistory(eleven) === eleven);

  const trimmed13 = selectUserInputHistory(fakeUserMessages(13));
  check('13 条压缩为 12 条', trimmed13.length === 12);
  check('13 条保留最早 4 条', markers(trimmed13.slice(0, 4)) === 'u0,u1,u2,u3');
  check('13 条保留最后 8 条', markers(trimmed13.slice(4)) === 'u5,u6,u7,u8,u9,u10,u11,u12');

  const trimmedMany = selectUserInputHistory(fakeUserMessages(100));
  check('大量输入仍只保留 12 条', trimmedMany.length === 12);
  check('大量输入保留首条与末条', trimmedMany[0].uuid === 'u0' && trimmedMany[11].uuid === 'u99');

  const custom = selectUserInputHistory(fakeUserMessages(20), 6, 2, 4);
  check('自定义 head/tail/max 生效', custom.length === 6);
  check('自定义 head/tail 取值正确', markers(custom) === 'u0,u1,u16,u17,u18,u19');

  // ── 子代理 agent mode 继承 ──
  setSessionAgentMode('parent-manual', 'manual');
  inheritAgentMode('parent-manual', 'child-manual');
  check('manual 父会话 → manual 子会话', getStoredSessionAgentMode('child-manual') === 'manual');

  setSessionAgentMode('parent-risk', 'risk');
  inheritAgentMode('parent-risk', 'child-risk');
  check('risk 父会话 → risk 子会话', getStoredSessionAgentMode('child-risk') === 'risk');

  setSessionAgentMode('parent-auto', 'auto');
  inheritAgentMode('parent-auto', 'child-auto');
  check('auto 父会话 → auto 子会话', getStoredSessionAgentMode('child-auto') === 'auto');

  inheritAgentModeFrom('manual', 'child-from-manual');
  check('inheritAgentModeFrom 原样复制 manual', getStoredSessionAgentMode('child-from-manual') === 'manual');

  inheritAgentModeFrom(undefined, 'child-from-undefined');
  check('父值缺失回退 risk', getStoredSessionAgentMode('child-from-undefined') === 'risk');

  inheritAgentMode('parent-not-recorded', 'child-not-recorded');
  check('父会话无记录回退 risk', getStoredSessionAgentMode('child-not-recorded') === 'risk');

  finish();
});
