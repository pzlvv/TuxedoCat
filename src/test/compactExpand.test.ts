import { canExpandCompact, compactGenerations, compactVisibleMessages } from '../../src/webview/compactExpand';
import type { CompactArchiveView } from '../../src/webview/compactExpand';
import { createChecker, runTests } from './helpers/harness';

/**
 * 压缩归档逐层展开的判定（`src/webview/compactExpand.ts`，specs/047 FR-002 / FR-004）。
 *
 * 覆盖点：代次数、每层的可见集合（从最新一代往更早补）、超界返回 null、
 * 按钮显隐三态（无归档 / 还没取数据 / 已展开到最深层）。
 *
 * 运行方式：npm run test:unit -- compact-expand
 */

/** 三代归档的完整序列：`[g1, g1, 摘要A] [摘要A, g2, 摘要B] [摘要B, g3, 摘要C] + 保留区` */
const THREE_GENERATIONS: CompactArchiveView = {
  messages: [
    '原文 1',
    '原文 2',
    '摘要 A',
    '原文 3',
    '摘要 B',
    '原文 4',
    '摘要 C',
    '保留区',
  ],
  generationStarts: [0, 2, 4],
};

runTests('compactExpand', async () => {
  const { check, finish } = createChecker();

  // ---------- 代次数 ----------
  {
    check('三代归档 → 代次数 3', compactGenerations(THREE_GENERATIONS) === 3);
    check('未取到数据 → 0', compactGenerations(null) === 0);
    check(
      '空载荷（宿主回 0 条）→ 0',
      compactGenerations({ messages: [], generationStarts: [] }) === 0,
    );
  }

  // ---------- 逐层的可见集合 ----------
  {
    check(
      '第 1 层 = 最新一代 + 保留区',
      JSON.stringify(compactVisibleMessages(THREE_GENERATIONS, 1)) ===
        JSON.stringify(['摘要 B', '原文 4', '摘要 C', '保留区']),
    );
    check(
      '第 2 层再多一代更早的内容（该代分界 = 上一代摘要，它本就存在于当时的对话里）',
      JSON.stringify(compactVisibleMessages(THREE_GENERATIONS, 2)) ===
        JSON.stringify(['摘要 A', '原文 3', '摘要 B', '原文 4', '摘要 C', '保留区']),
    );
    check(
      '第 3 层 = 全部原文 + 各代摘要 + 保留区（顺序仍是时间顺序）',
      JSON.stringify(compactVisibleMessages(THREE_GENERATIONS, 3)) ===
        JSON.stringify(THREE_GENERATIONS.messages),
    );
  }

  // ---------- 超界 / 非法输入 ----------
  {
    check('depth 0 不是「可见集合」的合法输入（由调用方铺压缩后形态）', compactVisibleMessages(THREE_GENERATIONS, 0) === null);
    check('depth 超过代次数 → null', compactVisibleMessages(THREE_GENERATIONS, 4) === null);
    check('非整数层 → null', compactVisibleMessages(THREE_GENERATIONS, 1.5) === null);
    check('负数层 → null', compactVisibleMessages(THREE_GENERATIONS, -1) === null);
    check('没有数据 → null', compactVisibleMessages(null, 1) === null);
  }

  // ---------- 分界重合（某代归档区只含已被去重的上代摘要） ----------
  {
    // 两次压缩之间新增消息全落在保留区：第 3 代的归档区只有「摘要 A」一条，而它已被去重，
    // 于是第 2 / 3 代分界落在同一下标。该层可见集合不变，但层级计数照常推进。
    const overlapping: CompactArchiveView = {
      messages: ['原文 1', '摘要 A', '摘要 B', '保留区'],
      generationStarts: [0, 1, 1],
    };
    check(
      '分界重合时该层退化成上层的可见集合（层级仍可继续推进）',
      JSON.stringify(compactVisibleMessages(overlapping, 1)) ===
        JSON.stringify(compactVisibleMessages(overlapping, 2)),
    );
    check(
      '分界重合不妨碍继续展开到最深层',
      JSON.stringify(compactVisibleMessages(overlapping, 3)) ===
        JSON.stringify(overlapping.messages),
    );
  }

  // ---------- 按钮显隐 ----------
  {
    check('没有归档 → 不显示按钮', canExpandCompact(false, 0, null) === false);
    check(
      '有归档、还没取数据 → 显示（点它去取）',
      canExpandCompact(true, 0, null) === true,
    );
    check(
      '三代、未展开 → 显示',
      canExpandCompact(true, 0, THREE_GENERATIONS) === true,
    );
    check(
      '三代、已展开 2 层 → 仍显示（还剩一层）',
      canExpandCompact(true, 2, THREE_GENERATIONS) === true,
    );
    check(
      '三代、已展开 3 层 → 隐藏',
      canExpandCompact(true, 3, THREE_GENERATIONS) === false,
    );
    check(
      '单代、展开一次后隐藏（与改动前的一次点击结果一致）',
      canExpandCompact(true, 1, { messages: ['原文', '摘要', '保留区'], generationStarts: [0] }) === false,
    );
  }

  finish();
});
