#!/usr/bin/env node
/**
 * 生成「对话压缩」对等对照表。
 *
 * 对照表 `src/test/fixtures/compactParity.json` 被两侧共用：
 * - `src/test/compactParity.test.ts` 用 Embedded 的真实实现
 *   （`compact/prompt.ts` / `compact/types.ts` / `compact/compact.ts` 的导出）断言对照表仍成立；
 * - `core-rs/src/compact_tests.rs` 的 `parity_tests` 用 Rust `compact::*` 断言结果一致。
 *
 * 只覆盖**纯函数**：提示词拼装、用户输入历史提取、阈值计算、可压缩判定与压缩后消息组装。
 * 真正跑 LLM 的压缩流程由 Rust 侧单测（假 LLM）覆盖。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-compact-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(repoRoot, 'out', 'src', 'core');

const {
  formatMessagesForCompact,
  getUserInputHistory,
  formatUserInputHistory,
  toUserInputEntries,
  formatUserInputEntries,
  readCompactUserInputHistory,
  selectUserInputHistory,
  generateCompactSummaryPrompt,
  generateCompactUserMessage,
} = require(join(coreDir, 'compact', 'prompt.js'));
const { getAutoCompactThreshold } = require(join(coreDir, 'compact', 'types.js'));
const { hasCompactableMessages, buildPostCompactMessages } = require(join(
  coreDir,
  'compact',
  'compact.js',
));
const { buildReplayMessageData } = require(join(coreDir, 'utils', 'replayMessages.js'));

// ---------------- 消息夹具 ----------------

const conversation = [
  {
    type: 'user',
    message: { role: 'user', content: '帮我看一下这个文件' },
    uuid: 'u-1',
    timestamp: 1,
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'x'.repeat(250) },
        { type: 'text', text: '好的，我先读一下' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    },
    uuid: 'a-1',
    timestamp: 2,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'line one\nline two',
          exit_code: 0,
        },
      ],
    },
    uuid: 'r-1',
    timestamp: 3,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '继续' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    },
    uuid: 'u-2',
    timestamp: 4,
  },
  { type: 'system', content: 'system note', uuid: 's-1', timestamp: 5 },
  {
    type: 'user',
    message: { role: 'user', content: '<reminder>please reply</reminder>' },
    uuid: 'u-3',
    timestamp: 6,
  },
  {
    type: 'user',
    message: { role: 'user', content: 'reminder 字段消息' },
    uuid: 'u-4',
    timestamp: 7,
    reminder: 'x',
  },
  {
    type: 'user',
    message: { role: 'user', content: 'silent 消息' },
    uuid: 'u-5',
    timestamp: 8,
    silent: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: '子代理回复' },
    uuid: 'u-6',
    timestamp: 9,
    origin: 'agent',
  },
  {
    type: 'user',
    message: { role: 'user', content: '旧字段子代理回复' },
    uuid: 'u-7',
    timestamp: 10,
    fromSubAgent: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: '后台任务完成' },
    uuid: 'u-8',
    timestamp: 11,
    origin: 'bash',
  },
  {
    type: 'user',
    message: { role: 'user', content: '技能注入' },
    uuid: 'u-9',
    timestamp: 12,
    isMeta: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: '压缩摘要' },
    uuid: 'u-10',
    timestamp: 13,
    isCompactSummary: true,
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '带块的用户消息' }] },
    uuid: 'u-11',
    timestamp: 14,
  },
  { type: 'user', message: { role: 'user', content: '' }, uuid: 'u-12', timestamp: 15 },
];

const toolResultArrayMessage = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: [
          { type: 'text', text: 'nested text' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B' } },
        ],
      },
    ],
  },
  uuid: 'r-2',
  timestamp: 16,
};

const sourceBlockMessage = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '' },
      { type: 'text', text: 'has text' },
      { type: 'unknown' },
      { type: 'thinking' },
      { type: 'tool_use', id: 'call_3', name: 'Bash', input: {} },
    ],
  },
  uuid: 'a-2',
  timestamp: 17,
};

// 未知类型 block 走 `JSON.stringify(block)` 兜底：整数值浮点（`1.0`）在 JS 里写成 `1`，
// 不能被 serde_json 写成 `1.0`。
const jsonFallbackBlockMessage = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'custom', value: 1.0, nested: { n: 100.0 }, note: '中文 note' },
    ],
  },
  uuid: 'u-json-fallback',
  timestamp: 18,
};

const formatCases = [
  { name: '完整会话', messages: conversation },
  { name: '空数组', messages: [] },
  { name: '工具结果数组内容', messages: [toolResultArrayMessage] },
  { name: 'assistant 各种块', messages: [sourceBlockMessage] },
  { name: '未知块走 JSON.stringify（整数值浮点）', messages: [jsonFallbackBlockMessage] },
];

const formatted = formatCases.map(({ name, messages }) => ({
  name,
  messages,
  result: formatMessagesForCompact(messages),
}));

// ---------------- 用户输入历史 ----------------

const historyCases = [
  { name: '完整会话', messages: conversation },
  { name: '空数组', messages: [] },
  {
    name: 'JS 空白口径（U+FEFF / U+0085）',
    messages: [
      { type: 'user', message: { role: 'user', content: '\uFEFF' }, uuid: 'w-1', timestamp: 1 },
      { type: 'user', message: { role: 'user', content: '\u0085' }, uuid: 'w-2', timestamp: 2 },
      { type: 'user', message: { role: 'user', content: '  \uFEFFhello\u0085  ' }, uuid: 'w-3', timestamp: 3 },
      { type: 'user', message: { role: 'user', content: '\uFEFF<reminder>x</reminder>' }, uuid: 'w-4', timestamp: 4 },
    ],
  },
];

const userHistory = historyCases.map(({ name, messages }) => ({
  name,
  messages,
  history: getUserInputHistory(messages),
  result: formatUserInputHistory(getUserInputHistory(messages)),
}));

// ---------------- 用户输入历史条目（uuid + 纯文本） ----------------

const userInputEntries = historyCases.map(({ name, messages }) => ({
  name,
  messages,
  result: toUserInputEntries(getUserInputHistory(messages)),
}));

const entryFormatCases = [
  {
    name: '两条',
    entries: [
      { uuid: 'e0', content: '第一条' },
      { uuid: 'e1', content: '第二条' },
    ],
  },
  {
    name: '空内容跳过并重新编号',
    entries: [
      { uuid: 'e0', content: '   ' },
      { uuid: 'e1', content: 'x' },
    ],
  },
  { name: '空数组', entries: [] },
];

const userInputEntryFormatting = entryFormatCases.map(({ name, entries }) => ({
  name,
  entries,
  result: formatUserInputEntries(entries),
}));

// ---------------- 全局用户输入历史选择（多次压缩） ----------------

const entry = (uuid, content = `msg-${uuid}`) => ({ uuid, content });
const entries = (prefix, count) =>
  Array.from({ length: count }, (_, i) => entry(`${prefix}${i}`));

const selectionCases = [
  { name: '首次压缩（无持久化历史）超限', previous: [], regionInputs: entries('r', 13) },
  { name: '合计恰好上限', previous: entries('u', 4), regionInputs: entries('r', 8) },
  { name: '多次压缩：头部固定为持久化历史', previous: entries('u', 4), regionInputs: entries('r', 20) },
  { name: '多次压缩：6 条历史 + 1 条新增', previous: entries('u', 6), regionInputs: entries('r', 1) },
  { name: '重复 uuid 去重且保序', previous: [entry('u0'), entry('u1')], regionInputs: [entry('u1'), entry('u2')] },
  { name: '空输入', previous: [], regionInputs: [] },
];

const userInputHistorySelection = selectionCases.map(({ name, previous, regionInputs }) => ({
  name,
  previous,
  regionInputs,
  result: selectUserInputHistory(previous, regionInputs),
}));

// ---------------- 读取摘要持久化的用户输入历史 ----------------

const summaryHistoryCases = [
  { name: '没有摘要消息', messages: conversation },
  {
    name: '摘要消息带历史',
    messages: [
      { type: 'user', message: { role: 'user', content: '普通' }, uuid: 'p-1', timestamp: 1 },
      {
        type: 'user',
        message: { role: 'user', content: '摘要' },
        uuid: 's-1',
        timestamp: 2,
        isCompactSummary: true,
        compactUserInputHistory: [entry('h0'), entry('h1')],
      },
    ],
  },
  {
    name: '取最后一条摘要消息',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: '摘要1' },
        uuid: 's-1',
        timestamp: 1,
        isCompactSummary: true,
        compactUserInputHistory: [entry('old')],
      },
      {
        type: 'user',
        message: { role: 'user', content: '摘要2' },
        uuid: 's-2',
        timestamp: 2,
        isCompactSummary: true,
        compactUserInputHistory: [entry('new')],
      },
    ],
  },
  {
    name: '摘要消息没有该字段',
    messages: [
      { type: 'user', message: { role: 'user', content: '摘要' }, uuid: 's-3', timestamp: 1, isCompactSummary: true },
    ],
  },
];

const compactUserInputHistory = summaryHistoryCases.map(({ name, messages }) => ({
  name,
  messages,
  result: readCompactUserInputHistory(messages),
}));

// ---------------- 摘要 prompt ----------------

const promptCases = [
  { name: '无自定义指示', messages: conversation, custom: null },
  { name: '有自定义指示', messages: conversation, custom: '只保留结论' },
  { name: '空消息', messages: [], custom: null },
];

const summaryPrompts = promptCases.map(({ name, messages, custom }) => ({
  name,
  messages,
  custom,
  result: generateCompactSummaryPrompt(messages, custom ?? undefined),
}));

// ---------------- 压缩后 user 消息 ----------------

const userMessageCases = [
  { name: '仅摘要', summary: 'SUM', transcriptPath: null, userInputHistory: null },
  { name: '带 transcript', summary: 'SUM', transcriptPath: '/tmp/t.jsonl', userInputHistory: null },
  { name: '带用户输入历史', summary: 'SUM', transcriptPath: null, userInputHistory: '1. hi' },
  { name: '全带', summary: 'SUM', transcriptPath: '/tmp/t.jsonl', userInputHistory: '1. hi\n\n2. yo' },
];

const compactUserMessages = userMessageCases.map(
  ({ name, summary, transcriptPath, userInputHistory }) => ({
    name,
    summary,
    transcriptPath,
    userInputHistory,
    result: generateCompactUserMessage(
      summary,
      transcriptPath ?? undefined,
      userInputHistory ?? undefined,
    ),
  }),
);

// ---------------- 阈值 ----------------

const thresholdCases = [
  { contextWindow: 1024 * 1024, maxOutputTokens: 384 * 1024 },
  { contextWindow: 200_000, maxOutputTokens: 8_192 },
  { contextWindow: 200_000, maxOutputTokens: 0 },
  { contextWindow: 100_000, maxOutputTokens: 200_000 },
  { contextWindow: 0, maxOutputTokens: 1000 },
];

const thresholds = thresholdCases.map(({ contextWindow, maxOutputTokens }) => ({
  contextWindow,
  maxOutputTokens,
  result: getAutoCompactThreshold(contextWindow, maxOutputTokens),
}));

// ---------------- 可压缩判定 ----------------

const boundary = (uuid) => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'boundary',
  uuid,
  timestamp: 0,
});

const compactableCases = [
  { name: '空数组', messages: [], keep: 30 },
  { name: '恰好等于保留数', messages: Array.from({ length: 30 }, (_, i) => ({ uuid: `m-${i}` })), keep: 30 },
  { name: '多一条', messages: Array.from({ length: 31 }, (_, i) => ({ uuid: `m-${i}` })), keep: 30 },
  { name: '只有边界', messages: [boundary('b-1')], keep: 30 },
  {
    name: '边界之前很多、之后不足',
    messages: [...Array.from({ length: 40 }, (_, i) => ({ uuid: `m-${i}` })), boundary('b-2')],
    keep: 30,
  },
  {
    name: '最后一个边界之后足够多',
    messages: [
      ...Array.from({ length: 40 }, (_, i) => ({ uuid: `old-${i}` })),
      boundary('b-3'),
      ...Array.from({ length: 31 }, (_, i) => ({ uuid: `new-${i}` })),
    ],
    keep: 30,
  },
];

const compactable = compactableCases.map(({ name, messages, keep }) => ({
  name,
  messages,
  keep,
  result: hasCompactableMessages(messages, keep),
}));

// ---------------- 压缩后消息组装 ----------------

const compactionResults = [
  {
    name: '只有边界与摘要',
    result: {
      boundaryMarker: boundary('b-new'),
      summaryMessages: [{ type: 'user', message: { role: 'user', content: 'SUMMARY' }, uuid: 'sum-1' }],
    },
  },
  {
    name: '带保留区',
    result: {
      boundaryMarker: boundary('b-new'),
      summaryMessages: [{ type: 'user', message: { role: 'user', content: 'SUMMARY' }, uuid: 'sum-1' }],
      messagesToKeep: [{ uuid: 'keep-1' }, { uuid: 'keep-2' }],
    },
  },
  {
    name: '保留区为空数组',
    result: {
      boundaryMarker: boundary('b-new'),
      summaryMessages: [],
      messagesToKeep: [],
    },
  },
];

const postCompact = compactionResults.map(({ name, result }) => ({
  name,
  result,
  messages: buildPostCompactMessages(result),
}));

// ---------------- 历史消息 → UI 消息（replayMessages） ----------------

const replayMessages = [
  {
    name: '用户消息（顶层文件信息）',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: '看看这个文件' },
        uuid: 'u-1',
        timestamp: 1,
        filePath: '/tmp/a.ts',
        fileSelectedLines: { start: 2, end: 4 },
      },
    ],
  },
  {
    name: '用户消息（文件被隐藏）',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: '隐藏文件信息' },
        uuid: 'u-2',
        timestamp: 2,
        filePath: '/tmp/a.ts',
        fileHidden: true,
      },
    ],
  },
  {
    name: '用户消息（_meta 里的文件信息）',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: 'meta 文件信息' },
        uuid: 'u-3',
        timestamp: 3,
        _meta: { filePath: '/tmp/b.ts', fileSelectedLines: { start: 1, end: 1 }, param: 'x' },
      },
    ],
  },
  {
    name: '用户消息（带图片）',
    messages: [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
        uuid: 'u-4',
        timestamp: 4,
      },
    ],
  },
  {
    name: 'isMeta / silent / 边界标记被跳过',
    messages: [
      { type: 'user', message: { role: 'user', content: 'meta' }, uuid: 'u-5', isMeta: true },
      { type: 'user', message: { role: 'user', content: 'silent' }, uuid: 'u-6', silent: true },
      {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'boundary',
        uuid: 's-1',
        timestamp: 5,
      },
      { type: 'system', content: 'system note', uuid: 's-2', timestamp: 6 },
    ],
  },
  {
    name: 'assistant 块（thinking / text / tool_use / Write 的 before-after）',
    messages: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想想' },
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
            {
              // 注意：`Edit` 走 `buildEditDiffHunks` 分支（Standalone 不预计算
              // `diffHunks`，见 `DIFF.md` 第 2.2 节），因此这里用 `Write` 覆盖
              // 「非 Edit 且带 before/after」的那条分支。
              type: 'tool_use',
              id: 'call_2',
              name: 'Write',
              input: { file_path: '/tmp/a.ts' },
              _meta: { beforeContent: 'old', afterContent: 'new' },
            },
          ],
        },
        uuid: 'a-1',
        timestamp: 7,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'file list', exit_code: 0 },
            { type: 'tool_result', tool_use_id: 'call_2', content: 'edited', exit_code: 1 },
          ],
        },
        uuid: 'r-1',
        timestamp: 8,
      },
    ],
  },
  {
    name: '已取消的 tool_result 不产生结果',
    messages: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_9', name: 'Bash', input: {} }],
        },
        uuid: 'a-9',
        timestamp: 9,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_9',
              content: 'canceled',
              is_canceled: true,
            },
          ],
        },
        uuid: 'r-9',
        timestamp: 10,
      },
    ],
  },
  {
    name: '子代理 / 后台任务来源',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: '子代理回复' },
        uuid: 'u-7',
        timestamp: 11,
        origin: 'agent',
        _meta: { param: 'host:agent:sub_1' },
      },
      {
        type: 'user',
        message: { role: 'user', content: '后台完成' },
        uuid: 'u-8',
        timestamp: 12,
        origin: 'bash',
      },
      {
        type: 'user',
        message: { role: 'user', content: '旧字段子代理' },
        uuid: 'u-9',
        timestamp: 13,
        fromSubAgent: true,
      },
    ],
  },
  {
    name: '压缩摘要消息',
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: '以下是之前对话的摘要：' },
        uuid: 'u-10',
        timestamp: 14,
        isCompactSummary: true,
      },
    ],
  },
  {
    name: '工具结果内容为数组',
    messages: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_img', name: 'Read', input: { file_path: '/tmp/i.png' } }],
        },
        uuid: 'a-img',
        timestamp: 15,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_img',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'C' } }],
              exit_code: 0,
            },
          ],
        },
        uuid: 'r-img',
        timestamp: 16,
      },
    ],
  },
];

const replay = replayMessages.map(({ name, messages }) => ({
  name,
  messages,
  result: buildReplayMessageData(messages),
}));

const output = {
  note:
    '对话压缩纯函数对照表（Embedded `compact/*` ↔ Standalone `core-rs/src/compact.rs`）。' +
    '只覆盖提示词拼装 / 用户输入历史（条目提取 / 格式化 / 跨多次压缩的全局选择 / ' +
    '读取摘要持久化历史）/ 阈值 / 可压缩判定 / 压缩后消息组装 / ' +
    '历史消息 → UI 消息的转换；真正跑 LLM 的压缩流程由 Rust 侧假 LLM 单测覆盖。',
  formatted,
  userHistory,
  userInputEntries,
  userInputEntryFormatting,
  userInputHistorySelection,
  compactUserInputHistory,
  summaryPrompts,
  compactUserMessages,
  thresholds,
  compactable,
  postCompact,
  replay,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'compactParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log('wrote src/test/fixtures/compactParity.json');
