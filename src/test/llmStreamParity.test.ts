/**
 * LLM 流式重试 / 退化重复 / 上下文余量对等测试（Embedded ↔ Standalone）。
 *
 * 本文件断言 Embedded 侧（真值）的以下口径，Standalone 侧在
 * `core-rs/src/llm_tests.rs` 与 `core-rs/src/util_tests.rs` 用同名用例断言同一张表：
 * - `repetitionDetector.ts` 的退化重复判定（尾窗 + 反转串 Z 函数）；
 * - `shared.ts` 的重试常量与可重试状态码集合；
 * - 请求体 `thinking_token_budget` 恒取模型注册表的 192K；
 * - `getAvailableOutputTokens` 的上下文余量钳制；
 * - `tokenEstimate.ts` 的估算表。
 *
 * 任一侧偏离即失败。
 *
 * 运行方式：npm run test:all -- llm-stream-parity
 */

import {
  RepetitionDetector,
  LLMRepetitionError,
  DEFAULT_REPETITION_WINDOW,
  DEFAULT_REPETITION_MIN_REPEATS,
  DEFAULT_REPETITION_MIN_SPAN,
  DEFAULT_REPETITION_MIN_CHECK_LENGTH,
  DEFAULT_REPETITION_CHECK_INTERVAL,
  DEFAULT_MAX_REPETITION_RETRIES,
} from '../core/llm/repetitionDetector';
import { RETRY_DELAY_MS, MAX_RETRIES, isRetryableStatus } from '../core/llm/shared';
import { FALLBACK_MODEL_PARAMS, getModelConfig } from '../core/utils/modelConfig';
import { availableOutputTokens } from '../core/llm/modelLimits';
import type { ModelLimits } from '../core/settingsSnapshot';
import { estimateRequestTokens, estimateTextTokens } from '../core/utils/tokenEstimate';
import { createChecker, runTests } from './helpers/harness';

interface Hit {
  unitLength: number;
  repeatCount: number;
  spanLength: number;
  unitPreview: string;
  totalLength: number;
}

function feed(chunks: readonly string[]): Hit | null {
  const detector = new RepetitionDetector();
  for (const chunk of chunks) {
    const hit = detector.append(chunk);
    if (hit) return hit as Hit;
  }
  return null;
}

/** 与 `core-rs/src/llm_tests.rs::repetition_detector_matches_embedded_table` 同表 */
const REPETITION_CASES: Array<{ name: string; chunks: string[]; expected: Hit | null }> = [
  {
    name: '单字符重复',
    chunks: ['a'.repeat(6000)],
    expected: { unitLength: 1, repeatCount: 6000, spanLength: 6000, unitPreview: 'a', totalLength: 6000 },
  },
  {
    name: '短语重复',
    chunks: ['hello world '.repeat(500)],
    expected: { unitLength: 12, repeatCount: 500, spanLength: 6000, unitPreview: 'hello world ', totalLength: 6000 },
  },
  { name: '低于 minCheckLength 不检测', chunks: ['a'.repeat(4000)], expected: null },
  { name: '低于 minCheckLength 不检测（abc）', chunks: ['abc'.repeat(1000)], expected: null },
  {
    name: '长短语重复',
    chunks: ["I'll check the file. ".repeat(300)],
    expected: { unitLength: 21, repeatCount: 300, spanLength: 6300, unitPreview: "I'll check the file. ", totalLength: 6300 },
  },
  {
    name: '换行重复',
    chunks: ['\n\n'.repeat(3000)],
    expected: { unitLength: 1, repeatCount: 6000, spanLength: 6000, unitPreview: '\n', totalLength: 6000 },
  },
  {
    name: '循环前混入正常内容只比尾部窗口',
    chunks: ['hello world '.repeat(300) + 'ab'.repeat(3000)],
    expected: { unitLength: 2, repeatCount: 3000, spanLength: 6000, unitPreview: 'ab', totalLength: 9600 },
  },
  {
    name: '代理对按 UTF-16 code unit 计',
    chunks: ['😀'.repeat(3000)],
    expected: { unitLength: 2, repeatCount: 3000, spanLength: 6000, unitPreview: '😀', totalLength: 6000 },
  },
  {
    name: '逐字符喂入在累计 5000 字符时命中',
    chunks: Array.from({ length: 6000 }, () => 'a'),
    expected: { unitLength: 1, repeatCount: 5000, spanLength: 5000, unitPreview: 'a', totalLength: 5000 },
  },
];

