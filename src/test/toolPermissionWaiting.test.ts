import fs from 'node:fs';
import path from 'node:path';
import { createChecker, runTests } from './helpers/harness';
import { applyTestSettings } from './helpers/fixtures';
import { startScenario, textRound, toolUseRound } from './helpers/scenario';

/**
 * 权限往返期间的 `waiting`（缺陷规格 `specs/009-standalone-tool-permission-waiting/` 的 RT-3）。
 *
 * Embedded 侧的参考口径：`toolPermissionRequested` 的往返（工具卡片上架 / 权限结果回传）
 * **不**改会话的 `waiting`——`src/core/tools/RunTools.ts` 的 `emitToolPermissionRequest`
 * 是普通总线请求；`waiting` 只由 `Integration.requestUserChoice`（入队）与宿主
 * `UserChoiceManager` 的 `userChoicePendingChanged`（弹出 / 应答）写入。
 *
 * 本用例驱动真实链路（用户消息 → 脚本 LLM → 工具轮 → 权限往返），断言运行时快照里
 * 不出现 `waiting: true`：权限往返若被标成等待用户，这里会红——那正是 Standalone 侧
 * 曾经的缺陷（每次工具调用凭空多一次 `running → waiting`，托盘闪一下 + 提醒音响一声）。
 * 注意：本 harness 由宿主直接应答 `userChoice` CoreRequest（不走 `UserChoiceQueue`），
 * 所以真等待的标记点（入队 / 弹出）在这里本来就不会触发，本用例锁的是「权限往返不标记」。
 *
 * 运行方式：npm run test:all -- toolPermissionWaiting
 */

/** 统计 `sessionRuntimeChanged` 里 `waiting` 为真的快照条数（只看本会话） */
function waitingSnapshots(scenario: Awaited<ReturnType<typeof startScenario>>, sessionId: string): number {
  return scenario
    .received('sessionRuntimeChanged')
    .filter((event) => event.states.some((state) => state.sessionId === sessionId && state.waiting))
    .length;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ── manual：卡片上架 → 保持 ask → 宿主弹确认框并选「允许」 ──
  {
    const scenario = await startScenario({
      sessionId: 'waiting_manual',
      rounds: ({ workspace }) => [
        toolUseRound({ name: 'Read', input: { file_path: path.join(workspace, 'a.txt') } }),
        textRound('读完了'),
      ],
      toolPermissionRequested: async () => ({ behavior: 'ask' }),
      userChoice: async () => ({ index: 0 }),
    });
    try {
      fs.writeFileSync(path.join(scenario.workspace, 'a.txt'), 'CONTENT_A\n', 'utf-8');
      await scenario.send('读一下 a.txt');
      check(
        'manual：权限往返（卡片上架 + 确认框）不改 waiting',
        waitingSnapshots(scenario, scenario.sessionId) === 0,
      );
      check('manual：工具确实跑完了', scenario.last('toolResult')?.status === 'success');
    } finally {
      scenario.close();
    }
  }

  // ── auto：免确认（PermissionPolicy 把 ask 加工成 allow）──
  {
    const scenario = await startScenario({
      sessionId: 'waiting_auto',
      rounds: ({ workspace }) => [
        toolUseRound({ name: 'Read', input: { file_path: path.join(workspace, 'a.txt') } }),
        textRound('读完了'),
      ],
    });
    try {
      // 配置快照是会话级覆盖缺省时的取值来源，必须在发消息前落下
      applyTestSettings({ defaultAgentMode: 'auto' });
      fs.writeFileSync(path.join(scenario.workspace, 'a.txt'), 'CONTENT_A\n', 'utf-8');
      await scenario.send('读一下 a.txt');
      check(
        'auto：免确认的工具调用全程不出现 waiting',
        waitingSnapshots(scenario, scenario.sessionId) === 0,
      );
      check('auto：工具确实跑完了', scenario.last('toolResult')?.status === 'success');
    } finally {
      scenario.close();
    }
  }

  finish();
}

runTests('toolPermissionWaiting', run);
