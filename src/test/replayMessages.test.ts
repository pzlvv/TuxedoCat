/**
 * 历史消息重放（`buildReplayMessageData`）——压缩后重建与展开归档的唯一转换点。
 *
 * 守护的是「被中止的工具在重放后仍是失败态」：`is_canceled: true` 的 `tool_result`
 * 不落进结果表，若没有单独补上「它已结束」这个事实，对应的 `tool_use` 会被当成
 * `running`——卡片时间线画旋转风扇、自动滚动的 scrollHeight 轮询一直空转、
 * 载入遮罩把它当实时内容。同一条历史在 `conversationLoaded` 那条恢复路径里
 * 是按失败态渲染的，两条通道不该给出两种卡片状态
 * （specs/defects/replay-drops-canceled-tool-results.md）。
 *
 * 运行方式：npm run test:unit -- replay-messages
 */

import * as assert from 'assert';
import type { Message, MessageData } from '../shared/types';
import { buildReplayMessageData, buildToolResultMap, buildToolResultMaps } from '../shared/utils/replayMessages';
import { createChecker, runTests } from './helpers/harness';

/** 造一条 assistant 消息（`tool_use` 块） */
function assistantToolUses(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })),
    },
  } as unknown as Message;
}

/** 造一条 user 消息（`tool_result` 块） */
function userToolResults(blocks: Array<Record<string, unknown>>): Message {
  return {
    type: 'user',
    message: { role: 'user', content: blocks },
  } as unknown as Message;
}

