import { sessionBusyLevel } from '../shared/sessionRuntime';
import { createChecker, runTests } from './helpers/harness';

/**
 * 会话忙闲的单一派生（三处消费：标签页流水灯 / 托盘状态点 / 关闭二次确认）。
 *
 * 锁定口径：waiting 优先（即使引擎已 idle），running 次之，idle 垫底——
 * 「等用户输入但空闲」的会话必须算忙，否则关对话不问、关工作区却问
 * （US-19 验收 7 明确把「等待用户确认」列进需要二次确认的非 idle 集合）。
 *
 * 运行方式：npm run test:all -- sessionBusyLevel
 */

runTests('sessionBusyLevel', () => {
  const { check, finish } = createChecker();

  check('waiting 优先（waiting-but-idle 也算忙）',
    sessionBusyLevel({ idle: true, waiting: true }) === 'waiting'
    && sessionBusyLevel({ idle: false, waiting: true }) === 'waiting');

  check('非 idle 且不在等用户 = running',
    sessionBusyLevel({ idle: false, waiting: false }) === 'running');

  check('idle 且不在等用户 = idle',
    sessionBusyLevel({ idle: true, waiting: false }) === 'idle');

  finish();
});
