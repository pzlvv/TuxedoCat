import {
  SleepBlocker,
  shouldPreventSleep,
  type PowerSaveBlockerPort,
} from '../../electron/powerSaveBlocker';
import { createChecker, runTests } from './helpers/harness';

/**
 * 系统电源阻断（`electron/powerSaveBlocker.ts`）。
 *
 * 覆盖点（docs/hosts/host-matrix.md 第 6 节宿主接线）：
 * - 任一会话非 idle（含 waiting）→ 启动 `prevent-app-suspension` 阻断；
 * - 全部空闲 / 空快照 → 释放阻断；
 * - 全量快照高频重复推送时幂等：不重复 start、不误 stop；
 * - 释放后再忙 → 重新 start（新 id）；
 * - dispose 释放且幂等。
 *
 * 运行方式：npm run test:all -- powerSaveBlocker
 */

/** 造一份会话状态（只填判定读的字段） */
function st(idle: boolean, waiting = false): { idle: boolean; waiting: boolean } {
  return { idle, waiting };
}

/** 记录 start / stop 调用的 `powerSaveBlocker` 替身（id 从 1 递增） */
function createFakeApi(): PowerSaveBlockerPort & {
  startedTypes: string[];
  startedIds: number[];
  stoppedIds: number[];
} {
  let nextId = 1;
  const fake = {
    startedTypes: [] as string[],
    startedIds: [] as number[],
    stoppedIds: [] as number[],
    start(type: 'prevent-app-suspension'): number {
      const id = nextId++;
      fake.startedTypes.push(type);
      fake.startedIds.push(id);
      return id;
    },
    stop(id: number): void {
      fake.stoppedIds.push(id);
    },
  };
  return fake;
}

runTests('powerSaveBlocker', async () => {
  const { check, finish } = createChecker();

  check('全部空闲 → 不阻断', (() => {
    const api = createFakeApi();
    new SleepBlocker(api).update([st(true), st(true)]);
    return api.startedIds.length === 0 && api.stoppedIds.length === 0;
  })());

  check('空快照 → 不阻断', (() => {
    const api = createFakeApi();
    new SleepBlocker(api).update([]);
    return api.startedIds.length === 0;
  })());

  check('任一会话非 idle → 启动 prevent-app-suspension 阻断', (() => {
    const api = createFakeApi();
    new SleepBlocker(api).update([st(true), st(false)]);
    return api.startedIds.length === 1 && api.startedTypes[0] === 'prevent-app-suspension';
  })());

  check('waiting（等用户确认）也非 idle → 阻断', (() => {
    const api = createFakeApi();
    new SleepBlocker(api).update([st(false, true)]);
    return api.startedIds.length === 1;
  })());

  check('重复推送非 idle → 幂等，只 start 一次', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.update([st(false)]);
    blocker.update([st(false), st(false)]);
    blocker.update([st(true), st(false)]);
    return api.startedIds.length === 1 && api.stoppedIds.length === 0;
  })());

  check('非 idle → 全部空闲 → stop 同一个 id', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.update([st(false)]);
    blocker.update([st(true)]);
    return api.startedIds.length === 1
      && api.stoppedIds.length === 1
      && api.stoppedIds[0] === api.startedIds[0];
  })());

  check('全部空闲时重复推送 → 幂等，不重复 stop', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.update([st(false)]);
    blocker.update([st(true)]);
    blocker.update([st(true)]);
    blocker.update([]);
    return api.startedIds.length === 1 && api.stoppedIds.length === 1;
  })());

  check('释放后再次变忙 → 重新 start（新 id）', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.update([st(false)]);
    blocker.update([st(true)]);
    blocker.update([st(false)]);
    return api.startedIds.length === 2
      && api.stoppedIds.length === 1
      && api.stoppedIds[0] === api.startedIds[0]
      && api.startedIds[1] !== api.startedIds[0];
  })());

  check('dispose 释放阻断', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.update([st(false)]);
    blocker.dispose();
    return api.startedIds.length === 1 && api.stoppedIds.length === 1;
  })());

  check('未阻断时 dispose 不产生 stop；重复 dispose 幂等', (() => {
    const api = createFakeApi();
    const blocker = new SleepBlocker(api);
    blocker.dispose();
    blocker.update([st(false)]);
    blocker.dispose();
    blocker.dispose();
    return api.startedIds.length === 1 && api.stoppedIds.length === 1;
  })());

  check('shouldPreventSleep：任一非 idle 即为真', (() => {
    return shouldPreventSleep([st(true)]) === false
      && shouldPreventSleep([]) === false
      && shouldPreventSleep([st(true), st(false, true)]) === true;
  })());

  finish();
});
