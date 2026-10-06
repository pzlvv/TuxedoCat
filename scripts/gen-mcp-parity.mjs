#!/usr/bin/env node
/**
 * 生成「MCP」对等对照表。
 *
 * 对照表 `src/test/fixtures/mcpParity.json` 被两侧共用：
 * - `src/test/mcpParity.test.ts` 用 Embedded 的真实实现（`mcp/Client.ts` /
 *   `mcp/Config.ts` / `mcp/McpTool.ts` 的导出）断言对照表仍成立；
 * - `core-rs/src/mcp_tests.rs` / `mcp_config_tests.rs` 的 `parity_tests` 用 Rust
 *   `mcp::*` / `mcp_config::*` 断言结果一致。
 *
 * 只覆盖**纯函数**：`tools/call` 结果展平、`tools/list` 分页/过滤、工具名拼接、
 * Windows 参数引号、传输类型判定、`mcp.json` 解析与启用状态合并。
 * 真正跑子进程 / HTTP 的流程由 Rust 侧真实进程与假 HTTP 服务器单测覆盖。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-mcp-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(repoRoot, 'out', 'src', 'core');
/** 沙箱配置目录名与真实口径一致（src/config/project.json 的 configDir） */
const configDirName = require(join(repoRoot, 'src', 'config', 'project.json')).configDir;

const { normalizeMcpCallResult, listMcpTools, quoteWindowsArg } = require(
  join(coreDir, 'mcp', 'Client.js'),
);
const { buildMcpToolName } = require(join(coreDir, 'mcp', 'McpTool.js'));
const { isRemoteType, isRemoteServer, readMcpServers } = require(
  join(coreDir, 'mcp', 'Config.js'),
);
const { resetSettingsCache } = require(join(coreDir, 'history', 'Config.js'));

// ---------------- tools/call 结果展平 ----------------

const callResultCases = [
  {
    name: '纯文本',
    result: { content: [{ type: 'text', text: 'hello' }] },
  },
  {
    name: '图片（有 / 无 mimeType）',
    result: {
      content: [
        { type: 'image', mimeType: 'image/png' },
        { type: 'image' },
        { type: 'image', mimeType: 7 },
      ],
    },
  },
  {
    name: 'resource（text / uri / 都没有）',
    result: {
      content: [
        { type: 'resource', resource: { uri: 'file:///a', text: 'file body' } },
        { type: 'resource', resource: { uri: 'file:///b' } },
        { type: 'resource', resource: {} },
        { type: 'resource' },
      ],
    },
  },
  {
    name: '未知块 JSON.stringify',
    result: {
      content: [
        { type: 'custom', value: 1, nested: { a: [1, 2] } },
        { type: 'text', text: 5 },
      ],
    },
  },
  {
    name: '混合 + 顺序',
    result: {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', mimeType: 'image/jpeg' },
        { type: 'text', text: 'b' },
      ],
    },
  },
  {
    name: '空 content 兜底',
    result: { content: [] },
  },
  {
    name: 'content 不是数组',
    result: { content: 'nope' },
  },
  {
    name: 'isError 为真',
    result: { content: [{ type: 'text', text: 'bad' }], isError: true },
  },
  {
    name: 'isError 非布尔',
    result: { content: [{ type: 'text', text: 'ok' }], isError: 1 },
  },
  {
    name: 'content 里有非对象项',
    result: { content: [null, 'x', 3, [1, 2], { type: 'text', text: 'kept' }] },
  },
  {
    name: 'null 结果',
    result: null,
  },
  {
    name: '数字 / 布尔字段',
    result: { content: [{ type: 'text', text: 'n' }], isError: false, extra: 1 },
  },
];

const callResults = callResultCases.map(({ name, result }) => {
  const normalized = normalizeMcpCallResult(result);
  return { name, result, text: normalized.text, isError: normalized.isError };
});

// ---------------- tools/list 分页与过滤 ----------------

const toolListCases = [];

{
  const pages = [
    {
      tools: [
        { name: 'a', description: 'A', inputSchema: { type: 'object' } },
        { name: 'b' },
      ],
      nextCursor: 'c1',
    },
    { tools: [{ name: 'c', annotations: { readOnlyHint: true } }] },
  ];
  toolListCases.push({ name: '两页', pages });
}

{
  const pages = [
    { tools: [{ name: 'p1' }], nextCursor: 'c1' },
    { tools: [{ name: 'p2' }], nextCursor: 'c2' },
    { tools: [{ name: 'p3' }], nextCursor: '' },
  ];
  toolListCases.push({ name: '空 nextCursor 停止', pages });
}

{
  // 环状 cursor：两侧都必须停在 50 页
  const pages = Array.from({ length: 50 }, () => ({
    tools: [{ name: 'loop' }],
    nextCursor: 'again',
  }));
  toolListCases.push({ name: '环状 cursor 防御', pages });
}

{
  const pages = [
    {
      tools: [
        { name: 'ok', description: 5, inputSchema: 'nope', annotations: [] },
        { name: '' },
        { name: 3 },
        'not-an-object',
        null,
        { name: 'second', description: 'Second' },
      ],
      nextCursor: 'c1',
    },
    { tools: [] },
  ];
  toolListCases.push({ name: '跳过非法项', pages });
}

{
  const pages = [{ tools: 'nope' }, { tools: [{ name: 'after-garbage' }] }];
  toolListCases.push({ name: 'tools 非数组', pages });
}

