/**
 * 提示词预设对等测试（Embedded ↔ Standalone）。
 *
 * Embedded（真值）的 `PromptPreset.ts` / `QueryEngine.getActivePromptPresetId` 口径：
 * - `normal`：核心身份 + 三个区块（tool-usage / environment / agents-md），全部工具；
 * - `minimal` / `mixed`：只有单行核心身份，无附加区块，工具白名单仅 `Bash` / `Edit`；
 * - 非法 / 缺省预设回退 `normal`（`getPromptPreset` / `isPromptPresetId` 白名单）；
 * - `mixed` 在首次 assistant 回复前用 `minimal`，之后切 `normal`。
 *
 * Standalone 侧由 `core-rs/src/prompt_tests.rs` 的同名用例
 * （`active_preset_matches_embedded_transitions`、`preset_tool_whitelist_and_minimal_prompt`）
 * 断言同一张表：任一侧偏离即失败。
 *
 * 运行方式：npm run test:all -- prompt-preset-parity
 */

import { PROMPT_PRESETS, getPromptPreset, isPromptPresetId } from '../core/prompt/PromptPreset';
import { assembleSystemPrompt, type SystemDynamicInfo } from '../core/prompt/SystemPrompt';
import { getAllTools } from '../core/tools/index';
import type { Tool } from '../core/tools/Tool';
import { createChecker, runTests } from './helpers/harness';

/** 与 Rust `preset_core_prompt` / `PROMPT_PRESETS[*].corePrompt` 同表 */
const MINIMAL_CORE_PROMPT = 'You are a helpful software engineer assistant.';
const MINIMAL_TOOL_NAMES = ['Bash', 'Edit'];

/** 与 Rust `active_preset` 同表：promptMode × 是否已有 assistant 回复 → 生效预设 */
function activePreset(mode: string | undefined, hasAssistantReply: boolean): string {
  if (mode === 'minimal') return 'minimal';
  if (mode === 'mixed') return hasAssistantReply ? 'normal' : 'minimal';
  return 'normal';
}

const SYSTEM_INFO: SystemDynamicInfo = {
  isGit: false,
  platform: 'linux',
  osType: 'Linux',
  osRelease: '1.0',
  shell: 'bash',
  shellName: 'bash',
};

function allToolNames(): string[] {
  return (getAllTools() as unknown as Array<{ name: string }>).map((tool) => tool.name);
}

function presetToolNames(toolNames: readonly string[] | undefined): string[] {
  const all = allToolNames();
  return toolNames === undefined ? all : all.filter((name) => toolNames.includes(name));
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== activePreset 转换表（与 Rust active_preset 同表） =====
  const TRANSITIONS: Array<[string | undefined, boolean, string]> = [
    [undefined, false, 'normal'],
    ['normal', true, 'normal'],
    ['minimal', true, 'minimal'],
    ['bogus', false, 'normal'],
    ['mixed', false, 'minimal'],
    ['mixed', true, 'normal'],
  ];
  for (const [mode, hasReply, expected] of TRANSITIONS) {
    check(
      `activePreset(${String(mode)}, ${hasReply}) === ${expected}`,
      activePreset(mode, hasReply) === expected,
    );
  }

  // ===== normal 预设：完整区块 + 全部工具 =====
  const normal = PROMPT_PRESETS.normal;
  check('normal 核心身份含 Core Principles', normal.corePrompt.includes('## Core Principles'));
  check(
    'normal 区块顺序 = tool-usage / environment / agents-md',
    JSON.stringify(normal.sections.map((section) => section.key))
      === JSON.stringify(['tool-usage', 'environment', 'agents-md']),
  );
  check('normal 不限制工具', normal.toolNames === undefined);
  check(
    'normal 工具 = 全部',
    JSON.stringify(presetToolNames(normal.toolNames)) === JSON.stringify(allToolNames()),
  );

  // ===== minimal / mixed：单行核心身份 + 空区块 + Bash/Edit =====
  for (const id of ['minimal', 'mixed'] as const) {
    const preset = PROMPT_PRESETS[id];
    check(`${id} 核心身份只有一行`, preset.corePrompt === MINIMAL_CORE_PROMPT);
    check(`${id} 无附加区块`, preset.sections.length === 0);
    check(
      `${id} 工具白名单 = Bash / Edit`,
      JSON.stringify(preset.toolNames) === JSON.stringify(MINIMAL_TOOL_NAMES),
    );
    check(
      `${id} 过滤后工具 = Bash / Edit`,
      JSON.stringify(presetToolNames(preset.toolNames)) === JSON.stringify(MINIMAL_TOOL_NAMES),
    );
  }

  // ===== 预设解析：非法 / 缺省回退 normal =====
  check('getPromptPreset(undefined) 回退 normal', getPromptPreset(undefined).id === 'normal');
  check('getPromptPreset(bogus) 回退 normal', getPromptPreset('bogus').id === 'normal');
  check('getPromptPreset(minimal) 命中 minimal', getPromptPreset('minimal').id === 'minimal');
  check(
    'isPromptPresetId 白名单',
    isPromptPresetId('normal')
      && isPromptPresetId('minimal')
      && isPromptPresetId('mixed')
      && !isPromptPresetId('bogus'),
  );

  // ===== 组装：minimal 只有单行；normal 含三个区块 =====
  const cwd = process.cwd();
  const minimalPrompt = await assembleSystemPrompt(PROMPT_PRESETS.minimal, {
    tools: [],
    systemInfo: SYSTEM_INFO,
    cwd,
  });
  check('minimal 组装后 = 单行核心身份', minimalPrompt === MINIMAL_CORE_PROMPT);

  const normalTools = getAllTools() as Tool[];
  const normalPrompt = await assembleSystemPrompt(PROMPT_PRESETS.normal, {
    tools: normalTools,
    systemInfo: SYSTEM_INFO,
    cwd,
  });
  check(
    'normal 组装以核心身份开头',
    normalPrompt.startsWith('You are a helpful software engineer assistant.'),
  );
  check('normal 组装含 Tool Usage', normalPrompt.includes('## Tool Usage'));
  check('normal 组装含 Environment', normalPrompt.includes('## Environment'));

  finish();
}

runTests('prompt-preset-parity', run);
