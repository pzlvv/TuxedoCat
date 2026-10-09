/**
 * 手工转后台（`UiEvent.bashBackgroundRequested`，Bash 卡片「转后台」按钮）的
 * Embedded 侧行为。Standalone 对应用例：
 * - `core-rs/src/tools_tests.rs::bash_manual_background_converts_and_requests_loop_pause`
 * - `core-rs/src/engine_tests.rs::manual_background_pauses_the_loop_until_a_queued_message_arrives`
 *
 * 语义（两侧一致）：
 * 1. 前台命令跑起来后由注册表触发，与自动转后台（超时 / 通知驱动）同一条路径，
 *    结果照常作为 tool_result（`assistantAutoBackgrounded` + `bg-auto-` taskId）；
 * 2. 转换成功回写引擎：置循环暂停标记（下一轮 LLM 请求不发起）+ 该任务登记
 *    「已兜底提醒」（查询收尾不为它补 reminder 又拉起循环）；
 * 3. 暂停标记一次性消费；新用户消息 / 中止会清掉残留标记。
 *
 * 运行方式：npm run test:all -- manualBackground
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEventBus } from '../host/EventBus';
import { resetGlobalEventBus, setGlobalEventBus } from '../core/AssistantEventBus';
import { sessionEngines, QueryEngine } from '../core/QueryEngine';
import { execCommand } from '../core/tools/bash/Exec';
import { abortBackgroundTasksForSession } from '../core/tools/bash/LocalShellTask';
import {
  isForegroundBashRunning,
  registerForegroundBashTrigger,
  requestManualBackground,
  unregisterForegroundBashTrigger,
} from '../core/tools/bash/ManualBackground';
import { setSessionWorkspace } from '../core/history/Config';
import { createChecker, runTests } from './helpers/harness';
import { makeTempDir } from './helpers/fixtures';

runTests('manualBackground', async () => {
  const { check, finish } = createChecker();

  // ===== 1. 注册表语义 =====
  let triggered = 0;
  registerForegroundBashTrigger('toolu-1', () => { triggered++; });
  check('登记后 isForegroundBashRunning 为真', isForegroundBashRunning('toolu-1'));
  check('requestManualBackground 命中已登记条目（返回 true）', requestManualBackground('toolu-1') === true);
  check('requestManualBackground 触发了转换回调', triggered === 1);
  check('未登记的 toolUseId 返回 false', requestManualBackground('toolu-missing') === false);
  unregisterForegroundBashTrigger('toolu-1');
  check('注销后 isForegroundBashRunning 为假', !isForegroundBashRunning('toolu-1'));
  check('注销后 requestManualBackground 返回 false', requestManualBackground('toolu-1') === false);

  // ===== 2. 真实执行：手工转后台触发转换并回写引擎 =====
  resetGlobalEventBus();
  const bus = createEventBus();
  setGlobalEventBus(bus);

  const SESSION = 's-manual-bg';
  const pausedFlags: string[] = [];
  const remindedTasks: string[] = [];
  const fakeEngine = {
    requestLoopPause: (): void => { pausedFlags.push('paused'); },
    markBackgroundTaskReminded: (taskId: string): void => { remindedTasks.push(taskId); },
  } as unknown as QueryEngine;
  sessionEngines.set(SESSION, fakeEngine);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-background-'));
  const TOOL_USE_ID = 'toolu-manual-bg';
  try {
    const execPromise = execCommand({
      command: 'sleep 8',
      timeout: 60_000,
      cwd: dir,
      signal: new AbortController().signal,
      description: 'Long sleep',
      toolUseId: TOOL_USE_ID,
      sessionID: SESSION,
    });

    // 等注册表登记完成再触发（触发太早找不到条目，返回 false）
    const deadline = Date.now() + 10_000;
    while (!isForegroundBashRunning(TOOL_USE_ID)) {
      if (Date.now() > deadline) throw new Error('前台 Bash 未登记到手工转后台注册表');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    check('触发时 requestManualBackground 返回 true', requestManualBackground(TOOL_USE_ID) === true);

    const result = await execPromise;
    check('手工转后台结果带 assistantAutoBackgrounded', result.assistantAutoBackgrounded === true);
    check('手工转后台结果带 bg-auto- taskId', (result.backgroundTaskId ?? '').startsWith('bg-auto-'));
    check('转换成功回写引擎：置循环暂停标记', pausedFlags.length === 1);
    check(
      '转换成功回写引擎：该任务登记已兜底提醒',
      remindedTasks.length === 1 && remindedTasks[0] === result.backgroundTaskId,
    );
    check('收尾后注册表条目已注销', !isForegroundBashRunning(TOOL_USE_ID));

    // 收尾：杀掉后台任务、还原引擎池与总线
    abortBackgroundTasksForSession(SESSION);
  } finally {
    sessionEngines.delete(SESSION);
    resetGlobalEventBus();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ===== 3. 暂停标记的生命周期 =====
  const root = makeTempDir('manual-background-engine');
  setSessionWorkspace('s-pause', root);
  const engine = new QueryEngine('s-pause', {
    cwd: root,
    tools: [],
    getAppState: () => ({}),
    setAppState: () => { },
  });
  try {
    engine.requestLoopPause();
    check('暂停请求可被消费（一次性）', engine.consumeLoopPauseRequest() === true);
    check('第二次消费返回 false（取走即清除）', engine.consumeLoopPauseRequest() === false);

    engine.requestLoopPause();
    engine.markBackgroundTaskReminded('bg-auto-x');
    const reminded = (engine as unknown as { remindedBackgroundTaskIds: Set<string> }).remindedBackgroundTaskIds;
    check('markBackgroundTaskReminded 登记任务 id', reminded.has('bg-auto-x'));

    // 中止清掉残留暂停标记：被中止的那轮查询不会再走到暂停出口
    engine.requestLoopPause();
    engine.interruptForeground();
    check('中止后暂停标记被清除', engine.consumeLoopPauseRequest() === false);
  } finally {
    await engine.flush().catch(() => undefined);
    sessionEngines.delete('s-pause');
  }

  finish();
});
