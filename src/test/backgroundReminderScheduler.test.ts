/**
 * 后台任务提醒调度行为测试（Embedded）。
 *
 * 覆盖 `BackgroundReminder.tickBackgroundReminders` 的会话状态联动：
 * - 会话空闲（abort 按钮为黄）时时钟前进，满一个间隔投递 reminder；
 * - query engine 有任务（`queryRunning`）时时钟暂停，暂停期间不投递、也不丢已积累量；
 * - 任务完成 / 会话中止后注销，不再提醒；
 * - 周期提醒 / 查询结束都会刷新任务的「上次访问时刻」，最小间隔内不再满足兜底门槛。
 *
 * 纯时钟推进（5 / 10 / 20 / 30 档位）由 `backgroundReminderParity.test.ts` 的对等
 * 对照表锁定，这里只验证与 `sessionRuntime` 的接线。
 *
 * 运行方式：npm run test:all -- background-reminder-scheduler
 */

import { markQueryRunning } from '../core/sessionRuntime';
import {
  BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS,
  isBackgroundFallbackReminderDue,
  markBackgroundTasksAccessed,
  registerBackgroundReminder,
  tickBackgroundReminders,
  unregisterBackgroundReminder,
  unregisterSessionBackgroundReminders,
} from '../core/tools/bash/BackgroundReminder';
import { createChecker, runTests } from './helpers/harness';

const MINUTE = 60_000;

/**
 * 时钟登记时会把 `lastTickMs` 设为当时的 `Date.now()`，比测试里先取的 `now` 晚几毫秒。
 * 每次推进多给 1s（真实调度器也是每秒 tick 一次，到点后最多晚 1s），保证阈值被跨过。
 */
const OVERSHOOT = 1000;

function run(): void {
  const { check, finish } = createChecker();

  // ===== 空闲时到点投递 =====
  {
    const delivered: string[] = [];
    const sessionID = 's-rem-idle';
    const now = Date.now();
    markQueryRunning(sessionID, false);
    registerBackgroundReminder({
      taskId: 'bg-idle',
      sessionID,
      description: 'Sleep',
      command: 'sleep 600',
      startTime: now - 5 * MINUTE,
      pid: 4242,
      deliver: (content) => delivered.push(content),
    });

    tickBackgroundReminders(now + MINUTE + OVERSHOOT); // 只过了 1min：不到 5min
    check('未满 5min 不投递', delivered.length === 0);

    tickBackgroundReminders(now + 5 * MINUTE + OVERSHOOT);
    check('满 5min 投递一次', delivered.length === 1);
    check('提醒带下次间隔 10min', delivered[0]?.includes('Next reminder in 10min.') === true);
    // 已执行时长取本次 tick 的注入时刻：startTime 距 now 5min，tick 在 now + 5min（+1s 跨阈值）
    check('提醒带已执行时长', delivered[0]?.includes('Elapsed: 10m 1s') === true);
    unregisterBackgroundReminder('bg-idle');
  }

  // ===== query engine 有任务时暂停计时 =====
  {
    const delivered: string[] = [];
    const sessionID = 's-rem-pause';
    const now = Date.now();
    markQueryRunning(sessionID, false);
    registerBackgroundReminder({
      taskId: 'bg-pause',
      sessionID,
      description: 'Pause',
      command: 'pause',
      startTime: now,
      pid: 1,
      deliver: (content) => delivered.push(content),
    });

    tickBackgroundReminders(now + 3 * MINUTE + OVERSHOOT); // 空闲 3min
    markQueryRunning(sessionID, true); // 引擎开始工作：暂停
    tickBackgroundReminders(now + 8 * MINUTE + OVERSHOOT); // 暂停期间过 5min，不计入
    check('暂停期间不投递', delivered.length === 0);

    markQueryRunning(sessionID, false); // 引擎空闲：恢复
    tickBackgroundReminders(now + 10 * MINUTE + OVERSHOOT); // 累计 3 + 2 = 5min
    check('恢复后补满 5min 即投递', delivered.length === 1);
    unregisterBackgroundReminder('bg-pause');
  }

  // ===== 会话中止：注销全部提醒 =====
  {
    const delivered: string[] = [];
    const sessionID = 's-rem-abort';
    const now = Date.now();
    markQueryRunning(sessionID, false);
    for (const taskId of ['bg-a', 'bg-b']) {
      registerBackgroundReminder({
        taskId,
        sessionID,
        description: taskId,
        command: taskId,
        startTime: now,
        pid: 1,
        deliver: (content) => delivered.push(content),
      });
    }
    unregisterSessionBackgroundReminders(sessionID);
    tickBackgroundReminders(now + 30 * MINUTE);
    check('注销后不再投递', delivered.length === 0);
  }

  // ===== 上次访问时刻：周期提醒 / 查询结束后最小间隔内不再兜底 =====
  {
    const delivered: string[] = [];
    const sessionID = 's-rem-cooldown';
    const now = Date.now();
    markQueryRunning(sessionID, false);
    registerBackgroundReminder({
      taskId: 'bg-cooldown',
      sessionID,
      description: 'Sleep',
      command: 'sleep 600',
      startTime: now,
      pid: 7,
      deliver: (content) => delivered.push(content),
    });
    check('刚注册的任务不满足兜底门槛', !isBackgroundFallbackReminderDue('bg-cooldown', now));

    const firedAt = now + 5 * MINUTE + OVERSHOOT;
    tickBackgroundReminders(firedAt);
    check('周期提醒已投递', delivered.length === 1);
    check('周期提醒后最小间隔内不满足兜底门槛', !isBackgroundFallbackReminderDue('bg-cooldown', firedAt));
    check(
      '满最小间隔后重新满足兜底门槛',
      isBackgroundFallbackReminderDue(
        'bg-cooldown',
        firedAt + BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS,
      ),
    );

    // 查询结束也是一次「访问」：兜底提醒自己拉起的那轮查询收尾后同样要冷却
    markBackgroundTasksAccessed(['bg-cooldown'], firedAt + MINUTE);
    check(
      '查询结束访问后刷新冷却起点',
      !isBackgroundFallbackReminderDue('bg-cooldown', firedAt + MINUTE),
    );
    unregisterBackgroundReminder('bg-cooldown');
  }

  finish();
}

runTests('backgroundReminderScheduler', run);
