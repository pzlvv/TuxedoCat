/**
 * 内置工具结果对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/toolResultParity.json`：
 * - 本文件用 Embedded 的**真实工具**（`tool.call` + `mapToolResultToToolResultBlockParam`）
 *   断言对照表仍然成立（防对照表腐化）；
 * - `core-rs/src/tools_tests.rs` 的 `tool_result_parity_tests` 断言
 *   「`tools::execute` == 对照表」。
 *
 * 覆盖入参边界（空串视为缺参、Read 的 `path` 回退）与关键成功路径的 tool_result
 * 文本（Read 行号、Write 创建 / 覆盖、Edit 行号与 diff、Grep / Glob、TodoWrite 清单）。
 *
 * 运行方式：npm run test:all -- tool-result-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setExtensionPath } from '../core/history/Config';
import { ReadTool } from '../core/tools/read/Read';
import { WriteTool } from '../core/tools/write/Write';
import { EditTool } from '../core/tools/edit/Edit';
import { GrepTool } from '../core/tools/grep/Grep';
import { GlobTool } from '../core/tools/glob/Glob';
import { TodoWriteTool } from '../core/tools/todowrite/TodoWrite';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/toolResultParity.json');

/** `files` 的值：直接给内容，或用生成器描述大文件（与生成脚本同一规则） */
type FileSpec =
  | string
  | { repeat?: string; count?: number; eol?: string; trailingEol?: boolean };

interface ParityCase {
  name: string;
  why: string;
  tool: 'Read' | 'Write' | 'Edit' | 'Grep' | 'Glob' | 'TodoWrite';
  files: Record<string, FileSpec>;
  /** 仓库相对路径引用的二进制夹具（xlsx 等），跑用例前拷进临时目录 */
  binaryFiles?: Record<string, string>;
  input: Record<string, unknown>;
  expected?: string;
  expectedError?: string;
}

/**
 * 展开 `files` 里的生成器描述。
 * 与 `scripts/gen-tool-result-parity.mjs` 的 `fileContent` 保持同一规则。
 */
function fileContent(value: FileSpec): string {
  if (typeof value === 'string') return value;
  const repeat = typeof value.repeat === 'string' ? value.repeat : '';
  const count = Number.isFinite(value.count) ? (value.count as number) : 0;
  const eol = typeof value.eol === 'string' ? value.eol : '\n';
  const trailingEol = value.trailingEol !== false;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += repeat;
    if (i < count - 1 || trailingEol) out += eol;
  }
  return out;
}

const TOOLS = {
  Read: ReadTool,
  Write: WriteTool,
  Edit: EditTool,
  Grep: GrepTool,
  Glob: GlobTool,
  TodoWrite: TodoWriteTool,
} as const;

/** 随应用分发的 ripgrep 产物是否存在（Grep / Glob 用例的运行条件） */
function ripgrepAvailable(): boolean {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const subDir = `${arch}-${platform}`;
  return [
    path.join(REPO_ROOT, 'dist', 'resources', 'ripgrep', subDir, exe),
    path.join(REPO_ROOT, 'resources', 'ripgrep', subDir, exe),
  ].some((candidate) => fs.existsSync(candidate));
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  // ripgrep 资源定位基准（Grep / Glob 用）
  setExtensionPath(REPO_ROOT);
  const hasRipgrep = ripgrepAvailable();
  let skipped = 0;

  for (const testCase of fixture.cases) {
    if (!hasRipgrep && (testCase.tool === 'Grep' || testCase.tool === 'Glob')) {
      skipped += 1;
      continue;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-result-parity-'));
    try {
      for (const [relative, content] of Object.entries(testCase.files)) {
        const target = path.join(dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fileContent(content));
      }
      for (const [relative, source] of Object.entries(testCase.binaryFiles ?? {})) {
        const target = path.join(dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, source), target);
      }
      const tool = TOOLS[testCase.tool];
      const context = {
        cwd: dir,
        sessionId: 's1',
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => undefined,
      };
      let actual: string;
      try {
        const result = await (tool as any).call(testCase.input, context);
        const mapped = (tool as any).mapToolResultToToolResultBlockParam(result.data, 't1');
        actual = mapped.content;
      } catch (error) {
        actual = (error as Error).message;
      }
      const expected = testCase.expected ?? testCase.expectedError;
      if (actual !== expected) {
        console.log(`     actual:   ${JSON.stringify(actual)}`);
        console.log(`     expected: ${JSON.stringify(expected)}`);
      }
      check(`${testCase.name}（${testCase.why}）`, actual === expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (skipped > 0) {
    console.log(`skip ${skipped} 条 Grep / Glob 用例（缺少 ripgrep 产物）`);
  }

  finish();
}

runTests('tool-result-parity', run);
