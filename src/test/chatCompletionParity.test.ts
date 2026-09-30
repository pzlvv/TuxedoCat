/**
 * OpenAI Chat Completions 消息转换对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/chatCompletionParity.json`：
 * - 本文件断言「对照表 == `convertMessagesToChatCompletions` 的真实输出」（防对照表腐化）；
 * - `core-rs/src/llm_tests.rs` 的 `chat_completion_parity_tests` 断言
 *   「`to_chat_messages` == 对照表」。
 *
 * 覆盖内部 Anthropic 风格消息 → Chat Completions 的关键分支：空串透传、
 * 纯文本数组压平成 `a\nb`、图片转 data URL、tool_result 压平为 tool 消息、
 * assistant tool_calls 的空文本 `content: null`、字符串 content、其它 role 透传。
 *
 * 运行方式：npm run test:all -- chat-completion-parity
 */

import * as path from 'path';
import * as fs from 'fs';
import {
  convertMessagesToChatCompletions,
  convertToolsToChatCompletionsFormat,
} from '../core/llm/OpenAiApi';
import { createChecker, runTests } from './helpers/harness';

interface MessageCase {
  name: string;
  input: Array<{ role: string; content: string | unknown[] }>;
  output: unknown[];
}

interface ToolCase {
  name: string;
  input: unknown[];
  output: unknown[];
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/chatCompletionParity.json');

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as {
    cases: MessageCase[];
    tools: ToolCase[];
  };
  check('对照表非空', fixture.cases.length > 0);
  check('工具对照表非空', fixture.tools.length > 0);

  for (const testCase of fixture.cases) {
    const actual = convertMessagesToChatCompletions(testCase.input);
    check(
      `${testCase.name}: 消息输出一致`,
      JSON.stringify(actual) === JSON.stringify(testCase.output),
    );
  }

  for (const testCase of fixture.tools) {
    const actual = convertToolsToChatCompletionsFormat(testCase.input);
    check(
      `${testCase.name}: 工具输出一致`,
      JSON.stringify(actual) === JSON.stringify(testCase.output),
    );
  }

  finish();
}

runTests('chat-completion-parity', run);
