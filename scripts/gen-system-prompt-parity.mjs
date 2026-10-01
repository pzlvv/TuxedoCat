#!/usr/bin/env node
/**
 * 生成「系统提示词」对等对照表。
 *
 * 对照表 `src/test/fixtures/systemPromptParity.json` 被两侧共用：
 * - `src/test/systemPromptParity.test.ts` 用 Embedded 的真实实现
 *   （`generateCoreSystemPrompt` / `generateToolUsagePrompt` / `assembleSystemPrompt`）
 *   断言对照表仍成立；
 * - `core-rs/src/prompt_tests.rs` 的 `system_prompt_parity_tests` 用 Rust
 *   `prompt::core_prompt` / `prompt::tool_usage_section` / `prompt::preset_core_prompt`
 *   断言结果一致。
 *
 * 只比较**与环境无关**的静态部分（核心身份 + 工具说明 / 详细用法 + 极简预设）：
 * 环境段含 shell / git / 可用命令等机器相关文本，另有 `prompt_tests.rs` 单测覆盖。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-system-prompt-parity.mjs`。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
require(join(repoRoot, 'out', 'src', 'core', 'history', 'Config.js')).setExtensionPath(repoRoot);

const {
  generateCoreSystemPrompt,
  generateToolUsagePrompt,
  assembleSystemPrompt,
} = require(join(repoRoot, 'out', 'src', 'core', 'prompt', 'SystemPrompt.js'));
const { PROMPT_PRESETS } = require(join(repoRoot, 'out', 'src', 'core', 'prompt', 'PromptPreset.js'));
const { getAllTools } = require(join(repoRoot, 'out', 'src', 'core', 'tools', 'index.js'));
const { buildAgentCommunicationSection } = require(join(repoRoot, 'out', 'src', 'core', 'tools', 'agent', 'Prompt.js'));

/**
 * 与 `core-rs/src/tools.rs::definitions()` 同一顺序 / 集合（Standalone 已迁入的工具）。
 * 顺序取自 Embedded `DEFAULT_TOOLS`（`Skill` 必须保持末位）。
 */
const BUILTIN_ORDER = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'TodoWrite', 'Agent', 'Reply', 'AskUserQuestion', 'Skill'];

const allTools = getAllTools();
const tools = BUILTIN_ORDER.map((name) => {
  const tool = allTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Embedded 缺少内置工具 ${name}`);
  return tool;
});

const CWD = '__CWD__';

const corePrompt = generateCoreSystemPrompt();
const toolUsage = await generateToolUsagePrompt(tools);
const minimalPrompt = await assembleSystemPrompt(PROMPT_PRESETS.minimal, {
  tools,
  systemInfo: {
    isGit: false,
    platform: 'linux',
    osType: 'Linux',
    osRelease: '1.0',
    shell: 'bash',
    shellName: 'bash',
  },
  cwd: CWD,
});

const output = {
  note:
    '系统提示词静态部分对照表（Embedded `prompt/*` ↔ Standalone `core-rs/src/prompt.rs`）。' +
    '只覆盖与环境无关的文本：核心身份、`## Tool Usage` + `## Tool Details`、极简预设、' +
    'Master 子代理的 `## Communication` 前缀段。',
  corePrompt,
  toolUsage,
  minimalPrompt,
  subAgentCommunicationSection: buildAgentCommunicationSection('__CREATOR__'),
  tools: BUILTIN_ORDER,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'systemPromptParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`wrote systemPromptParity.json`);
console.log(`  corePrompt: ${corePrompt.length} chars`);
console.log(`  toolUsage:  ${toolUsage.length} chars`);
console.log(`  minimalPrompt: ${JSON.stringify(minimalPrompt)}`);
