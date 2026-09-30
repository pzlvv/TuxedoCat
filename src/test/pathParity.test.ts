/**
 * 路径展开对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/pathParity.json`：
 * - 本文件断言「对照表 == Embedded `utils/path.ts::expandPath`」；
 * - `core-rs/src/tools_tests.rs` 的 `path_parity_tests` 断言
 *   「Standalone `tools::expand_path` == 对照表」。
 *
 * 覆盖空串 / JS 空白口径 / `~` 展开 / 词法规范化 / Windows 的 WSL 路径、
 * `/c/...` 盘符路径、UNC 与「当前盘根路径」（`/tmp/x`）语义。
 * 对照表里的 `__CWD__` / `__HOME__` 是占位符，分隔符统一为 `/`。
 *
 * 运行方式：npm run test:all -- path-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandPath } from '../core/utils/path';
import { createChecker, runTests } from './helpers/harness';

interface PathCase {
  name: string;
  why: string;
  input: string;
  expected: string;
  /** 只在对应平台成立的用例（Node 的 path.isAbsolute 平台相关） */
  platform?: 'win32' | 'linux' | 'darwin';
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/pathParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: PathCase[] };
  check('对照表非空', fixture.cases.length > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-parity-'));
  const forwardCwd = dir.split('\\').join('/');
  const forwardHome = os.homedir().split('\\').join('/');
  const canonicalize = (value: string): string =>
    value
      .split('\\').join('/')
      .split(forwardCwd).join('__CWD__')
      .split(forwardHome).join('__HOME__');

  try {
    for (const testCase of fixture.cases) {
      if (testCase.platform && testCase.platform !== process.platform) {
        check(`${testCase.name}（跳过：仅 ${testCase.platform}）`, true);
        continue;
      }
      const input = testCase.input.split('__CWD__').join(dir);
      const actual = canonicalize(expandPath(input, dir));
      check(
        `${testCase.name}（${testCase.why}）`,
        actual === testCase.expected,
      );
      if (actual !== testCase.expected) {
        console.log(`     期望: ${JSON.stringify(testCase.expected)}\n     实际: ${JSON.stringify(actual)}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
}

runTests('path-parity', run);
