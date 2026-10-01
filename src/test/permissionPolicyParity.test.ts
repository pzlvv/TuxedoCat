/**
 * 权限加工对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/permissionPolicyParity.json`：
 * - 本文件跑 Embedded 的 `resolveToolPermission`（真实工具实例的 `checkPermissions`）；
 * - `core-rs/src/permission_tests.rs::permission_policy_matches_the_embedded_fixture`
 *   跑 Standalone 的 `permission::resolve_tool_permission`。
 *
 * 逐字段比对 `permResult`（behavior / message / choices / Edit / Write 的 diff 字段 /
 * 默认工具与只读 Bash 的 updatedInput）与 `displayArgs`（路径展开、Write 预览字段、
 * Edit 的 old/new/replace_all 与 diff 字段）。路径用 `__CWD__` 占位。
 *
 * `displayArgs.diffHunks` 两侧比较前统一剔除：Standalone 不预计算该键，
 * webview 会用同一份 beforeContent / afterContent 调 `buildEditDiffHunks` 得到一致渲染。
 *
 * 运行方式：npm run test:all -- permission-policy-parity
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { resolveToolPermission, setSessionAgentMode } from '../core/tools/PermissionPolicy';
import { setSessionWorkspace } from '../core/history/Config';
import { BashTool } from '../core/tools/bash/Bash';
import { ReadTool } from '../core/tools/read/Read';
import { WriteTool } from '../core/tools/write/Write';
import { EditTool } from '../core/tools/edit/Edit';
import { AskUserQuestionTool } from '../core/tools/askuser/AskUserQuestion';
import { AgentTool } from '../core/tools/agent/AgentTool';
import { ReplyTool } from '../core/tools/agent/ReplyTool';
import { SkillTool } from '../core/tools/skill/SkillTool';
import type { Tool } from '../core/tools/Tool';
import type { AgentMode } from '../core/types';
import { createChecker, runTests } from './helpers/harness';

interface ParityCase {
  name: string;
  why: string;
  tool: string;
  /** 工具不存在（tool = null）：permResult 恒为 allow，displayArgs 仍按工具名展开 */
  noTool?: boolean;
  mode: AgentMode;
  /** 会话 id（缺省用 SESSION 常量）：Agent 的嵌套调用拒绝需要 `sub_` 前缀的会话 */
  sessionId?: string;
  files?: Record<string, string>;
  args: unknown;
  expectPermResult: Record<string, unknown>;
  expectDisplayArgs: Record<string, unknown>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/permissionPolicyParity.json');

const TOOLS: Record<string, Tool | undefined> = {
  Bash: BashTool,
  Read: ReadTool,
  Write: WriteTool,
  Edit: EditTool,
  AskUserQuestion: AskUserQuestionTool,
  Agent: AgentTool,
  Reply: ReplyTool,
  Skill: SkillTool,
};

const SESSION = 'permission-policy-parity';

/** 剔除 Standalone 有意省略的 diffHunks（渲染等价，见文件头注释） */
function stripDiffHunks(value: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete clone.diffHunks;
  return clone;
}

/** 把真实工作目录替换回 `__CWD__` 占位，便于与对照表直接比较 */
function replaceWorkspace(value: unknown, workspace: string): unknown {
  if (typeof value === 'string') {
    return value.split(workspace).join('__CWD__');
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceWorkspace(item, workspace));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceWorkspace(item, workspace);
    }
    return out;
  }
  return value;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: ParityCase[] };
  check('对照表非空', fixture.cases.length > 0);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-policy-parity-'));

  try {
    for (const testCase of fixture.cases) {
      // 每个用例前清空目录，避免上一条的文件残留
      for (const entry of fs.readdirSync(workspace)) {
        fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
      }
      for (const [relative, content] of Object.entries(testCase.files ?? {})) {
        const target = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      // 会话工作目录按会话登记（core 按会话解析目录的唯一来源）
      setSessionWorkspace(testCase.sessionId ?? SESSION, workspace);
      setSessionAgentMode(SESSION, testCase.mode);

      const { permResult, displayArgs } = await resolveToolPermission(
        testCase.sessionId ?? SESSION,
        testCase.tool,
        testCase.args as Record<string, unknown>,
        testCase.noTool ? undefined : TOOLS[testCase.tool],
      );

      const actualPerm = replaceWorkspace(permResult, workspace);
      const actualDisplay = replaceWorkspace(stripDiffHunks(displayArgs), workspace);
      const expectedPerm = replaceWorkspace(testCase.expectPermResult, workspace);
      const expectedDisplay = replaceWorkspace(stripDiffHunks(testCase.expectDisplayArgs), workspace);

      const permOk = JSON.stringify(actualPerm) === JSON.stringify(expectedPerm);
      const displayOk = JSON.stringify(actualDisplay) === JSON.stringify(expectedDisplay);
      const detail = [
        permOk ? '' : `permResult 实际 ${JSON.stringify(actualPerm)} / 期望 ${JSON.stringify(expectedPerm)}`,
        displayOk ? '' : `displayArgs 实际 ${JSON.stringify(actualDisplay)} / 期望 ${JSON.stringify(expectedDisplay)}`,
      ].filter(Boolean).join('；');
      check(
        `${testCase.name}（${testCase.why}）${detail ? `— ${detail}` : ''}`,
        permOk && displayOk,
      );
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  finish();
}

runTests('permission-policy-parity', run);
