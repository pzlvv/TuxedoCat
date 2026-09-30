#!/usr/bin/env node
/**
 * 生成「Skill 系统」对等对照表。
 *
 * 对照表 `src/test/fixtures/skillsParity.json` 被两侧共用：
 * - `src/test/skillsParity.test.ts` 用 Embedded 的真实实现
 *   （`frontmatterParser` / `variableResolver` / `formatSkillListing`）断言对照表仍成立；
 * - `core-rs/src/skills_tests.rs` 的 `parity_tests` 用 Rust `skills::*` 断言结果一致。
 *
 * 只覆盖**纯函数**：不碰文件系统（`loadSkillsDir` 的目录扫描另由 Rust 单测覆盖）。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-skills-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(repoRoot, 'out', 'src', 'core');

const {
  parseFrontmatter,
  parseSkillFrontmatterFields,
  extractDescriptionFromMarkdown,
  parseSkillPaths,
  parseArgumentNames,
  parseBooleanFrontmatter,
  coerceDescriptionToString,
} = require(join(coreDir, 'skills', 'frontmatterParser.js'));
const {
  substituteArguments,
  parsePositionalArgs,
  substituteBuiltinVariables,
} = require(join(coreDir, 'skills', 'variableResolver.js'));
const { formatSkillListing } = require(join(coreDir, 'tools', 'skill', 'Prompt.js'));

// ---------------- frontmatter 解析 ----------------

const frontmatterCases = [
  'plain text, no frontmatter',
  '---\ndescription: A skill\n---\nBody text',
  '---\n\n---\n\nBody',
  '---\ndescription: A skill\n',
  '---\nname: my-skill\ndescription: "Quoted desc"\nwhen_to_use: When X\nversion: 1.2.3\nmodel: inherit\nuser-invocable: false\n---\nBody',
  "---\ndescription: 'single'\narguments: [a, b]\n---\nBody",
  '---\ndescription: Multi\nline: |\n  first line\n  second line\nnext: after\n---\nBody',
  '---\ntags:\n  - one\n  - two\ndescription: d\n---\nBody',
  '---\ntags:\n  - one\n  - two\n---\nBody',
  '---\n# a comment\nflag: true\nother: false\nnum: 42\nfloat: 3.5\nnegative: -7\nnil: ~\nnull2: null\n---\nBody',
  // JS 只有 double：`parseFloat("1.0")` 是 1，JSON 里写 `1` 而不是 `1.0`
  '---\nwhole: 1.0\nnegative: -2.0\nfraction: 0.5\n---\nBody',
  '---\nempty:\nafter: x\n---\nBody',
  '---\n   spaced:   value   \n---\nBody',
  '---\npaths: [src/**/*.ts, docs/**]\n---\nBody',
  '---\ntrailing: |\n  only line\n---\nBody',
  // JS 空白口径（U+FEFF / U+0085）：多行值 / 数组项的 `.trim()` 必须与 Embedded 一致
  '---\ndescription: Multi\nline: |\n  first\uFEFF\n  second\u0085\nnext: after\n---\nBody',
  '---\ntags:\n  - \uFEFFone\n  - \u0085two\n---\nBody',
  '---\n\uFEFFspaced\u0085:   \uFEFFvalue\u0085   \n---\nBody',
];

const frontmatter = frontmatterCases.map((content) => {
  const parsed = parseFrontmatter(content);
  return { content, frontmatter: parsed.frontmatter, body: parsed.content };
});

// ---------------- frontmatter 字段解析 ----------------

const fieldCases = [
  { frontmatter: {}, markdown: 'Body text here' },
  { frontmatter: { description: 'From frontmatter' }, markdown: 'Body text here' },
  { frontmatter: { description: '   ' }, markdown: '# Title\n\nFirst paragraph.' },
  { frontmatter: { description: 42 }, markdown: 'Body' },
  { frontmatter: { name: 'display', description: 'd' }, markdown: 'Body' },
  { frontmatter: { name: 7 }, markdown: 'Body' },
  { frontmatter: { 'user-invocable': false }, markdown: 'Body' },
  { frontmatter: { 'user-invocable': 'yes' }, markdown: 'Body' },
  { frontmatter: { 'user-invocable': 'no' }, markdown: 'Body' },
  { frontmatter: { 'user-invocable': true }, markdown: 'Body' },
  { frontmatter: { model: 'inherit' }, markdown: 'Body' },
  { frontmatter: { model: 'claude-sonnet-4-20250514' }, markdown: 'Body' },
  { frontmatter: { model: 5 }, markdown: 'Body' },
  { frontmatter: { arguments: 'single' }, markdown: 'Body' },
  { frontmatter: { arguments: ['a', 'b'] }, markdown: 'Body' },
  { frontmatter: { when_to_use: 'When X', version: '1.0.0' }, markdown: 'Body' },
  { frontmatter: { paths: ['src/**'] }, markdown: 'Body' },
  { frontmatter: { paths: ['**'] }, markdown: 'Body' },
];

const fields = fieldCases.map(({ frontmatter: fm, markdown }) => ({
  frontmatter: fm,
  markdown,
  result: parseSkillFrontmatterFields(fm, markdown, 'skill-name'),
}));

// ---------------- 描述提取 ----------------

const descriptionCases = [
  '---\ndescription: from fm\n---\nBody',
  'Plain first line\nsecond line',
  '# Heading only\n\n## Another\n\nReal text',
  '```\ncode fence\n```\n\nAfter fence',
  '- list item\n> quote\nReal description',
  '',
  `${'x'.repeat(200)}`,
  `${'y'.repeat(160)} tail`,
];

const descriptions = descriptionCases.map((markdown) => ({
  markdown,
  result: extractDescriptionFromMarkdown(markdown),
}));

// ---------------- paths / arguments / boolean / coerce ----------------

const pathValues = [
  null,
  undefined,
  [],
  ['**'],
  ['*'],
  ['**/*'],
  ['src/**'],
  ['src/**', '**'],
  ['', 'src/**'],
  ['a', 1],
];

