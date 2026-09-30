/**
 * OpenAI Responses API 对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/responsesParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `llm/ResponsesApi.ts` 转换纯函数」；
 * - `core-rs/src/responses_tests.rs` 的 `parity_tests` 断言「Rust `responses::*` == 对照表」。
 *
 * 覆盖：请求 URL、工具转换、消息 → input items、status 映射、usage 提取、
 * 本地输入估算、usage 可信度、`response.output` → 内容块校准。
 * SSE 事件循环本身由 Rust 侧假 LLM 端到端用例覆盖。
 *
 * 运行方式：npm run test:all -- responses-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildResponsesUrl,
  convertMessagesToResponsesInput,
  convertToolsToResponsesFormat,
  estimateLocalInputTokens,
  extractUsage,
  mapResponsesStatus,
  shouldSkipUsageForContext,
  syncContentBlocksFromOutput,
} from '../core/llm/ResponsesApi';
import { createChecker, runTests } from './helpers/harness';

interface Fixture {
  urls: Array<{ baseURL: string; result: string }>;
  tools: Array<{ input: unknown[]; result: unknown[] }>;
  messages: Array<{ name: string; input: unknown[]; result: unknown[] }>;
  statuses: Array<{ status: string | null; reason: string | null; result: string }>;
  usages: Array<{ input: unknown; result: unknown }>;
  estimates: Array<{ name: string; input: unknown[]; system: string | null; tools: unknown[]; result: number }>;
  skipUsage: Array<{
    webSearchUsed: boolean;
    inputTokens: number;
    localInputEstimate: number;
    contextWindow: number;
    result: { skip: boolean; reason: string };
  }>;
  syncOutput: Array<{ name: string; output: unknown; result: unknown[] }>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/responsesParity.json');

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.urls.length > 0 && fixture.messages.length > 0);

  for (const item of fixture.urls) {
    check(
      `buildResponsesUrl: ${item.baseURL}`,
      buildResponsesUrl(item.baseURL) === item.result,
    );
  }

  for (const item of fixture.tools) {
    check(
      `convertToolsToResponsesFormat: ${item.input.length} 个工具`,
      JSON.stringify(convertToolsToResponsesFormat(item.input)) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.messages) {
    check(
      `convertMessagesToResponsesInput: ${item.name}`,
      JSON.stringify(convertMessagesToResponsesInput(item.input as never)) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.statuses) {
    check(
      `mapResponsesStatus: ${item.status}/${item.reason}`,
      mapResponsesStatus(item.status ?? undefined, item.reason ? { reason: item.reason } : undefined)
        === item.result,
    );
  }

  for (const item of fixture.usages) {
    check(
      `extractUsage: ${JSON.stringify(item.input)}`,
      JSON.stringify(extractUsage(item.input as never) ?? null) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.estimates) {
    check(
      `estimateLocalInputTokens: ${item.name}`,
      estimateLocalInputTokens(item.input, item.system ?? undefined, item.tools) === item.result,
    );
  }

  for (const item of fixture.skipUsage) {
    check(
      `shouldSkipUsageForContext: input=${item.inputTokens} window=${item.contextWindow}`,
      shouldSkipUsageForContext({
        webSearchUsed: item.webSearchUsed,
        inputTokens: item.inputTokens,
        localInputEstimate: item.localInputEstimate,
        contextWindow: item.contextWindow,
      }).skip === item.result.skip,
    );
  }

  for (const item of fixture.syncOutput) {
    const blocks: unknown[] = [];
    syncContentBlocksFromOutput(blocks, item.output as never);
    check(
      `syncContentBlocksFromOutput: ${item.name}`,
      JSON.stringify(blocks) === JSON.stringify(item.result),
    );
  }

  finish();
}

runTests('responses-parity', run);
