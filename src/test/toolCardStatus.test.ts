/**
 * 工具卡片的两个状态推进不变量（`specs/defects/overlay-tool-card-stuck-running.md`）。
 *
 * 缺陷的成因是消息顺序而不是界面样式：`addMessage`（上架卡片）与 `updateToolStatus`
 * （推进状态）是两条独立推送，同会话内不保证后者晚到。Overlay 对话把间隔放大
 * （首次工具要现挂视图、权限阶段经代理回读文件），因此缺陷在那里最容易显形。
 *
 * 两个判定都抽成了纯函数，这里直接驱动它们——不经过 React，也不需要真实 Core：
 * - `applyBufferedToolStatus`：状态先到时缓冲，卡片上牌后必须被消费（不能永久停在 running）；
 * - `shouldKeepThinkingForToolCard`：卡片还没进执行态时不能让出 thinking（否则出现无指示空窗）。
 *
 * 运行方式：npm run test:unit -- toolCardStatus
 */

import { applyBufferedToolStatus, isToolCardRunning, shouldKeepThinkingForToolCard } from '../webview/toolCardStatus';
import type { Message } from '../webview/types';
import { createChecker, runTests } from './helpers/harness';

/** 一张已经上屏的工具卡片 */
function card(status: Message['status'] = 'running'): Message {
  return {
    role: 'toolcall',
    content: '',
    toolCallId: 'tool_1',
    toolName: 'Write',
    status,
    isStreaming: status === 'running',
  } as Message;
}

/** 缓冲里「先于卡片到达」的状态更新 */
function buffered(status: string, output?: string): Map<string, { status: string; output?: string }> {
  return new Map<string, { status: string; output?: string }>([['tool_1', { status, output }]]);
}

const { check, finish } = createChecker();

runTests('toolCardStatus', () => {
  // ── RT-1：缓冲的状态在卡片上牌后被消费（否则卡片永久停在 running） ──
  {
    const buffer = buffered('success', 'Created file: a.txt');
    const applied = applyBufferedToolStatus(card('running'), buffer);
    check('success 覆盖卡片的 running' + '（'+String(`实际：${String(applied?.status)}`)+'）', applied !== null && applied.status === 'success');
    check('success 带上输出内容' + '（'+String(`实际：${String(applied?.content)}`)+'）', applied !== null && applied.content === 'Created file: a.txt');
    check('success 清掉流式标记' + '（'+String(`实际：${String(applied?.isStreaming)}`)+'）', applied !== null && applied.isStreaming === false);
    check('消费后缓冲出队' + '（实际剩余 ${buffer.size} 条）', buffer.size === 0);
  }

  // ── RT-2：状态只升不降（已收尾的卡片不能被拉回运行态） ──
  {
    const buffer = buffered('running');
    const applied = applyBufferedToolStatus(card('success'), buffer);
    check('running 不得覆盖已 success 的卡片' + '（实际：${String(applied?.status)}）', applied === null);
    check('即使不覆盖也要消费缓冲' + '（实际剩余 ${buffer.size} 条）', buffer.size === 0);
  }

  // ── RT-3：不相关的卡片不受影响 ──
  {
    const buffer = buffered('success');
    const other = { ...card('running'), toolCallId: 'tool_2' } as Message;
    check('别的工具卡片不被误改（不应命中）', applyBufferedToolStatus(other, buffer) === null);
    check(`未命中的条目留在缓冲里（实际剩余 ${buffer.size} 条）`, buffer.size === 1);
  }

  // ── RT-4：只有「卡片此刻就是进行中」时才让出 thinking ──
  check(
    'status 未推进时卡片仍算进行中（与内容渲染口径一致）',
    isToolCardRunning(undefined) === true,
  );
  check('status=running 算进行中', isToolCardRunning('running') === true);
  check('status=normal（等待授权）算进行中', isToolCardRunning('normal') === true);
  check('success 不算进行中', isToolCardRunning('success') === false);
  check('fail 不算进行中', isToolCardRunning('fail') === false);

  // 让出 thinking 的判据与「卡片会不会转风车」同源：卡片进行中就让位，否则保留。
  check('卡片进行中时让出 thinking', shouldKeepThinkingForToolCard('Write', 'running') === false);
  check('卡片未进行中时保留 thinking', shouldKeepThinkingForToolCard('Write', 'success') === true);
  check('status 未推进时同样让出（风车已亮）', shouldKeepThinkingForToolCard('Write', undefined) === false);

  // ── RT-5：WebSearch 的既有例外不变（搜索期间保留动画） ──
  check('WebSearch 即使 running 也保留 thinking' + '（搜索在 LLM 流内、卡片无动态反馈）', shouldKeepThinkingForToolCard('WebSearch', 'running') === true);
  check('工具名大小写与分隔符归一' + '（归一化后再判定）', shouldKeepThinkingForToolCard('web_search', 'running') === true);

  finish();
});
