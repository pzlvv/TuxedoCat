/**
 * 子代理槽位授予顺序的判定（US-49 FIFO 断言，specs/defects/
 * us49-fifo-assertion-reads-first-request-order.md）。
 *
 * 这层是纯函数，因此「首请求到达顺序与预留顺序相反时判定不变」可以用构造数据
 * 确定性锁住，不需要靠概率性的整应用用例去撞（原用例在 CI 上就是概率性红的）。
 */

import { createChecker, runTests } from './helpers/harness.js';
import {
  grantOrder,
  parseGrantMillis,
  parseTaskNumber,
  queuedGrantViolations,
} from '../../e2e/helpers/subagentGrantOrder.js';
import type { SubAgentGrant } from '../../e2e/helpers/subagentGrantOrder.js';

const QUEUED = [5, 6] as const;

function grant(task: number, millis: number): SubAgentGrant {
  return { description: `任务${task}`, sessionId: `sub_${millis}_${task}a` };
}

function run(): void {
  const checker = createChecker();

  // ---------------- 解析口径 ----------------

  checker.check(
    '子会话 id 取 granted 毫秒',
    parseGrantMillis('sub_1763800000123_ab12') === 1763800000123,
  );
  checker.check(
    '非子会话 id 取不到毫秒',
    parseGrantMillis('session_1763800000123') === null,
  );
  checker.check('description 取任务编号', parseTaskNumber('任务5') === 5);
  checker.check('description 非「任务N」形态返回 null', parseTaskNumber('并发任务5') === null);

  // ---------------- 排序口径 ----------------

  const shuffled = [grant(6, 2000), grant(5, 1000), grant(2, 500)];
  checker.check(
    '按授予时刻升序排列',
    grantOrder(shuffled).map((entry) => entry.description).join(',') === '任务2,任务5,任务6',
  );

  // ---------------- FIFO 判定 ----------------

  checker.check(
    '排队者按发起顺序授予 → 无违规',
    queuedGrantViolations([grant(5, 1000), grant(6, 2000)], QUEUED).length === 0,
  );
  checker.check(
    '排队者逆序授予 → 报 FIFO 破坏',
    queuedGrantViolations([grant(5, 2000), grant(6, 1000)], QUEUED).length === 1,
  );
  checker.check(
    '同一毫秒授予 → 报先后无法观测（不放宽为通过）',
    queuedGrantViolations([grant(5, 1000), grant(6, 1000)], QUEUED).length === 1,
  );
  checker.check(
    '排队者缺席 → 报未启动',
    queuedGrantViolations([grant(5, 1000)], QUEUED).length === 1,
  );
  checker.check(
    '首轮并发直取批次不参与排队顺序比较（任意顺序都不违规）',
    queuedGrantViolations(
      [grant(3, 900), grant(1, 100), grant(4, 950), grant(2, 500), grant(5, 1000), grant(6, 2000)],
      QUEUED,
    ).length === 0,
  );

  // ---------------- 与首请求到达顺序解耦（本次缺陷的要害） ----------------

  // 构造「首请求到达顺序 = 6 → 5」的输入：判定只看授予时刻，结果必须与「5 → 6」相同。
  const grantsByGrantOrder = [grant(1, 100), grant(2, 200), grant(3, 300), grant(4, 400), grant(5, 1000), grant(6, 2000)];
  const firstRequestOrder = [1, 2, 3, 4, 6, 5]; // mock 的 startedAt 排序（CI 上真实出现过 6 → 5）
  const queuedAsSeenByFirstRequest = grantsByGrantOrder
    .filter((entry) => firstRequestOrder.indexOf(parseTaskNumber(entry.description) ?? -1) >= 4)
    .sort(
      (left, right) =>
        firstRequestOrder.indexOf(parseTaskNumber(left.description) ?? -1) -
        firstRequestOrder.indexOf(parseTaskNumber(right.description) ?? -1),
    );
  checker.check(
    '首请求顺序为 6 → 5 时，授予顺序判定仍是 5 → 6（不读 HTTP 到达顺序）',
    queuedAsSeenByFirstRequest.map((entry) => entry.description).join(',') === '任务6,任务5' &&
      queuedGrantViolations(grantsByGrantOrder, QUEUED).length === 0,
  );
  checker.check(
    '同一份授予事实在两种首请求顺序下判定一致',
    queuedGrantViolations(grantsByGrantOrder, QUEUED).join('|') ===
      queuedGrantViolations([...grantsByGrantOrder].reverse(), QUEUED).join('|'),
  );

  checker.finish();
}

runTests('subagentGrantOrder', run);
