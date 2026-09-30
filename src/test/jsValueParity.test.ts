/**
 * JS 语义对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/jsValueParity.json`：
 * - 本文件断言「对照表 == `parseDataUrl` / 原生 `String()`」（防对照表腐化）；
 * - `core-rs/src/engine_tests.rs` 的 `js_value_parity_tests` 断言
 *   「`split_data_url` / `js_string` == 对照表」。
 *
 * 覆盖 data URL 正则（`^data:([^;,]+);base64,(.*)$`：media type 非空、不接受
 * charset 中间参数、大小写敏感、不匹配时视为纯 base64）与 `buildRawApiMessages`
 * 里 `String(content)` 兜底的语义（对象 `[object Object]`、数组逗号连接等）。
 *
 * 运行方式：npm run test:all -- js-value-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDataUrl } from '../core/utils/contentBlocks';
import { createChecker, runTests } from './helpers/harness';

interface DataUrlCase {
  input: string;
  mediaType: string;
  data: string;
}

interface StringifyCase {
  input: unknown;
  expected: string;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/jsValueParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
    dataUrls: DataUrlCase[];
    stringify: StringifyCase[];
  };

  check('dataUrls 非空', fixture.dataUrls.length > 0);
  for (const testCase of fixture.dataUrls) {
    const actual = parseDataUrl(testCase.input);
    check(
      `parseDataUrl(${JSON.stringify(testCase.input)})`,
      actual.mediaType === testCase.mediaType && actual.data === testCase.data,
    );
  }

  check('stringify 非空', fixture.stringify.length > 0);
  for (const testCase of fixture.stringify) {
    check(
      `String(${JSON.stringify(testCase.input)})`,
      String(testCase.input) === testCase.expected,
    );
  }

  finish();
}

runTests('js-value-parity', run);
