import {
  diffCompletionAttention,
  type CompletionAttentionFacts,
} from '../../electron/completionAttention';
import { createChecker, runTests } from './helpers/harness';

/**
 * 「任务完成」绿色呼吸的武装判定（`electron/completionAttention.ts`）。
 *
 * 覆盖点：
 * - 只有 running → idle 算完成；waiting → idle、idle → waiting 等迁移不算；
 * - 对话项武装条件：完成时刻用户看得到（窗口聚焦 + 标签页激活 + 当前对话）不武装；
 *   窗口失焦 / 标签页未激活 / 非当前对话任一命中即武装；
 * - 标签页武装条件更严：只在完成时该标签页**未激活**才武装——激活中的标签页视为
 *   已读（里面的完成由对话项的灯当场表达），切走再切回不补亮；
 * - 新出现 / 消失的会话不武装（消失的从级别表移除，供调用方清未读集合）；
 * - 同一工作区多个会话完成只武装一个标签页（去重），对话逐个武装。
 *
 * 运行方式：npm run test:all -- completionAttention
 */

/** 造一份会话状态（只填 diffCompletionAttention 读的字段） */
function st(sessionId: string, level: 'idle' | 'running' | 'waiting'): { sessionId: string; idle: boolean; waiting: boolean } {
  return {
    sessionId,
    idle: level === 'idle',
    waiting: level === 'waiting',
  };
}

/** 默认画面事实：用户正盯着这个会话完成（不武装） */
function seen(overrides?: Partial<CompletionAttentionFacts>): CompletionAttentionFacts {
  return {
    workspaceKey: 'ws-a',
    tabActive: true,
    sessionCurrent: true,
    windowFocused: true,
    ...overrides,
  };
}

runTests('completionAttention', async () => {
  const { check, finish } = createChecker();

  check('running → idle 且用户正盯着（聚焦 + 激活 + 当前对话）→ 不武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen());
    return second.tabs.length === 0 && second.sessions.length === 0 && second.next.get('a') === 'idle';
  })());

  check('窗口失焦 + 激活标签页内的会话完成 → 只武装对话，标签页视为已读不武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen({ windowFocused: false }));
    return second.tabs.length === 0 && second.sessions.length === 1 && second.sessions[0] === 'a';
  })());

  check('窗口失焦 + 未激活标签页内的会话完成 → 标签页与对话都武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(
      first.next,
      [st('a', 'idle')],
      () => seen({ windowFocused: false, tabActive: false }),
    );
    return second.tabs.length === 1 && second.tabs[0] === 'ws-a' && second.sessions.length === 1 && second.sessions[0] === 'a';
  })());

  check('标签页未激活时完成（窗口聚焦）→ 武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen({ tabActive: false }));
    return second.tabs.length === 1 && second.sessions.length === 1;
  })());

  check('非当前对话完成（窗口聚焦、标签页激活）→ 只武装对话不武装标签页', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen({ sessionCurrent: false }));
    return second.tabs.length === 0 && second.sessions.length === 1 && second.sessions[0] === 'a';
  })());

  check('waiting → idle 不算完成（用户应答 / 中止的结果不是刚结束的任务）', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'waiting')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen({ windowFocused: false }));
    return second.tabs.length === 0 && second.sessions.length === 0 && second.next.get('a') === 'idle';
  })());

  check('running → running、idle → running、running → waiting 都不武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running'), st('b', 'idle'), st('c', 'running')], () => seen());
    const second = diffCompletionAttention(
      first.next,
      [st('a', 'running'), st('b', 'running'), st('c', 'waiting')],
      () => seen({ windowFocused: false }),
    );
    return second.tabs.length === 0 && second.sessions.length === 0;
  })());

  check('新出现的会话只登记不武装（启动恢复出的空闲不是刚完成的任务）', (() => {
    const second = diffCompletionAttention(new Map(), [st('a', 'idle'), st('b', 'running')], () => seen({ windowFocused: false }));
    return second.tabs.length === 0 && second.sessions.length === 0
      && second.next.get('a') === 'idle' && second.next.get('b') === 'running';
  })());

  check('消失的会话进入 gone（调用方清未读集合）且不武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running'), st('b', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('b', 'running')], () => seen({ windowFocused: false }));
    return second.gone.length === 1 && second.gone[0] === 'a' && !second.next.has('a');
  })());

  check('无归属工作区的会话只武装对话，不武装标签页', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(
      first.next,
      [st('a', 'idle')],
      () => seen({ workspaceKey: null, windowFocused: false }),
    );
    return second.tabs.length === 0 && second.sessions.length === 1 && second.sessions[0] === 'a';
  })());

  check('同一工作区两个会话完成：标签页去重成一个，对话逐个武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running'), st('b', 'running')], () => seen());
    const second = diffCompletionAttention(
      first.next,
      [st('a', 'idle'), st('b', 'idle')],
      () => seen({ windowFocused: false, tabActive: false }),
    );
    return second.tabs.length === 1 && second.sessions.length === 2;
  })());

  check('next 作为下一次差分基准：再次 running → idle 再次武装', (() => {
    const first = diffCompletionAttention(new Map(), [st('a', 'running')], () => seen());
    const second = diffCompletionAttention(first.next, [st('a', 'idle')], () => seen({ windowFocused: false }));
    const third = diffCompletionAttention(second.next, [st('a', 'running')], () => seen());
    const fourth = diffCompletionAttention(third.next, [st('a', 'idle')], () => seen({ windowFocused: false }));
    return second.sessions.length === 1 && fourth.sessions.length === 1;
  })());

  finish();
});
