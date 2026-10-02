/**
 * 场景测试：用户中止链路。
 *
 * LLM 长时间不返回（脚本挂起等 abort）→ 用户发 `abortRequested` →
 * 查询走 isAborted → `*User Interrupted*` 系统消息 → 会话收尾落盘 →
 * 下一条用户消息正常开新一轮（abortRequested 复位，引擎不被中止态卡死）。
 *
 * 竞态说明：中止必须落在 LLM 已挂起之后。若中止先于消息提交被处理，
 * `submitMessage` 会把 `abortRequested` 复位（用户发新消息清除旧中止是产品语义），
 * 这次中止就会被吞掉——测试用 `onHanging` 回调确认「可以中止了」再发 abort。
 *
 * 运行方式：npm run test:all -- scenario-abort
 */

import { createChecker, runTests } from './helpers/harness';
import { startScenario, abortedRound, textRound } from './helpers/scenario';

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  let hangingResolve: (() => void) | null = null;
  const llmHanging = new Promise<void>((resolve) => {
    hangingResolve = resolve;
  });

  const scenario = await startScenario({
    sessionId: 'scenario_abort',
    rounds: () => [
      abortedRound({ onHanging: () => hangingResolve?.() }),
      textRound('恢复后的回答'),
    ],
  });

  try {
    // ---- 先提交不等结束：等 LLM 真正挂起后再中止 ----
    scenario.submit('开始一个长任务');
    await llmHanging;
    await scenario.abort();

    // ---- 中止回显 ----
    const interrupted = scenario
      .received('message')
      .find((m) => m.data.role === 'system' && m.data.content === '*User Interrupted*');
    check('收到 *User Interrupted* 系统消息', interrupted !== undefined);

    // ---- 查询以一次 queryBegin / queryEnd 闭合 ----
    const tl = scenario.timeline('queryBegin', 'queryEnd');
    check(
      '恰好一轮 queryBegin → queryEnd',
      JSON.stringify(tl) === JSON.stringify(['queryBegin', 'queryEnd']),
    );

    // ---- 中止消息已落盘 ----
    const afterAbort = await scenario.conversation();
    check(
      '*User Interrupted* 已落盘',
      afterAbort.messages.some((m) => (m as { content?: string }).content === '*User Interrupted*'),
    );

    // ---- 中止后引擎可复用：下一条消息正常走完一轮 ----
    await scenario.send('继续');
    check('中止后 LLM 进入第二轮脚本', scenario.llm.calls() === 2);
    const afterResume = await scenario.conversation();
    check(
      '恢复后的回答已落盘',
      afterResume.messages.some((m) =>
        JSON.stringify((m as { message?: { content?: unknown } }).message?.content)?.includes(
          '恢复后的回答',
        ),
      ),
    );
    const finalTl = scenario.timeline('queryEnd');
    check('两轮查询各发一次 queryEnd', finalTl.length === 2);
  } finally {
    scenario.close();
  }
  finish();
}

runTests('scenarioAbort', run);
