import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm, RecordedRequest, ScriptDecision } from '../helpers/mockLlmServer';
import { parseTaskNumber, queuedGrantViolations } from '../helpers/subagentGrantOrder';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * US-49 子代理并发上限（specs/005）
 *
 * Electron 整应用链路：真实 standalone core（Rust）+ 本地 mock LLM。父会话一轮
 * 发出 6 个 `Agent` 调用，断言同父会话并行子代理 ≤ 4、排队者按 FIFO 启动、
 * 前台中止时已排队尚未启动的派发放弃（不创建子代理会话）。
 *
 * 超上限的 `Agent` 调用**立即返回排队文案**（"Agent [Master] queued"），创建
 * 由 Core 在槽位空出后自动进行——排队不再占用父会话的轮次。跨轮扇出的脚本按
 * 「助手是否已发出该任务的 tool_use」推进轮次，不数工具结果文案：回投与下一轮
 * 驱动之间存在竞态（e2e/README.md 的已知坑 18）。
 *
 * 并发观测原理：mock 服务器的 `delayMs` 在写响应前 setTimeout 让出事件循环，
 * 期间其他连接的请求可以进来被解析——子代理首请求的 [startedAt, finishedAt]
 * 区间重叠数就是真实的并行子代理数。
 *
 * **FIFO 的观测点不在 mock 的请求时刻**（specs/defects/
 * us49-fifo-assertion-reads-first-request-order.md）：产品的 FIFO 保证点是槽位预留
 * 转移（`core-rs/src/subagent.rs` 的 `enter_slot_queue` / `hand_off_reservation`），
 * 而首请求要经过「后台线程 → 建 meta / 注册 / emit → 再起驱动线程 → 组提示词」
 * 若干段没有顺序依赖的链路，CI 上因此概率性读到 `[6, 5]`。排队顺序改读子会话 id 里的
 * `now_millis()` 前缀（`sub_<millis>_<suffix>`，即授予预留后建会话的时刻），
 * 判定在 `helpers/subagentGrantOrder.ts`，由 `src/test/subagentGrantOrder.test.ts` 锁定。
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

/**
 * 从沙箱 home 读取子代理会话的落盘事实（`description` + 子会话 id）。
 *
 * 只认带 `parentSessionId` 的 meta.json：父会话没有该键，工作区清单
 * （`workspace.meta.json`）另有过滤，两者都不该混进来。
 */
function readSubAgentGrants(): Array<{ description: string; sessionId: string }> {
  const conversationsRoot = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
  const grants: Array<{ description: string; sessionId: string }> = [];
  for (const project of fs.readdirSync(conversationsRoot)) {
    const projectDir = path.join(conversationsRoot, project);
    if (!fs.statSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.meta.json') || file === 'workspace.meta.json') continue;
      const meta = JSON.parse(fs.readFileSync(path.join(projectDir, file), 'utf-8')) as {
        sessionId?: unknown;
        title?: unknown;
        parentSessionId?: unknown;
      };
      if (typeof meta.parentSessionId !== 'string') continue;
      if (typeof meta.sessionId !== 'string' || typeof meta.title !== 'string') continue;
      grants.push({ description: meta.title, sessionId: meta.sessionId });
    }
  }
  return grants;
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
      // 单独一轮发起——排队结果的脚本推进按「该任务是否已被派发过」判轮。
      //
      // 判据只能用**助手自己那条 tool_use**（它一发出就永久留在历史里），不能用
      // 工具结果文案：排队结果的回投与下一轮驱动之间有竞态，单核 runner 上下一轮
      // 可能先于回投到达，按文案计数会把「该发 5」误判成「还没排队、再发一次」，
      // 于是任务 6 先被发出、断言读到 `[6, 5]`（run `45027408803` / `45030636920`
      // 实证，e2e/README.md 的已知坑 18 记的是同一现象）。
      const context = JSON.stringify(req.body.messages);
      /** 该任务是否已被派发过（tool_use 的 args 里带完整提示词，一进历史就不再消失） */
      const issued = (n: number): boolean => context.includes(`并发任务${n}：慢慢回答`);
      if (![1, 2, 3, 4].some(issued)) {
        return {
          kind: 'tools',
          calls: [1, 2, 3, 4].map((n) => ({
            name: 'Agent',
            args: { prompt: `并发任务${n}：慢慢回答`, agentRole: 'Master', description: `任务${n}` },
          })),
        };
      }
      if (!issued(5)) {
        return {
          kind: 'tool',
          name: 'Agent',
          args: { prompt: '并发任务5：慢慢回答', agentRole: 'Master', description: '任务5' },
        };
      }
      if (!issued(6)) {
        return {
          kind: 'tool',
          name: 'Agent',
          args: { prompt: '并发任务6：慢慢回答', agentRole: 'Master', description: '任务6' },
        };
      }
      return { kind: 'text', text: '6 个子代理都排上了，等槽位空出自动开跑。' };
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
  // 侧栏最终列出全部会话：父 1 + 子 6。默认展开上限是 `SUBAGENT_AUTO_EXPAND_LIMIT`
  // （5：达到即不自动展开，`src/host/ui/conversationTreeDefaults.ts`，与 webview 对话树
  // 同一份事实）——6 个子会话默认折叠，先锁定折叠态，再点开父会话的折叠按钮断言 7 条。
  // 直接数 7 会把「批量委派不自动撑满列表」这条既有设计当成缺陷（specs/defects/
  // us49-sidebar-not-listing-subagents.md）。
  const parentRow = sb.locator(SIDEBAR_ITEM).first();
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 30_000 })
    .toBe(1);
  await parentRow.locator('[data-action="toggle-sub"]').click();
  await expect
    .poll(() => sb.locator(SIDEBAR_ITEM).count(), { timeout: 30_000 })
    .toBe(7);

  // 峰值并发恰为 4：< 4 说明子代理被串行化（接线缺失），> 4 说明上限失效
  const firsts = subFirstRequests([1, 2, 3, 4, 5, 6]);
  expect(maxOverlap(firsts)).toBe(4);

  // FIFO（US-49 验收 2）：任务 5、6 跨轮先后发起，槽位预留必须按 5 → 6 授予。
  // 观测点是子会话 id 里的授予时刻，不是 mock 的请求到达顺序——后者在产品链路上
  // 没有任何顺序保证（本文件头部注释与 specs/defects/
  // us49-fifo-assertion-reads-first-request-order.md）。
  // 首轮并发直取的任务 1–4 之间本就不承诺顺序，不参与比较。
  const grants = readSubAgentGrants();
  const queuedTasks = [5, 6];
  expect(queuedGrantViolations(grants, queuedTasks)).toEqual([]);
  // 反向确认判据确实读到两个排队者的授予事实：否则「缺席」会被上一条的空数组
  // 误读成「顺序正确」
  const grantedTasks = grants
    .map((grant) => parseTaskNumber(grant.description))
    .filter((task): task is number => task !== null);
  expect([5, 6].every((task) => grantedTasks.includes(task))).toBe(true);

  // 排队者只能在槽位释放后启动：任务 5 的首请求不早于前 4 个中最早的完成
  const ordered = [...firsts].sort((a, b) => a.startedAt - b.startedAt);
  const earliestFinish = Math.min(...ordered.slice(0, 4).map((req) => req.finishedAt ?? 0));
  expect(ordered[4].startedAt).toBeGreaterThanOrEqual(earliestFinish);
});

