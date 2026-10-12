/**
 * 场景测试：子代理并发上限（specs/005）。
 *
 * 两组用例：
 * 1. `SubagentSlots` 桶语义直测（FIFO / 取消竞速 / 配对破坏 / reset）；
 * 2. 走真实 QueryEngine 的端到端：一轮 6 个 `Agent` 调用——前 4 个并行、
 *    其余排队等槽位释放（FIFO），以及排队调用随前台中止而取消（不建会话）。
 *
 * 运行方式：npm run test:all -- agentConcurrency
 */

import { createChecker, runTests } from './helpers/harness';
import { startScenario, textRound } from './helpers/scenario';
import type { ScriptedRound, ScriptedBlock } from './helpers/scenario';
import type { AssistantMessage } from '../core/types';
import type { StreamOptions } from '../core/llm/index';
import {
  acquireSlot,
  releaseSlot,
  heldSlots,
  queuedSlots,
  resetForTest,
  SUBAGENT_CONCURRENCY_LIMIT,
} from '../core/tools/agent/SubagentSlots.js';
import { subAgentRegistry } from '../core/tools/agent/SubAgentRegistry.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(desc: string, timeoutMs: number, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${timeoutMs}ms）：${desc}`);
    }
    await delay(25);
  }
}

/** 一条 assistant 消息里带多个 tool_use（对齐 scenario.toolUseRound 的消息形状） */
function multiToolUseRound(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ScriptedRound {
  return () =>
    (async function* () {
      const blocks: ScriptedBlock[] = calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      }));
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: blocks, stop_reason: 'tool_use' },
        uuid: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
      } as AssistantMessage;
    })();
}

/** 慢速 Reply 轮：先等 delayMs 再应答 Reply 工具调用（占住槽位用） */
function slowReplyRound(delayMs: number, message: string): ScriptedRound {
  return () =>
    (async function* () {
      await delay(delayMs);
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `reply_${Date.now()}`, name: 'Reply', input: { message } }],
          stop_reason: 'tool_use',
        },
        uuid: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
      } as AssistantMessage;
    })();
}

/** 直接抛错的 LLM 轮：注入子代理失败路径（错误轮 → 后台任务 catch → finally 释放槽位） */
function throwingRound(): ScriptedRound {
  return () =>
    (async function* () {
      throw new Error('注入的子代理 LLM 失败');
      // 保留 yield 使该函数成为异步生成器（抛错即结束本轮，不会真的产出）
      yield {} as AssistantMessage;
    })();
}

/** 单轮路由：按请求特征分流（父会话轮次 / 子代理轮次） */
function routingRound(route: (options: StreamOptions) => ScriptedRound): ScriptedRound {
  return (options) => route(options)(options);
}

/**
 * 场景脚本是按 LLM 调用逐个消费数组的；路由轮不依赖调用序（按内容分流），
 * 复制足够多份让整轮对话（父会话 + 6 个子代理的多轮请求）都命中同一分流逻辑。
 */
function routingScript(route: (options: StreamOptions) => ScriptedRound, copies = 300): readonly ScriptedRound[] {
  const round = routingRound(route);
  return Array.from({ length: copies }, () => round);
}