function toolCalls(messages: MessageData[]): MessageData[] {
  return messages.filter((m) => m.role === 'toolcall');
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ---------------- RT-1：被取消的工具落成 fail + 取消说明 ----------------

  // 修复前：取消结果被跳过，tool_use 落成 status='running'、content=''。
  const canceledConversation = [
    assistantToolUses([{ id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
    userToolResults([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_canceled: true,
        content: '[Previous session interrupted] Tool "Bash" was canceled before execution.',
      },
    ]),
  ];
  const canceledReplay = buildReplayMessageData(canceledConversation);
  const canceledCards = toolCalls(canceledReplay);
  assert.strictEqual(canceledCards.length, 1, 'RT-1：一个 tool_use 对应一张卡片');
  assert.strictEqual(
    canceledCards[0]?.status,
    'fail',
    'RT-1：被取消的工具是失败态，不是运行中',
  );
  assert.strictEqual(
    canceledCards[0]?.content,
    '[Previous session interrupted] Tool "Bash" was canceled before execution.',
    'RT-1：卡片内容是那条取消说明',
  );
  assert.strictEqual(canceledCards[0]?.toolCallId, 'toolu_1', 'RT-1：卡片仍对应原 tool_use_id');
  check('RT-1 被取消的工具落成 fail + 取消说明', true);

  // ---------------- RT-2：没有对应 tool_use 的取消结果不产生幽灵卡片 ----------------

  const ghostConversation = [
    assistantToolUses([{ id: 'toolu_live', name: 'Bash' }]),
    userToolResults([
      { type: 'tool_result', tool_use_id: 'toolu_ghost', is_canceled: true, content: 'gone' },
    ]),
  ];
  const ghostCards = toolCalls(buildReplayMessageData(ghostConversation));
  assert.strictEqual(ghostCards.length, 1, 'RT-2：取消结果不额外产出卡片');
  assert.strictEqual(ghostCards[0]?.toolCallId, 'toolu_live', 'RT-2：只保留有 tool_use 的卡片');
  assert.strictEqual(ghostCards[0]?.status, 'running', 'RT-2：无结果的 tool_use 仍是运行中');
  check('RT-2 取消结果不产生幽灵卡片', true);

  // ---------------- RT-3：既有语义不回归 ----------------

  const mixedConversation = [
    assistantToolUses([
      { id: 'ok', name: 'Bash' },
      { id: 'bad', name: 'Bash' },
      { id: 'pending', name: 'Bash' },
      { id: 'stopped', name: 'Bash' },
    ]),
    userToolResults([
      { type: 'tool_result', tool_use_id: 'ok', content: 'done', exit_code: 0 },
      { type: 'tool_result', tool_use_id: 'bad', content: 'boom', exit_code: 2 },
      { type: 'tool_result', tool_use_id: 'stopped', content: 'interrupted', exit_code: 130, is_canceled: true },
    ]),
  ];
  const mixedCards = toolCalls(buildReplayMessageData(mixedConversation));
  const byId = new Map(mixedCards.map((card) => [card.toolCallId, card]));
  assert.strictEqual(byId.get('ok')?.status, 'success', 'RT-3a：exit_code=0 仍是 success');
  assert.strictEqual(byId.get('ok')?.content, 'done', 'RT-3a：成功结果内容不变');
  assert.strictEqual(byId.get('bad')?.status, 'fail', 'RT-3b：exit_code≠0 仍是 fail');
  assert.strictEqual(byId.get('bad')?.content, 'boom', 'RT-3b：失败结果内容不变');
  assert.strictEqual(byId.get('pending')?.status, 'running', 'RT-3c：无结果且未取消仍是 running');
  assert.strictEqual(byId.get('stopped')?.status, 'fail', 'RT-3d：取消优先于 exit_code=130 的失败口径');
  assert.strictEqual(byId.get('stopped')?.content, 'interrupted', 'RT-3d：取消说明作为内容');
  check('RT-3 既有状态语义不回归', true);

  // ---------------- 结果表拆分 ----------------

  const maps = buildToolResultMaps(mixedConversation);
  assert.strictEqual(maps.results.size, 2, '结果表只含未取消的两条');
  assert.strictEqual(maps.canceled.size, 1, '取消表只含被取消的一条');
  assert.strictEqual(maps.canceled.get('stopped'), 'interrupted', '取消表保存说明文本');
  assert.strictEqual(
    buildToolResultMap(mixedConversation).size,
    2,
    'buildToolResultMap 仍只返回结果表（既有调用方语义不变）',
  );
  check('结果表与取消表拆分正确', true);

  // 同一 tool_use_id 后写覆盖先写（既有语义）
  const overwritten = buildToolResultMap([
    userToolResults([
      { type: 'tool_result', tool_use_id: 'dup', content: 'first', exit_code: 0 },
      { type: 'tool_result', tool_use_id: 'dup', content: 'second', exit_code: 3 },
    ]),
  ]);
  assert.strictEqual(overwritten.get('dup')?.content, 'second', '后写覆盖先写');
  assert.strictEqual(overwritten.get('dup')?.exitCode, 3, '后写的 exit_code 生效');
  check('结果表同 id 后写覆盖先写', true);

  // 数组内容（图片）按 [Image] 展示；取消说明没有文本时留空串
  const imageAndEmpty = buildToolResultMaps([
    userToolResults([
      { type: 'tool_result', tool_use_id: 'img', content: [{ type: 'image' }], exit_code: 0 },
      { type: 'tool_result', tool_use_id: 'silent', is_canceled: true, content: [{ type: 'image' }] },
    ]),
  ]);
  assert.strictEqual(imageAndEmpty.results.get('img')?.content, '[Image]', '数组内容按 [Image] 展示');
  assert.strictEqual(imageAndEmpty.canceled.get('silent'), '', '取消说明无文本时留空串');
  check('数组内容与空取消说明的口径', true);

  // 缺 tool_use_id / 非 tool_result 的块被跳过
  const ignored = buildToolResultMaps([
    userToolResults([
      { type: 'text', text: 'not a result' },
      { type: 'tool_result', content: 'no id' },
    ]),
  ]);
  assert.strictEqual(ignored.results.size, 0, '缺 tool_use_id 的结果被跳过');
  assert.strictEqual(ignored.canceled.size, 0, '缺 tool_use_id 的取消结果被跳过');
  check('非法块被跳过', true);

  finish();
}

runTests('replay-messages', run);
