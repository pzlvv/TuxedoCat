import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * Bash 卡片「转后台」按钮（`UiEvent.bashBackgroundRequested`）的整应用链路：
 * 真实 standalone core + mock LLM。
 *
 * 语义（与两侧单测一致）：
 * - 手工转后台后结果照常进入 tool_result，但下一轮 agent 循环暂停——
 *   会话回到「等待用户输入」（终止按钮转后台态、无第二次 LLM 请求）；
 * - 队列消息（暂停后新发的用户消息 / 转后台前已排队的用户消息 / 后台完成通知）
 *   到达时立刻续跑循环，续跑由队列消息触发。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

/** manual 模式下允许 Bash 权限确认 */
async function allowBashPermission(chatPage: Awaited<ReturnType<AppHandle['chatPage']>>): Promise<void> {
  const overlay = chatPage.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await overlay.getByRole('button', { name: /允许/ }).first().click();
}

/**
 * 断言转后台的 tool_result 与 assistant 的 tool_use 正确配对（不是孤儿结果），
 * 且结果文案是「已转入后台」。
 */
function expectPairedBackgroundToolResult(
  messages: MockLlm['requests'][number]['body']['messages'],
): void {
  const toolMessage = messages.find((m) => m.role === 'tool') as
    { content?: unknown; tool_call_id?: string } | undefined;
  expect(toolMessage, '上下文应带转后台的 tool_result').toBeTruthy();
  expect(String(toolMessage?.content)).toContain('Command moved to the background');
  const toolCallIds = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m.tool_calls ?? []) as Array<{ id?: string }>)
    .map((call) => call.id);
  expect(toolCallIds, 'tool_result 应对应 assistant 的 tool_use').toContain(toolMessage?.tool_call_id);
}

test('US-45 手工转后台：结果进上下文、本轮暂停等输入，新用户消息立刻续跑', async () => {
  // 第一轮 → Bash(sleep 60)；转后台的 tool_result 回传后的轮次 → 终轮文本
  mockLlm.setHandler((req) => {
    const hasBgToolResult = req.body.messages.some(
      (m) => m.role === 'tool' && String(m.content).includes('Command moved to the background'),
    );
    if (hasBgToolResult) return { kind: 'text', text: '收到后台结果。' };
    const text = lastUserText(req.body.messages);
    if (text.includes('跑个长命令')) {
      return { kind: 'tool', name: 'Bash', args: { command: 'sleep 60', description: 'Long sleep' } };
    }
    return { kind: 'text', text: '好的。' };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '跑个长命令');
  await chatPage.press('textarea.input-textarea', 'Enter');

  await allowBashPermission(chatPage);

  // Bash 卡片执行中：「转后台」按钮出现在复制按钮左侧
  const backgroundButton = chatPage.locator('button[title^="转入后台"]');
  await expect(backgroundButton).toBeVisible({ timeout: 30_000 });
  const copyButton = chatPage.locator('button[title="复制命令"]');
  await expect(copyButton).toBeVisible();
  expect(
    (await backgroundButton.boundingBox())!.x < (await copyButton.boundingBox())!.x,
    '转后台按钮应在复制按钮左侧',
  ).toBe(true);

  await backgroundButton.click();

  // 工具卡片完成：显示「已转入后台」的结果（tool_result 文案）
  await expect(chatPage.getByText(/Command moved to the background/).first()).toBeVisible({ timeout: 30_000 });
  // 按钮随卡片完成消失
  await expect(backgroundButton).toBeHidden();

  // 本轮暂停：终止按钮进入后台态（前台停、后台任务仍在跑）
  const abortButton = chatPage.locator('button[data-abort-state]');
  await expect(abortButton).toHaveAttribute('data-abort-state', 'background', { timeout: 30_000 });

  // 没有第二次 LLM 请求：下一轮 agent 循环被暂停，等待用户输入
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(mockLlm.requests.length, '手工转后台后不应发起第二次 LLM 请求').toBe(1);

  // 队列消息（新用户消息）立刻续跑：第二次请求的上下文带转后台 tool_result
  await chatPage.fill('textarea.input-textarea', '继续');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText('收到后台结果。').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => mockLlm.requests.length, { timeout: 15_000 }).toBe(2);
  // 第二轮上下文带着转后台的 tool_result，且与 assistant 的 tool_use 配对
  expectPairedBackgroundToolResult(mockLlm.requests[1].body.messages);
  // 第二轮里最后一条用户消息是新发的「继续」
  expect(lastUserText(mockLlm.requests[1].body.messages)).toContain('继续');
});

