import {
  diffSessionEndEvents,
  type SessionLevel,
} from '../../electron/trayAttention';
import { createChecker, runTests } from './helpers/harness';

/**
 * 托盘「任务结束提醒」的事件差分（`electron/trayAttention.ts`）。
 *
 * 覆盖点（DEVELOPMENT.md 第 8.6 节托盘段落）：
 * - 任一会话 running → idle / waiting 都产生事件（不看聚合状态是否变化：
 *   两个对话在跑时其中一个完成也要提醒）；
 * - running → running、waiting → running、idle → waiting 等迁移不算「任务结束」；
 * - 新出现 / 消失的会话不产生事件（启动恢复、切换工作区、关闭对话不是任务结束）。
 *
 * 运行方式：npm run test:all -- trayAttention
 */

/** 造一份会话状态（只填 diffSessionEndEvents 读的字段） */
function st(sessionId: string, level: SessionLevel): { sessionId: string; idle: boolean; waiting: boolean } {
  return {
    sessionId,
    idle: level === 'idle',
    waiting: level === 'waiting',
  };
}

runTests('trayAttention', async () => {
  const { check, finish } = createChecker();

  check('两个 running 中一个完成 → anyCompleted，另一个保持 running', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'running')]);
    return second.anyCompleted && !second.anyNowWaiting
      && second.next.get('a') === 'idle' && second.next.get('b') === 'running';
  })());

  check('两个 running 中一个转等待 → anyNowWaiting', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'waiting'), st('b', 'running')]);
    return second.anyNowWaiting && !second.anyCompleted && second.next.get('a') === 'waiting';
  })());

  check('等用户但引擎已空闲（idle=true + waiting=true）按 waiting 算', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running')]);
    const second = diffSessionEndEvents(first.next, [
      { sessionId: 'a', idle: true, waiting: true },
    ]);
    return second.anyNowWaiting && !second.anyCompleted && second.next.get('a') === 'waiting';
  })());

  check('running → running、waiting → running、idle → running 都不算事件', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'waiting'), st('c', 'idle')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'running'), st('b', 'running'), st('c', 'running')]);
    return !second.anyCompleted && !second.anyNowWaiting;
  })());

  check('idle → waiting、waiting → waiting、idle → idle 不算事件', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'idle'), st('b', 'waiting'), st('c', 'idle')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'waiting'), st('b', 'waiting'), st('c', 'idle')]);
    return !second.anyCompleted && !second.anyNowWaiting;
  })());

  check('新出现的会话只登记不产生事件（启动恢复出 waiting 不提醒）', (() => {
    const second = diffSessionEndEvents(new Map(), [st('a', 'waiting'), st('b', 'running')]);
    return !second.anyCompleted && !second.anyNowWaiting
      && second.next.get('a') === 'waiting' && second.next.get('b') === 'running';
  })());

  check('消失的会话从级别表移除且不产生事件（关闭对话不是任务结束）', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('b', 'running')]);
    return !second.anyCompleted && !second.anyNowWaiting
      && !second.next.has('a') && second.next.get('b') === 'running';
  })());

  check('空推送清空级别表', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running')]);
    const second = diffSessionEndEvents(first.next, []);
    return !second.anyCompleted && !second.anyNowWaiting && second.next.size === 0;
  })());

  check('连续两次完成各触发一次事件（next 作为下一次差分基准）', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'running')]);
    const third = diffSessionEndEvents(second.next, [st('a', 'idle'), st('b', 'idle')]);
    return second.anyCompleted && third.anyCompleted;
  })());

  check('同一推送里一个完成一个转等待 → 两个事件同时为真', (() => {
    const first = diffSessionEndEvents(new Map(), [st('a', 'running'), st('b', 'running')]);
    const second = diffSessionEndEvents(first.next, [st('a', 'idle'), st('b', 'waiting')]);
    return second.anyCompleted && second.anyNowWaiting;
  })());

  finish();
});
