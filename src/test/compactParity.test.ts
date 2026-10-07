/**
 * 对话压缩对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/compactParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `compact/prompt.ts` / `compact/types.ts` /
 *   `compact/compact.ts` / `utils/replayMessages.ts`」；
 * - `core-rs/src/compact_tests.rs` 与 `replay_tests.rs` 断言「Rust `compact::*` /
 *   `replay::*` == 对照表」。
 *
 * 只覆盖**纯函数**：提示词拼装、用户输入历史（条目提取 / 格式化 / 跨多次压缩的全局选择 /
 * 读取摘要持久化历史）、阈值、可压缩判定、压缩后消息组装、历史消息 → UI 消息的转换。
 * 真正跑 LLM 的压缩流程由 Rust 侧假 LLM 单测覆盖。
 *
 * 运行方式：npm run test:all -- compact-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  formatMessagesForCompact,
  formatUserInputHistory,
  formatUserInputEntries,
  generateCompactSummaryPrompt,
  generateCompactUserMessage,
  getUserInputHistory,
  readCompactUserInputHistory,
  selectUserInputHistory,
  toUserInputEntries,
} from '../core/compact/prompt';
import { getAutoCompactThreshold } from '../core/compact/types';
import { buildPostCompactMessages, hasCompactableMessages } from '../core/compact/compact';
import type { CompactionResult } from '../core/compact/types';
import { buildReplayMessageData } from '../core/utils/replayMessages';
import type { Message, UserInputHistoryEntry } from '../core/types';
import { createChecker, runTests } from './helpers/harness';

interface Fixture {
  formatted: Array<{ name: string; messages: unknown[]; result: string }>;
  userHistory: Array<{ name: string; messages: unknown[]; history: unknown[]; result: string }>;
  userInputEntries: Array<{ name: string; messages: unknown[]; result: UserInputHistoryEntry[] }>;
  userInputEntryFormatting: Array<{ name: string; entries: UserInputHistoryEntry[]; result: string }>;
  userInputHistorySelection: Array<{
    name: string;
    previous: UserInputHistoryEntry[];
    regionInputs: UserInputHistoryEntry[];
    result: UserInputHistoryEntry[];
  }>;
  compactUserInputHistory: Array<{ name: string; messages: unknown[]; result: UserInputHistoryEntry[] }>;
  summaryPrompts: Array<{ name: string; messages: unknown[]; custom: string | null; result: string }>;
  compactUserMessages: Array<{
    name: string;
    summary: string;
    transcriptPath: string | null;
    userInputHistory: string | null;
    result: string;
  }>;
  thresholds: Array<{ contextWindow: number; maxOutputTokens: number; result: number }>;
  compactable: Array<{ name: string; messages: unknown[]; keep: number; result: boolean }>;
  postCompact: Array<{ name: string; result: CompactionResult; messages: unknown[] }>;
  replay: Array<{ name: string; messages: unknown[]; result: unknown[] }>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/compactParity.json');

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.formatted.length > 0 && fixture.thresholds.length > 0);

  for (const item of fixture.formatted) {
    check(
      `formatMessagesForCompact: ${item.name}`,
      formatMessagesForCompact(item.messages as never) === item.result,
    );
  }

  for (const item of fixture.userHistory) {
    const history = getUserInputHistory(item.messages as never);
    check(
      `getUserInputHistory: ${item.name}`,
      JSON.stringify(history) === JSON.stringify(item.history)
        && formatUserInputHistory(history) === item.result,
    );
  }

  for (const item of fixture.userInputEntries) {
    check(
      `toUserInputEntries: ${item.name}`,
      JSON.stringify(toUserInputEntries(getUserInputHistory(item.messages as never)))
        === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.userInputEntryFormatting) {
    check(
      `formatUserInputEntries: ${item.name}`,
      formatUserInputEntries(item.entries) === item.result,
    );
  }

  for (const item of fixture.userInputHistorySelection) {
    check(
      `selectUserInputHistory: ${item.name}`,
      JSON.stringify(selectUserInputHistory(item.previous, item.regionInputs))
        === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.compactUserInputHistory) {
    check(
      `readCompactUserInputHistory: ${item.name}`,
      JSON.stringify(readCompactUserInputHistory(item.messages as Message[]))
        === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.summaryPrompts) {
    check(
      `generateCompactSummaryPrompt: ${item.name}`,
      generateCompactSummaryPrompt(item.messages as never, item.custom ?? undefined) === item.result,
    );
  }

  for (const item of fixture.compactUserMessages) {
    check(
      `generateCompactUserMessage: ${item.name}`,
      generateCompactUserMessage(
        item.summary,
        item.transcriptPath ?? undefined,
        item.userInputHistory ?? undefined,
      ) === item.result,
    );
  }

  for (const item of fixture.thresholds) {
    check(
      `getAutoCompactThreshold: ${item.contextWindow}/${item.maxOutputTokens}`,
      getAutoCompactThreshold(item.contextWindow, item.maxOutputTokens) === item.result,
    );
  }

  for (const item of fixture.compactable) {
    check(
      `hasCompactableMessages: ${item.name}`,
      hasCompactableMessages(item.messages as never, item.keep) === item.result,
    );
  }

  for (const item of fixture.postCompact) {
    check(
      `buildPostCompactMessages: ${item.name}`,
      JSON.stringify(buildPostCompactMessages(item.result)) === JSON.stringify(item.messages),
    );
  }

  for (const item of fixture.replay) {
    check(
      `buildReplayMessageData: ${item.name}`,
      JSON.stringify(buildReplayMessageData(item.messages as Message[])) === JSON.stringify(item.result),
    );
  }

  finish();
}

runTests('compact-parity', run);
