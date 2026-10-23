import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-57 `@` 工作区补全与提醒注入（specs/023 FR-007）
 *
 * webview UI 级链路：假宿主在 `requestWorkspaces` 时下发「除本工作区之外的已打开工作区」，
 * 断言候选菜单、过滤、引号形态插入与「只认首字符」。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

test('US-57 @ 工作区补全：候选列表与插入引号形态', async () => {
  const { page } = handle;
  const input = page.locator('textarea.input-textarea');

  await input.click();
  await input.fill('@');

  // 候选：宿主下发的两个工作区（目录名 + 身份 ID）
  await expect(page.getByText('alpha', { exact: true })).toBeVisible();
  await expect(page.getByText('gamma', { exact: true })).toBeVisible();
  await expect(page.getByText('DEV-PC:C:\\Program Files\\gamma')).toBeVisible();

  // 键盘选中第二项（gamma，身份含空格）→ 插入引号形态
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('@"DEV-PC:C:\\Program Files\\gamma" ');
});

test('US-57 @ 只认首字符：正文中的 @ 不弹候选', async () => {
  const { page } = handle;
  const input = page.locator('textarea.input-textarea');

  await input.click();
  await input.fill('看下 @alpha 这个');
  await expect(page.getByText('alpha', { exact: true })).toHaveCount(0);
});
