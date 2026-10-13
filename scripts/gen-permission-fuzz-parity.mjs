#!/usr/bin/env node
/**
 * 生成「Bash 权限决策」随机对等对照表。
 *
 * 与 `permissionParity.json`（人工挑选的用例）互补：这里用固定种子的伪随机组合，
 * 覆盖命令分词 / 引号 / 转义 / `$(...)` / 环境变量前缀 / 多词只读命令 /
 * 破坏性命令 / JS 空白字符（U+0085 / U+FEFF）等组合空间。
 *
 * 对照表 `src/test/fixtures/permissionFuzzParity.json` 被两侧共用：
 * - `src/test/permissionFuzzParity.test.ts` 跑 Embedded `resolveToolPermission`；
 * - `core-rs/src/permission_tests.rs` 的 `fuzz_parity_tests` 跑 `permission::decide`。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-permission-fuzz-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
require(join(repoRoot, 'out', 'src', 'core', 'history', 'Config.js')).setExtensionPath(repoRoot);

const { resolveToolPermission, setSessionAgentMode } = require(
  join(repoRoot, 'out', 'src', 'core', 'tools', 'PermissionPolicy.js'),
);
const { setSessionWorkspace } = require(join(repoRoot, 'out', 'src', 'core', 'history', 'Config.js'));
const { BashTool } = require(join(repoRoot, 'out', 'src', 'core', 'tools', 'bash', 'Bash.js'));

/** mulberry32：固定种子的确定性 PRNG，保证对照表可重复生成 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const READONLY = ['ls', 'cat', 'head', 'grep', 'find', 'echo', 'pwd', 'sort', 'date', 'jq', 'mkdir', 'cd'];
const WRITE = ['rm', 'mv', 'cp', 'curl', 'npm', 'node', 'python', 'docker', 'sed', 'chmod', 'kill'];
const DESTRUCTIVE = ['dd', 'mkfs', 'format', 'fdisk', 'shred', 'wipe'];
const MULTI_WORD = [
  'git status',
  'git diff',
  'git log',
  'git reset',
  'git checkout',
  'git commit',
  'git stash list',
  'git stash show',
  'git config',
  'git branch',
];
const ARGS = ['', ' -la', ' --short', ' file.txt', ' "a|b"', " 'x;y'", ' $(echo hi)', ' \\|', ' -rf /'];
const ENV_PREFIX = ['', 'FOO=1 ', 'FOO="a b" ', "FOO='a b' ", 'A_B= '];
const SEPARATORS = ['; ', ' && ', ' || ', ' | ', ';', '&&', '\n'];
const PADDING = ['', ' ', '\t', '\u0085', '\uFEFF', '  '];

const COMMAND_COUNT = 140;
const MODES = ['manual', 'auto', 'risk'];

const random = makeRandom(0x5eedc0de);
const pick = (items) => items[Math.floor(random() * items.length)];

function buildCommand() {
  const shape = random();
  let command;
  if (shape < 0.08) {
    // 空 / 纯空白命令
    command = pick(PADDING);
  } else if (shape < 0.5) {
    command = pick([...READONLY, ...WRITE, ...DESTRUCTIVE]) + pick(ARGS);
  } else if (shape < 0.75) {
    command = pick(MULTI_WORD) + pick(ARGS);
  } else {
    const parts = [];
    const count = 2 + Math.floor(random() * 3);
    for (let i = 0; i < count; i += 1) {
      const word = random() < 0.7 ? pick(READONLY) : pick([...WRITE, ...DESTRUCTIVE]);
      parts.push(pick(ENV_PREFIX) + word + pick(ARGS));
    }
    command = parts.join(pick(SEPARATORS));
  }
  // 偶尔加引号包裹 / 首尾空白
  if (random() < 0.12) command = `'${command}'`;
  else if (random() < 0.12) command = `"${command}"`;
  return pick(PADDING) + command + pick(PADDING);
}

const dir = mkdtempSync(join(tmpdir(), 'permission-fuzz-parity-'));
setSessionWorkspace('fuzz-session', dir);

const cases = [];
try {
  for (let i = 0; i < COMMAND_COUNT; i += 1) {
    const command = buildCommand();
    for (const mode of MODES) {
      setSessionAgentMode('fuzz-session', mode);
      let expect;
      try {
        const { permResult } = await resolveToolPermission('fuzz-session', 'Bash', { command }, BashTool);
        expect = permResult.behavior;
      } catch (error) {
        expect = `ERROR: ${error.message}`;
      }
      cases.push({ mode, args: { command }, expect, why: `fuzz #${i}` });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const output = {
  note:
    'Bash 权限决策随机对等对照表（固定种子生成）：Embedded `resolveToolPermission` ↔ ' +
    'Standalone `core-rs/src/permission.rs::decide`。',
  seed: '0x5eedc0de',
  cases,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'permissionFuzzParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
const tally = cases.reduce((acc, testCase) => {
  acc[testCase.expect] = (acc[testCase.expect] ?? 0) + 1;
  return acc;
}, {});
console.log(`wrote ${cases.length} cases`, tally);
