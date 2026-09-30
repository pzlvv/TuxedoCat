#!/usr/bin/env node
/**
 * 生成「工具入参修复」对等对照表。
 *
 * 对照表 `src/test/fixtures/toolInputRepairParity.json` 被两侧共用：
 * - `src/test/toolInputRepairParity.test.ts` 用 Embedded 的
 *   `RunTools.fixToolInput` 断言对照表仍然成立（TS 实现改了这里会红）；
 * - `core-rs/src/engine_tests.rs` 的 `fix_tool_input_parity_tests` 用 Rust
 *   `engine::fix_tool_input` 断言结果一致。
 *
 * 覆盖 `RunTools.fixToolInput` 的三段逻辑：
 * 1. 顶层字符串 double-encode 解包；
 * 2. 字段值是合法 JSON 字符串时解包成对象 / 数组；
 * 3. 字段值形似数组 / 对象但 JSON 畸形时的抢救（key 缺引号、单引号、按逗号拆分）。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-tool-input-repair-parity.mjs`。
 * 每条用例：`{ name, input, output }`（input 原样进两侧，output 是 TS 的真实输出）。
 * Rust 侧按 `output === input` 判断「未修复」。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fixToolInput } = require(join(repoRoot, 'out', 'src', 'core', 'tools', 'RunTools.js'));

const cases = [
  // ---- 顶层字符串 ----
  ['top-string-object', '{"a": 1}'],
  ['top-string-nested', '"{\\"a\\": 1}"'],
  ['top-string-array', '[1, 2]'],
  ['top-string-plain', 'hello'],
  ['top-string-number', '123'],
  ['top-string-empty', ''],
  ['top-string-broken', '{"a": '],

  // ---- 字段值：合法 JSON 字符串 ----
  ['field-object-json', { a: '{"x": 1}' }],
  ['field-array-json', { a: '[1, 2]' }],
  ['field-string-json', { a: '"hello"' }],
  ['field-number-json', { a: '123' }],
  ['field-null-json', { a: 'null' }],
  ['field-bool-json', { a: 'true' }],
  ['field-broken-json', { a: '{oops' }],

  // ---- 字段值：畸形数组抢救 ----
  ['field-array-missing-quotes', { a: '[xx: abc, yy: def]' }],
  ['field-array-key-quoted', { a: '["xx": "abc"]' }],
  ['field-array-single-quotes', { a: "['a', 'b']" }],
  ['field-array-plain-items', { a: '[a, b]' }],
  ['field-array-mixed-items', { a: '[a, xx: b]' }],
  ['field-array-nested-object', { a: '[{xx: 1}]' }],
  ['field-array-nested-brackets', { a: '[a, [b, c]]' }],
  ['field-array-empty', { a: '[]' }],
  ['field-array-only-comma', { a: '[,]' }],
  ['field-array-trailing-comma', { a: '[a,]' }],
  ['field-array-value-with-colon', { a: '[key: a:b:c]' }],
  ['field-array-quoted-comma', { a: '["a,b", c]' }],
  ['field-array-single-quoted-key', { a: "['xx': 'abc']" }],
  ['field-array-newline', { a: '[xx: a\n yy: b]' }],

  // ---- 字段值：畸形对象抢救 ----
  ['field-object-missing-quotes', { a: '{xx: abc, yy: def}' }],
  ['field-object-single-quoted-key', { a: "{'xx': 1}" }],
  ['field-object-single-quoted-value', { a: "{xx: 'a'}" }],
  ['field-object-spaces', { a: '{ xx : 1 }' }],
  ['field-object-broken', { a: '{xx 1}' }],

  // ---- 组合 / 其它类型 ----
  ['field-multiple', { a: '[xx: 1]', b: '{yy: 2}', c: 'plain' }],
  ['field-non-string', { a: 1, b: null, c: true, d: [1] }],
  ['input-array', ['[xx: 1]']],
  ['input-number', 42],
  ['input-null', null],
  ['input-bool', false],
];

const result = cases.map(([name, input]) => ({
  name,
  input,
  output: fixToolInput(input),
}));

const fixture = {
  note:
    '工具入参修复对照表（RunTools.fixToolInput）。两侧共用：' +
    'src/test/toolInputRepairParity.test.ts 断言 Embedded fixToolInput 产出该表，' +
    'core-rs 的 fix_tool_input_parity_tests 断言 Rust engine::fix_tool_input 产出同结果' +
    '（output 与 input 深度相等表示「未修复」）。由 scripts/gen-tool-input-repair-parity.mjs 生成。',
  cases: result,
};

const target = join(repoRoot, 'src', 'test', 'fixtures', 'toolInputRepairParity.json');
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`已写入 ${target}（${result.length} 条）`);