function agentCalls(count: number): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent_${i + 1}`,
    name: 'Agent',
    input: { prompt: `并发任务${i + 1}：慢慢回答`, agentRole: 'Master', description: `任务${i + 1}` },
  }));
}

/** 某个 core→UI 事件收到的全部事件对象（按到达顺序） */
function eventVolume(scenario: ReturnType<typeof startScenario> extends Promise<infer S> ? S : never): number {
  return (
    scenario.received('message').length +
    scenario.received('queryBegin').length +
    scenario.received('queryEnd').length +
    scenario.received('toolResult').length
  );
}

/**
 * 等场景事件流静默：子代理回投会让父会话继续消费若干轮，`close()` 会复位全局
 * 总线——在途轮次的 persistMessage 撞上已复位的总线会以未处理拒绝崩掉测试进程，
 * 收尾前必须等事件流停止增长。
 */
async function waitForQuiet(
  scenario: ReturnType<typeof startScenario> extends Promise<infer S> ? S : never,
  quietMs = 1_200,
): Promise<void> {
  let last = eventVolume(scenario);
  let lastChange = Date.now();
  while (Date.now() - lastChange < quietMs) {
    await delay(100);
    const now = eventVolume(scenario);
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    }
  }
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  // ==================== 桶语义直测 ====================

  resetForTest();
  {
    // 直取至上限
    let ok = true;
    for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) {
      ok = ok && (await acquireSlot('p1'));
    }
    check('上限内全部立即取得槽位', ok && heldSlots('p1') === SUBAGENT_CONCURRENCY_LIMIT);
    // 超出排队
    let fifthResolved = false;
    const fifth = acquireSlot('p1').then((granted) => {
      fifthResolved = true;
      return granted;
    });
    await delay(30);
    check('超出上限的调用不返回且排队', !fifthResolved && queuedSlots('p1') === 1);
    releaseSlot('p1');
    check('释放后按 FIFO 唤醒排队者', (await fifth) === true && queuedSlots('p1') === 0);
    // 此时在握 4 个（3 个原始持有者 + 转移给第五个的槽位）：全部归还后再释放才抛错
    for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) {
      releaseSlot('p1');
    }
    let threw = false;
    try {
      releaseSlot('p1');
    } catch {
      threw = true;
    }
    check('未持有却释放直接抛错（配对破坏）', threw);
    resetForTest();
  }

  {
    // 多个排队者按 FIFO 顺序唤醒
    for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) await acquireSlot('p2');
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      acquireSlot('p2').then((granted) => {
        order.push(n);
        return granted;
      }),
    );
    await delay(30);
    releaseSlot('p2');
    releaseSlot('p2');
    releaseSlot('p2');
    const granted = await Promise.all(waiters);
    check('多个排队者按 FIFO 顺序获得槽位', granted.every(Boolean) && order.join(',') === '1,2,3');
    resetForTest();
  }

  {
    // 已中止的信号：立即返回 false
    const controller = new AbortController();
    controller.abort();
    check('已中止信号直接取消', (await acquireSlot('p3', controller.signal)) === false);
    // 排队中取消：pending 的 acquire 以 false 落定并出队
    for (let i = 0; i < SUBAGENT_CONCURRENCY_LIMIT; i++) await acquireSlot('p3');
    const pending = acquireSlot('p3', controller.signal);
    await delay(30);
    releaseSlot('p3'); // 取消者已出队：槽位真正归还而非转移
    check('排队中取消后槽位不再转移给它', (await pending) === false && heldSlots('p3') === SUBAGENT_CONCURRENCY_LIMIT - 1);
    resetForTest();
  }

  // ==================== 端到端：6 个 Agent 调用 ====================

  {
    // 一轮 6 个 Agent 调用：4 个并行、2 个排队，最终全部完成
    const creator = 'e2e-parent';
    let maxHeld = 0;
    const firstRoundDone = new Set<string>();
    const startOrder: number[] = [];
    const scenario = await startScenario({
      sessionId: creator,
      rounds: () => routingScript((options) => {
        maxHeld = Math.max(maxHeld, heldSlots(creator));
        if (options.sessionId === creator) {
          const sawAgentResults = JSON.stringify(options.messages).includes('Sub-agent created with ID');
          return sawAgentResults ? textRound('全部完成') : multiToolUseRound(agentCalls(6));
        }
        if (!firstRoundDone.has(options.sessionId)) {
          firstRoundDone.add(options.sessionId);
          // 首请求到达序 = 子代理实际启动序（任务号从任务消息里取）
          const task = /并发任务(\d+)：/.exec(JSON.stringify(options.messages))?.[1];
          if (task) startOrder.push(Number(task));
          return slowReplyRound(300, `并发任务完成（${options.sessionId.slice(0, 12)}）`);
        }
        return textRound('好');
      }),
    });
    try {
      await scenario.send('派6个并发子代理');
      check('并行子代理槽位峰值恰为 4', maxHeld === SUBAGENT_CONCURRENCY_LIMIT);
      // 父会话 queryEnd 不等子代理收尾（Agent 调用非阻塞返回，槽位在子代理后台
      // 任务的 finally 里释放）——注册表计数与槽位归零都用等待式断言
      await waitFor('6 个子代理全部登记', 15_000, () =>
        subAgentRegistry.listForCreator(creator).length === 6,
      );
      check('父会话一轮内 6 个调用全部启动（注册表累计 6 个）', subAgentRegistry.listForCreator(creator).length === 6);
      await waitFor('6 条子代理回复', 15_000, () => {
        const replies = scenario.received('message').filter(
          (event) => (event.data as { origin?: string }).origin === 'agent',
        );
        return replies.length >= 6;
      });
      await waitFor('全部槽位归还', 15_000, () => heldSlots(creator) === 0 && queuedSlots(creator) === 0);
      check('全部槽位已归还', heldSlots(creator) === 0 && queuedSlots(creator) === 0);
      // FIFO：前 4 个启动者是直取槽位的任务 1-4（相互竞速，顺序不限）；
      // 排队的两个按发起顺序（任务 5 先于任务 6）启动
      const firstFour = startOrder.slice(0, 4).sort((a, b) => a - b).join(',');
      check('前 4 个启动者是任务 1-4（直取槽位）', firstFour === '1,2,3,4');
      check('排队者按发起顺序启动（FIFO：任务 5 先于任务 6）', startOrder.slice(4).join(',') === '5,6');
      await waitForQuiet(scenario);
    } finally {
      scenario.close();
    }
  }

  {
    // 排队调用随前台中止取消：不创建会话、工具结果为取消文案
    const creator = 'abort-parent';
    const firstRoundDone = new Set<string>();
    const scenario = await startScenario({
      sessionId: creator,
      rounds: () => routingScript((options) => {
        if (options.sessionId === creator) {
          const sawAgentResults = JSON.stringify(options.messages).includes('Sub-agent created with ID');
          return sawAgentResults ? textRound('已中止') : multiToolUseRound(agentCalls(6));
        }
        if (!firstRoundDone.has(options.sessionId)) {
          firstRoundDone.add(options.sessionId);
          return slowReplyRound(2_500, '中止前完成的子代理回复');
        }
        return textRound('好');
      }),
    });
    try {
      scenario.submit('派6个并发子代理');
      await waitFor('4 个在跑 + 2 个排队', 10_000, () => {
        return subAgentRegistry.listForCreator(creator).length === 4 && queuedSlots(creator) === 2;
      });
      await scenario.abort();
      // drain 的批量取消会把中止后仍待产出的工具结果统一改写为取消文案，
      // 逐字计数只需覆盖两个排队调用；会话是否创建以注册表为准
      const parentAgentResults = scenario
        .received('toolResult')
        .filter((event) => event.sessionId === creator && event.toolName === 'Agent');
      const canceledResults = parentAgentResults.filter(
        (event) => event.output === 'Tool was canceled due to abort',
      );
      check('父会话 6 个 Agent 调用都有结果', parentAgentResults.length === 6);
      check('排队调用取消（文案逐字一致）', canceledResults.length >= 2);
      check('排队调用不创建子代理会话', subAgentRegistry.listForCreator(creator).length === 4);
      await waitFor('4 个运行中子代理完成', 15_000, () => {
        const replies = scenario.received('message').filter(
          (event) => (event.data as { origin?: string }).origin === 'agent',
        );
        return replies.length >= 4;
      });
      // 中止只停前台：4 个运行中子代理继续完成并回投（槽位在它们各自收尾时释放）
      await waitFor('中止后槽位全部归还', 15_000, () => heldSlots(creator) === 0 && queuedSlots(creator) === 0);
      check(
        '运行中子代理完成后槽位全部归还（中止路径释放接线）',
        heldSlots(creator) === 0 && queuedSlots(creator) === 0,
      );
      await waitForQuiet(scenario);
    } finally {
      scenario.close();
    }
  }

  {
    // 失败路径：子代理 LLM 注入失败 → 后台任务 catch → finally 仍释放槽位
    // （边界承诺「三类退出各释放一个槽位」的第三类）
    const creator = 'fail-parent';
    const scenario = await startScenario({
      sessionId: creator,
      rounds: () => routingScript((options) => {
        if (options.sessionId === creator) {
          const sawAgentResults = JSON.stringify(options.messages).includes('Sub-agent created with ID');
          return sawAgentResults ? textRound('收尾') : multiToolUseRound(agentCalls(1));
        }
        if (JSON.stringify(options.messages).includes('并发任务1')) {
          return throwingRound();
        }
        return textRound('好');
      }),
    });
    try {
      await scenario.send('派1个子代理');
      await waitFor('失败子代理的槽位归还', 15_000, () => heldSlots(creator) === 0 && queuedSlots(creator) === 0);
      check('子代理异常失败后槽位仍释放（三类退出锁定）', heldSlots(creator) === 0);
      await waitForQuiet(scenario);
    } finally {
      scenario.close();
    }
  }

  finish();
}

runTests('agentConcurrency', run);
