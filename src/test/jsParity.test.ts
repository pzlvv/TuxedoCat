/**
 * JS 语义对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/jsParity.json`：
 * - 本文件用 Embedded 的**真实实现**断言对照表仍然成立（防对照表腐化）；
 * - `core-rs/src/tools_tests.rs` 的 `js_parity_tests` 断言
 *   「Rust 的 `format_file_size` / `clamp_output` / `validate_input` == 对照表」。
 *
 * 覆盖三个跨语言最容易踩坑的口径：
 * 1. `formatFileSize`：`Number.prototype.toFixed(1)` 的四舍五入（`262400 B = 256.3 KB`，
 *    不能是 Rust `{:.1}` 的「四舍六入五成双」）；
 * 2. `generateHeadTailPreview`：按 UTF-16 code unit 计算长度 / 截断，代理对不切开；
 * 3. Bash `validateInput`：命令非空 + 长度上限 10000。
 *
 * 运行方式：npm run test:all -- js-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { formatFileSize } from '../core/tools/read/limits';
import { generateHeadTailPreview } from '../core/tools/toolResultStorage';
import { validateInput } from '../core/tools/bash/Validation';
import { createChecker, runTests } from './helpers/harness';

interface FileSizeCase {
  bytes: number;
  expected: string;
}

interface ClampCase {
  name: string;
  text: string;
  head: number;
  tail: number;
  expected: string;
  hasMore: boolean;
}

interface BashValidationCase {
  name: string;
  command: string;
  expected: string | null;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/jsParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
    fileSizes: FileSizeCase[];
    clamps: ClampCase[];
    bashValidation: BashValidationCase[];
  };

  check('对照表非空', fixture.fileSizes.length > 0 && fixture.clamps.length > 0 && fixture.bashValidation.length > 0);

  for (const testCase of fixture.fileSizes) {
    const actual = formatFileSize(testCase.bytes);
    if (actual !== testCase.expected) {
      console.log(`     actual:   ${JSON.stringify(actual)}`);
      console.log(`     expected: ${JSON.stringify(testCase.expected)}`);
    }
    check(`formatFileSize(${testCase.bytes}) === ${testCase.expected}`, actual === testCase.expected);
  }

  for (const testCase of fixture.clamps) {
    const actual = generateHeadTailPreview(testCase.text, testCase.head, testCase.tail);
    check(
      `${testCase.name}：前 ${testCase.head} + 后 ${testCase.tail} 预览`,
      actual.preview === testCase.expected && actual.hasMore === testCase.hasMore,
    );
  }

  for (const testCase of fixture.bashValidation) {
    const result = await validateInput({ command: testCase.command } as never);
    const actual = result.result ? null : result.message;
    if (actual !== testCase.expected) {
      console.log(`     actual:   ${JSON.stringify(actual)}`);
      console.log(`     expected: ${JSON.stringify(testCase.expected)}`);
    }
    check(`${testCase.name}：Bash validateInput`, actual === testCase.expected);
  }

  finish();
}

runTests('js-parity', run);
