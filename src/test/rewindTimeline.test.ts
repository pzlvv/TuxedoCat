import { isTimelineDotHit, rewindAvailability, rewindPreview, TIMELINE_DOT_HIT_BOX } from '../../src/webview/rewindTimeline';
import type { RewindPreviewMessage } from '../../src/webview/rewindTimeline';
import { createChecker, runTests } from './helpers/harness';

/**
 * 时间线节点「从这里继续」的入口与禁用判定
 * （`src/webview/rewindTimeline.ts`，specs/039 FR-001 / FR-002 / FR-005）。
 *
 * 覆盖点：右键只命中状态点 / 禁用矩阵（无 nodeId / 压缩摘要 / 未 idle / 末节点）/
 * 判定顺序 / 确认框规模与 core 截断口径一致。
 *
 * 运行方式：npm run test:unit -- rewind-timeline
 */

runTests('rewindTimeline', async () => {
  const { check, finish } = createChecker();

  // ---------- 放行 ----------
  {
    const availability = rewindAvailability('u-1', false, true, false);
    check('普通节点 + 空闲 + 非末节点 → 可回退', availability.enabled === true);
    check('放行时没有原因', availability.reason === null);
  }

  // ---------- 四种禁用 ----------
  {
    const none = rewindAvailability(undefined, false, true, false);
    check('无 nodeId（once 通知 / 老数据）→ 禁用', none.enabled === false && none.reason === 'noNodeId');
    check('空串 nodeId 同样禁用', rewindAvailability('', false, true, false).reason === 'noNodeId');
  }
  {
    const summary = rewindAvailability('c-1', false, true, true);
    check('压缩摘要 → 禁用', summary.enabled === false && summary.reason === 'compactSummary');
  }
  {
    const busy = rewindAvailability('u-1', false, false, false);
    check('会话未 idle → 禁用', busy.enabled === false && busy.reason === 'busy');
  }
  {
    const last = rewindAvailability('u-1', true, true, false);
    check('末节点 → 禁用', last.enabled === false && last.reason === 'lastNode');
  }

  // ---------- 判定顺序 ----------
  {
    // 无 nodeId 优先于其它原因：用户先要知道「这个节点不是对话节点」
    check('无 nodeId 优先于忙',
      rewindAvailability(undefined, true, false, true).reason === 'noNodeId');
    check('压缩摘要优先于忙',
      rewindAvailability('c-1', true, false, true).reason === 'compactSummary');
    check('忙优先于末节点',
      rewindAvailability('u-1', true, false, false).reason === 'busy');
  }

  // ---------- 右键命中：只有状态点响应 ----------
  {
    const box = TIMELINE_DOT_HIT_BOX;
    check('状态点圆心命中', isTimelineDotHit(5, 12.5));
    check('命中盒左 / 上边界可命中', isTimelineDotHit(box.inlineStart, box.top));
    check('命中盒右 / 下边界可命中', isTimelineDotHit(box.inlineEnd, box.bottom));
    check('行内内容区（圆点右侧 > 13px）不命中', !isTimelineDotHit(14, 12.5));
    check('行内内边距之外的正文（100px）不命中', !isTimelineDotHit(100, 12.5));
    check('竖线正中（4px）但高于命中盒不命中', !isTimelineDotHit(4, box.top - 1));
    check('行首左侧（负偏移，涟漪盒左缘外）不命中', !isTimelineDotHit(-1, 12.5));
    check('节点下方空白（30px）不命中', !isTimelineDotHit(5, 30));
  }

  // ---------- 确认框规模与 core 截断口径一致 ----------
  const conversation: RewindPreviewMessage[] = [
    { role: 'user', messageUuid: 'u1' },
    { role: 'thinking', messageUuid: 'a1' },
    { role: 'toolcall', messageUuid: 'a1', toolCallId: 't1', toolName: 'Bash' },
    { role: 'assistant', messageUuid: 'a2' },
    { role: 'toolcall', messageUuid: 'a3', toolCallId: 't2', toolName: 'Edit' },
    { role: 'assistant', messageUuid: 'a4' },
  ];
  {
    const preview = rewindPreview(conversation, 'u1');
    check('用户节点：保留自身，其后全部计入删除', preview?.removed === 5);
    check('区间内 Edit 卡片计入回滚文件数', preview?.files === 1);
  }
  {
    // Bash 卡片回退：卡片是保留区末尾时整体前移，不能停在工具调用中间
    const preview = rewindPreview(conversation, 't1');
    check('工具卡片：截断点前移，卡片自身也被删除', preview?.removed === 5);
  }
  {
    check('目标不存在 → 不弹确认框', rewindPreview(conversation, 'nope') === null);
  }

  finish();
});
