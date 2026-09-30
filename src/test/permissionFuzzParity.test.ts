/**
 * Bash 权限决策随机对等测试（Embedded ↔ Standalone）。
 *
 * 对照表由 `scripts/gen-permission-fuzz-parity.mjs` 用固定种子生成，两侧共用：
 * - 本文件断言「对照表 == Embedded `resolveToolPermission`」；
 * - `core-rs/src/permission_tests.rs` 的 `fuzz_parity_tests` 断言
 *   「Standalone `permission::decide` == 对照表」。
 *
 * 与 `permissionParity.json` 的人工用例互补：这里覆盖命令分词 / 引号 / 转义 /
 * `$(...)` / 环境变量前缀 / 多词只读命令 / 破坏性命令 / JS 空白字符的组合空间。
 *
 * 运行方式：npm run test:all -- permission-fuzz-parity
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveToolPermission, setSessionAgentMode } from '../core/tools/PermissionPolicy';
import { setSessionWorkspace } from '../core/history/Config';
import { BashTool } from '../core/tools/bash/Bash';
import type { AgentMode } from '../core/types';
import { createChecker, runTests } from './helpers/harness';

interface FuzzCase {
  mode: AgentMode;
  args: { command: string };
  expect: 'allow' | 'ask' | 'deny' | string;
  why: string;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/permissionFuzzParity.json');
const SESSION = 'permission-fuzz-session';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { cases: FuzzCase[] };
  check('对照表非空', fixture.cases.length > 0);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-fuzz-parity-'));
  setSessionWorkspace(SESSION, workspace);

  let failures = 0;
  try {
    for (const testCase of fixture.cases) {
      setSessionAgentMode(SESSION, testCase.mode);
      let actual: string;
      try {
        const { permResult } = await resolveToolPermission(SESSION, 'Bash', testCase.args, BashTool);
        actual = permResult.behavior;
      } catch (error) {
        actual = `ERROR: ${(error as Error).message}`;
      }
      if (actual !== testCase.expect) {
        failures += 1;
        if (failures <= 10) {
          console.log(
            `     ${testCase.mode} ${JSON.stringify(testCase.args.command)} → ${actual}（期望 ${testCase.expect}）`,
          );
        }
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  check(`${fixture.cases.length} 条随机用例全部一致`, failures === 0);
  finish();
}

runTests('permission-fuzz-parity', run);
