/**
 * CommandDispatcher 单测：
 * - "/<skill> 多行参数" 必须能匹配（此前用 `.*` 导致换行后整体判为 passthrough，
 *   Skill 命令退化成普通消息，只能靠 LLM 自己想起来调 Skill）。
 * - 参数拆分口径：第一个空白之前是命令名，其余（含换行）全部是参数。
 * - 非命令 / 空命令 / 未匹配命令仍走 passthrough。
 * 运行方式：npm run test:all -- command-dispatch
 */

import * as assert from 'assert';
import { dispatch } from '../core/CommandDispatcher';
import { makeTempDir } from './helpers/fixtures';
import { runTests } from './helpers/harness';

async function run(): Promise<void> {
  // 用空目录作为 cwd：只暴露内置 Skill，避免读到仓库自带的 .tuxedo-cat/skills
  const cwd = makeTempDir('dispatch');

  const cases: Array<{ input: string; result: string; skillName?: string; args?: string }> = [
    { input: '/commit', result: 'skill', skillName: 'commit', args: '' },
    { input: '/commit 修复登录问题', result: 'skill', skillName: 'commit', args: '修复登录问题' },
    {
      input: '/commit 修复 A\n再修 B',
      result: 'skill',
      skillName: 'commit',
      args: '修复 A\n再修 B',
    },
    { input: '/commit\nfoo', result: 'skill', skillName: 'commit', args: 'foo' },
    { input: '  /commit  多行\n第二行  ', result: 'skill', skillName: 'commit', args: '多行\n第二行' },
    // 未匹配任何 Skill/内置命令：保持 passthrough（交由 LLM 正常处理）
    { input: '/not-a-skill 多行\n参数', result: 'passthrough' },
    { input: '/', result: 'passthrough' },
    { input: '普通消息', result: 'passthrough' },
    { input: '/usr/bin/env', result: 'passthrough' },
    // JS 空白口径（U+FEFF / U+0085）：`prompt.trim()` 必须与 Embedded 一致
    { input: '\uFEFF/commit', result: 'skill', skillName: 'commit', args: '' },
    { input: '\uFEFF/commit \uFEFF修复', result: 'skill', skillName: 'commit', args: '修复' },
    { input: '/commit\uFEFF', result: 'skill', skillName: 'commit', args: '' },
    { input: '\u0085/commit', result: 'passthrough' },
    { input: '\uFEFF\u0085/commit', result: 'passthrough' },
  ];

  for (const c of cases) {
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
