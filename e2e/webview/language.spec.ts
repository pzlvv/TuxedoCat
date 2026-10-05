import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-41 界面语言切换立即生效
 *
 * 设置面板切 English 保存 → 宿主回 llmConfigSaved（带 language）→
 * 界面整体重挂载为新语言，全部文案立即切换（US-41 / US-24 验收 2）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

test('US-41 语言切 English 保存后全部文案立即切换', async () => {
  const { page, host } = handle;

  // 经功能菜单打开设置（与 settings.spec 同一入口），界面语言切 English 后保存
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  await menu.getByText('设置', { exact: true }).click({ force: true });
  await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();

  await page.getByText('界面语言').locator('..').getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();

  const saved = await host.waitForSent('saveLLMConfig', 15_000);
  expect(saved.language).toBe('en');

  // 保存回执带 language=en：界面重挂载，顶栏按钮与功能菜单标题全部切英文
  await expect(page.locator('button[title="Conversation History"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('textarea.input-textarea')).toBeVisible();

  const menuButtonEn = page.locator('button[title="Options"]');
  await expect(menuButtonEn).toBeVisible({ timeout: 10_000 });
  await menuButtonEn.click();
  const menuEn = page.locator('ul.agent-mode-menu');
  await expect(menuEn.getByText('Settings', { exact: true })).toBeVisible();
  await expect(menuEn.getByText('Model', { exact: true })).toBeVisible();
});
