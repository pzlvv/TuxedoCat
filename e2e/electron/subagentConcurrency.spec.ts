import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest, ScriptDecision } from '../helpers/mockLlmServer';

/**
 * US-49 子代理并发上限（specs/005）
 *
 * Electron 整应用链路：真实 standalone core（Rust）+ 本地 mock LLM。父会话一轮
 * 发出 6 个 `Agent` 调用，断言同父会话并行子代理 ≤ 4、排队者按 FIFO 启动、
 * 前台中止时排队调用取消（不创建子代理会话）。
 *
 * 并发观测原理：mock 服务器的 `delayMs` 在写响应前 setTimeout 让出事件循环，
 * 期间其他连接的请求可以进来被解析——子代理首请求的 [startedAt, finishedAt]
 * 区间重叠数就是真实的并行子代理数。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

const SIDEBAR_ITEM = '#list .item[data-session-id]';

/** 子代理首请求数（任务提示词 + 消息里没有任何 tool 结果 = 首轮请求） */
function subFirstRequests(tasks: number[]): RecordedRequest[] {
  return mockLlm.requests.filter((req) => {
    if (req.body.messages.some((m: { role: string }) => m.role === 'tool')) return false;
    const text = lastUserText(req.body.messages);
    return tasks.some((n) => text === `并发任务${n}：慢慢回答`);
  });
}

/** 区间最大重叠数（并发峰值） */
function maxOverlap(requests: RecordedRequest[]): number {
  let best = 0;
  for (const req of requests) {
    const start = req.startedAt;
    const end = req.finishedAt ?? req.startedAt;
    const overlap = requests.filter((other) => {
      const otherStart = other.startedAt;
      const otherEnd = other.finishedAt ?? other.startedAt;
      return otherStart <= end && otherEnd >= start;
    }).length;
    best = Math.max(best, overlap);
  }
  return best;
}

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir, agentMode: 'auto' });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-49 并发上限 4：直取 + 跨轮排队均受限，排队者按发起顺序启动', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    const subTask = /^并发任务(\d+)：慢慢回答$/.exec(text);
    if (subTask) {
      // 子代理首轮：慢延迟 Reply（占住槽位，让并发窗口可观测）；
      // 工具结果回传后的追问轮 → 终轮文本收尾
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: '子代理任务完成。' };
      }
      return {
        kind: 'tool',
        name: 'Reply',
        args: { message: `并发任务${subTask[1]}完成` },
        delayMs: 900,
      };
    }
    if (text === '并发派活' || JSON.stringify(req.body.messages).includes('并发派活')) {
      // 父会话请求（上下文必然携带首条用户消息；子代理上下文没有）。
      // 不用 lastUserText 判轮次：子代理回投并入后父会话的最后一条 user 消息
      // 是回投文本。跨轮扇出：第 1 轮 4 个（直取满槽），任务 5 / 任务 6 各自
      // 单独一轮发起——并行批每工具一个线程，同轮多个调用的直取分配是线程
      // 竞争；轮次边界把排队顺序串行化，FIFO 断言才确定（顺带覆盖跨轮排队）
      const created =
        JSON.stringify(req.body.messages).split('Sub-agent created with ID').length - 1;
      if (created === 0) {
        return {
          kind: 'tools',
          calls: [1, 2, 3, 4].map((n) => ({
            name: 'Agent',
            args: { prompt: `并发任务${n}：慢慢回答`, agentRole: 'Master', description: `任务${n}` },
          })),
        };
      }
      if (created === 4) {
        return {
          kind: 'tool',
          name: 'Agent',
          args: { prompt: '并发任务5：慢慢回答', agentRole: 'Master', description: '任务5' },
        };
      }
      if (created === 5) {
        return {
          kind: 'tool',
          name: 'Agent',
          args: { prompt: '并发任务6：慢慢回答', agentRole: 'Master', description: '任务6' },
        };
      }
      return { kind: 'text', text: '6 个子代理都完成了。' };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const chatPage = await app.chatPage();
  const sb = await app.sidebarPage();
  await chatPage.fill('textarea.input-textarea', '并发派活');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 6 个子代理的首请求全部到达（排队的两个也拿到了槽位）。
  // 不锚定父会话的终轮文案：子代理回投会并入父会话的后续轮次，终轮内容
  // 随回投到达时序变化；会话与请求数是稳定信号
  await expect
    .poll(() => subFirstRequests([1, 2, 3, 4, 5, 6]).length, { timeout: 60_000 })
    .toBe(6);
  // 侧栏最终列出全部会话：父 1 + 子 6
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 30_000 })
    .toBe(7);

  // 峰值并发恰为 4：< 4 说明子代理被串行化（接线缺失），> 4 说明上限失效
  const firsts = subFirstRequests([1, 2, 3, 4, 5, 6]);
  expect(maxOverlap(firsts)).toBe(4);

  // FIFO：任务 1-4 先启动（第 1 轮）；任务 5、6 跨轮先后发起，启动顺序必为 5 → 6
  const ordered = [...firsts].sort((a, b) => a.startedAt - b.startedAt);
  const taskOf = (req: RecordedRequest): number =>
    Number(/^并发任务(\d+)：/.exec(lastUserText(req.body.messages))?.[1]);
  expect(ordered.slice(4).map(taskOf)).toEqual([5, 6]);
  // 排队者只能在槽位释放后启动：任务 5 的首请求不早于前 4 个中最早的完成
  const earliestFinish = Math.min(...ordered.slice(0, 4).map((req) => req.finishedAt ?? 0));
  expect(ordered[4].startedAt).toBeGreaterThanOrEqual(earliestFinish);
});

test('US-49 前台中止：排队中的 2 个调用取消、不创建子代理会话', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    const subTask = /^并发任务(\d+)：慢慢回答$/.exec(text);
    if (subTask) {
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: '子代理任务完成。' };
      }
      return {
        kind: 'tool',
        name: 'Reply',
        args: { message: `并发任务${subTask[1]}完成` },
        delayMs: 5_000,
      };
    }
    if (text === '并发派活') {
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        return { kind: 'text', text: '已中止。' };
      }
      return {
        kind: 'tools',
        calls: [1, 2, 3, 4, 5, 6].map((n) => ({
          name: 'Agent',
          args: { prompt: `并发任务${n}：慢慢回答`, agentRole: 'Master', description: `任务${n}` },
        })),
      };
    }
    return { kind: 'text', text: `收到：${text.slice(0, 40)}` };
  });

  const chatPage = await app.chatPage();
  const sb = await app.sidebarPage();
  await chatPage.fill('textarea.input-textarea', '并发派活');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // 恰好 4 个子代理会话出现在侧栏（排队 2 个未建会话）
  // 侧栏总数 = 父会话 1 + 子代理 4；等它稳定在 5
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 30_000 })
    .toBe(5);

  // 首击只停前台：排队调用随前台取消
  const abortButton = chatPage.locator('button[title="终止"]');
  await abortButton.click();

  // 子会话数维持 5（4 子 + 1 父）：排队 2 个从未创建会话
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 15_000 })
    .toBe(5);
  // 按钮仍可点（收尾中：4 个子代理还在跑）
  await expect(abortButton).toBeEnabled({ timeout: 15_000 });

  // 等待窗口内排队者不得补位启动：子代理首请求数恒为 4
  await chatPage.waitForTimeout(3_000);
  expect(subFirstRequests([1, 2, 3, 4, 5, 6])).toHaveLength(4);
});
