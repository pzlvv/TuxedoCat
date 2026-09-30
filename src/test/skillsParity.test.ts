/**
 * Skill 系统对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/skillsParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `frontmatterParser` / `variableResolver` /
 *   `formatSkillListing`」；
 * - `core-rs/src/skills_tests.rs` 的 `parity_tests` 断言「Rust `skills::*` == 对照表」。
 *
 * 只覆盖**纯函数**：frontmatter 解析、变量替换、技能清单格式化。目录扫描 /
 * 内置注册由各自单测覆盖。
 *
 * 运行方式：npm run test:all -- skills-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  coerceDescriptionToString,
  extractDescriptionFromMarkdown,
  parseArgumentNames,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseSkillFrontmatterFields,
  parseSkillPaths,
} from '../core/skills/frontmatterParser';
import {
  parsePositionalArgs,
  substituteArguments,
  substituteBuiltinVariables,
} from '../core/skills/variableResolver';
import { formatSkillListing } from '../core/tools/skill/Prompt';
import { createChecker, runTests } from './helpers/harness';

interface Fixture {
  frontmatter: Array<{ content: string; frontmatter: Record<string, unknown>; body: string }>;
  fields: Array<{ frontmatter: Record<string, unknown>; markdown: string; result: Record<string, unknown> }>;
  descriptions: Array<{ markdown: string; result: string }>;
  paths: Array<{ value: unknown; result: string[] | null }>;
  argumentNames: Array<{ value: unknown; result: string[] }>;
  booleans: Array<{ value: unknown; result: boolean }>;
  coerce: Array<{ value: unknown; result: string | null }>;
  substituteArguments: Array<{ content: string; args: string; argNames: string[]; result: string }>;
  positional: Array<{ args: string; count: number; result: string[] }>;
  builtinVariables: Array<{ content: string; skillDir: string | null; sessionId: string | null; result: string }>;
  skillListing: Array<{ skills: Array<Record<string, unknown>>; result: string }>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/skillsParity.json');

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.frontmatter.length > 0 && fixture.substituteArguments.length > 0);

  for (const item of fixture.frontmatter) {
    const parsed = parseFrontmatter(item.content);
    check(
      `frontmatter: ${JSON.stringify(item.content)}`,
      JSON.stringify(parsed.frontmatter) === JSON.stringify(item.frontmatter)
        && parsed.content === item.body,
    );
  }

  for (const item of fixture.fields) {
    const parsed = parseSkillFrontmatterFields(item.frontmatter, item.markdown, 'skill-name');
    check(
      `fields: ${JSON.stringify(item.frontmatter)}`,
      JSON.stringify(parsed) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.descriptions) {
    check(
      `description: ${JSON.stringify(item.markdown.slice(0, 30))}`,
      extractDescriptionFromMarkdown(item.markdown) === item.result,
    );
  }

  for (const item of fixture.paths) {
    check(
      `paths: ${JSON.stringify(item.value)}`,
      JSON.stringify(parseSkillPaths(item.value) ?? null) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.argumentNames) {
    check(
      `argumentNames: ${JSON.stringify(item.value)}`,
      JSON.stringify(parseArgumentNames(item.value as string | string[] | undefined))
        === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.booleans) {
    check(
      `booleans: ${JSON.stringify(item.value)}`,
      parseBooleanFrontmatter(item.value) === item.result,
    );
  }

  for (const item of fixture.coerce) {
    check(
      `coerce: ${JSON.stringify(item.value)}`,
      coerceDescriptionToString(item.value, 'skill-name') === item.result,
    );
  }

  for (const item of fixture.substituteArguments) {
    check(
      `substituteArguments: ${JSON.stringify(item.content)} args=${JSON.stringify(item.args)}`,
      substituteArguments(item.content, item.args, item.argNames) === item.result,
    );
  }

  for (const item of fixture.positional) {
    check(
      `positional: ${JSON.stringify(item.args)} count=${item.count}`,
      JSON.stringify(parsePositionalArgs(item.args, item.count)) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.builtinVariables) {
    check(
      `builtinVariables: ${JSON.stringify(item.content)}`,
      substituteBuiltinVariables(item.content, item.skillDir ?? undefined, item.sessionId ?? undefined)
        === item.result,
    );
  }

  for (const item of fixture.skillListing) {
    check(
      `skillListing: ${item.skills.length} 条`,
      formatSkillListing(item.skills as never) === item.result,
    );
  }

  finish();
}

runTests('skills-parity', run);
