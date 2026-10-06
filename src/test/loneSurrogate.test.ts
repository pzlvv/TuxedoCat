/**
 * 孤立代理项（lone surrogate）防线。
 *
 * 背景（真实事故，见配置目录 `fail_logs/llm_fail_2026-09-26T15-05-45-068Z.json`）：
 *   一段以 emoji 结尾的 Bash 输出落盘后，工具结果被按「前 2K + 后 2K」截断，
 *   尾部 `slice` 正好切在 `😀`（`D83D DE00`）的代理对中间，留下孤立低位代理项
 *   `\uDE00`。`JSON.stringify` 把它写成 `"\ude00"`——语法合法、语义非法。
 *   这个坏掉的 tool_result 进入对话历史后，**每一轮**请求都带着它，网关一律
 *   返回 400 `Upstream response was not valid JSON`，会话彻底卡死。
 *
 * 这个文件守护三件事：
 *   1. 所有按长度截断的地方都不切开代理对（对齐到字符边界）；
 *   2. 序列化出口（LLM 请求体 / Core 帧 / 历史 JSONL）不会输出 `\ude00`；
 *   3. 字面量文本 `\\ude00`（数据里真的写了这六个字符）不能被误改。
 *
 * 运行方式：npm run test:all -- lone-surrogate
 */

import * as assert from 'assert';
import { generateHeadTailPreview } from '../core/tools/toolResultStorage';
import { truncateLine } from '../core/tools/read/Read';
import { getToolUseSummary } from '../core/tools/bash/Prompt';
import {
  EndTruncatingAccumulator,
  hasLoneSurrogate,
  repairLoneSurrogatesInJson,
  sanitizeLoneSurrogates,
  stringifyJsonSafe,
  surrogateSafeHeadEnd,
  surrogateSafeTailStart,
} from '../core/utils/stringUtils';
import { encodeFrame } from '../host/standalone/protocol';
import { runCases } from './helpers/harness';

function checkPreviewNeverSplitsSurrogates(): void {
  // 头部边界：`limit` 落在代理对中间时整对丢掉
  const head = `${'😀'.repeat(4)}x`;
  assert.strictEqual(head.length, 9);
  assert.strictEqual(surrogateSafeHeadEnd(head, 3), 2, '第 2 个 emoji 不完整，整对丢掉');
  assert.strictEqual(head.slice(0, surrogateSafeHeadEnd(head, 3)), '😀');

  // 尾部边界：`start` 落在低位代理上时后移一个 code unit
  // head 的 code unit：0-1=😀 2-3=😀 4-5=😀 6-7=😀 8=x，9-4=5 正好是低位代理
  assert.strictEqual(surrogateSafeTailStart(head, 4), 6);
  assert.strictEqual(head.slice(surrogateSafeTailStart(head, 4)), '😀x');

  // 边界正好落在字符之间时不做多余调整
  assert.strictEqual(surrogateSafeHeadEnd('abcdef', 3), 3);
  assert.strictEqual(surrogateSafeTailStart('abcdef', 3), 3);
  assert.strictEqual(surrogateSafeHeadEnd('abc', 99), 3);
  assert.strictEqual(surrogateSafeTailStart('abc', 99), 0);
}

function checkGenerateHeadTailPreviewIsSurrogateSafe(): void {
  // 事故现场：总长 1 + 20 code unit，尾部 4 个 code unit 从代理对中间开始
  const content = `a${'😀'.repeat(10)}`;
  const { preview, hasMore } = generateHeadTailPreview(content, 4, 4);
  assert.strictEqual(hasMore, true);
  assert.strictEqual(preview, 'a😀\n... (14 chars omitted) ...\n😀😀');
  assert.ok(!hasLoneSurrogate(preview), 'preview 不能含孤立代理项');
  // 省略数按对齐后的实际边界算（不是 4 + 4）
  assert.ok(preview.includes('(14 chars omitted)'), preview);

  // 头部边界切开代理对时同样整对丢掉
  // 总长 8 + 20 = 28：头部只留 2 个 code unit（1 个 emoji），尾部 4 个 'b'
  const headSplit = `${'😀'.repeat(4)}${'b'.repeat(20)}`;
  const headPreview = generateHeadTailPreview(headSplit, 3, 4);
  assert.strictEqual(headPreview.preview, '😀\n... (22 chars omitted) ...\nbbbb');
  assert.ok(!hasLoneSurrogate(headPreview.preview));

  // 不超上限时原样返回
  const short = '😀😀';
  assert.deepStrictEqual(generateHeadTailPreview(short, 4, 4), { preview: short, hasMore: false });
}

function checkTruncateLineIsSurrogateSafe(): void {
  const line = `${'a'.repeat(5)}${'😀'.repeat(5)}`;
  // maxLineLength=6 落在第 1 个 emoji 的低位代理上 → 只保留 5 个 'a'
  const truncated = truncateLine(line, 6);
  assert.strictEqual(truncated, 'aaaaa... (line truncated to 6 chars)');
  assert.ok(!hasLoneSurrogate(truncated));
  // 未超长时原样返回
  assert.strictEqual(truncateLine('abc', 6), 'abc');
}