const toolLists = await Promise.all(
  toolListCases.map(async ({ name, pages }) => {
    let index = 0;
    const calls = [];
    const tools = await listMcpTools(async (method, params, timeoutMs) => {
      calls.push({ method, params });
      void timeoutMs;
      return pages[index++] ?? {};
    });
    return {
      name,
      pages,
      calls,
      tools: tools.map((tool) => {
        const out = { name: tool.name };
        if (tool.description !== undefined) out.description = tool.description;
        if (tool.inputSchema !== undefined) out.inputSchema = tool.inputSchema;
        if (tool.annotations !== undefined) out.annotations = tool.annotations;
        return out;
      }),
    };
  }),
);

// ---------------- 工具名拼接 ----------------

const toolNameCases = [
  ['my server', 'do.it'],
  ['a-b_c', 'x/y'],
  ['srv', 'read_file'],
  ['srv 1', 'tool 2'],
  ['中文', '工具'],
  ['srv', 'a😀b'],
  ['', ''],
].map(([server, tool]) => ({
  server,
  tool,
  result: buildMcpToolName(server, tool),
}));

// ---------------- Windows 参数引号 ----------------

const quoteWindowsArgCases = [
  '',
  'node',
  'a b',
  'a"b',
  'C:\\Program Files\\x',
  'a&b',
  'a|b',
  'a<b',
  'a>b',
  'a^b',
  'a(b)',
  'plain/path.exe',
  'tab\there',
  // JS 正则 `\s` 口径：含 U+FEFF（需要加引号）、不含 U+0085（不需要）
  '\uFEFF',
  '\u0085',
  'a\uFEFFb',
  'a\u0085b',
].map((input) => ({ input, result: quoteWindowsArg(input) }));

// ---------------- 传输类型判定 ----------------

const isRemoteTypeCases = [
  'remote',
  'HTTP',
  ' https ',
  'sse',
  'http-sse',
  'streamable',
  'streamable-http',
  'streamablehttp',
  'local',
  'stdio',
  '',
].map((type) => ({ type, result: isRemoteType(type) }));

const isRemoteServerCases = [
  { type: 'remote', url: '', command: [] },
  { type: 'local', url: 'https://x', command: [] },
  { type: 'local', url: 'https://x', command: ['npx'] },
  { type: 'local', url: '', command: ['npx'] },
  { type: 'stdio', url: '', command: ['uvx'] },
  { type: 'http', url: 'https://x', command: ['npx'] },
  { type: 'local', url: '  ', command: [] },
].map(({ type, url, command }) => ({
  type,
  url,
  command,
  result: isRemoteServer({ type, url, command }),
}));

// ---------------- mcp.json 解析 + 启用状态合并 ----------------

const configParseCases = [
  {
    name: 'local + remote + 各种回退',
    mcpJson: {
      mcp: {
        blender: {
          type: 'local',
          command: ['uvx', 'blender-mcp'],
          environment: { BLENDER_HOST: 'localhost', BLENDER_PORT: 9876 },
        },
        search: {
          type: 'remote',
          url: 'https://search.parallel.ai/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        endpointOnly: { endpoint: 'https://a/mcp' },
        serverUrlOnly: { serverUrl: 'https://b/mcp' },
        envAlias: { command: 'npx', env: { TOKEN: 42 } },
        urlNullFallsThrough: { url: null, endpoint: 'https://c/mcp' },
        stringCommand: { command: '  uvx  ' },
        emptyCommand: { command: '   ' },
        notObject: 5,
      },
    },
    settingsJson: { mcp: { enabled: ['search', 'blender'] } },
  },
  {
    name: 'mcpServers 包裹层',
    mcpJson: { mcpServers: { a: { command: 'npx' }, b: { url: 'https://b' } } },
    settingsJson: { mcp: { enabled: ['b'] } },
  },
  {
    name: '根对象直接当映射',
    mcpJson: { a: { command: ['npx', 'a'] } },
    settingsJson: {},
  },
  {
    name: 'mcp 不是对象 → 空',
    mcpJson: { mcp: 'nope', a: { command: 'npx' } },
    settingsJson: { mcp: { enabled: ['a'] } },
  },
  {
    name: 'enabled 非数组 → 全部禁用',
    mcpJson: { mcp: { a: { command: 'npx' } } },
    settingsJson: { mcp: { enabled: 'a' } },
  },
];

const tempHome = mkdtempSync(join(tmpdir(), 'mcp-parity-'));
const configDir = join(tempHome, configDirName);
mkdirSync(configDir, { recursive: true });
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const configParse = [];
try {
  for (const testCase of configParseCases) {
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify(testCase.mcpJson, null, 2));
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(testCase.settingsJson, null, 2));
    resetSettingsCache();
    const servers = await readMcpServers();
    configParse.push({
      name: testCase.name,
      mcpJson: testCase.mcpJson,
      settingsJson: testCase.settingsJson,
      servers,
    });
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(tempHome, { recursive: true, force: true });
}

// ---------------- 输出 ----------------

const output = {
  note:
    'MCP 纯函数对照表（Embedded `mcp/*` ↔ Standalone `core-rs/src/mcp.rs` + ' +
    '`mcp_config.rs`）。只覆盖 `tools/call` 结果展平 / `tools/list` 分页与过滤 / ' +
    '工具名拼接 / Windows 参数引号 / 传输类型判定 / `mcp.json` 解析与启用状态合并；' +
    'stdio 子进程与 HTTP 传输由 Rust 侧真实进程 / 假 HTTP 服务器单测覆盖。',
  callResults,
  toolLists,
  toolNames: toolNameCases,
  quoteWindowsArgs: quoteWindowsArgCases,
  isRemoteType: isRemoteTypeCases,
  isRemoteServer: isRemoteServerCases,
  configParse,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'mcpParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log('wrote src/test/fixtures/mcpParity.json');
