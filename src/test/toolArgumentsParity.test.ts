/**
 * 工具入参序列化对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/toolArgumentsParity.json`：
 * - 本文件断言「对照表 == 真实 `serializeToolArguments` / `sanitizeAnthropicMessages`
 *   的输出」（防对照表腐化）；
 * - `core-rs/src/engine_tests.rs` 的 `tool_arguments_parity_tests` 断言 Rust 侧
 *   `serialize_tool_arguments` / `sanitize_anthropic_messages` 产出同结果。
 *
 * 背景：LLM 生成的工具参数解析失败时，非法 JSON 原文会残留在 `tool_use.input`
 * （string）；若原样发给 Provider，严格校验 arguments / input 的服务商会 400，
 * 且毒化上下文后**此后每一轮**请求都失败。序列化层必须保证输出永远是合法 JSON /
 * 对象。
 *
 * 运行方式：npm run test:all -- tool-arguments-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { serializeToolArguments } from '../core/utils/toolInput';
import { sanitizeAnthropicMessages } from '../core/llm/RealApi';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  input: unknown;
  arguments: string;
  objectInput: unknown;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/toolArgumentsParity.json');

/** 把单个 input 包成 assistant tool_use 消息再消毒，取回归一后的 input */
function sanitizedObjectInput(input: unknown): unknown {
  const [message] = sanitizeAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: 'Bash', input }] },
  ]);
  const block = (message.content as Array<{ type: string; input?: unknown }>)[0];
  return block.input;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    check(
      `${testCase.name}: arguments 一致`,
      serializeToolArguments(testCase.input) === testCase.arguments,
    );
    check(
      `${testCase.name}: Anthropic input 一致`,
      JSON.stringify(sanitizedObjectInput(testCase.input)) === JSON.stringify(testCase.objectInput),
    );
  }

  // input 缺失（undefined）的口径：arguments 空对象、Anthropic input 空对象
  check('input 缺失：arguments 空对象', serializeToolArguments(undefined) === '{}');
  check('input 缺失：Anthropic input 空对象', JSON.stringify(sanitizedObjectInput(undefined)) === '{}');

  // 对象型 tool_use 不被改写（保持原引用，请求体不因消毒多复制消息）
  const objectBlock = { type: 'tool_use', id: 't-2', name: 'Bash', input: { command: 'ls' } };
  const userMessage = { role: 'user', content: 'hi' };
  const sanitized = sanitizeAnthropicMessages([
    userMessage,
    { role: 'assistant', content: [objectBlock, { type: 'text', text: 'ok' }] },
  ] as Array<{ role: string; content: string | unknown[] }>);
  const keptMessage = sanitized[1];
  check('对象型 tool_use 保持原引用', (keptMessage.content as unknown[])[0] === objectBlock);

  finish();
}

runTests('tool-arguments-parity', run);
