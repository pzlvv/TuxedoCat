/**
 * 后台 Bash 完成收尾的运行时快照顺序（Embedded 侧；与 Standalone
 * `core-rs/src/bash_task_tests.rs` 的 `completion_notifies_the_engine_before_clearing_background`
 * 对齐，parity）。
 *
 * `LocalShellTask` 的退出回调先 `notifyEngine`（唤醒引擎置 running）再
 * `syncBackgroundState`（清 background）：完成通知触发的接续查询开始之前，
 * `sessionRuntimeChanged` 快照流里不允许出现 idle=true——宿主
 * （`electron/completionAttention.ts`）会把 running → idle 差分成一次完成而武装
 * 「任务完成」绿灯，而任务其实还在接续查询里继续（Standalone 侧曾把同步读输出
 * 文件夹在两个事实翻转之间，远程 daemon 上宽到肉眼可见的误亮）。
 *
 * 运行方式：npm run test:all -- backgroundCompletionOrder
 */

import { createEventBus } from '../host/EventBus';
import {
  resetGlobalEventBus,
  setGlobalEventBus,
  type CoreEvent,
  type SessionRuntimeState,
} from '../core/AssistantEventBus';
import { registerBackgroundTask } from '../core/tools/bash/LocalShellTask';
import { sessionEngines, type QueryEngine } from '../core/QueryEngine';
import {
  dropSessionRuntime,
  markQueryRunning,
  markSessionBackground,
} from '../core/sessionRuntime';
import { createChecker, runTests } from './helpers/harness';

runTests('backgroundCompletionOrder', async () => {
  const { check, finish } = createChecker();

  const SESSION_ID = 's-completion-order';
  /** 同步交织日志：快照到达与 notify 唤醒按真实顺序落盘，锁的是二者的相对顺序 */
  const log: string[] = [];

  resetGlobalEventBus();
  const bus = createEventBus();
  setGlobalEventBus(bus);
  bus.onCoreEvents(
    new Proxy(
      {},
      {
        get: (_target, _prop: string) => (event: CoreEvent) => {
          if (event.type !== 'sessionRuntimeChanged') return;
          const states = (event as unknown as { states: SessionRuntimeState[] }).states;
          const state = states.find(s => s.sessionId === SESSION_ID);
          if (state) log.push(`snap:idle=${state.idle}`);
        },
      },
    ) as never,
  );

  // 假引擎：enqueueAgentMessage 对齐真引擎的同步唤醒——真引擎 beginConsumer 的
  // 第一件事就是 markQueryRunning(true)（QueryEngine.beginConsumer）
  const fakeEngine = {
    enqueueAgentMessage: (_content: string, _agentId?: string, _source?: string): void => {
      log.push('notify');
      markQueryRunning(SESSION_ID, true);
    },
  } as unknown as QueryEngine;
  sessionEngines.set(SESSION_ID, fakeEngine);

  // 假 ShellCommand：registerBackgroundTask 只用 taskOutput.taskId / pid /
  // background() / result，不真的起进程
  const fakeShellCommand = {
    taskOutput: { taskId: 'bg-completion-order' },
    pid: 4242,
    background: (): void => {},
    result: Promise.resolve({ code: 0, stdout: 'done' }),
  } as never;
  registerBackgroundTask(fakeShellCommand, 'Order probe', 'echo done', undefined, undefined, SESSION_ID);

  // 退出回调挂在 result.then 上，让微任务跑完
  await new Promise(resolve => setTimeout(resolve, 50));

  check('快照流从未出现 idle=true（瞬时 idle 会被宿主差分成 running → idle 而误亮绿灯）', (() => {
    return !log.some(entry => entry === 'snap:idle=true');
  })());

  check('顺序：注册(background=true) → notify 唤醒引擎 → 清 background，全程 idle=false', (() => {
    // 顺序反了（先清 background 再唤醒）第三条会是 snap:idle=true
    return (
      JSON.stringify(log) ===
      JSON.stringify(['snap:idle=false', 'notify', 'snap:idle=false', 'snap:idle=false'])
    );
  })());

  // 收尾：事实与注册表还原，不影响其它测试
  markQueryRunning(SESSION_ID, false);
  markSessionBackground(SESSION_ID, false);
  dropSessionRuntime(SESSION_ID);
  sessionEngines.delete(SESSION_ID);
  resetGlobalEventBus();

  finish();
});
