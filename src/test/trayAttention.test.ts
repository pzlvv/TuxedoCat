import {
  diffSessionEndEvents,
  shouldFireCompletion,
  type SessionLevel,
  type SessionRuntimeSummary,
} from '../../electron/trayAttention';
import { createChecker, runTests } from './helpers/harness';

/**
 * 托盘「任务结束提醒」的事件差分（`electron/trayAttention.ts`）。
 *
 * 覆盖点（docs/hosts/host-matrix.md 托盘段落）：
 * - 任一会话 running → idle / waiting 都产生事件（不看聚合状态是否变化：
 *   两个对话在跑时其中一个完成也要提醒）；
 * - running → running、waiting → running、idle → waiting 等迁移不算「任务结束」；
 * - 新出现 / 消失的会话不产生事件（启动恢复、切换工作区、关闭对话不是任务结束）；
 * - 「子对话完成」不提醒：非 user 创建的会话（creator 为 agent 形态——本地子代理 /
 *   Agent 工具派发的跨工作区对话，specs/025 FR-003）的完成、以及父会话
 *   「仅因子代理在跑而忙」的落回 idle 都不是任务结束；转等待用户不受抑制。
 * - 完成进确认窗口：`completedSessions` 是完成候选（空闲挂起项提交 / 排队压缩等
 *   队列续跑发生在 idle 推送之后，差分无从预知），放行判定 `shouldFireCompletion`
 *   只在窗口结束时仍空闲 / 等用户才为真。
 *
 * 运行方式：npm run test:all -- trayAttention
 */

/** 造一份会话状态（只填 diffSessionEndEvents 读的字段） */
function st(sessionId: string, level: SessionLevel, extra: Partial<SessionRuntimeSummary> = {}): SessionRuntimeSummary {
  return {
    sessionId,
    idle: level === 'idle',
    waiting: level === 'waiting',
    ...extra,
  };
}

