/**
 * 自动压缩「当前上下文 token 数」估算口径的回归测试。
 *
 * 背景（真实事故）：
 *   一个 700 条消息 / 8.6MB 的会话，最后一次 API usage 的 input_tokens 只有
 *   ~406K，但自动压缩判断用的估算值却是 3,017,087 —— 于是 context 显示才
 *   ~400K（不到 500K）就触发了自动压缩。
 *
 * 根因：估算直接 `JSON.stringify(内部 Message[])`，把只服务 UI 的字段也算进了
 *   请求长度：
 *     - content block 顶层 `_meta`（UI 历史恢复 / 统计）
 *     - tool_result 的 `beforeContent` / `afterContent`（Edit/Write 的 diff 展示，
 *       可能是**整份文件内容**）
 *   这些字段一个字节都不会发给 LLM，却占了该会话 8.6MB 中的绝大部分。
 *
 * 运行方式：npm run test:all -- context-token-estimate
 */

import * as assert from 'assert';
import { buildRawApiMessages } from '../core/Query';
import { estimateRequestTokens, estimateTextTokens } from '../core/utils/tokenEstimate';
import { runCases } from './helpers/harness';

/** 构造一条「Edit 工具结果」user 消息：content 很短，diff 展示字段极大。 */
function editToolResultMessage(toolUseId: string, fileBody: string): any {
  return {
    type: 'user',
    uuid: `tool_${toolUseId}`,
    parentUuid: 'msg_parent',
    timestamp: 1790000000000,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Edited file: d:\\proj\\DEVELOPMENT.md\nMade 1 replacement\nEdited lines 1008-1017',
          exit_code: 0,
          is_canceled: false,
          startLine: 1008,
          endLine: 1017,
          // UI 专用：整份文件内容
          beforeContent: fileBody,
          afterContent: fileBody,
          contextBefore: fileBody.split('\n').slice(0, 4),
          contextAfter: fileBody.split('\n').slice(-4),
        },
      ],
    },
  };
}

/** 构造一条 assistant 消息：tool_use block 顶层带 UI 专用 `_meta`。 */
function assistantToolUseMessage(toolUseId: string, bigMeta: string): any {
  return {
    type: 'assistant',
    uuid: `msg_${toolUseId}`,
    parentUuid: null,
    timestamp: 1790000000001,
    message: {
      role: 'assistant',
      usage: { input_tokens: 406128, output_tokens: 87 },
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Edit',
          input: { file_path: 'd:\\proj\\DEVELOPMENT.md', old_string: 'a', new_string: 'b' },
          _meta: { beforeContent: bigMeta, afterContent: bigMeta, diffHunks: [{ x: bigMeta }] },
        },
      ],
    },
  };
}

function checkStripsUiOnlyFields(): void {
  const body = Array.from({ length: 2000 }, (_, i) => `line ${i}: const x = ${i};`).join('\n');
  const messages = [
    assistantToolUseMessage('call_1', body),
    editToolResultMessage('call_1', body),
  ] as any[];

  const shaped = buildRawApiMessages(messages as any);
  assert.strictEqual(shaped.length, 2, 'user / assistant 各保留一条');

  const toolUse = (shaped[0].content as any[])[0];
  assert.strictEqual(toolUse._meta, undefined, 'tool_use 的 _meta 不应进入请求载荷');
  assert.strictEqual(toolUse.type, 'tool_use');
  assert.deepStrictEqual(toolUse.input, messages[0].message.content[0].input, 'input 必须原样保留');

  const toolResult = (shaped[1].content as any[])[0];
  assert.strictEqual(toolResult.beforeContent, undefined, 'tool_result.beforeContent 不应进入请求载荷');
  assert.strictEqual(toolResult.afterContent, undefined, 'tool_result.afterContent 不应进入请求载荷');
  assert.strictEqual(toolResult.contextBefore, undefined, 'tool_result.contextBefore 不应进入请求载荷');
  assert.strictEqual(toolResult.contextAfter, undefined, 'tool_result.contextAfter 不应进入请求载荷');
  assert.strictEqual(toolResult.type, 'tool_result', 'type 必须保留');
  assert.strictEqual(toolResult.tool_use_id, 'call_1', 'tool_use_id 必须保留');
  assert.strictEqual(toolResult.exit_code, 0, 'exit_code 必须保留');
  assert.ok(
    typeof toolResult.content === 'string' && toolResult.content.includes('Made 1 replacement'),
    'tool_result.content 必须原样保留（这才是发给 LLM 的内容）',
  );
}

function checkEstimateMatchesPayloadNotUiFields(): void {
  const body = Array.from({ length: 2000 }, (_, i) => `line ${i}: const x = ${i};`).join('\n');
  const messages = [
    assistantToolUseMessage('call_1', body),
    editToolResultMessage('call_1', body),
  ] as any[];

  const rawEstimate = estimateRequestTokens({ messages });
  const shapedEstimate = estimateRequestTokens({ messages: buildRawApiMessages(messages as any) });

  assert.ok(
    rawEstimate > shapedEstimate * 5,
    `估算应基于请求载荷：raw=${rawEstimate} 远大于 shaped=${shapedEstimate}`,
  );
  // shaped 只剩短 content + 小 input，量级应该很小
  assert.ok(shapedEstimate < 1000, `shaped 估算应很小，实际 ${shapedEstimate}`);

  // 关键回归：拿「请求载荷」估算出的值必须远低于 1M 上下文的压缩阈值（~998K），
  // 而拿内部 Message[] 估算的值会误触发压缩。
  assert.ok(shapedEstimate < 998_576, '基于请求载荷的估算不应误触发自动压缩');
}

function checkEstimateTextTokensBasics(): void {
  assert.strictEqual(estimateTextTokens(''), 0);
  // 非 CJK 走 3 字符/token（保守），纯 ASCII 估算 ≈ len/3
  assert.strictEqual(estimateTextTokens('abcdef'), 2);
  // CJK 走 1.2 token/字
  assert.strictEqual(estimateTextTokens('你好'), 3);
}

function checkPreservesNonArrayContent(): void {
  const messages = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
    { type: 'system', uuid: 's1', content: 'should be dropped' },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 123 } },
  ] as any[];

  const shaped = buildRawApiMessages(messages as any);
  assert.strictEqual(shaped.length, 2, 'system 消息被过滤，user/assistant 保留');
  assert.strictEqual(shaped[0].content, 'hello');
  assert.strictEqual(shaped[1].content, '123', '非 string/array 的 content 统一 String() 化');
}

const CASES: Array<[string, () => void]> = [
  ['buildRawApiMessages 剔除 _meta 与 tool_result diff 展示字段', checkStripsUiOnlyFields],
  ['自动压缩估算基于请求载荷而非内部 Message[]', checkEstimateMatchesPayloadNotUiFields],
  ['estimateTextTokens 基础折算', checkEstimateTextTokensBasics],
  ['buildRawApiMessages 保留非数组 content 语义', checkPreservesNonArrayContent],
];

runCases('contextTokenEstimate', CASES.map(([name, run]) => ({ name, run })));