function checkToolUseSummaryIsSurrogateSafe(): void {
  const summary = getToolUseSummary({ command: `${'a'.repeat(49)}${'😀'.repeat(5)}` }) ?? '';
  assert.ok(!hasLoneSurrogate(summary), `summary 含孤立代理项: ${summary}`);
  assert.ok(summary.endsWith('...'));
}

function checkAccumulatorIsSurrogateSafe(): void {
  const acc = new EndTruncatingAccumulator(5);
  acc.append('aaaa');
  acc.append('😀😀'); // 剩余 1 个 code unit：只能丢掉整个 emoji
  const text = acc.toString();
  assert.ok(text.startsWith('aaaa'), text);
  assert.ok(!hasLoneSurrogate(text), `累加器输出含孤立代理项: ${text}`);
}

function checkSanitizeHelpers(): void {
  assert.strictEqual(hasLoneSurrogate('😀 正常'), false);
  assert.strictEqual(hasLoneSurrogate('\uDE00'), true);
  assert.strictEqual(hasLoneSurrogate('a\uD83Db'), true, '高位代理后面不是低位代理');

  assert.strictEqual(sanitizeLoneSurrogates('😀 正常'), '😀 正常', '干净字符串原样返回');
  assert.strictEqual(sanitizeLoneSurrogates('a\uDE00b'), 'a\uFFFDb');
  assert.strictEqual(sanitizeLoneSurrogates('\uD83D\uDE00'), '😀', '合法代理对不动');
}

function checkStringifyJsonSafe(): void {
  // 事故里的那条：JSON.stringify 会把孤立代理项写成 `\ude00`
  const broken = { output: `emoji ${'\uDE00'}` };
  assert.ok(JSON.stringify(broken).includes('\\ude00'), '前提：JSON.stringify 会输出转义');
  assert.ok(!stringifyJsonSafe(broken).includes('\\ude00'));
  assert.strictEqual(JSON.parse(stringifyJsonSafe(broken)).output, 'emoji \uFFFD');

  // 字面量文本 `\ude00`（反斜杠 + ude00）不能被误改
  const literal = { text: '\\ude00' };
  assert.strictEqual(stringifyJsonSafe(literal), JSON.stringify(literal));
  assert.strictEqual(JSON.parse(stringifyJsonSafe(literal)).text, '\\ude00');

  // 转义反斜杠 + 孤立代理项：反斜杠要保留，代理项要修掉
  const mixed = { text: '\\\uDE00' };
  const repaired = stringifyJsonSafe(mixed);
  assert.ok(!repaired.includes('\\ude00'), repaired);
  assert.strictEqual(JSON.parse(repaired).text, '\\\uFFFD');

  // 合法代理对、普通 `\uXXXX` 转义、控制字符都不受影响
  const untouched = { a: '😀', b: '\u0041', c: '\n', d: '\u2028' };
  assert.strictEqual(stringifyJsonSafe(untouched), JSON.stringify(untouched));
  assert.strictEqual(repairLoneSurrogatesInJson('{"a":1}'), '{"a":1}');
  // 手写的合法代理对转义（JSON.stringify 不会这么输出，但要和 Core 侧口径一致）
  assert.strictEqual(repairLoneSurrogatesInJson('"\\ud83d\\ude00"'), '"\\ud83d\\ude00"');
  // 高位转义后面跟的不是低位转义 → 仍然要修
  assert.strictEqual(repairLoneSurrogatesInJson('"\\ud83dx"'), '"\uFFFDx"');
}

function checkEncodeFrameRepairsLoneSurrogates(): void {
  const frame = {
    kind: 'response' as const,
    id: 7,
    ok: true as const,
    result: { content: `尾巴 ${'\uDE00'}` },
  };
  const line = encodeFrame(frame as never);
  assert.ok(line.endsWith('\n'), '帧必须以换行结尾');
  assert.ok(!line.includes('\\ude00'), line);
  // Core（Rust/serde_json）能严格解析
  const parsed = JSON.parse(line);
  assert.strictEqual(parsed.id, 7);
  assert.ok(parsed.result.content.endsWith('\uFFFD'), parsed.result.content);
}

const CASES: Array<[string, () => void]> = [
  ['代理对边界对齐（head/tail）', checkPreviewNeverSplitsSurrogates],
  ['工具结果「前 2K + 后 2K」预览不切开 emoji', checkGenerateHeadTailPreviewIsSurrogateSafe],
  ['Read 单行截断不切开 emoji', checkTruncateLineIsSurrogateSafe],
  ['Bash 命令摘要截断不切开 emoji', checkToolUseSummaryIsSurrogateSafe],
  ['EndTruncatingAccumulator 不切开 emoji', checkAccumulatorIsSurrogateSafe],
  ['sanitizeLoneSurrogates / hasLoneSurrogate', checkSanitizeHelpers],
  ['stringifyJsonSafe 修转义且不误伤字面量', checkStringifyJsonSafe],
  ['encodeFrame 输出可被严格解析', checkEncodeFrameRepairsLoneSurrogates],
];

runCases(
  'loneSurrogate',
  CASES.map(([name, run]) => ({ name, run })),
);
