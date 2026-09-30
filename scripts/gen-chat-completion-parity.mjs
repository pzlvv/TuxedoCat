#!/usr/bin/env node
/**
 * 生成「OpenAI Chat Completions 转换」对等对照表。
 *
 * 对照表 `src/test/fixtures/chatCompletionParity.json` 被两侧共用：
 * - `src/test/chatCompletionParity.test.ts` 用 Embedded 的
 *   `convertMessagesToChatCompletions` / `convertToolsToChatCompletionsFormat`
 *   断言对照表仍然成立（TS 实现改了这里会红）；
 * - `core-rs/src/llm_tests.rs` 的 `chat_completion_parity_tests` 用 Rust
 *   `to_chat_messages` / `to_chat_tools` 断言结果一致。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-chat-completion-parity.mjs`。
 * 每条用例：`{ name, input, output }`（input 原样进两侧，output 是 TS 的真实输出）。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const openai = require(join(repoRoot, 'out', 'src', 'core', 'llm', 'OpenAiApi.js'));

/** 消息转换用例：内部 Anthropic 风格消息 → Chat Completions 消息 */
const messageCases = [
  ['user-string', [{ role: 'user', content: '你好' }]],
  ['user-empty-string', [{ role: 'user', content: '' }]],
  ['user-empty-array', [{ role: 'user', content: [] }]],
  ['assistant-text-array', [{ role: 'assistant', content: [{ type: 'text', text: '在的' }] }]],
  ['assistant-string', [{ role: 'assistant', content: 'plain' }]],
  ['assistant-multi-text', [{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]],
  ['user-merged-text-only', [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]],
  ['user-text-and-image', [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }]],
  ['user-image-only', [{ role: 'user', content: [{ type: 'image', source: { data: 'BBBB' } }] }]],
  ['user-image-empty-data', [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', source: { data: '' } }] }]],
  ['user-input-text', [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]],
  ['user-tool-result-string', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '第一行' }] }]],
  ['user-tool-result-array', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out' }, { type: 'image', source: { data: 'x' } }] }] }]],
  ['user-tool-result-nonstring', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 42 }] }]],
  // `JSON.stringify(content ?? '')`：整数值浮点写 `1`，不能是 serde_json 的 `1.0`
  ['user-tool-result-float-object', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: { a: 1.0, b: 2.5 } }] }]],
  ['user-tool-result-float-array', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: [1.0, { n: 100.0 }] }] }]],
  ['user-tool-result-call-id-fallback', [{ role: 'user', content: [{ type: 'tool_result', tool_call_id: 'tc_1', content: 'x' }] }]],
  ['user-tool-result-and-text', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: '接着做' }] }]],
  ['assistant-tool-use-only', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'ls' } }] }]],
  ['assistant-text-and-tool-use', [{ role: 'assistant', content: [{ type: 'text', text: '我来查一下' }, { type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'call_9', name: 'Bash', input: { command: 'ls' } }] }]],
  ['assistant-tool-use-string-input', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: '{"command":"ls"}' }] }]],
  ['assistant-tool-use-null-input', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: null }] }]],
  // `JSON.stringify(input ?? {})`：整数值浮点写 `1`
  ['assistant-tool-use-float-input', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { temperature: 1.0, top_p: 0.95 } }] }]],
  ['assistant-tool-use-array-input', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: [1.0, 2] }] }]],
  ['assistant-tool-use-call-id-fallback', [{ role: 'assistant', content: [{ type: 'tool_use', call_id: 'legacy', name: 'Bash', input: {} }] }]],
  ['assistant-thinking-only', [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }]],
  ['assistant-unknown-only', [{ role: 'assistant', content: [{ type: 'unknown' }] }]],
  ['system-passthrough', [{ role: 'system', content: 'sys' }]],
  ['no-role-string', [{ content: 'no role' }]],
];

/** 工具转换用例：内部 Anthropic 风格工具 → Chat Completions function 工具 */
const toolCases = [
  ['builtin', [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]],
  ['missing-name', [{ description: '无名字' }]],
  ['empty-name', [{ name: '', description: 'd' }]],
  ['missing-schema', [{ name: 'X' }]],
  ['null-schema', [{ name: 'X', input_schema: null }]],
  ['non-function-type', [{ name: 'web_search', type: 'web_search_preview' }]],
  ['function-type', [{ name: 'Y', type: 'function', input_schema: { type: 'object' } }]],
  ['non-object-entry', [null, 'x', 42, { name: 'Z' }]],
];

const cases = messageCases.map(([name, input]) => ({
  name,
  input,
  output: openai.convertMessagesToChatCompletions(input),
}));

const tools = toolCases.map(([name, input]) => ({
  name,
  input,
  output: openai.convertToolsToChatCompletionsFormat(input),
}));

const target = join(repoRoot, 'src', 'test', 'fixtures', 'chatCompletionParity.json');
writeFileSync(target, `${JSON.stringify({ cases, tools }, null, 2)}\n`, 'utf8');
console.log(`wrote ${cases.length} message cases + ${tools.length} tool cases -> ${target}`);
