/**
 * 工具入参修复对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/toolInputRepairParity.json`：
 * - 本文件断言「对照表 == 真实 `RunTools.fixToolInput` 的输出」（防对照表腐化）；
 * - `core-rs/src/engine_tests.rs` 的 `fix_tool_input_parity_tests` 断言
 *   「`engine::fix_tool_input` == 对照表」（`output` 与 `input` 深度相等表示未修复）。
 *
 * 覆盖：顶层 double-encode 解包、字段值合法 JSON 字符串解包、畸形数组 / 对象的抢救
 * （key 缺引号、单引号、按逗号拆分、嵌套括号、引号内逗号）、以及非对象 / 非字符串输入。
 *
 * 运行方式：npm run test:all -- tool-input-repair-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { fixToolInput } from '../core/tools/RunTools';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  input: unknown;
  output: unknown;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/toolInputRepairParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const actual = fixToolInput(testCase.input);
    check(
      `${testCase.name}: 修复结果一致`,
      JSON.stringify(actual) === JSON.stringify(testCase.output),
    );
    // 未修复时必须原样返回（Rust 侧据此断言 `fix_tool_input` 返回 None）
    if (JSON.stringify(testCase.output) === JSON.stringify(testCase.input)) {
      check(`${testCase.name}: 未修复时原样返回`, actual === testCase.input);
    }
  }

  finish();
}

runTests('tool-input-repair-parity', run);
