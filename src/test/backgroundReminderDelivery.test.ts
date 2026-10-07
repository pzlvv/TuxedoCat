/**
 * 后台任务提醒投递测试（Embedded `QueryEngine.deliverBackgroundReminder`）。
 *
 * 锁定投递语义：同一 tick 多个任务到点时**追加**而不是覆盖（否则先到点的会被顶掉）。
 * Standalone 对应用例 `core-rs/src/engine_tests.rs::background_reminder_appends_to_pending_reminder`。
 *
 * 运行方式：npm run test:all -- background-reminder-delivery
 */

import { createEventBus } from '../host/EventBus';
import { resetGlobalEventBus, setGlobalEventBus } from '../core/AssistantEventBus';
import { QueryEngine } from '../core/QueryEngine';
import { setSessionWorkspace } from '../core/history/Config';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';

function run(): void {
  const { check, finish } = createChecker();
  const bus = createEventBus();
  setGlobalEventBus(bus);
  const root = makeTempDir('background-reminder-delivery');
  setSessionWorkspace('s-rem', root);
  try {
    const engine = new QueryEngine('s-rem', {
      cwd: root,
      tools: [],
      getAppState: () => ({}),
      setAppState: () => {},
    });
    // 假装消费循环在跑：投递只入队，不启动 consumer（避免真跑 LLM）
    (engine as unknown as { isConsumerRunning: boolean }).isConsumerRunning = true;

    engine.deliverBackgroundReminder('A');
    engine.deliverBackgroundReminder('B');
    const pending = (engine as unknown as { pendingReminder: string | null }).pendingReminder;
    check('同一 tick 的两条提醒追加而不是覆盖', pending === 'A\n\nB');
  } finally {
    resetGlobalEventBus();
  }
  finish();
}

runTests('backgroundReminderDelivery', run);