test('US-49 前台中止：排队中的 2 个调用取消、不创建子代理会话', async () => {
  mockLlm.setHandler((req): ScriptDecision => {
    const text = lastUserText(req.body.messages);
    const subTask = /^并发任务(\d+)：慢慢回答$/.exec(text);
    if (subTask) {
      // 子代理首轮**一直挂着**（`hang` 不回首字）：本用例要断言的「4 个子代理
      // 还在跑」必须是一个不会自己到期的状态。用有限延迟（此前 5s）撑窗口时，
      // 慢 runner 上 4 个子会话创建完就已经过期，中止点击后的快照是
      // `queryRunning=false` / `subAgentRunning=false`（灰、不可点），
      // 断言读到的是「没有后台工作」，与 US-49 要锁的语义无关
      // （run `45007017025` 实证）。
      return { kind: 'hang' };
    }
    if (text === '并发派活') {
      if (req.body.messages[req.body.messages.length - 1]?.role === 'tool') {
        // 父会话收尾轮同样一直挂着：排队结果立即返回后父会话的工具批很快结束，
        // 若这一轮按有限延迟收尾，中止点击会落到「前台已空闲」那一档——首击走
        // 「中止范围」（连已运行的子代理一起中止），用例锁定的事件就不再是
        // US-49 的「排队派发随前台取消」。挂起保证中止**确定**落在前台阶段。
        return { kind: 'hang' };
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

  // 首击只停前台：父会话收尾轮被 mock 挂住（不回首字），此刻仍是前台在跑；
  // 前台中止置会话取消标记，已排队未启动的 2 个派发随之放弃
  //
  // 定位用 `data-abort-state`（红 / 黄 / 灰恒在），不用 `title`：按钮转黄后 native title
  // 被移除、由悬停明细浮层取代（docs/features/abort-button.md FR-004），跨态定位器会在
  // 断言前就匹配不到元素（specs/defects/us49-abort-locator-reads-vanished-title）。
  const abortButton = chatPage.locator('button[data-abort-state]');
  await expect(abortButton).toHaveAttribute('data-abort-state', 'query', { timeout: 30_000 });
  await abortButton.click();

  // 点击后按钮转黄（前台已停、4 个子代理仍在跑）：先等状态落定再断言可点，
  // 否则断言会落在转黄之前的红态窗口里，绿的时机取决于调度
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 15_000 });
  await expect(abortButton).toBeEnabled();

  // 等待窗口内排队者不得补位启动：子代理首请求数恒为 4；
  // 会话总数维持 5（4 子 + 1 父，排队 2 个从未创建会话）——放在等待窗口之后，
  // 立即轮询时数值尚未经历「可能补位」的窗口，断言是空的
  await chatPage.waitForTimeout(3_000);
  expect(subFirstRequests([1, 2, 3, 4, 5, 6])).toHaveLength(4);
  await expect(sb.locator(SIDEBAR_ITEM)).toHaveCount(5);
});
