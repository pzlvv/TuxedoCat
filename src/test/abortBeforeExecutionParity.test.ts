/**
 * 对等测试：工具「执行前已中止」的收尾（Embedded ↔ Standalone）。
 *
 * Embedded `executeSingleItem` / `executeParallelBatch` 在执行前检查 abort 信号：
 * 已中止时**不执行**工具，直接产出一条
 * `Command was aborted before execution`（`exit_code: -1`、`is_canceled: true`）的
 * tool_result，并置 `shouldPreventContinuation`（不再回到 LLM 要下一轮）。
 *
 * Standalone 侧同一行为由 `core-rs/src/engine.rs` 的 run_query_loop 实现，
 * 对应用例 `core-rs/src/engine_tests.rs` 的
 * `abort_during_the_tool_loop_skips_the_next_llm_round`。
 *
 * 运行方式：npm run test:all -- abort-before-execution-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeTestBus, makeTempDir } from './helpers/fixtures';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { setSessionWorkspace } from '../core/history/Config';
import { setSessionAgentMode } from '../core/tools/PermissionPolicy';
import { runTools } from '../core/tools/RunTools';
import { createChecker, runTests } from './helpers/harness';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const testBus = makeTestBus();
  setGlobalEventBus(testBus.bus);
  const root = makeTempDir('abort-before-execution-parity');
  setSessionWorkspace('s1', root);
  // auto：Bash 的非只读命令直接放行，不再弹确认框（本用例只关心 abort 分支）
  setSessionAgentMode('s1', 'auto');

  try {
    const controller = new AbortController();
    controller.abort();
    const updates: Array<Record<string, unknown>> = [];
    for await (const update of runTools(
      's1',
      [{ id: 'call_1', name: 'Bash', input: { command: 'touch should-not-run' } }],
      {
        abortController: controller,
        cwd: root,
        getAppState: () => ({}),
        setAppState: () => undefined,
        messages: [],
        sessionId: 's1',
      } as never,
    )) {
      updates.push(update as unknown as Record<string, unknown>);
    }

    const messages = updates
      .map((update) => update.message)
      .filter((message): message is Record<string, unknown> => !!message);
    check('只产出一条 tool_result 消息', messages.length === 1);
    const block = (messages[0] as { message: { content: Array<Record<string, unknown>> } })
      .message.content[0];
    check(
      '文案为 Command was aborted before execution',
      block.content === 'Command was aborted before execution',
    );
    check('exit_code 为 -1', block.exit_code === -1);
    check('is_canceled 为 true', block.is_canceled === true);
    check('工具没有真的执行', !fs.existsSync(path.join(root, 'should-not-run')));
    check(
      'shouldPreventContinuation 为真',
      updates.some((update) => update.shouldPreventContinuation === true),
    );

    const toolResult = testBus.received('toolResult')[0];
    check('UI 收到 error 状态的 toolResult', toolResult?.status === 'error');
    check(
      'UI 文案与落盘一致',
      toolResult?.output === 'Command was aborted before execution',
    );
  } finally {
    resetGlobalEventBus();
    finish();
  }
}

runTests('abort-before-execution-parity', run);
