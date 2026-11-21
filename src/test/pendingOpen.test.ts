/**
 * 单测：打开对话的两条落定判据
 * （`electron/pendingOpen.ts` 的待打开登记 + `src/webview/conversationLoadRejection.ts`
 * 的拒绝匹配）。
 *
 * 锁三处口径漂移：
 * - 内容未装载完成之前那条对话**不算已打开**（侧栏绿点、UserChoiceQueue 的 open 判据
 *   都据 `onlySettled`）——视图对象存在只是中间态；
 * - 打开被拒只认「被拒的正是本视图在等的那个会话」，别的会话的占用通知不结束当前加载；
 * - 一次拒绝只撤销一次（重复 / 迟到的拒绝不产生第二次回滚），撤销后回到打开前那条
 *   对话的 key 而不是「最近使用的视图」（specs/032 / US-66 的「失败的打开动作无副作用」）。
 *
 * 运行方式：npm run test:unit -- open-locked-conversation
 */

import { PendingOpenRegistry } from '../../electron/pendingOpen';
import { rejectedLoadSessionOf } from '../webview/conversationLoadRejection';
import { CoreNoticeKeys } from '../shared/coreText';
import { createChecker, runTests } from './helpers/harness';

runTests('pendingOpen', () => {
  const { check, finish } = createChecker();

  // ---------- PendingOpenRegistry ----------
  const registry = new PendingOpenRegistry();
  registry.begin('s1', 'view-before');
  check('待打开会话不进「已打开」集合', registry.onlySettled(['view-before', 's1']).join(',') === 'view-before');
  check('已登记的会话判为在途打开', registry.isPending('s1'));
  check('未登记的会话不判在途', !registry.isPending('s2'));

  // 重复 begin 保留原记录：装载完成前「打开前那一个」不会再变
  registry.begin('s1', 'other-view');
  const settledEntry = registry.reject('s1');
  check(
    '重复 begin 不覆盖「打开前那一条」（撤销回到真正的原视图）',
    settledEntry !== null && settledEntry.previousKey === 'view-before',
  );
  check('撤销后不再算在途打开', !registry.isPending('s1'));
  check('同一拒绝只撤销一次', registry.reject('s1') === null);
  check('撤销后回到已打开集合', registry.onlySettled(['view-before', 's1']).join(',') === 'view-before,s1');

  // 装载完成：settle 注销登记并让会话进入已打开集合
  registry.begin('s2', null);
  check('装载完成前不算已打开', !registry.onlySettled(['s2']).includes('s2'));
  check('装载完成时 settle 返回 true', registry.settle('s2'));
  check('装载完成后算已打开', registry.onlySettled(['s2']).includes('s2'));
  check('迟到的完成不重复通知', !registry.settle('s2'));

  // 视图被别处销毁：登记一并清掉（否则该会话永远被排除在已打开集合之外）
  registry.begin('s3', 'view-before');
  registry.drop('s3');
  check('视图销毁后登记被清理', !registry.isPending('s3'));

  // 打开前没有可回的对话视图：previousKey 为 null（撤销时由宿主另建新对话）
  registry.begin('s4', null);
  const noPrevious = registry.reject('s4');
  check('打开前无对话视图时 previousKey 为 null', noPrevious !== null && noPrevious.previousKey === null);

  // ---------- rejectedLoadSessionOf（webview） ----------
  const locked = (sessionId?: string) => ({ key: CoreNoticeKeys.sessionLockedOpen, sessionId });
  check('被拒的正是本视图在等的会话 → 作废这次加载', rejectedLoadSessionOf('s1', locked('s1')) === 's1');
  check('别的会话被拒不影响本视图的加载', rejectedLoadSessionOf('s1', locked('s2')) === null);
  check('没有在等任何会话时不受影响', rejectedLoadSessionOf(null, locked('s1')) === null);
  check(
    '其它占用类提示（变更被拒）不结束加载',
    rejectedLoadSessionOf('s1', { key: CoreNoticeKeys.sessionLockedChange, sessionId: 's1' }) === null,
  );
  check(
    '与占用无关的瞬时提示不结束加载',
    rejectedLoadSessionOf('s1', { key: CoreNoticeKeys.spinCannotRead, sessionId: 's1' }) === null,
  );
  check('通知缺会话键时不结束加载', rejectedLoadSessionOf('s1', locked(undefined)) === null);

  finish();
});
