import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * Bash 卡片「转后台」按钮（`backgroundBashTool` 消息）的 webview 侧行为：
 * 执行中（status=running）显示在复制按钮左侧；点击上报 sessionId + toolCallId；
 * 卡片完成后隐藏。core 侧链路（转后台 + 暂停循环）由 electron 整应用用例覆盖
 * （`e2e/electron/backgroundBash.spec.ts`）。
 *
 * 工具卡片挂在「用户消息开头的 segment」里渲染（MessagesView 的分组逻辑），
 * 因此注入卡片前先注入一条用户消息，与真实链路（用户消息 → LLM 工具轮）同形。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

async function currentSessionId(): Promise<string> {
  const started = await handle.host.waitForSent('startNewConversation');
  return started.sessionId as string;
}

/** 注入一条用户消息 + 一张 Bash 工具卡片（默认执行中） */
async function addBashCard(
  host: WebviewHandle['host'],
  sessionId: string,
  toolCallId: string,
  status: 'running' | 'success',
): Promise<void> {
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'user',
    content: '跑个长命令',
  });
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'toolcall',
    content: '',
    param: 'Bash',
    toolName: 'Bash',
    toolArgs: { command: 'sleep 30', description: 'Long sleep' },
    toolCallId,
    status,
  });
}

test('US-45 执行中的 Bash 卡片显示「转后台」按钮，位于复制按钮左侧', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await addBashCard(host, sessionId, 'bash-run-1', 'running');

  const backgroundButton = page.locator('button[title^="转入后台"]');
  await expect(backgroundButton).toBeVisible({ timeout: 10_000 });

  const copyButton = page.locator('button[title="复制命令"]');
  await expect(copyButton).toBeVisible();
  const bgBox = await backgroundButton.boundingBox();
  const copyBox = await copyButton.boundingBox();
  expect(bgBox && copyBox && bgBox.x < copyBox.x, '转后台按钮应在复制按钮左侧').toBe(true);
});

test('US-45 点击「转后台」上报 backgroundBashTool（sessionId + toolCallId）', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await addBashCard(host, sessionId, 'bash-run-2', 'running');

  const backgroundButton = page.locator('button[title^="转入后台"]');
  await expect(backgroundButton).toBeVisible({ timeout: 10_000 });
  await backgroundButton.click();

  const sent = await host.waitForSent('backgroundBashTool');
  expect(sent.sessionId).toBe(sessionId);
  expect(sent.toolUseId).toBe('bash-run-2');
});

test('US-45 卡片完成后不再显示「转后台」按钮', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();

  // 直接以完成态加载的卡片：没有按钮
  await addBashCard(host, sessionId, 'bash-done-1', 'success');
  await expect(page.locator('button[title="复制命令"]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('button[title^="转入后台"]')).toHaveCount(0);

  // 执行中 → 完成的状态切换也会撤下按钮
  await addBashCard(host, sessionId, 'bash-run-3', 'running');
  await expect(page.locator('button[title^="转入后台"]').first()).toBeVisible({ timeout: 10_000 });
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'bash-run-3',
    status: 'success',
    output: 'done',
  });
  await expect(page.locator('button[title^="转入后台"]')).toHaveCount(0, { timeout: 10_000 });
});