runTests('trayAttention', async () => {
  const { check, finish } = createChecker();

  check('两个 running 中一个完成 → completedSessions 记下它，另一个保持 running', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'running')]);
    return second.completedSessions.length === 1 && second.completedSessions[0] === 'a'
      && !second.anyNowWaiting
      && second.next.get('a')?.level === 'idle' && second.next.get('b')?.level === 'running';
  })());

  check('两个 running 中一个转等待 → anyNowWaiting', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'waiting'), st('b', 'running')]);
    return second.anyNowWaiting && second.completedSessions.length === 0 && second.next.get('a')?.level === 'waiting';
  })());

  check('等用户但引擎已空闲（idle=true + waiting=true）按 waiting 算', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running')]);
    const second = diffSessionEndEvents(first.next, [
      { sessionId: 'a', idle: true, waiting: true },
    ]);
    return second.anyNowWaiting && second.completedSessions.length === 0 && second.next.get('a')?.level === 'waiting';
  })());

  check('running → running、waiting → running、idle → running 都不算事件', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'waiting'), st('c', 'idle')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'running'), st('b', 'running'), st('c', 'running')]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting;
  })());

  check('idle → waiting、waiting → waiting、idle → idle 不算事件', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'idle'), st('b', 'waiting'), st('c', 'idle')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'waiting'), st('b', 'waiting'), st('c', 'idle')]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting;
  })());

  check('新出现的会话只登记不产生事件（启动恢复出 waiting 不提醒）', (() => {
    const second = diffSessionEndEvents(new Map(), [st('a', 'waiting'), st('b', 'running')]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting
      && second.next.get('a')?.level === 'waiting' && second.next.get('b')?.level === 'running';
  })());

  check('消失的会话从级别表移除且不产生事件（关闭对话不是任务结束）', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('b', 'running')]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting
      && !second.next.has('a') && second.next.get('b')?.level === 'running';
  })());

  check('空推送清空级别表', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running')]);
    const second = diffSessionEndEvents(first.next, []);
    return second.completedSessions.length === 0 && !second.anyNowWaiting && second.next.size === 0;
  })());

  check('连续两次完成各记一次完成候选（next 作为下一次差分基准）', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'running')]);
    const third = diffSessionEndEvents(second.next, [st('a', 'idle'), st('b', 'idle')]);
    return second.completedSessions.length === 1 && third.completedSessions.length === 1;
  })());

  check('同一推送里一个完成一个转等待 → 完成候选与等待事件同时为真', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'waiting')]);
    return second.completedSessions.length === 1 && second.anyNowWaiting;
  })());

  check('子代理会话自身的完成不提醒（子对话完成不打扰）', (() => {
    const first = diffSessionEndEvents(new Map(), [
      st('parent', 'running', { queryRunning: true }),
      st('sub', 'running', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' }, queryRunning: true }),
    ]);
    // 子代理跑完、主对话继续跑：只有子代理会话落 idle
    const second = diffSessionEndEvents(first.next, [
      st('parent', 'running', { queryRunning: true }),
      st('sub', 'idle', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' } }),
    ]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting;
  })());

  check('父会话仅因子代理在跑而忙（spin）时落回 idle 不提醒', (() => {
    // 父会话自身无任何工作，只有 subAgentRunning=true（子代理在跑 → 非 idle）
    const first = diffSessionEndEvents(new Map(), [
      st('parent', 'running', { subAgentRunning: true }),
      st('sub', 'running', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' }, queryRunning: true }),
    ]);
    const second = diffSessionEndEvents(first.next, [
      st('parent', 'idle'),
      st('sub', 'idle', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' } }),
    ]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting;
  })());

  check('父会话自身有工作时完成仍提醒（子代理抑制只针对子对话完成）', (() => {
    // 父会话 query 在跑（普通 Agent 模式）：自身完成要提醒
    const first = diffSessionEndEvents(new Map(), [
      st('parent', 'running', { queryRunning: true, subAgentRunning: true, creator: { kind: 'user' } }),
      st('sub', 'idle', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' } }),
    ]);
    const second = diffSessionEndEvents(first.next, [
      st('parent', 'idle', { creator: { kind: 'user' } }),
      st('sub', 'idle', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' } }),
    ]);
    return second.completedSessions.length === 1 && !second.anyNowWaiting;
  })());

  check('子代理转等待用户照常提醒（不受子对话抑制）', (() => {
    const first = diffSessionEndEvents(new Map(), [
      st('parent', 'running', { queryRunning: true }),
      st('sub', 'running', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' }, queryRunning: true }),
    ]);
    const second = diffSessionEndEvents(first.next, [
      st('parent', 'running', { queryRunning: true }),
      st('sub', 'waiting', { parentSessionId: 'parent', creator: { kind: 'agent', workspaceId: null, sessionId: 'parent' }, waiting: true }),
    ]);
    return second.anyNowWaiting && second.completedSessions.length === 0;
  })());

  // specs/025 FR-003：Agent 工具派发的跨工作区对话是顶层普通会话（无 parentSessionId），
  // 完成静默按 creator 的 agent 形态判定
  check('跨工作区对话（顶层、creator 为 agent 形态）完成静默；发起方仅因子代理忙时落回 idle 同样静默', (() => {
    const first = diffSessionEndEvents(new Map(), [
      st('origin', 'running', { subAgentRunning: true }),
      st('sub_remote', 'running', { creator: { kind: 'agent', workspaceId: 'HOST:/a', sessionId: 'origin' } }),
    ]);
    const second = diffSessionEndEvents(first.next, [
      st('origin', 'idle', { creator: { kind: 'user' } }),
      st('sub_remote', 'idle', { creator: { kind: 'agent', workspaceId: 'HOST:/a', sessionId: 'origin' } }),
    ]);
    return second.completedSessions.length === 0 && !second.anyNowWaiting;
  })());

  check('跨工作区子代理转等待用户照常提醒（specs/024 FR-002）', (() => {
    const first = diffSessionEndEvents(new Map(), [
      st('sub_remote', 'running', { creator: { kind: 'agent', workspaceId: 'HOST:/a', sessionId: 'origin' } }),
    ]);
    const second = diffSessionEndEvents(first.next, [
      st('sub_remote', 'waiting', { creator: { kind: 'agent', workspaceId: 'HOST:/a', sessionId: 'origin' }, waiting: true }),
    ]);
    return second.anyNowWaiting && second.completedSessions.length === 0;
  })());

  check('creator 为 user 的会话完成照常提醒（specs/025 FR-003）', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running', { creator: { kind: 'user' } })]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle', { creator: { kind: 'user' } })]);
    return second.completedSessions.length === 1 && !second.anyNowWaiting;
  })());

  check('确认窗口放行判定：仍空闲 / 等用户为真，又跑起来或已消失为假', (() => {
    return shouldFireCompletion('idle') && shouldFireCompletion('waiting')
      && !shouldFireCompletion('running') && !shouldFireCompletion(undefined);
  })());

  finish();
});
