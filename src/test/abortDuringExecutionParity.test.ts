/**
 * 对等测试：工具「执行中才被中止」的收尾（Embedded ↔ Standalone）。
 *
 * Embedded `RunTools.executeSingleItem` 在执行**完成后**再查一次 abort 信号：
 * 已中止时产出的 tool_result 带 `Command was interrupted`，并置
 * `shouldPreventContinuation`（`Query.ts` 据此上报 `*User Interrupted*`、不再回到 LLM）。
 * `drainStartedItems` 的 `hasAborted` 分支同理（并发安全工具批）。
 *
 * Standalone 侧同一行为由 `core-rs/src/engine.rs` 的 run_query_loop 实现
 * （串行路径在 `emit_tool_outcome` 之后、并发批在 `flush_pending_batch` 之后各补一次
 * cancel 判定），对应用例 `core-rs/src/engine_tests.rs` 的
 * `abort_during_tool_execution_reports_interruption`。
 *
 * 运行方式：npm run test:all -- abort-during-execution-parity
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
  const root = makeTempDir('abort-during-execution-parity');
  setSessionWorkspace('s1', root);
  // auto：Bash 的非只读命令直接放行，不再弹确认框（本用例只关心 abort 分支）
  setSessionAgentMode('s1', 'auto');

  try {
    const controller = new AbortController();
    const marker = path.join(root, 'started.marker');
    const updates: Array<Record<string, unknown>> = [];

    const consume = (async () => {
      for await (const update of runTools(
        's1',
        [
          {
            id: 'call_1',
            name: 'Bash',
            // 先建标记文件证明工具已开跑，再长睡等待 abort（cwd 即 workspace）
            input: { command: 'touch started.marker && sleep 30' },
          },
        ],
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
    })();

    // 等工具真的开始执行再中止，确保命中「执行中到达」的窗口
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    check('工具已开始执行', fs.existsSync(marker));
    controller.abort();
    await consume;

    const messages = updates
      .map((update) => update.message)
      .filter((message): message is Record<string, unknown> => !!message);
    check('只产出一条 tool_result 消息', messages.length === 1);
    const block = (messages[0] as { message: { content: Array<Record<string, unknown>> } })
      .message.content[0];
    check(
      '文案含 Command was interrupted',
      typeof block.content === 'string' && block.content.includes('Command was interrupted'),
    );
    check(
      'shouldPreventContinuation 为真',
      updates.some((update) => update.shouldPreventContinuation === true),
    );

    const toolResult = testBus.received('toolResult')[0];
    check('UI 收到 error 状态的 toolResult', toolResult?.status === 'error');
    check(
      'UI 文案含 Command was interrupted',
      typeof toolResult?.output === 'string' && toolResult.output.includes('Command was interrupted'),
    );
  } finally {
    resetGlobalEventBus();
    finish();
  }
}

runTests('abort-during-execution-parity', run);
