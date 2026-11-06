import { rewindAvailability } from '../../src/webview/rewindTimeline';
import { createChecker, runTests } from './helpers/harness';

/**
 * 时间线节点「从这里继续」的禁用矩阵（`src/webview/rewindTimeline.ts`，specs/039 FR-001 / FR-005）。
 *
 * 覆盖点：无 nodeId / 压缩摘要 / 会话忙 / 末节点四种禁用原因，与全部满足时的放行；
 * 判定顺序（先判「是不是对话节点」再判「能不能动」）。
 *
 * 运行方式：npm run test:unit -- rewind-timeline
 */

runTests('rewindTimeline', async () => {
  const { check, finish } = createChecker();

  // ---------- 放行 ----------
  {
    const availability = rewindAvailability('u-1', false, false, false);
    check('普通节点 + 空闲 + 非末节点 → 可回退', availability.enabled === true);
    check('放行时没有原因', availability.reason === null);
  }

  // ---------- 四种禁用 ----------
  {
    const none = rewindAvailability(undefined, false, false, false);
    check('无 nodeId（once 通知 / 老数据）→ 禁用', none.enabled === false && none.reason === 'noNodeId');
    check('空串 nodeId 同样禁用', rewindAvailability('', false, false, false).reason === 'noNodeId');
  }
  {
    const summary = rewindAvailability('c-1', false, false, true);
    check('压缩摘要 → 禁用', summary.enabled === false && summary.reason === 'compactSummary');
  }
  {
    const busy = rewindAvailability('u-1', false, true, false);
    check('会话忙 → 禁用', busy.enabled === false && busy.reason === 'busy');
  }
  {
    const last = rewindAvailability('u-1', true, false, false);
    check('末节点 → 禁用', last.enabled === false && last.reason === 'lastNode');
  }

  // ---------- 判定顺序 ----------
  {
    // 无 nodeId 优先于其它原因：用户先要知道「这个节点不是对话节点」
    check('无 nodeId 优先于忙',
      rewindAvailability(undefined, true, true, true).reason === 'noNodeId');
    check('压缩摘要优先于忙',
      rewindAvailability('c-1', true, true, true).reason === 'compactSummary');
    check('忙优先于末节点',
      rewindAvailability('u-1', true, true, false).reason === 'busy');
  }

  finish();
});
