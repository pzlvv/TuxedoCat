/**
 * 对话切换锁的登记表（specs/059 FR-007）。
 *
 * 锁的判据是跨宿主唯一的：webview 上报 `conversationSwitchLockChanged`，主进程各入口
 * （标签页、侧栏、菜单动作）按同一份判据早返回。这里逐条锁定它的语义——按视图隔离、
 * 无来源不锁、销毁即清。
 *
 * 运行方式：npm run test:unit -- conversation-switch-lock
 */

import { ConversationSwitchLock } from '../host/conversationSwitchLock';
import { createChecker, runTests } from './helpers/harness';

runTests('conversationSwitchLock', () => {
  const { check, finish } = createChecker();

  // ── 基本开关 ──
  {
    const lock = new ConversationSwitchLock();
    const view = {};
    check('初始未锁', lock.isLocked(view) === false);

    lock.set(view, true);
    check('上锁后该视图锁着', lock.isLocked(view) === true);

    lock.set(view, false);
    check('解锁后恢复', lock.isLocked(view) === false);
  }

  // ── 按视图隔离（一个视图弹框不该锁住别的标签页）──
  {
    const lock = new ConversationSwitchLock();
    const viewA = {};
    const viewB = {};
    lock.set(viewA, true);
    check('A 锁着不影响 B', lock.isLocked(viewB) === false);
    check('A 自己锁着', lock.isLocked(viewA) === true);
    check('集合里只有一个', lock.size === 1);
  }

  // ── 无来源视图不动作（接线错误不猜）──
  {
    const lock = new ConversationSwitchLock();
    lock.set(null, true);
    check('null 视图不记锁', lock.size === 0);
    check('null 视图恒未锁', lock.isLocked(null) === false);
  }

  // ── 视图销毁即清（防对象复用带上残留锁）──
  {
    const lock = new ConversationSwitchLock();
    const view = {};
    lock.set(view, true);
    lock.release(view);
    check('release 后不再锁', lock.isLocked(view) === false);
    check('release 后集合清空', lock.size === 0);
    // release 对没锁的视图是幂等 no-op
    lock.release(view);
    check('重复 release 幂等', lock.size === 0);
  }

  // ── 幂等：重复上锁不重复计入 ──
  {
    const lock = new ConversationSwitchLock();
    const view = {};
    lock.set(view, true);
    lock.set(view, true);
    check('重复上锁只算一个', lock.size === 1);
    lock.set(view, false);
    check('一次解锁即清掉', lock.isLocked(view) === false && lock.size === 0);
  }

  finish();
});
