/**
 * CommandDispatcher 单测（对照表版）：
 * 用例全部来自 fixtures/commandDispatchParity.json，Rust 侧 commands_tests.rs
 * 读同一张表（此前两侧各自手写用例，commands.rs 注释引用的对照表并不存在）。
 * 覆盖：
 * - "/<skill> 多行参数" 必须能匹配（此前用 .* 导致换行后整体判为 passthrough，
 *   Skill 命令退化成普通消息，只能靠 LLM 自己想起来调 Skill）。
 * - 参数拆分口径：第一个空白之前是命令名，其余（含换行）全部是参数。
 * - 非命令 / 空命令 / 未匹配命令仍走 passthrough。
 * - JS 空白口径（U+FEFF / U+0085）：prompt.trim() 必须与 Embedded 一致。
 * 运行方式：npm run test:all -- commandDispatch
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { dispatch } from '../core/CommandDispatcher';
import { makeTempDir } from './helpers/fixtures';
import { runTests } from './helpers/harness';

async function run(): Promise<void> {
  // 用空目录作为 cwd：只暴露内置 Skill，避免读到仓库自带的 .tuxedo-cat/skills
  const cwd = makeTempDir('dispatch');

  const fixturePath = path.resolve(__dirname, '../../../src/test/fixtures/commandDispatchParity.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as {
    cases: Array<{ input: string; result: string; skillName?: string; args?: string }>;
  };

  for (const c of fixture.cases) {
    const res = await dispatch(c.input, { sessionId: 'test-session', cwd });
    assert.equal(res.result, c.result, `result mismatch for ${JSON.stringify(c.input)}`);
    if (c.result === 'skill') {
      assert.equal(res.skillInfo?.skillName, c.skillName, `skillName for ${JSON.stringify(c.input)}`);
      assert.equal(res.skillInfo?.skillArgs, c.args, `args for ${JSON.stringify(c.input)}`);
    } else {
      assert.equal(res.skillInfo, undefined, `skillInfo should be absent for ${JSON.stringify(c.input)}`);
    }
  }
}

runTests('commandDispatch', run);