/**
 * 单测：压缩摘要的用户输入历史（全局头部 + 本次归档区尾部）+ 子代理 agent mode 继承。
 *
 * 验证：
 * - `selectUserInputHistory`（src/core/compact/prompt.ts）：
 *   把上次摘要持久化的历史与本次归档区输入合并去重，取最早 4 条 + 最后 8 条
 *   （默认 4 + 8 = 12）；不足 12 条全留。多次压缩时头部来自持久化历史，
 *   会话最初的用户输入不会因为再次压缩而丢失。
 * - `toUserInputEntries` / `formatUserInputEntries` / `readCompactUserInputHistory`。
 * - `inheritAgentMode` / `inheritAgentModeFrom`（src/core/tools/PermissionPolicy.ts）：
 *   子会话完整继承父会话的 manual / risk / auto；父值缺失时取配置快照的默认值
 *   （默认值只有一处来源，见 `docs/hosts/webview-facts.md` 第 2 节）。
 *
 * 运行方式：npm run test:all -- compactAgentMode
 */

import { createChecker, runTests } from './helpers/harness';
import type { Message, UserInputHistoryEntry, UserMessage } from '../core/types';
import {
  selectUserInputHistory,
  toUserInputEntries,
  formatUserInputEntries,
  readCompactUserInputHistory,
} from '../core/compact/prompt';
import { applyTestSettings } from './helpers/fixtures';
import {
  inheritAgentMode,
  inheritAgentModeFrom,
  setSessionAgentMode,
  getStoredSessionAgentMode,
} from '../core/tools/PermissionPolicy';

/** 用 uuid 标记原始下标；selectUserInputHistory 只按 uuid 去重、不做内容判断 */
function fakeEntries(count: number, prefix = 'u'): UserInputHistoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    uuid: `${prefix}${i}`,
    content: `msg-${prefix}${i}`,
  }));
}

function markers(entries: readonly UserInputHistoryEntry[]): string {
  return entries.map((e) => e.uuid).join(',');
}

runTests('compactAgentMode', () => {
  const { check, finish } = createChecker();

  // ── 用户输入历史：全局头部 + 本次归档区尾部 ──
  const justEnough = selectUserInputHistory(fakeEntries(4), fakeEntries(8, 'r'));
  check('合计恰好 12 条全留', markers(justEnough) === 'u0,u1,u2,u3,r0,r1,r2,r3,r4,r5,r6,r7');

  const trimmed = selectUserInputHistory(fakeEntries(0), fakeEntries(13, 'r'));
  check('无持久化历史时保留最早 4 条 + 最后 8 条', markers(trimmed) === 'r0,r1,r2,r3,r5,r6,r7,r8,r9,r10,r11,r12');

  const carriedHead = selectUserInputHistory(fakeEntries(4), fakeEntries(20, 'r'));
  check('头部固定为持久化历史（跨多次压缩不丢）', markers(carriedHead.slice(0, 4)) === 'u0,u1,u2,u3');
  check('尾部取本次归档区最后 8 条', markers(carriedHead.slice(4)) === 'r12,r13,r14,r15,r16,r17,r18,r19');

  const deduped = selectUserInputHistory(fakeEntries(2), [fakeEntries(4)[1], fakeEntries(4)[2]]);
  check('重复 uuid 去重且保序', markers(deduped) === 'u0,u1,u2');

  // 用户确认的场景：上次已存 6 条 + 本次归档区新增 1 条 → 7 条全留
  const confirmed = selectUserInputHistory(fakeEntries(6), fakeEntries(1, 'r'));
  check('6 条持久化历史 + 1 条新增 = 7 条', markers(confirmed) === 'u0,u1,u2,u3,u4,u5,r0');

  const custom = selectUserInputHistory(fakeEntries(0), fakeEntries(20, 'r'), 6, 2, 4);
  check('自定义 head/tail/max 生效', markers(custom) === 'r0,r1,r16,r17,r18,r19');

  // ── 条目提取 / 格式化 / 读取持久化历史 ──
  const rawMessages: Message[] = [
    { type: 'user', message: { role: 'user', content: '  第一条  ' }, uuid: 'm0', timestamp: 0 },
    { type: 'user', message: { role: 'user', content: '' }, uuid: 'm1', timestamp: 1 },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第二条' }, { type: 'image', source: {} }] },
      uuid: 'm2',
      timestamp: 2,
    },
  ];
  const entries = toUserInputEntries(rawMessages as UserMessage[]);
  check('提取条目跳过空内容与图片块', JSON.stringify(entries) === JSON.stringify([
    { uuid: 'm0', content: '第一条' },
    { uuid: 'm2', content: '第二条' },
  ]));
  check('格式化编号列表', formatUserInputEntries(entries) === '1. 第一条\n\n2. 第二条');

  const withSummary: Message[] = [
    { type: 'user', message: { role: 'user', content: '普通' }, uuid: 'p0', timestamp: 0 },
    {
      type: 'user',
      message: { role: 'user', content: '摘要' },
      uuid: 's0',
      timestamp: 1,
      isCompactSummary: true,
      compactUserInputHistory: entries,
    },
  ];
  check('读取摘要持久化的历史', JSON.stringify(readCompactUserInputHistory(withSummary)) === JSON.stringify(entries));
  check('没有摘要时返回空数组', readCompactUserInputHistory(rawMessages).length === 0);

  // ── 子代理 agent mode 继承 ──
  // 配置快照的 defaultAgentMode 决定「父会话无记录」时的取值：这里给 'auto'，
  // 断言回退取的是配置值而不是某个写死的常量。
  applyTestSettings({ defaultAgentMode: 'auto' });

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

  inheritAgentMode('parent-not-recorded', 'child-not-recorded');
  check(
    '父会话无记录时取配置快照的 defaultAgentMode',
    getStoredSessionAgentMode('child-not-recorded') === 'auto',
  );

  // 配置快照变化后回退值随之变化（证明没有写死的兜底常量）
  applyTestSettings({ defaultAgentMode: 'risk' });
  inheritAgentMode('parent-not-recorded-2', 'child-not-recorded-2');
  check(
    '配置改为 risk 后回退值同步变化',
    getStoredSessionAgentMode('child-not-recorded-2') === 'risk',
  );

  finish();
});
