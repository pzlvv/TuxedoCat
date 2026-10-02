/**
 * 场景测试：权限拒绝链路。
 *
 * LLM 请求 Bash 工具 → core 经 `toolPermissionRequested` 向 UI 要决策 →
 * UI 返回 deny → 工具不执行、错误结果回传 → 拒绝原因进入下一轮 LLM 上下文 →
 * 会话正常收尾落盘。
 *
 * 回归的是「拒绝后整条管线仍然闭合」：RunTools 单测只断言拒绝的工具本身
 * （abortBeforeExecutionParity 等），这里断言拒绝不悬空消费循环、
 * 下一轮请求真的带着拒绝结果、最终应答落盘。
 *
 * 运行方式：npm run test:all -- scenario-permission-denied
 */

import { createChecker, runTests } from './helpers/harness';
import { startScenario, toolUseRound, textRound } from './helpers/scenario';

const DENY_REASON = '测试场景拒绝执行';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const scenario = await startScenario({
    sessionId: 'scenario_permission_denied',
    rounds: () => [
      toolUseRound({ name: 'Bash', input: { command: 'echo should-not-run' } }, '执行一个命令'),
      textRound('明白，已放弃执行该命令。'),
    ],
    toolPermissionRequested: async () => ({ behavior: 'deny', message: DENY_REASON }),
  });

  try {
    await scenario.send('帮我跑个命令');

    // ---- LLM 被调用两次：拒绝不终止轮次循环，第二轮正常进行 ----
    check('LLM 恰好被调用两次', scenario.llm.calls() === 2);

    // ---- 事件顺序：toolCall 卡片在权限询问前上架，拒绝结果随后 ----
    const tl = scenario.timeline('queryBegin', 'toolCall', 'toolResult', 'queryEnd');
    check(
      '事件顺序 queryBegin → toolCall → toolResult → queryEnd',
      JSON.stringify(tl) === JSON.stringify(['queryBegin', 'toolCall', 'toolResult', 'queryEnd']),
    );

    // ---- 拒绝以 error 状态回传，且命令没有被执行 ----
    const toolResult = scenario.last('toolResult');
    check('toolResult 状态 error', toolResult?.status === 'error');
    check('toolResult 输出带拒绝原因', (toolResult?.output ?? '').includes(DENY_REASON));
    check('toolResult 是 Bash 工具', toolResult?.toolName === 'Bash');

    // ---- 拒绝原因进入第二轮 LLM 上下文，模型据此收尾 ----
    const secondRequest = JSON.stringify(scenario.llm.requestMessages(2));
    check('第二轮上下文包含拒绝原因', secondRequest.includes(DENY_REASON));

    // ---- 落盘：拒绝的 tool_result 与最终应答都在会话文件里 ----
    const conversation = await scenario.conversation();
    const all = JSON.stringify(conversation.messages);
    check('tool_result（含拒绝原因）已落盘', all.includes(DENY_REASON));
    check(
      '最终应答已落盘',
      conversation.messages.some((m) =>
        JSON.stringify((m as { message?: { content?: unknown } }).message?.content)?.includes(
          '明白，已放弃执行该命令。',
        ),
      ),
    );
  } finally {
    scenario.close();
  }
  finish();
}

runTests('scenarioPermissionDenied', run);
