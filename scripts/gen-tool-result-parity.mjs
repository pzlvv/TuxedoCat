#!/usr/bin/env node
/**
 * 生成「内置工具结果」对等对照表。
 *
 * 对照表 `src/test/fixtures/toolResultParity.json` 被两侧共用：
 * - `src/test/toolResultParity.test.ts` 用 Embedded 的真实工具
 *   （`tool.call` + `mapToolResultToToolResultBlockParam`）断言对照表仍然成立；
 * - `core-rs/src/tools_tests.rs` 的 `tool_result_parity_tests` 用 Rust
 *   `tools::execute` 断言结果一致。
 *
 * 覆盖「入参边界（空串视为缺参 / Read 的 path 回退）」与关键成功路径的
 * tool_result 文本（Read 行号、Write 创建 / 覆盖、Edit 行号与 diff、Grep / Glob、
 * TodoWrite 清单格式）。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-tool-result-parity.mjs`。
 * 每条用例：`{ name, why, tool, files, input, expected | expectedError }`。
 * 用例只在临时目录里跑，输出不得包含绝对路径（否则两侧无法比对）。
 */

import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
require(join(repoRoot, 'out', 'src', 'core', 'history', 'Config.js')).setExtensionPath(repoRoot);
const XLSX = require('xlsx');

/**
 * 生成提交入库的 xlsx 夹具（两侧共用同一份二进制）。
 *
 * 二进制无法直接写进 JSON 对照表，因此 `binaryFiles` 用仓库相对路径引用这些夹具，
 * TS / Rust 两侧在跑用例前把它拷进临时目录。
 */
function writeXlsxFixtures() {
  const dir = join(repoRoot, 'src', 'test', 'fixtures', 'xlsx');
  mkdirSync(dir, { recursive: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Name', 'Age', 'Score'],
      ['Alice', 30, 95.5],
      [],
      ['Bob', 25, 88],
    ]),
    'People',
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['x'], [1]]), 'Other');
  XLSX.writeFile(workbook, join(dir, 'people.xlsx'));
}

writeXlsxFixtures();

const tools = {
  Read: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'read', 'Read.js')).ReadTool,
  Write: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'write', 'Write.js')).WriteTool,
  Edit: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'edit', 'Edit.js')).EditTool,
  Grep: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'grep', 'Grep.js')).GrepTool,
  Glob: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'glob', 'Glob.js')).GlobTool,
  TodoWrite: require(join(repoRoot, 'out', 'src', 'core', 'tools', 'todowrite', 'TodoWrite.js')).TodoWriteTool,
};

/**
 * `files` 的值可以是字符串，也可以是 `{ repeat, count, eol, trailingEol }` 生成器：
 * 大文件（Read 的行数 / 字节上限）不必写进对照表，两侧按同一规则展开。
 */
function fileContent(value) {
  if (typeof value === 'string') return value;
  const repeat = typeof value.repeat === 'string' ? value.repeat : '';
  const count = Number.isFinite(value.count) ? value.count : 0;
  const eol = typeof value.eol === 'string' ? value.eol : '\n';
  const trailingEol = value.trailingEol !== false;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += repeat;
    if (i < count - 1 || trailingEol) out += eol;
  }
  return out;
}