const paths = pathValues.map((value) => ({ value: value ?? null, result: parseSkillPaths(value) ?? null }));

const argumentValues = [undefined, null, 'one', ['a', 'b'], []];

const argumentNames = argumentValues.map((value) => ({
  value: value ?? null,
  result: parseArgumentNames(value),
}));

const booleanValues = [undefined, null, true, false, 'true', 'false', 'yes', 'no', 'other', 0, 1, {}];

const booleans = booleanValues.map((value) => ({
  value: value === undefined ? null : value,
  result: parseBooleanFrontmatter(value),
}));

const coerceValues = [undefined, null, '', '   ', 'text', '  padded  ', 42, {}, []];

const coerce = coerceValues.map((value) => ({
  value: value === undefined ? null : value,
  result: coerceDescriptionToString(value, 'skill-name'),
}));

// ---------------- 变量替换 ----------------

const substituteCases = [
  { content: 'no vars', args: '', argNames: [] },
  { content: 'Args: $ARGUMENTS', args: 'hello world', argNames: [] },
  { content: 'Args: $ARGUMENTS', args: '', argNames: [] },
  { content: 'First: $0', args: 'alpha beta', argNames: [] },
  { content: 'First: $0 / Second: $1', args: 'alpha beta', argNames: ['first', 'second'] },
  { content: 'First: $0 / Second: $1', args: 'only', argNames: ['first', 'second'] },
  { content: 'Named: ${first} and $first', args: 'value', argNames: ['first'] },
  { content: 'Prefix: $firstname', args: 'value', argNames: ['first'] },
  { content: 'Quoted: $0', args: '"two words" rest', argNames: ['a', 'b'] },
  { content: 'Escaped: $0', args: 'a\\ b c', argNames: ['a', 'b'] },
  { content: "Single: $0", args: "'one two' three", argNames: ['a', 'b'] },
  { content: 'Dollar: $0', args: '$& literal', argNames: ['a'] },
  { content: 'Dollar: $0', args: '$$', argNames: ['a'] },
  { content: 'All: $ARGUMENTS and $0', args: 'x y', argNames: ['n'] },
  { content: 'Multi $0\n$1', args: 'a b', argNames: ['n', 'm'] },
];

const substituteArgumentsCases = substituteCases.map(({ content, args, argNames }) => ({
  content,
  args,
  argNames,
  result: substituteArguments(content, args, argNames),
}));

const positionalCases = [
  { args: '', count: 0 },
  { args: '', count: 2 },
  { args: 'a b c', count: 3 },
  { args: 'a b c', count: 1 },
  { args: 'a b c', count: 5 },
  { args: '  leading and trailing  ', count: 3 },
  { args: '"quoted arg" plain', count: 2 },
  { args: "'single quoted' plain", count: 2 },
  { args: 'back\\ slash', count: 2 },
  { args: 'a\\', count: 2 },
];

const positional = positionalCases.map(({ args, count }) => ({
  args,
  count,
  result: parsePositionalArgs(args, count),
}));

const builtinCases = [
  { content: 'Dir: ${SKILL_DIR}', skillDir: '/tmp/skill', sessionId: 'sess-1' },
  { content: 'Dir: ${SKILL_DIR}', skillDir: null, sessionId: 'sess-1' },
  { content: 'Session: ${SESSION_ID}', skillDir: '/tmp/skill', sessionId: null },
  { content: 'Both ${SKILL_DIR} ${SESSION_ID}', skillDir: 'C:\\skills\\x', sessionId: 's' },
  { content: 'No placeholders', skillDir: '/a', sessionId: 'b' },
];

const builtinVariables = builtinCases.map(({ content, skillDir, sessionId }) => ({
  content,
  skillDir,
  sessionId,
  result: substituteBuiltinVariables(content, skillDir ?? undefined, sessionId ?? undefined),
}));

// ---------------- Skill 列表 ----------------

const listingCases = [
  [],
  [{ name: 'commit', description: 'Create a git commit', userInvocable: true, isHidden: false }],
  [
    { name: 'commit', description: 'Create a git commit', userInvocable: true, isHidden: false, whenToUse: 'When asked' },
    { name: 'hidden', description: 'Hidden one', userInvocable: true, isHidden: true },
    { name: 'manual', description: 'Manual only', userInvocable: false, isHidden: false },
    { name: 'review', description: 'Review code', userInvocable: true, isHidden: false },
  ],
];

const skillListing = listingCases.map((skills) => ({
  skills,
  result: formatSkillListing(skills),
}));

const output = {
  note:
    'Skill 系统纯函数对照表（Embedded `skills/*` ↔ Standalone `core-rs/src/skills.rs`）。' +
    '只覆盖 frontmatter 解析、变量替换与技能清单格式化；目录扫描 / 内置注册由各自单测覆盖。',
  frontmatter,
  fields,
  descriptions,
  paths,
  argumentNames,
  booleans,
  coerce,
  substituteArguments: substituteArgumentsCases,
  positional,
  builtinVariables,
  skillListing,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'skillsParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log('wrote src/test/fixtures/skillsParity.json');
