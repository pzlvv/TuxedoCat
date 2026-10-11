import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-46 空闲发送与发送模式下拉（US-46，规格 docs/features/user-message-pipeline.md FR-003）
 *
 * 场景级：以真实用户操作（点下拉、输入、Enter、点横幅按钮）驱动构建后的 webview bundle，
 * 宿主侧由假宿主按 wire 协议应答（`e2e/helpers/fakeHost.ts`）。空闲挂起是 webview 本地
 * 状态：忙碌时选「空闲发送」不上送，等会话快照回 idle 才自动提交——上行断言用
 * sendMessage 计数锁定「未投递 / 触发投递」，横幅断言锁定「空闲后发送」标签与忙碌
 * 排队（「等待中」）可区分。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 上行 sendMessage 快照（按到达顺序） */
async function sendMessages(host: WebviewHandle['host']): Promise<Array<Record<string, unknown>>> {
  return (await host.sentAll()).filter((m) => m.type === 'sendMessage');
}

test('US-46 下拉列出「立即发送 / 空闲发送」，立即发送与主按钮等价', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '回复。', chunkDelayMs: 5 });
  await page.fill('textarea.input-textarea', '下拉立即发送');

  // 下拉打开：两项齐备
  await page.locator('button[data-send-mode-caret="true"]').click();
  await expect(page.getByText('立即发送', { exact: true })).toBeVisible();
  await expect(page.getByText('空闲发送', { exact: true })).toBeVisible();

  // 立即发送 = 主按钮语义：同一载荷直接上送
  await page.getByText('立即发送', { exact: true }).click();
  const sent = await host.waitForSent('sendMessage');
  expect(sent.content).toBe('下拉立即发送');
});

test('US-46 空闲发送：忙碌时本地挂起不上送，空闲后自动提交', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '第一轮。'.repeat(30), chunkDelayMs: 120 });

  await page.fill('textarea.input-textarea', '第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });
  expect((await sendMessages(host)).length).toBe(1);

  // 忙碌中选「空闲发送」：挂起横幅出现且标明「空闲后发送」（与忙碌排队「等待中」可区分），
  // 内容不上送、输入框被挂起接管清空
  await page.fill('textarea.input-textarea', '等空闲再发');
  await page.locator('button[data-send-mode-caret="true"]').click();
  await page.getByText('空闲发送', { exact: true }).click();
  const banner = page.getByText(/空闲后发送/).first();
  await expect(banner).toBeVisible();
  await expect(page.getByText(/等待中/).first()).toBeHidden();
  await expect(page.locator('textarea.input-textarea')).toHaveValue('');
  await page.waitForTimeout(500);
  expect((await sendMessages(host)).length).toBe(1);

  // 第一轮结束（快照回 idle）：挂起项自动按立即发送语义提交，横幅清除
  await expect.poll(async () => (await sendMessages(host)).length, { timeout: 20_000 }).toBe(2);
  expect((await sendMessages(host))[1].content).toBe('等空闲再发');
  await expect(banner).toBeHidden({ timeout: 10_000 });
});

test('US-46 挂起期间禁止发送；编辑撤回 / 删除为纯本地动作', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '长任务。'.repeat(25), chunkDelayMs: 150 });
  await page.fill('textarea.input-textarea', '第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });

  await page.fill('textarea.input-textarea', '挂起的消息');
  await page.locator('button[data-send-mode-caret="true"]').click();
  await page.getByText('空闲发送', { exact: true }).click();
  const banner = page.getByText(/空闲后发送/).first();
  await expect(banner).toBeVisible();

  // 挂起期间主按钮置灰，Enter 也不再上送（一次一条：改主意走横幅）
  const sendButton = page.locator('button:has(.ti-send)').last();
  await expect(sendButton).toBeDisabled();
  await page.fill('textarea.input-textarea', '挂起中不能再发');
  await page.press('textarea.input-textarea', 'Enter');
  await page.waitForTimeout(300);
  expect((await sendMessages(host)).length).toBe(1);

  // 编辑：撤回到输入框。挂起项不经宿主——没有 discardQueuedMessage 上行（与忙碌排队撤回的本质区别）
  await page.locator('button[title*="编辑排队消息"]').click();
  await expect(banner).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toHaveValue(/挂起的消息/, { timeout: 10_000 });
  expect((await host.sentAll()).filter((m) => m.type === 'discardQueuedMessage')).toHaveLength(0);
  expect((await sendMessages(host)).length).toBe(1);

  // 再挂起一条后删除：直接丢弃、输入框保持空，同样无 discardQueuedMessage
  await page.fill('textarea.input-textarea', '再挂起一条');
  await page.locator('button[data-send-mode-caret="true"]').click();
  await page.getByText('空闲发送', { exact: true }).click();
  const banner2 = page.getByText(/空闲后发送/).first();
  await expect(banner2).toBeVisible();
  await page.locator('button[title*="删除排队消息"]').click();
  await expect(banner2).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toHaveValue('');
  expect((await host.sentAll()).filter((m) => m.type === 'discardQueuedMessage')).toHaveLength(0);

  // 撤回即取消：本轮结束后不自动提交
  await expect(page.locator('button[title="终止"]')).toBeDisabled({ timeout: 20_000 });
  expect((await sendMessages(host)).length).toBe(1);
});

test('FR-003 中止回填优先：挂起项随中止回填输入框，空闲推送不重复投递', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '慢任务。'.repeat(40), chunkDelayMs: 200 });
  await page.fill('textarea.input-textarea', '第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });

  await page.fill('textarea.input-textarea', '会被回填的消息');
  await page.locator('button[data-send-mode-caret="true"]').click();
  await page.getByText('空闲发送', { exact: true }).click();
  await expect(page.getByText(/空闲后发送/).first()).toBeVisible();

  // 中止：abort 照常上送；挂起项回填输入框、不再自动提交（中止回填优先于空闲触发）
  await page.locator('button[title="终止"]').click();
  await host.waitForSent('abort');
  await expect(page.locator('textarea.input-textarea')).toHaveValue(/会被回填的消息/, { timeout: 10_000 });
  await expect(page.getByText(/空闲后发送/).first()).toBeHidden({ timeout: 10_000 });

  // 假宿主在 abort 后回推空闲快照 + queryEnd：挂起项已清除，触发不得再投递
  await page.waitForTimeout(500);
  expect((await sendMessages(host)).length).toBe(1);
});

test('FR-003 webview 重载丢挂起项：不投递、不恢复', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '长任务。'.repeat(30), chunkDelayMs: 150 });
  await page.fill('textarea.input-textarea', '第一条消息');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeVisible({ timeout: 15_000 });
  await page.fill('textarea.input-textarea', '重载后应当丢失');
  await page.locator('button[data-send-mode-caret="true"]').click();
  await page.getByText('空闲发送', { exact: true }).click();
  await expect(page.getByText(/空闲后发送/).first()).toBeVisible();
  const sid = (await host.waitForSent('sendMessage')).sessionId as string;

  // 挂起是 webview 本地状态、无持久化：重载后横幅消失
  await page.reload();
  await host.waitReady();
  await expect(page.getByText(/空闲后发送/).first()).toBeHidden();

  // 注入该会话的空闲快照也不得触发投递（挂起项已随重载丢失）
  await host.send({
    type: 'sessionRuntimeStates',
    states: [{
      sessionId: sid, idle: true, waiting: false,
      queryRunning: false, compacting: false, backgroundRunning: false, subAgentRunning: false,
    }],
  });
  await page.waitForTimeout(500);
  expect((await host.sentAll()).filter((m) => m.type === 'sendMessage')).toHaveLength(0);
});
