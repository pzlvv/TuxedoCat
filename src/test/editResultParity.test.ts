/**
 * Edit 工具结果对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/editResultParity.json`：
 * - 本文件跑 Embedded 的 `EditTool.call` + `mapToolResultToToolResultBlockParam`；
 * - `core-rs/src/tools_tests.rs` 的 `edit_result_parity_tests` 跑 Standalone 的 `run_edit`。
 *
 * 任一侧偏离对照表都会失败。重点覆盖 `(+N, -M)` 的 diff 口径（Embedded 用 jsdiff 的
 * 最短编辑脚本，不是「old/new 行数 × 替换次数」）、`replace_all` 的字符串感知解析、
 * CRLF 文件、搜索窗口、错误文案。
 *
 * 运行方式：npm run test:all -- edit-result-parity
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EditTool } from '../core/tools/edit/Edit';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  why: string;
  content: string;
  /** 目标文件名（默认 a.txt） */
  file?: string;
  /** true = 不落盘，用不存在的文件触发 ENOENT */
  missing?: boolean;
  args: Record<string, unknown>;
  expected?: string;
  error?: string;
  expectedStartLine?: number;
  expectedEndLine?: number;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/editResultParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-result-parity-'));
  try {
    for (const testCase of fixture.cases) {
      const relative = testCase.file ?? 'a.txt';
      const filePath = path.join(dir, relative);
      if (!testCase.missing) {
        fs.writeFileSync(filePath, testCase.content, 'utf8');
      }
      const input = { file_path: relative, ...testCase.args };
      let actual: string;
      let startLine: number | undefined;
      let endLine: number | undefined;
      try {
        const result = await (EditTool as any).call(input, { cwd: dir });
        const mapped = (EditTool as any).mapToolResultToToolResultBlockParam(result.data, 'toolu_1');
        actual = mapped.content;
        startLine = mapped.startLine;
        endLine = mapped.endLine;
      } catch (err) {
        actual = (err as Error).message;
      }
      // 对照表用 `__CWD__` 占位；Node 错误文案里的路径与分隔符统一归一化
      const normalized = actual.split(dir).join('__CWD__').split('\\').join('/');
      const expected = testCase.expected ?? testCase.error;
      check(
        `${testCase.name}（${testCase.why}）`,
        normalized === expected,
      );
      if (normalized !== expected) {
        console.log(`     期望: ${JSON.stringify(expected)}\n     实际: ${JSON.stringify(normalized)}`);
      }
      if (testCase.expectedStartLine !== undefined && testCase.expected !== undefined) {
        check(
          `${testCase.name} 行号 ${testCase.expectedStartLine}-${testCase.expectedEndLine}`,
          startLine === testCase.expectedStartLine && endLine === testCase.expectedEndLine,
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
}

runTests('edit-result-parity', run);