const cases = [
  {
    name: 'read-empty-file-path',
    why: '空串 file_path 是假值：与缺参同样报错',
    tool: 'Read',
    files: {},
    input: { file_path: '' },
  },
  {
    name: 'read-path-fallback',
    why: '空串 file_path 回退到 path（对齐 `input.file_path || input.path`）',
    tool: 'Read',
    files: { 'a.txt': 'hello\n' },
    input: { file_path: '', path: 'a.txt' },
  },
  {
    name: 'read-basic',
    why: '行号 `N|text`，按 \\n 切分保留末尾空行',
    tool: 'Read',
    files: { 'a.txt': 'one\ntwo\nthree\n' },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-offset-limit',
    why: 'offset 是 1-based 行号：offset=2/limit=2 展示第 2-3 行',
    tool: 'Read',
    files: { 'a.txt': 'a\nb\nc\nd\ne\n' },
    input: { file_path: 'a.txt', offset: 2, limit: 2 },
  },
  {
    name: 'read-offset-zero',
    why: 'offset=0 与缺省一样从第一行开始（历史兼容：0/1 都映射到第一行）',
    tool: 'Read',
    files: { 'a.txt': 'a\nb\nc\n' },
    input: { file_path: 'a.txt', offset: 0, limit: 1 },
  },
  {
    name: 'read-offset-beyond-eof',
    why: 'offset 超过总行数：输出为空、不追加续读 footer',
    tool: 'Read',
    files: { 'a.txt': 'a\nb\nc\n' },
    input: { file_path: 'a.txt', offset: 100 },
  },
  {
    name: 'read-trailing-newline',
    why: '按 `\\n` 切分保留末尾空行：`a\\nb\\n` 是 3 行，最后一行是空串',
    tool: 'Read',
    files: { 'a.txt': 'a\nb\n' },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-crlf',
    why: 'CRLF 文件每行去掉尾随 `\\r`',
    tool: 'Read',
    files: { 'a.txt': 'a\r\nb\r\n' },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-limit-over-max',
    why: 'limit 超过单次最大行数（2000）直接报错',
    tool: 'Read',
    files: { 'a.txt': 'a\n' },
    input: { file_path: 'a.txt', limit: 2001 },
  },
  {
    name: 'read-long-line',
    why: '单行超过 2000 字符按 UTF-16 code unit 截断并追加说明',
    tool: 'Read',
    files: { 'a.txt': { repeat: 'x', count: 2500, eol: '', trailingEol: false } },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-max-lines',
    why: '超过 2000 行只展示前 2000 行，footer 给出 `Use offset=2001`',
    tool: 'Read',
    files: { 'a.txt': { repeat: 'line', count: 2500 } },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-output-bytes-cap',
    why: '50KB 字节上限先于 2000 行触发：footer 带 `Output capped.` 前缀',
    tool: 'Read',
    files: { 'a.txt': { repeat: 'y'.repeat(100), count: 1000 } },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-file-too-large',
    why: '未传 limit 时整文件读取先做 256KB 上限检查',
    tool: 'Read',
    files: { 'a.txt': { repeat: 'x', count: 300_000, eol: '', trailingEol: false } },
    input: { file_path: 'a.txt' },
  },
  {
    name: 'read-xlsx-basic',
    why: 'xlsx 转文本表格：列对齐、空行过滤、尾部空列裁剪',
    tool: 'Read',
    files: {},
    binaryFiles: { 'a.xlsx': 'src/test/fixtures/xlsx/people.xlsx' },
    input: { file_path: 'a.xlsx' },
  },
  {
    name: 'read-xlsx-sheet-missing',
    why: 'sheet 不存在时列出可用 sheet',
    tool: 'Read',
    files: {},
    binaryFiles: { 'a.xlsx': 'src/test/fixtures/xlsx/people.xlsx' },
    input: { file_path: 'a.xlsx', sheet: 'Missing' },
  },
  {
    name: 'read-xlsx-sheet-named',
    why: 'sheet 指定第二个工作表',
    tool: 'Read',
    files: {},
    binaryFiles: { 'a.xlsx': 'src/test/fixtures/xlsx/people.xlsx' },
    input: { file_path: 'a.xlsx', sheet: 'Other' },
  },
  {
    name: 'read-xlsx-offset-limit',
    why: 'xlsx 的 offset/limit 窗口（列宽按窗口内行计算）与续读 footer',
    tool: 'Read',
    files: {},
    binaryFiles: { 'a.xlsx': 'src/test/fixtures/xlsx/people.xlsx' },
    input: { file_path: 'a.xlsx', offset: 2, limit: 1 },
  },
  {
    name: 'write-empty-file-path',
    why: '空串 file_path 视为缺参',
    tool: 'Write',
    files: {},
    input: { file_path: '', content: 'x' },
  },
  {
    name: 'write-create',
    why: '新建文件的 Created 文案（行数 / 字节数）',
    tool: 'Write',
    files: {},
    input: { file_path: 'out.txt', content: 'hello\nworld' },
  },
  {
    name: 'write-update',
    why: '覆盖已有文件的 Updated 文案',
    tool: 'Write',
    files: { 'out.txt': 'old' },
    input: { file_path: 'out.txt', content: 'new' },
  },
  {
    name: 'edit-empty-file-path',
    why: '空串 file_path 视为缺参',
    tool: 'Edit',
    files: {},
    input: { file_path: '', old_string: 'a', new_string: 'b' },
  },
  {
    name: 'edit-single',
    why: '单处替换的行号与 (+N, -M) diff 口径',
    tool: 'Edit',
    files: { 'a.txt': 'alpha\n' },
    input: { file_path: 'a.txt', old_string: 'alpha', new_string: 'beta' },
  },
  {
    name: 'grep-empty-pattern',
    why: '空串 pattern 视为缺参',
    tool: 'Grep',
    files: {},
    input: { pattern: '' },
  },
  {
    name: 'grep-no-match',
    why: '无匹配时 files_with_matches 的 No files found',
    tool: 'Grep',
    files: { 'a.txt': 'beta\n' },
    input: { pattern: 'zzz' },
  },
  {
    name: 'grep-count-single-file',
    why: 'count 模式的汇总文案（单文件，避免 rg 并行遍历导致的文件顺序抖动）',
    tool: 'Grep',
    files: { 'a.txt': 'alpha\nalpha\n' },
    input: { pattern: 'alpha', output_mode: 'count' },
  },
  {
    name: 'glob-empty-pattern',
    why: '空串 pattern 视为缺参',
    tool: 'Glob',
    files: {},
    input: { pattern: '' },
  },
  {
    name: 'glob-single',
    why: '单个匹配文件的 Found 文案',
    tool: 'Glob',
    files: { 'a.txt': 'x', 'b.md': 'y' },
    input: { pattern: '*.txt' },
  },
  {
    name: 'glob-none',
    why: '无匹配时 No files found',
    tool: 'Glob',
    files: { 'a.txt': 'x' },
    input: { pattern: '*.zzz' },
  },
  {
    name: 'todowrite-three-items',
    why: '清单格式：标题与第 1 条之间是空行（`Tasks:\\n\\n1. ...`）',
    tool: 'TodoWrite',
    files: {},
    input: {
      todos: [
        { content: 'a', activeForm: 'A', status: 'completed' },
        { content: 'b', activeForm: 'B', status: 'in_progress' },
        { content: 'c', activeForm: 'C', status: 'pending' },
      ],
    },
  },
  {
    name: 'todowrite-empty',
    why: '空清单只输出汇总行，不输出 Tasks 段',
    tool: 'TodoWrite',
    files: {},
    input: { todos: [] },
  },
];

