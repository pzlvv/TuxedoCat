/**
 * 工具入参 schema 校验对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/toolInputValidation.json`：
 * - 本文件断言「对照表 == 真实 Zod `inputSchema.safeParse` 的输出」（防对照表腐化）；
 * - `core-rs/src/tools_tests.rs` 的 `tool_input_validation_parity_tests` 断言
 *   「`tool_input::parse_input` == 对照表」。
 *
 * 覆盖：strictObject 的多余字段、必填/类型错误、`coerce.number().int()...` 的
 * NaN/非整数/负数、`coerce.boolean`、enum、Todo 项的 min(1)/默认 status、
 * Edit `replace_all` 的 union + default。任一侧偏离都会失败。
 *
 * 运行方式：npm run test:all -- tool-input-validation-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReadTool } from '../core/tools/read/Read';
import { WriteTool } from '../core/tools/write/Write';
import { EditTool } from '../core/tools/edit/Edit';
import { BashTool } from '../core/tools/bash/Bash';
import { GlobTool } from '../core/tools/glob/Glob';
import { GrepTool } from '../core/tools/grep/Grep';
import { TodoWriteTool } from '../core/tools/todowrite/TodoWrite';
import { AskUserQuestionTool } from '../core/tools/askuser/AskUserQuestion';
import { AgentTool } from '../core/tools/agent/AgentTool';
import { ReplyTool } from '../core/tools/agent/ReplyTool';
import type { Tool } from '../core/tools/Tool';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  tool: string;
  input: unknown;
  error: string | null;
  parsed: unknown;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/toolInputValidation.json');

const TOOLS: Record<string, Tool> = {
  Read: ReadTool as unknown as Tool,
  Write: WriteTool as unknown as Tool,
  Edit: EditTool as unknown as Tool,
  Bash: BashTool as unknown as Tool,
  Glob: GlobTool as unknown as Tool,
  Grep: GrepTool as unknown as Tool,
  TodoWrite: TodoWriteTool as unknown as Tool,
  AskUserQuestion: AskUserQuestionTool as unknown as Tool,
  Agent: AgentTool as unknown as Tool,
  Reply: ReplyTool as unknown as Tool,
};

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const tool = TOOLS[testCase.tool];
    check(`${testCase.name}: 工具存在`, !!tool);
    if (!tool) continue;

    const result = tool.inputSchema.safeParse(testCase.input);
    if (testCase.error !== null) {
      check(`${testCase.name}: 校验失败`, !result.success);
      if (!result.success) {
        check(
          `${testCase.name}: 错误文案一致`,
          result.error.message === testCase.error,
        );
      }
    } else {
      check(`${testCase.name}: 校验通过`, result.success);
      if (result.success) {
        check(
          `${testCase.name}: 规范化数据一致`,
          JSON.stringify(result.data) === JSON.stringify(testCase.parsed),
        );
      }
    }
  }

  finish();
}

runTests('tool-input-validation-parity', run);
