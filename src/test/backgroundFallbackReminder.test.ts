/**
 * 查询结束兜底提醒的门槛与冷却（Embedded `QueryEngine.maybeRemindBackgroundTasks`，
 * 规格见 `docs/background-reminder.md` 第 1.0 节）。
 *
 * 锁定三条接线语义：
 * - 任务刚注册（距上次访问不足最小间隔）不进兜底列表；
 * - 距上次访问满最小间隔时投递一条 reminder（带 kill 命令）；
 * - 查询结束本身刷新「上次访问时刻」，因此兜底提醒自己拉起的那轮查询结束时不会递归兜底。
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
  beginConsumer: (silent: boolean) => void;
  pendingReminder: string | null;
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
      'Long sleep',
      'sleep 600',
      'toolu-fallback',
      undefined,
      SESSION,
    );

    // 刚注册：距上次访问不足最小间隔（任务开始时间即上次访问时刻）
    await internal.maybeRemindBackgroundTasks();
    check('刚注册的任务不触发兜底提醒', internal.pendingReminder === null);

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
  } finally {
    abortBackgroundTasksForSession(SESSION);
    sessionEngines.delete(SESSION);
    resetGlobalEventBus();
    fs.rmSync(root, { recursive: true, force: true });
  }
  finish();
});
