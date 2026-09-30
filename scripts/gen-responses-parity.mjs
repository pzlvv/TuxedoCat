#!/usr/bin/env node
/**
 * 生成「OpenAI Responses API」对等对照表。
 *
 * 对照表 `src/test/fixtures/responsesParity.json` 被两侧共用：
 * - `src/test/responsesParity.test.ts` 用 Embedded 的真实实现
 *   （`llm/ResponsesApi.ts` 的转换纯函数）断言对照表仍成立；
 * - `core-rs/src/responses_tests.rs` 的 `parity_tests` 用 Rust `responses::*` 断言结果一致。
 *
 * 覆盖：请求 URL、工具转换、消息 → input items 转换、status 映射、usage 提取、
 * 本地输入估算、usage 可信度判定、`response.output` → 内容块校准。
 * SSE 事件循环本身由 Rust 侧假 LLM 端到端用例覆盖。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-responses-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const responses = require(join(repoRoot, 'out', 'src', 'core', 'llm', 'ResponsesApi.js'));

// ---------------- 请求 URL ----------------

const urlCases = [
  'https://api.deepseek.com',
  'https://api.deepseek.com/v1',
  'https://api.deepseek.com/v1/',
  'https://api.deepseek.com/',
  'http://127.0.0.1:8080/v1',
  'https://opencode.ai/zen/go',
];

const urls = urlCases.map((baseURL) => ({
  baseURL,
  result: responses.buildResponsesUrl(baseURL),
}));

// ---------------- 工具转换 ----------------

const toolCases = [
  [],
  [{ name: 'Bash', description: 'Execute Bash', input_schema: { type: 'object', properties: {} } }],
  [
    { name: 'Read', description: 'Read', input_schema: { type: 'object', required: ['file_path'] } },
    { type: 'web_search' },
    { type: 'function', name: 'Explicit', description: 'd', parameters: { type: 'object' } },
  ],
  [{ description: 'no name' }],
  [{ name: 'NoSchema' }],
];

const tools = toolCases.map((input) => ({
  input,
  result: responses.convertToolsToResponsesFormat(input),
}));

// ---------------- 消息 → input items ----------------

const messageCases = [
  { name: '纯字符串 user', messages: [{ role: 'user', content: 'hello' }] },
  { name: '纯字符串 assistant', messages: [{ role: 'assistant', content: 'hi' }] },
  {
    name: 'user 文本块',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'input_text', text: 'b' }] }],
  },
  {
    name: 'user 工具结果（字符串）',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    ],
  },
  {
    name: 'user 工具结果（数组）',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'nested' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
              'plain',
            ],
          },
        ],
      },
    ],
  },
  {
    // 数组里缺 text 的 text 块 / 缺 source 的 image 块：TS 分别落到
    // `JSON.stringify(block)` 与 `toImagePart(...) === null`
    name: 'user 工具结果（数组含缺字段的块）',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text' }, { type: 'image' }, { type: 'text', text: 'ok' }, 42],
          },
        ],
      },
    ],
  },
  {
    // `JSON.stringify(content ?? '')`：null 先补成空串，再 stringify 得到 `""`
    name: 'user 工具结果（content 为 null）',
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: null }] },
    ],
  },
  {
    name: 'user 工具结果（content 缺失）',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1' }] }],
  },
  {
    // 整数值浮点：`JSON.stringify` 写 `1`，不能是 serde_json 的 `1.0`
    name: 'user 工具结果（content 为对象，整数值浮点）',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: { a: 1.0, b: 2.5 } }],
      },
    ],
  },
  {
    name: 'user 工具结果 + 文本（顺序：先 output 后 user）',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'done' },
        ],
      },
    ],
  },
  {
    name: 'user 图片',
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZ' } }],
      },
    ],
  },
  {
    name: 'user 图片缺 source',
    messages: [{ role: 'user', content: [{ type: 'image' }] }],
  },
  {
    name: 'assistant 文本 + 思考 + 工具调用',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想想' },
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'call_3', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    ],
  },
  {
    name: 'assistant 空思考被跳过',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'x' }] }],
  },
  {
    name: 'assistant 工具入参是字符串',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: '{"command":"ls"}' }] },
    ],
  },
  {
    name: 'assistant 工具入参缺失',
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash' }] }],
  },
  {
    name: '多轮完整对话',
    messages: [
      { role: 'user', content: '帮我看看' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考中' },
          { type: 'text', text: '我先读一下' },
          { type: 'tool_use', id: 'call_r', name: 'Read', input: { file_path: '/tmp/a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_r', content: 'line' }] },
    ],
  },
];

const messages = messageCases.map(({ name, messages: input }) => ({
  name,
  input,
  result: responses.convertMessagesToResponsesInput(input),
}));

// ---------------- status 映射 ----------------

const statusCases = [
  { status: 'completed', reason: null },
  { status: 'incomplete', reason: 'max_output_tokens' },
  { status: 'incomplete', reason: 'other' },
  { status: 'incomplete', reason: null },
  { status: 'failed', reason: null },
  { status: 'cancelled', reason: null },
  { status: 'queued', reason: null },
  { status: undefined, reason: null },
];

const statuses = statusCases.map(({ status, reason }) => ({
  status: status ?? null,
  reason,
  result: responses.mapResponsesStatus(status, reason ? { reason } : undefined),
}));

// ---------------- usage 提取 ----------------

const usageCases = [
  undefined,
  {},
  { input_tokens: 10, output_tokens: 5 },
  {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 60 },
    output_tokens_details: { reasoning_tokens: 8 },
  },
  { input_tokens: 0, output_tokens: 0 },
  { input_tokens_details: { cached_tokens: 3 } },
];

const usages = usageCases.map((input) => ({
  input: input ?? null,
  result: responses.extractUsage(input) ?? null,
}));

// ---------------- 本地输入估算 ----------------

const estimateCases = [
  { name: '纯文本', input: [{ role: 'user', content: [{ type: 'input_text', text: 'abcd' }] }], system: 'sys', tools: [] },
  {
    name: '带图片（base64 被剔除）',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'x' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ],
    system: null,
    tools: [],
  },
  {
    name: '带工具',
    input: [],
    system: 'system prompt',
    tools: [{ type: 'function', name: 'Bash', description: 'd', parameters: { type: 'object' } }],
  },
];

estimateCases.push(
  // 长度按 UTF-16 code unit（JS `.length`）：非 ASCII 时与 UTF-8 字节数差出整倍数
  { name: '非 ASCII 系统提示（UTF-16 长度）', input: [], system: '中文系统提示 🐱', tools: [] },
  // 整数值浮点：`JSON.stringify` 写 `1`，不能是 serde_json 的 `1.0`
  {
    name: '整数值浮点（JSON.stringify 写 1）',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'x' }],
        meta: { temperature: 1.0, top_p: 0.95 },
      },
    ],
    system: null,
    tools: [],
  },
);

const estimates = estimateCases.map(({ name, input, system, tools: inputTools }) => ({
  name,
  input,
  system,
  tools: inputTools,
  result: responses.estimateLocalInputTokens(input, system ?? undefined, inputTools),
}));

// ---------------- usage 可信度 ----------------

const skipCases = [
  { webSearchUsed: true, inputTokens: 10, localInputEstimate: 10, contextWindow: 100_000 },
  { webSearchUsed: false, inputTokens: 10, localInputEstimate: 10, contextWindow: 100_000 },
  { webSearchUsed: false, inputTokens: 60_001, localInputEstimate: 10, contextWindow: 100_000 },
  { webSearchUsed: false, inputTokens: 60_000, localInputEstimate: 10, contextWindow: 100_000 },
  { webSearchUsed: false, inputTokens: 0, localInputEstimate: 0, contextWindow: 0 },
];

const skipUsage = skipCases.map((input) => ({
  ...input,
  result: responses.shouldSkipUsageForContext(input),
}));

// ---------------- response.output → 内容块 ----------------

const syncCases = [
  { name: '空 output', output: null },
  { name: '空数组', output: [] },
  {
    name: '文本消息',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
  },
  {
    name: 'reasoning（content 优先）',
    output: [
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: 'from-content' }],
        summary: [{ text: 'from-summary' }],
      },
    ],
  },
  {
    name: 'reasoning（回退 summary）',
    output: [{ type: 'reasoning', content: [], summary: [{ text: 'only-summary' }] }],
  },
  {
    name: 'function_call',
    output: [{ type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":"ls"}' }],
  },
  {
    name: 'function_call 坏 JSON',
    output: [{ type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":' }],
  },
  {
    name: '混合（顺序保持）',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r' }] },
      { type: 'message', content: [{ type: 'output_text', text: 't' }] },
      { type: 'function_call', id: 'call_a', name: 'Read', arguments: '{}' },
      { type: 'web_search_call' },
    ],
  },
];

const syncOutput = syncCases.map(({ name, output }) => {
  const blocks = [];
  responses.syncContentBlocksFromOutput(blocks, output ?? undefined);
  return { name, output: output ?? null, result: blocks };
});

const fixture = {
  note:
    'OpenAI Responses API 纯函数对照表（Embedded `llm/ResponsesApi.ts` ↔ Standalone `core-rs/src/responses.rs`）。' +
    '覆盖 URL / 工具 / 消息转换、status 映射、usage 提取、本地输入估算、usage 可信度与 output 校准；' +
    'SSE 事件循环由 Rust 侧假 LLM 端到端用例覆盖。',
  urls,
  tools,
  messages,
  statuses,
  usages,
  estimates,
  skipUsage,
  syncOutput,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'responsesParity.json'),
  `${JSON.stringify(fixture, null, 2)}\n`,
);

console.log('wrote src/test/fixtures/responsesParity.json');
