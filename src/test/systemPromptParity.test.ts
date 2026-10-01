/**
 * 系统提示词对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/systemPromptParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `generateCoreSystemPrompt` /
 *   `generateToolUsagePrompt` / `assembleSystemPrompt`」；
 * - `core-rs/src/prompt_tests.rs` 的 `system_prompt_parity_tests` 断言
 *   「Rust `prompt::core_prompt` / `tool_usage_section` / `preset_core_prompt` == 对照表」。
 *
 * 只覆盖与环境无关的静态文本：核心身份、工具说明 + 逐工具详细用法、极简预设。
 * 环境段（shell / git / 可用命令）随机器变化，由 Rust 侧单测覆盖。
 *
 * 运行方式：npm run test:all -- system-prompt-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { assembleSystemPrompt, generateCoreSystemPrompt, generateToolUsagePrompt } from '../core/prompt/SystemPrompt';
import { PROMPT_PRESETS } from '../core/prompt/PromptPreset';
import { getAllTools } from '../core/tools/index';
import { buildAgentCommunicationSection } from '../core/tools/agent/Prompt';
import { createChecker, runTests } from './helpers/harness';

interface Fixture {
  corePrompt: string;
  toolUsage: string;
  minimalPrompt: string;
  subAgentCommunicationSection: string;
  tools: string[];
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/systemPromptParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.tools.length > 0);

  const allTools = getAllTools();
  const tools = fixture.tools.map((name) => {
    const tool = allTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Embedded 缺少内置工具 ${name}`);
    return tool;
  });

  const corePrompt = generateCoreSystemPrompt();
  check('核心身份提示词逐字一致', corePrompt === fixture.corePrompt);
  if (corePrompt !== fixture.corePrompt) {
    console.log(`     期望: ${JSON.stringify(fixture.corePrompt)}\n     实际: ${JSON.stringify(corePrompt)}`);
  }

  const toolUsage = await generateToolUsagePrompt(tools);
  check('工具说明 + 详细用法逐字一致', toolUsage === fixture.toolUsage);
  if (toolUsage !== fixture.toolUsage) {
    const index = [...toolUsage].findIndex((char, i) => char !== [...fixture.toolUsage][i]);
    console.log(`     首个差异位置: ${index}`);
    console.log(`     期望: ${JSON.stringify(fixture.toolUsage.slice(Math.max(0, index - 60), index + 60))}`);
    console.log(`     实际: ${JSON.stringify(toolUsage.slice(Math.max(0, index - 60), index + 60))}`);
  }

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
    cwd: '__CWD__',
  });
  check('极简预设只有单行核心身份', minimalPrompt === fixture.minimalPrompt);
  if (minimalPrompt !== fixture.minimalPrompt) {
    console.log(`     期望: ${JSON.stringify(fixture.minimalPrompt)}\n     实际: ${JSON.stringify(minimalPrompt)}`);
  }

  const subAgentCommunication = buildAgentCommunicationSection('__CREATOR__');
  check('Master 子代理 Communication 前缀逐字一致', subAgentCommunication === fixture.subAgentCommunicationSection);
  if (subAgentCommunication !== fixture.subAgentCommunicationSection) {
    console.log(`     期望: ${JSON.stringify(fixture.subAgentCommunicationSection)}\n     实际: ${JSON.stringify(subAgentCommunication)}`);
  }

  finish();
}

runTests('system-prompt-parity', run);
