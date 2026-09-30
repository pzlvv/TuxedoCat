/**
 * Read 二进制判定对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/binaryDetection.json`：
 * - 本文件跑 Embedded 使用的 `isbinaryfile`；
 * - `core-rs/src/tools_tests.rs` 的 `binary_detection_parity_tests` 跑 Standalone 的
 *   `is_binary_content`（逐分支移植 `isbinaryfile`）。
 *
 * 二进制判定决定 Read 是「按文本读 / 返回图片 block / 报 Cannot read binary file」，
 * 两侧必须给出同一个结论。
 *
 * 运行方式：npm run test:all -- binary-detection-parity
 */

import * as path from 'path';
import * as fs from 'fs';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  hex: string;
  expected: boolean;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/binaryDetection.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const { isBinaryFile } = (await import('isbinaryfile')) as {
    isBinaryFile: (file: Buffer) => Promise<boolean>;
  };

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const actual = await isBinaryFile(Buffer.from(testCase.hex, 'hex'));
    check(
      `${testCase.name}（期望 binary=${testCase.expected}）`,
      actual === testCase.expected,
    );
  }

  finish();
}

runTests('binary-detection-parity', run);
