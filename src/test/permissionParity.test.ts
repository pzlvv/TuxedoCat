/**
 * 权限决策对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/permissionParity.json`：
 * - 本文件跑 Embedded 的 `resolveToolPermission`（真实工具实例的 `checkPermissions`）；
 * - `core-rs/src/permission.rs` 的单测跑 Standalone 的 `permission::decide`。
 *
 * 任一侧偏离对照表都会失败，从而保证「同一个 agentMode + 同一段命令 → 同一个决策」。
 *
 * 运行方式：npm run test:all -- permission-parity
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { resolveToolPermission, setSessionAgentMode } from '../core/tools/PermissionPolicy';
import { setSessionWorkspace } from '../core/history/Config';
import { BashTool } from '../core/tools/bash/Bash';
import { ReadTool } from '../core/tools/read/Read';
import { GrepTool } from '../core/tools/grep/Grep';
import { GlobTool } from '../core/tools/glob/Glob';
import { TodoWriteTool } from '../core/tools/todowrite/TodoWrite';
import { WriteTool } from '../core/tools/write/Write';
import { EditTool } from '../core/tools/edit/Edit';
import { AskUserQuestionTool } from '../core/tools/askuser/AskUserQuestion';
import type { Tool } from '../core/tools/Tool';
import type { AgentMode } from '../core/types';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  tool: string;
  mode: AgentMode;
  args: Record<string, unknown>;
  expect: 'allow' | 'ask' | 'deny';
  why: string;
  /** 该用例运行前写入会话工作目录的文件（Edit 的 old_string 匹配校验需要真实文件） */
  files?: Record<string, string>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/permissionParity.json');

const TOOLS: Record<string, Tool | undefined> = {
  Bash: BashTool,
  Read: ReadTool,
  Grep: GrepTool,
  Glob: GlobTool,
  TodoWrite: TodoWriteTool,
  Write: WriteTool,
  Edit: EditTool,
  AskUserQuestion: AskUserQuestionTool,
};

const SESSION = 'parity-session';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  // `resolveToolPermission` 会读会话工作目录；给一个存在的临时目录
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-parity-'));
  setSessionWorkspace(SESSION, workspace);

  try {
    for (const testCase of fixture.cases) {
      const tool = TOOLS[testCase.tool];
      // 用例自带的文件先落到会话工作目录（每个用例都重写，避免上一条内容残留）
      for (const [relative, content] of Object.entries(testCase.files ?? {})) {
        const target = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      setSessionAgentMode(SESSION, testCase.mode);
      const { permResult } = await resolveToolPermission(
        SESSION,
        testCase.tool,
        testCase.args,
        tool,
      );
      const label = `${testCase.tool} @${testCase.mode} ${JSON.stringify(testCase.args)} → ${testCase.expect}`;
      check(
        `${label}（${permResult.behavior === testCase.expect ? '一致' : `实际 ${permResult.behavior}`}；${testCase.why}）`,
        permResult.behavior === testCase.expect,
      );
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  finish();
}

runTests('permission-parity', run);
