import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-18 工具执行前的权限确认（UserChoiceOverlay）
 *
 * 假宿主直接下发 `requestUserChoice`（真实链路：core RunTools ask →
 * UserChoiceQueue → 宿主 wire），覆盖点选、数字快捷键、自定义文本三种应答。
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

async function requestPermission(sessionId: string): Promise<void> {
  await handle.host.send({
    type: 'requestUserChoice',
    sessionId,
    choiceId: 'choice-e2e-1',
    toolName: 'Write',
    message: 'Write 工具请求写入文件 notes.md，是否允许？',
    choices: [
      { label: '允许', description: '创建文件' },
      { label: '拒绝', description: '取消操作' },
    ],
  });
}

test('US-18 点击「允许」提交权限确认', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestPermission(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(overlay.getByText('Write 工具请求写入文件 notes.md，是否允许？')).toBeVisible();
  await expect(overlay.getByText(/允许/).first()).toBeVisible();
  await expect(overlay.getByText(/拒绝/).first()).toBeVisible();

  await overlay.getByRole('button', { name: /允许/ }).first().click();

  const resp = await host.waitForSent('respondUserChoice');
  expect(resp.choiceId).toBe('choice-e2e-1');
  expect(resp.index).toBe(0);
  // 确认框关闭，主输入框恢复
  await expect(overlay).toBeHidden();
  await expect(page.locator('textarea.input-textarea')).toBeVisible();
});

test('US-18 数字快捷键「2」直接拒绝', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestPermission(sessionId);

  await expect(page.locator('.user-choice-overlay')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('2');

  const resp = await host.waitForSent('respondUserChoice');
  expect(resp.index).toBe(1);
});

test('US-18 输入自定义文本提交（携带 reply）', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  await requestPermission(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  const input = overlay.locator('textarea');
  await input.fill('改成只写前半部分');
  await input.press('Enter');

  const resp = await host.waitForSent('respondUserChoice');
  // 带 choices 的请求里文本提交按「拒绝 + 原因」语义携带 index=1（useAppHandlers）
  expect(resp.index).toBe(1);
  expect(resp.reply).toBe('改成只写前半部分');
});

test('US-18 权限等待期间主输入框被替换、未发送草稿在确认后保留', async () => {
  const { page, host } = handle;
  const sessionId = await currentSessionId();
  // 用户正在打草稿时权限请求弹出（草稿被暂存）
  await page.fill('textarea.input-textarea', '我还没打完的草稿');
  await requestPermission(sessionId);

  const overlay = page.locator('.user-choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toBeHidden();

  await overlay.getByRole('button', { name: /允许/ }).first().click();
  await host.waitForSent('respondUserChoice');

  // 确认后主输入框恢复且草稿保留
  await expect(page.locator('textarea.input-textarea')).toBeVisible();
  await expect(page.locator('textarea.input-textarea')).toHaveValue('我还没打完的草稿');
});