/** 与 `core-rs/src/util_tests.rs::estimate_text_tokens_matches_embedded_table` 同表 */
const TEXT_TOKEN_CASES: Array<[string, number]> = [
  ['', 0],
  ['abc', 1],
  ['hello world', 4],
  ['你好世界', 5],
  ['こんにちは', 6],
  ['a你b好c', 4],
  ['，。！？', 5],
  ['日本語のテキストです', 12],
  ['你你你你你你你你你你', 12],
  ['x'.repeat(100), 34],
];

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ===== 退化重复判定 =====
  for (const testCase of REPETITION_CASES) {
    const hit = feed(testCase.chunks);
    if (testCase.expected === null) {
      check(`repetition:${testCase.name} 不命中`, hit === null);
    } else {
      check(
        `repetition:${testCase.name} 命中 ${JSON.stringify(testCase.expected)}`,
        hit !== null
          && hit.unitLength === testCase.expected.unitLength
          && hit.repeatCount === testCase.expected.repeatCount
          && hit.spanLength === testCase.expected.spanLength
          && hit.unitPreview === testCase.expected.unitPreview
          && hit.totalLength === testCase.expected.totalLength,
      );
    }
  }

  // 常量
  check('DEFAULT_REPETITION_WINDOW', DEFAULT_REPETITION_WINDOW === 16_384);
  check('DEFAULT_REPETITION_MIN_REPEATS', DEFAULT_REPETITION_MIN_REPEATS === 50);
  check('DEFAULT_REPETITION_MIN_SPAN', DEFAULT_REPETITION_MIN_SPAN === 200);
  check('DEFAULT_REPETITION_MIN_CHECK_LENGTH', DEFAULT_REPETITION_MIN_CHECK_LENGTH === 5_000);
  check('DEFAULT_REPETITION_CHECK_INTERVAL', DEFAULT_REPETITION_CHECK_INTERVAL === 128);
  check('DEFAULT_MAX_REPETITION_RETRIES', DEFAULT_MAX_REPETITION_RETRIES === 1);

  // 错误文案（与 Rust `repetition_error_message_matches_embedded_wording` 同字）
  {
    const detector = new RepetitionDetector();
    const hit = detector.append('a'.repeat(6000));
    let message = '';
    try {
      if (hit) throw new LLMRepetitionError('text', hit);
    } catch (err) {
      message = (err as Error).message;
    }
    check(
      'LLMRepetitionError 文案',
      message === '检测到模型循环输出：正文中长度 1 的片段连续重复 6000 次（共 6000 字符），判定为服务端异常',
    );
  }

  // ===== 重试常量与状态码集合 =====
  check('RETRY_DELAY_MS', RETRY_DELAY_MS === 1000);
  check('MAX_RETRIES', MAX_RETRIES === 3);
  check('isRetryableStatus(502)', isRetryableStatus(502));
  check('isRetryableStatus(503)', isRetryableStatus(503));
  check('isRetryableStatus(500) === false', !isRetryableStatus(500));
  check('isRetryableStatus(400) === false', !isRetryableStatus(400));
  check('isRetryableStatus(429) === false', !isRetryableStatus(429));

  // ===== thinking_token_budget 恒取注册表 192K =====
  check('FALLBACK thinking_token_budget === 192K', FALLBACK_MODEL_PARAMS.thinking_token_budget === 192 * 1024);
  check(
    'getModelConfig(未命中模型).thinking_token_budget === 192K',
    getModelConfig('unknown-model').thinking_token_budget === 192 * 1024,
  );
  check(
    'getModelConfig(deepseek-v4-pro).thinking_token_budget === 192K',
    getModelConfig('deepseek-v4-pro').thinking_token_budget === 192 * 1024,
  );

  // ===== 上下文余量钳制 =====
  // 限值改由配置快照提供：这里直接构造 ModelLimits，锁定派生逻辑本身
  const bigLimits: ModelLimits = {
    context: FALLBACK_MODEL_PARAMS.contextWindow,
    output: FALLBACK_MODEL_PARAMS.maxOutputTokens,
    apiType: 'OpenAI',
    thinkingTokenBudget: FALLBACK_MODEL_PARAMS.thinking_token_budget,
  };
  check(
    'availableOutputTokens 上下文充足',
    availableOutputTokens(bigLimits, bigLimits, 1000) === 384 * 1024,
  );
  check(
    'availableOutputTokens 剩余空间不足',
    availableOutputTokens(bigLimits, bigLimits, 1024 * 1024 - 100) === 100,
  );
  check(
    'availableOutputTokens 超窗取下限 1',
    availableOutputTokens(bigLimits, bigLimits, 1024 * 1024 + 10) === 1,
  );
  check(
    'availableOutputTokens 用限值的 context',
    availableOutputTokens({ ...bigLimits, context: 1000, output: 4096 }, bigLimits, 900) === 100,
  );

  // ===== token 估算表 =====
  for (const [text, expected] of TEXT_TOKEN_CASES) {
    check(`estimateTextTokens(${JSON.stringify(text.slice(0, 12))}) === ${expected}`, estimateTextTokens(text) === expected);
  }
  check(
    'estimateRequestTokens 基础表',
    estimateRequestTokens({
      messages: [{ role: 'user', content: '你好' }],
      systemPrompt: 'sys',
      tools: [{ name: 't' }],
    }) === 19,
  );
  check(
    'estimateRequestTokens Anthropic 内联图片',
    estimateRequestTokens({
      messages: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(2000) } }],
      systemPrompt: '',
      tools: [],
    }) === 1519,
  );
  check(
    'estimateRequestTokens OpenAI image_url 嵌套对象不替换',
    estimateRequestTokens({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'B'.repeat(3000)}` } }] }],
    }) === 1032,
  );
  check('estimateRequestTokens 空输入', estimateRequestTokens({ systemPrompt: 'abc' }) === 1);

  finish();
}

runTests('llmStreamParity', run);
