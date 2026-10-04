/**
 * 单测：会话级 MCP 启用列表（Embedded `core/mcp/Config.ts`）。
 *
 * 覆盖两层启用状态与两个写入入口：
 * - 生效值 = 会话覆盖优先，其次全局默认（`settings.json` 的 `mcp.enabled`）；
 * - `setSessionMcpEnabled`（输入框菜单的单开关，增量合并）；
 * - `setSessionMcpEnabledList`（整表覆盖，宿主保存默认配置前用来钉住当前对话）。
 *
 * 与 Rust 侧 `main_tests::session_config_events_are_dispatched` 的
 * `mcpEnabledListChanged` 断言同口径（`docs/core-ui-separation.md` 第 4 节）。
 *
 * 运行方式：npm run test:all -- mcpSessionEnabled
 */

import { applyTestSettings } from './helpers/fixtures';
import { createChecker, runTests } from './helpers/harness';
import {
  clearSessionMcpOverride,
  readEnabledMcps,
  readSessionEnabledMcps,
  setSessionMcpEnabled,
  setSessionMcpEnabledList,
} from '../core/mcp/Config';

/** 列表比较：顺序有意义（去重后保留首次出现顺序） */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  // 全局默认启用 a / b；未设置过覆盖的会话回退到它
  applyTestSettings({ mcp: { enabled: ['a', 'b'] } });

  const sessionId = 'mcp-session-enabled-test';
  clearSessionMcpOverride(sessionId);

  check('未设置过覆盖时回退全局默认', sameList(await readEnabledMcps(sessionId), ['a', 'b']));
  check('未设置过覆盖时读到 null（区别于「显式空列表」）', (await readSessionEnabledMcps(sessionId)) === null);

  await setSessionMcpEnabled(sessionId, 'c', true);
  check('单开关从当前生效值增量合并', sameList(await readEnabledMcps(sessionId), ['a', 'b', 'c']));

  await setSessionMcpEnabledList(sessionId, ['b', 'a', 'b', '']);
  check('整表覆盖去重并保留首次出现顺序', sameList(await readEnabledMcps(sessionId), ['b', 'a']));

  await setSessionMcpEnabledList(sessionId, []);
  check('空列表 = 显式「该会话全部禁用」', sameList(await readEnabledMcps(sessionId), []));

  await setSessionMcpEnabledList(sessionId, ['a', 'a']);
  check('整表覆盖后会话覆盖不再是 null', sameList((await readSessionEnabledMcps(sessionId)) ?? ['<null>'], ['a']));

  clearSessionMcpOverride(sessionId);
  check('清掉覆盖后重新回退全局默认', sameList(await readEnabledMcps(sessionId), ['a', 'b']));

  finish();
}

runTests('mcpSessionEnabled', run);
