#!/usr/bin/env node
/**
 * 生成「工具入参 schema 校验」对等对照表。
 *
 * 对照表 `src/test/fixtures/toolInputValidation.json` 被两侧共用：
 * - `src/test/toolInputValidationParity.test.ts` 用 Embedded 各工具的 Zod `inputSchema`
 *   断言对照表仍然成立（schema 改了这里会红）；
 * - `core-rs/src/tools_tests.rs` 的 `tool_input_validation_parity_tests` 用 Rust
 *   `tool_input::parse_input` 断言结果一致。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-tool-input-validation.mjs`。
 * 每条用例：`{ name, tool, input, error, parsed }`，`error` 是 Zod `error.message`
 * （即 `InputValidationError:` 后面的那段 JSON），`parsed` 是校验通过后的规范化数据。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'out', 'src', 'core', 'tools');

const schemas = {
  Read: require(join(outDir, 'read', 'Types.js')).inputSchema,
  Write: require(join(outDir, 'write', 'Types.js')).inputSchema,
  Edit: require(join(outDir, 'edit', 'Types.js')).inputSchema,
  Bash: require(join(outDir, 'bash', 'Types.js')).bashInputSchema,
  Glob: require(join(outDir, 'glob', 'Glob.js')).GlobTool.inputSchema,
  Grep: require(join(outDir, 'grep', 'Grep.js')).GrepTool.inputSchema,
  TodoWrite: require(join(outDir, 'todowrite', 'TodoWrite.js')).TodoWriteTool.inputSchema,
  AskUserQuestion: require(join(outDir, 'askuser', 'Types.js')).inputSchema,
  Agent: require(join(outDir, 'agent', 'Types.js')).inputSchema,
  Reply: require(join(outDir, 'agent', 'ReplyTool.js')).ReplyTool.inputSchema,
};

/** 每条用例：tool + input（input 原样进两侧） */
const cases = [
  ['Read', {}],
  ['Read', { file_path: 'a' }],
  ['Read', { file_path: 123 }],
  ['Read', { file_path: null }],
  ['Read', 'x'],
  ['Read', { file_path: 'a', extra: 1 }],
  ['Read', { file_path: 'a', extra: 1, extra2: 2 }],
  ['Read', { file_path: 'a', offset: '3', limit: '5' }],
  ['Read', { file_path: 'a', offset: '0' }],
  ['Read', { file_path: 'a', offset: '-1' }],
  ['Read', { file_path: 'a', offset: 2.5 }],
  ['Read', { file_path: 'a', offset: null }],
  ['Read', { file_path: 'a', limit: '0' }],
  ['Read', { file_path: 'a', limit: 'x' }],
  ['Read', { file_path: 'a', offset: '-1', extra: 1 }],
  ['Read', { file_path: 'a', sheet: 5 }],
  ['Read', { file_path: 'a', sheet: 'Sheet1' }],
  ['Read', { file_path: 'a', sheet: '' }],
  ['Read', { file_path: 'a', sheet: null }],
  ['Read', { file_path: 'a', limit: 100000 }],

  ['Write', { file_path: 'a', content: 'c' }],
  ['Write', {}],
  ['Write', { file_path: 'a' }],
  ['Write', { file_path: 'a', content: 5 }],
  ['Write', { file_path: 'a', content: 'c', extra: 1 }],

  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }],
  ['Edit', { file_path: 'a' }],
  ['Edit', { file_path: 'a', old_string: 'x' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: 'true' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: 'false' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: '' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: 'maybe' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: 1 }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: null }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', offset: '2' }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', offset: 0 }],
  ['Edit', { file_path: 'a', old_string: 'x', new_string: 'y', extra: 1 }],

  ['Bash', { command: 'ls' }],
  ['Bash', {}],
  ['Bash', { command: 5 }],
  ['Bash', { command: 'ls', description: 5 }],
  ['Bash', { command: 'ls', cwd: null }],
  ['Bash', { command: 'ls', run_in_background: 'false' }],
  ['Bash', { command: 'ls', run_in_background: 'true' }],
  ['Bash', { command: 'ls', run_in_background: 0 }],
  ['Bash', { command: 'ls', run_in_background: null }],
  ['Bash', { command: 'ls', extra: 1 }],

  ['Glob', { pattern: '**/*' }],
  ['Glob', {}],
  ['Glob', { pattern: 5 }],
  ['Glob', { pattern: 'x', path: 5 }],
  ['Glob', { pattern: 'x', extra: 1 }],

  ['Grep', { pattern: 'x' }],
  ['Grep', {}],
  ['Grep', { pattern: 5 }],
  ['Grep', { pattern: 'x', output_mode: 'bad' }],
  ['Grep', { pattern: 'x', output_mode: 'count' }],
  ['Grep', { pattern: 'x', '-A': '3' }],
  ['Grep', { pattern: 'x', '-A': '-1' }],
  ['Grep', { pattern: 'x', '-n': 'false' }],
  ['Grep', { pattern: 'x', '-i': null }],
  ['Grep', { pattern: 'x', head_limit: '-1' }],
  ['Grep', { pattern: 'x', offset: '2' }],
  ['Grep', { pattern: 'x', multiline: '1' }],
  ['Grep', { pattern: 'x', extra: 1 }],

  ['TodoWrite', { todos: [] }],
  ['TodoWrite', {}],
  ['TodoWrite', { todos: 'x' }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: 'a' }] }],
  ['TodoWrite', { todos: [{ content: 'c' }] }],
  ['TodoWrite', { todos: [{ content: '', activeForm: 'a' }] }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: '' }] }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: 'a', status: 'bad' }] }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: 'a', status: 'in_progress' }] }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: 'a', extra: 1 }] }],
  ['TodoWrite', { todos: [{ content: 'c' }, { content: '', activeForm: 'a' }] }],
  ['TodoWrite', { todos: [{ content: 'c', activeForm: 'a' }, 'x'] }],

  ['AskUserQuestion', { question: 'hi' }],
  ['AskUserQuestion', {}],
  ['AskUserQuestion', { question: 5 }],
  ['AskUserQuestion', { question: 'hi', extra: 1 }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a' }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a', description: 'd' }] }],
  ['AskUserQuestion', { question: 'hi', choices: [] }],
  ['AskUserQuestion', { question: 'hi', choices: 'x' }],
  ['AskUserQuestion', { question: 'hi', choices: [5] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ description: 'd' }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 5 }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a', description: 5 }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a', description: null }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a', x: 1 }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a' }, { label: 'b', z: 1, y: 2 }] }],
  ['AskUserQuestion', { question: 'hi', choices: [{ label: 'a' }, { label: 5 }] }],
  ['AskUserQuestion', { question: 'hi', choices: new Array(10).fill({ label: 'a' }) }],
  ['AskUserQuestion', { question: 'hi', choices: new Array(10).fill({ label: 5 }) }],

  ['Agent', { prompt: 'do it', agentRole: 'Master' }],
  ['Agent', {}],
  ['Agent', { prompt: 'do it' }],
  ['Agent', { agentRole: 'Master' }],
  ['Agent', { prompt: 'do it', agentRole: 'Master', description: 'd' }],
  ['Agent', { prompt: 'do it', agentRole: 'Master', extra: 1 }],
  ['Agent', { prompt: 5, agentRole: 'Master' }],
  ['Agent', { prompt: 'do it', agentRole: 5 }],
  ['Agent', { prompt: 'do it', agentRole: 'Master', description: 5 }],

  ['Reply', { message: 'hi' }],
  ['Reply', {}],
  ['Reply', { message: 5 }],
  ['Reply', { message: 'hi', targetSessionId: 's1' }],
  ['Reply', { message: 'hi', targetSessionId: 5 }],
  ['Reply', { message: 'hi', extra: 1 }],
];

const result = cases.map(([tool, input], index) => {
  const parsed = schemas[tool].safeParse(input);
  return {
    name: `${tool}-${index}`,
    tool,
    input,
    error: parsed.success ? null : parsed.error.message,
    parsed: parsed.success ? parsed.data : null,
  };
});

const fixture = {
  note:
    '工具入参 schema 校验对照表（Zod safeParse）。两侧共用：' +
    'src/test/toolInputValidationParity.test.ts 断言 Embedded schema 产出该表，' +
    'core-rs 的 tool_input_validation_parity_tests 断言 Rust parse_input 产出同结果。' +
    '由 scripts/gen-tool-input-validation.mjs 生成。',
  cases: result,
};

const target = join(repoRoot, 'src', 'test', 'fixtures', 'toolInputValidation.json');
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`已写入 ${target}（${result.length} 条）`);
