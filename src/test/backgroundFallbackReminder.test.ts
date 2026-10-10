/**
 * 查询结束兜底提醒的门槛与冷却（Embedded `QueryEngine.maybeRemindBackgroundTasks`，
 * 规格见 `docs/background-reminder.md` 第 1.0 节）。
 *
 * 锁定五条接线语义：
 * - 任务刚注册（距上次访问不足最小间隔、且不满足 sleep 豁免）不进兜底列表；
 * - 距上次访问满最小间隔时投递一条 reminder（带 kill 命令）；
 * - 含 sleep 子命令的任务刚注册即兜底一次，登记「已兜底」后不再命中；
 * - 查询结束本身刷新「上次访问时刻」，因此兜底提醒自己拉起的那轮查询结束时不会递归兜底；
 * - 由 reminder 拉起的那一轮结束时（`finalizeIdle`）不再补兜底提醒。
 *
 * 纯门槛判定与计时器状态由 `backgroundReminderParity.test.ts` /
 * `backgroundReminderScheduler.test.ts` 覆盖；Standalone 对应
 * `core-rs/src/engine.rs` 的 `background_reminder`。
 *
 * 运行方式：npm run test:all -- background-fallback-reminder
 */

import fs from 'fs';
import { createEventBus } from '../host/EventBus';
import { resetGlobalEventBus, setGlobalEventBus } from '../core/AssistantEventBus';
import { QueryEngine, sessionEngines } from '../core/QueryEngine';
import { setSessionWorkspace } from '../core/history/Config';
import { markBackgroundTasksAccessed } from '../core/tools/bash/BackgroundReminder';
import {
  abortBackgroundTasksForSession,
  registerBackgroundTask,
} from '../core/tools/bash/LocalShellTask';
import type { ShellCommand } from '../core/tools/bash/ShellCommand';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';

const SESSION = 's-fallback';
const MINUTE = 60_000;

/** 永不结束的假 ShellCommand：任务保持「运行中」，收尾由 `abortBackgroundTasksForSession` 负责 */
function makeNeverEndingShellCommand(taskId: string): ShellCommand {
  return {
    background: () => true,
    result: new Promise(() => { /* 永不结束 */ }),
    kill: () => undefined,
    pid: 4242,
    status: 'backgrounded',
    cleanup: () => undefined,
    taskOutput: { taskId },
  } as unknown as ShellCommand;
}

/** `maybeRemindBackgroundTasks` 是私有方法：测试经类型转换直接调用，并桩掉会真跑 LLM 的消费循环 */
interface EngineInternals {
  maybeRemindBackgroundTasks: () => Promise<void>;
  finalizeIdle: (notifyQueryEnd: boolean) => Promise<void>;
  beginConsumer: (silent: boolean) => void;
  pendingReminder: string | null;
}

/**
 * 经函数边界读 `pendingReminder`：属性访问会被 TS 按前一处 `=== null` 断言收窄成
 * `null`，收窄后无法再调 `includes`；函数返回声明的联合类型，调用点不受影响。
 */
function readPendingReminder(internal: EngineInternals): string | null {
  return internal.pendingReminder;
}

runTests('backgroundFallbackReminder', async () => {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  setGlobalEventBus(bus);
  const root = makeTempDir('background-fallback-reminder');
  setSessionWorkspace(SESSION, root);
  const engine = new QueryEngine(SESSION, {
    cwd: root,
    tools: [],
    getAppState: () => ({}),
    setAppState: () => {},
  });
  const internal = engine as unknown as EngineInternals;
  internal.beginConsumer = () => undefined;
  try {
    const taskId = registerBackgroundTask(
      makeNeverEndingShellCommand('bg-fallback'),
      'Watcher',
      'build --watch',
      'toolu-fallback',
      undefined,
      SESSION,
    );

    // 刚注册：距上次访问不足最小间隔（任务开始时间即上次访问时刻）
    await internal.maybeRemindBackgroundTasks();
    check('刚注册的非 sleep 任务不触发兜底提醒', internal.pendingReminder === null);

    // 把上次访问时刻倒推 4 分钟：满最小间隔，本次查询结束应兜底
    markBackgroundTasksAccessed([taskId], Date.now() - 4 * MINUTE);
    await internal.maybeRemindBackgroundTasks();
    check(
      '距上次访问满最小间隔触发兜底提醒',
      internal.pendingReminder !== null && internal.pendingReminder.includes(taskId),
    );
    check('兜底提醒带 kill 命令', internal.pendingReminder?.includes('kill:') === true);

    // 上一次查询结束已把上次访问时刻刷成当前时刻：立刻再来一次不会重复兜底
    internal.pendingReminder = null;
    await internal.maybeRemindBackgroundTasks();
    check('查询结束刷新上次访问时刻，不递归兜底', internal.pendingReminder === null);

    // ===== sleep 豁免：刚注册即兜底一次，登记「已兜底」后不再命中 =====
    const sleepTaskId = registerBackgroundTask(
      makeNeverEndingShellCommand('bg-sleep-fallback'),
      'Long sleep',
      'sleep 600',
      'toolu-sleep',
      undefined,
      SESSION,
    );
    internal.pendingReminder = null;
    await internal.maybeRemindBackgroundTasks();
    const sleepReminder = readPendingReminder(internal);
    check(
      '含 sleep 的任务刚注册即兜底',
      sleepReminder !== null && sleepReminder.includes(sleepTaskId),
    );
    internal.pendingReminder = null;
    await internal.maybeRemindBackgroundTasks();
    check('sleep 豁免每个任务只走一次', internal.pendingReminder === null);

    // ===== 由 reminder 拉起的那一轮结束时不再补兜底 =====
    // `finalizeIdle(false)`：不向 UI 发 queryEnd（本用例没接 core 事件处理器），
    // 兜底判定与 notifyQueryEnd 无关。
    engine.deliverBackgroundReminder('<reminder>progress</reminder>');
    internal.pendingReminder = null;
    await internal.finalizeIdle(false);
    check('reminder 拉起的那一轮结束时不补兜底提醒', internal.pendingReminder === null);
    // 标记只对刚结束的那一轮有效：下一轮仍按门槛判定（这里把任务倒推到满 3 分钟）
    markBackgroundTasksAccessed([taskId], Date.now() - 4 * MINUTE);
    await internal.finalizeIdle(false);
    check('reminder 标记只对刚结束的那一轮有效', internal.pendingReminder !== null);

    // 兜底提醒自己拉起的这一轮同样算「由 reminder 拉起」：收尾不再补兜底
    markBackgroundTasksAccessed([taskId], Date.now() - 4 * MINUTE);
    internal.pendingReminder = null;
    await internal.finalizeIdle(false);
    check('兜底提醒拉起的这一轮收尾不再补兜底', internal.pendingReminder === null);
  } finally {
    abortBackgroundTasksForSession(SESSION);
    sessionEngines.delete(SESSION);
    resetGlobalEventBus();
    fs.rmSync(root, { recursive: true, force: true });
  }
  finish();
});
