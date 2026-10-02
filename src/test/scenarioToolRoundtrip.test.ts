/**
 * 场景测试：工具调用全链路。
 *
 * 一条 userMessageSubmitted 走完整管线：入队 → LLM 请求 Read 工具 → 权限放行 →
 * 工具执行 → tool_result 进入下一轮 LLM 上下文 → 最终应答 → 落盘。
 *
 * 与 runToolsApproval 等单测的区别：那里直接调 `runTools` 断言工具语义；
 * 这里经 `Integration.submitUserMessage`（`UiEvent` 唯一入口）驱动，断言的是
 * 事件顺序、LLM 上下文、会话落盘三者的一致性——任何一层断了这个场景都会挂。
 *
 * 运行方式：npm run test:all -- scenario-tool-roundtrip
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { startScenario, toolUseRound, textRound } from './helpers/scenario';

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const scenario = await startScenario({
    sessionId: 'scenario_tool_roundtrip',
    rounds: ({ workspace }) => [
      toolUseRound(
        { name: 'Read', input: { file_path: path.join(workspace, 'a.txt') } },
        '我先读一下文件',
      ),
      textRound('文件内容已确认。', '读取完成，做总结'),
    ],
  });

  try {
    fs.writeFileSync(path.join(scenario.workspace, 'a.txt'), 'CONTENT_A\n', 'utf-8');

    await scenario.send('帮我读一下 a.txt');

    // ---- LLM 被调用两次：第一次请求工具，第二次拿到工具结果做总结 ----
    check('LLM 恰好被调用两次', scenario.llm.calls() === 2);

    // ---- 事件顺序：queryBegin → toolCall×2 → toolResult → queryEnd ----
    // toolCall 发两次是既定行为：权限询问前上架 running 卡片一次（避免「权限决策
    // 期间既没有 thinking 也没有 running」的空窗），批准开跑时再上架一次。
    const tl = scenario.timeline('queryBegin', 'toolCall', 'toolResult', 'queryEnd');
    check(
      '事件顺序 queryBegin → toolCall×2 → toolResult → queryEnd',
      JSON.stringify(tl) ===
        JSON.stringify(['queryBegin', 'toolCall', 'toolCall', 'toolResult', 'queryEnd']),
    );

    // ---- 工具卡片与结果 ----
    const toolCall = scenario.last('toolCall');
    check('toolCall 是 Read 工具', toolCall?.toolName === 'Read');
    const toolResult = scenario.last('toolResult');
    check('toolResult 状态 success', toolResult?.status === 'success');
    check('toolResult 输出包含文件内容', (toolResult?.output ?? '').includes('CONTENT_A'));
    check(
      'toolCall 与 toolResult 指向同一次调用',
      toolCall !== undefined &&
        toolResult !== undefined &&
        toolCall.toolUseId === toolResult.toolUseId,
    );

    // ---- 工具结果进入第二轮 LLM 上下文 ----
    const secondRequest = JSON.stringify(scenario.llm.requestMessages(2));
    check(
      '第二轮上下文包含 tool_use id',
      toolCall !== undefined && secondRequest.includes(toolCall.toolUseId),
    );
    check('第二轮上下文包含工具读到的内容', secondRequest.includes('CONTENT_A'));

    // ---- 落盘：用户消息、两轮 assistant、tool_result 全部可从会话文件读回 ----
    const conversation = await scenario.conversation();
    const contents = conversation.messages.map((m) => {
      const c = (m as { message?: { content?: unknown } }).message?.content;
      return typeof c === 'string' ? c : JSON.stringify(c);
    });
    check('用户消息已落盘', contents.includes('帮我读一下 a.txt'));
    check(
      '第一轮 assistant（含 tool_use）已落盘',
      conversation.messages.some(
        (m) =>
          (m as { type?: string }).type === 'assistant' &&
          JSON.stringify((m as { message?: { content?: unknown[] } }).message?.content)?.includes(
            '"tool_use"',
          ),
      ),
    );
    check(
      'tool_result 已落盘',
      conversation.messages.some((m) =>
        JSON.stringify((m as { message?: { content?: unknown } }).message?.content)?.includes(
          'tool_result',
        ),
      ),
    );
    check(
      '最终应答已落盘',
      contents.some((c) => c.includes('文件内容已确认。')),
    );
  } finally {
    scenario.close();
  }
  finish();
}

runTests('scenarioToolRoundtrip', run);