test('US-45 转后台前已排队的用户消息，在暂停点立刻接续循环', async () => {
  // 第一轮 → Bash(sleep 60)；命令跑着时用户消息进队列；转后台的暂停点发现
  // 队列非空 → 由该排队消息立刻拉起第二轮（接续由队列消息触发）
  mockLlm.setHandler((req) => {
    const text = lastUserText(req.body.messages);
    if (text.includes('跑个长命令')) {
      return { kind: 'tool', name: 'Bash', args: { command: 'sleep 60', description: 'Long sleep' } };
    }
    return { kind: 'text', text: '收到排队消息。' };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '跑个长命令');
  await chatPage.press('textarea.input-textarea', 'Enter');

  await allowBashPermission(chatPage);

  // 命令执行中（引擎忙碌）：新消息登记为排队项，不另起一轮查询
  await chatPage.fill('textarea.input-textarea', '继续');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await expect(chatPage.getByText(/等待中/).first()).toBeVisible({ timeout: 30_000 });
  expect(mockLlm.requests.length, '排队消息不应自己另起一轮').toBe(1);

  // 转后台：暂停点消费队列 → 排队消息立刻接续循环
  const backgroundButton = chatPage.locator('button[title^="转入后台"]');
  await expect(backgroundButton).toBeVisible({ timeout: 30_000 });
  await backgroundButton.click();

  await expect(chatPage.getByText('收到排队消息。').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => mockLlm.requests.length, { timeout: 30_000 }).toBe(2);
  // 第二轮上下文：转后台的 tool_result（与 tool_use 配对）+ 排队的那条用户消息
  expectPairedBackgroundToolResult(mockLlm.requests[1].body.messages);
  expect(lastUserText(mockLlm.requests[1].body.messages)).toContain('继续');
});

test('US-45 手工转后台后，后台完成通知作为队列消息立刻续跑循环', async () => {
  // sleep 6：转后台后任务很快自己完成，完成通知应作为队列消息拉起新一轮 LLM
  mockLlm.setHandler((req) => {
    const notified = req.body.messages.some(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Background task completed'),
    );
    if (notified) return { kind: 'text', text: '后台任务完成了。' };
    const last = req.body.messages[req.body.messages.length - 1];
    if (last?.role === 'tool') return { kind: 'text', text: '收到后台结果。' };
    const text = lastUserText(req.body.messages);
    if (text.includes('跑个短后台')) {
      return { kind: 'tool', name: 'Bash', args: { command: 'sleep 6', description: 'Short sleep' } };
    }
    return { kind: 'text', text: '好的。' };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '跑个短后台');
  await chatPage.press('textarea.input-textarea', 'Enter');

  await allowBashPermission(chatPage);

  const backgroundButton = chatPage.locator('button[title^="转入后台"]');
  await expect(backgroundButton).toBeVisible({ timeout: 30_000 });
  await backgroundButton.click();
  await expect(chatPage.getByText(/Command moved to the background/).first()).toBeVisible({ timeout: 30_000 });

  // 转后台时本轮暂停：此刻只有第一次请求
  expect(mockLlm.requests.length).toBe(1);

  // 后台任务（sleep 6）完成后，完成通知作为队列消息立刻续跑循环
  await expect(chatPage.getByText('后台任务完成了。').first()).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => mockLlm.requests.length, { timeout: 45_000 }).toBe(2);
  const notified = mockLlm.requests[1].body.messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Background task completed'),
  );
  expect(notified, '第二轮上下文应包含后台完成通知').toBeTruthy();
  // 同一轮里也带着转后台的 tool_result（通知与 tool_result 同轮消费）
  expectPairedBackgroundToolResult(mockLlm.requests[1].body.messages);

  // 后台任务已结束：终止按钮回到空闲（灰、禁用）
  const abortButton = chatPage.locator('button[data-abort-state]');
  await expect(abortButton).toHaveAttribute('data-abort-state', 'none', { timeout: 30_000 });
  await expect(abortButton).toBeDisabled();
});
