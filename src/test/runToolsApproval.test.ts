/**
 * 单测：并发安全工具的「批准即执行」语义（RunTools）。
 *
 * 回归两个 bug：
 * 1. 一次产生多个并发安全工具时，第一个被批准后必须**立刻执行**，
 *    不能等整批（后面可能还在等用户确认的工具）都授权完才开始；
 * 2. 后续工具被拒绝时，已批准（且已启动）的工具不能被一起取消。
 *
 * 用两个 Read（并发安全、只读）模拟：第一个放行 / 确认，第二个拒绝。
 * 旧实现会先把第一个收进 batch，等第二个拒绝后把第一个也取消（is_canceled）；
 * 新实现下第一个已经开跑，应拿到真实读取结果。
 *
 * 运行方式：npm run test:all -- run-tools-approval
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { runTools } from '../core/tools/RunTools';
import { setGlobalEventBus, resetGlobalEventBus } from '../core/AssistantEventBus';
import { setSessionWorkspace, clearAllSessionWorkspaces } from '../core/history/Config';
import { makeTestBus, makeTempDir } from './helpers/fixtures';
import { createChecker, runTests } from './helpers/harness';

interface ToolResultBlock {
  tool_use_id: string;
  content: unknown;
  exit_code?: number;
  is_canceled?: boolean;
}

/** 从 runTools 产出的消息里取出指定 tool_use_id 的 tool_result block */
function resultBlock(messages: any[], toolUseId: string): ToolResultBlock | undefined {
  for (const m of messages) {
    const blocks = m?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const hit = blocks.find((b: any) => b?.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (hit) return hit as ToolResultBlock;
  }
  return undefined;
}

async function collect(
  sessionId: string,
  blocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  cwd: string,
): Promise<any[]> {
  const messages: any[] = [];
  for await (const update of runTools(sessionId, blocks, {
    abortController: new AbortController(),
    cwd,
    getAppState: () => ({}),
    setAppState: () => {},
    messages: [],
    sessionId,
  } as any)) {
    if (update.message) messages.push(update.message);
  }
  return messages;
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  clearAllSessionWorkspaces();

  const ws = makeTempDir('run-tools-approval');
  const sessionId = 'session_run_tools_approval';
  setSessionWorkspace(sessionId, ws);

  const fileA = path.join(ws, 'a.txt');
  const fileB = path.join(ws, 'b.txt');
  fs.writeFileSync(fileA, 'CONTENT_A\n', 'utf-8');
  fs.writeFileSync(fileB, 'CONTENT_B\n', 'utf-8');

  const blocks = [
    { id: 'tool_a', name: 'Read', input: { file_path: fileA } },
    { id: 'tool_b', name: 'Read', input: { file_path: fileB } },
  ];

  // ---- 用例 1：第一个放行、第二个拒绝 ----
  {
    let permCalls = 0;
    const { bus } = makeTestBus({
      toolPermissionRequested: async () => {
        permCalls++;
        if (permCalls === 1) return { behavior: 'allow' } as never;
        return { behavior: 'deny', message: 'user rejected' } as never;
      },
    });
    setGlobalEventBus(bus);
    const messages = await collect(sessionId, blocks, ws);
    resetGlobalEventBus();

    const a = resultBlock(messages, 'tool_a');
    const b = resultBlock(messages, 'tool_b');
    assert.ok(a, '第一个工具必须有 tool_result');
    check('第一个工具拿到 tool_result', !!a);
    check('第一个工具没有被取消（is_canceled 不为 true）', a!.is_canceled !== true);
    check('第一个工具确实执行了（读到文件内容）', String(a!.content).includes('CONTENT_A'));
    assert.ok(b, '第二个工具必须有 tool_result');
    check('第二个工具被拒绝（exit_code = -1）', b!.exit_code === -1);
  }

  // ---- 用例 2：第一个需要用户确认（ask），确认后立刻执行；第二个拒绝 ----
  {
    let permCalls = 0;
    let toolCallCountForAWhenBRequested = -1;
    const testBus = makeTestBus({
      toolPermissionRequested: async () => {
        permCalls++;
        if (permCalls === 1) {
          // 模拟 UI：第一个工具需要用户确认
          return {
            behavior: 'ask',
            message: 'confirm A',
            choices: [{ label: '允许' }, { label: '拒绝' }],
          } as never;
        }
        // 第二个工具的权限请求到来时，第一个工具应已经「开始执行」
        // （authorizeOne 的 toolCall + startApprovedItem 的 toolCall，共 2 次）
        toolCallCountForAWhenBRequested =
          testBus.received('toolCall').filter((e) => e.toolUseId === 'tool_a').length;
        return { behavior: 'deny', message: 'user rejected' } as never;
      },
      // ask 走 UserChoiceQueue 未初始化时的总线兜底：选第 0 项 = 允许
      userChoice: async () => ({ index: 0 }),
    });
    setGlobalEventBus(testBus.bus);
    const messages = await collect(sessionId, blocks, ws);
    resetGlobalEventBus();

    check('第二个工具请求权限时，第一个工具已经启动（toolCall 已发 2 次）', toolCallCountForAWhenBRequested >= 2);
    const a = resultBlock(messages, 'tool_a');
    check('确认后的第一个工具没有被第二个拒绝连累取消', !!a && a.is_canceled !== true);
    check('确认后的第一个工具确实执行了', !!a && String(a.content).includes('CONTENT_A'));
  }

  finish();
}

runTests('runToolsApproval', run);
