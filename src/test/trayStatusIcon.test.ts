import { deriveTrayStatusFromStates } from '../../electron/trayStatusIcon';
import { createChecker, runTests } from './helpers/harness';

/**
 * 托盘状态点的聚合口径（`electron/trayStatusIcon.ts` 的 `deriveTrayStatusFromStates`）。
 *
 * US-33 验收 1（绿=全部空闲 / 红=运行中 / 黄=等待用户确认）只有这一处派生：托盘图标
 * 颜色、闪烁相位与提示文案都由它决定。真实托盘图标渲染与 OS 交互无法被 Playwright
 * 断言，颜色语义因此在这里锁死——聚合是「任一会话 waiting 即 waiting，否则任一非
 * idle 即 running，其余 idle」，单会话的忙闲判定复用 core 的 `sessionBusyLevel`。
 *
 * 运行方式：npm run test:all -- trayStatusIcon
 */

const state = (over: { idle?: boolean; waiting?: boolean }) => ({
  idle: true,
  waiting: false,
  ...over,
});

runTests('trayStatusIcon', () => {
  const { check, finish } = createChecker();

  check('无会话 → 绿点（全部空闲）',
    deriveTrayStatusFromStates([]) === 'idle');

  check('全部空闲 → 绿点',
    deriveTrayStatusFromStates([state({}), state({})]) === 'idle');

  check('任一非 idle → 红点（运行中）',
    deriveTrayStatusFromStates([state({}), state({ idle: false })]) === 'running');

  check('等待用户确认 → 黄点，即使引擎已 idle',
    deriveTrayStatusFromStates([state({ idle: true, waiting: true })]) === 'waiting');

  check('waiting 优先于 running（同时存在时黄点）',
    deriveTrayStatusFromStates([
      state({ idle: false, waiting: false }),
      state({ idle: true, waiting: true }),
    ]) === 'waiting');

  check('多任务在跑、其中一个完成（其余仍非 idle）→ 仍红点',
    deriveTrayStatusFromStates([
      state({ idle: false, waiting: false }),
      state({ idle: false, waiting: false }),
      state({ idle: true, waiting: false }),
    ]) === 'running');

  check('字段缺省按空闲处理（快照只带部分字段时不误报红点）',
    deriveTrayStatusFromStates([{}, {}]) === 'idle');

  finish();
});