async function runCase(testCase) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-parity-'));
  for (const [relative, content] of Object.entries(testCase.files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fileContent(content));
  }
  for (const [relative, source] of Object.entries(testCase.binaryFiles ?? {})) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(repoRoot, source), path);
  }
  const context = {
    cwd: dir,
    sessionId: 's1',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => undefined,
  };
  const tool = tools[testCase.tool];
  try {
    const result = await tool.call(testCase.input, context);
    const mapped = tool.mapToolResultToToolResultBlockParam(result.data, 't1');
    return { expected: mapped.content };
  } catch (error) {
    return { expectedError: error.message };
  }
}

const generated = [];
for (const testCase of cases) {
  generated.push({ ...testCase, ...(await runCase(testCase)) });
}

const output = {
  note:
    'Embedded（src/core/tools/*，真实 tool.call + mapToolResultToToolResultBlockParam）与 ' +
    'Standalone（core-rs/src/tools.rs 的 tools::execute）的工具结果对照表。' +
    'TS 侧测试断言本表等于真实输出；Rust 侧测试断言 tools::execute 的结果等于本表。' +
    '用例只在临时目录里跑，expected / expectedError 不含绝对路径。',
  cases: generated,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'toolResultParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`wrote ${generated.length} cases`);
for (const testCase of generated) {
  console.log(`  ${testCase.name}: ${JSON.stringify(testCase.expected ?? testCase.expectedError)}`);
}
