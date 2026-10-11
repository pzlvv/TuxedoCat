import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-47 跳到底部按钮（US-47，规格 docs/hosts/webview-ui.md 第 11 节）
 *
 * 场景级：压低视口 + 长回复撑高消息列表，真实滚轮向上滚离底部（按钮显隐依赖
 * 「不在底部 && 用户主动滚离」，程序化 scrollTop 不带用户输入、不触发），点击按钮
 * 回底并恢复自动跟随。显隐与钉底判定均断言真实 DOM 状态。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

test('US-47 底部不显示按钮；滚离后浮现；点击回底并隐藏', async () => {
  const { page, host } = handle;
  await page.setViewportSize({ width: 1280, height: 500 });
  await host.setTurn({ text: '段落内容，用于撑高消息列表。'.repeat(200), chunkDelayMs: 5 });
  await page.fill('textarea.input-textarea', '撑高列表');
  await page.press('textarea.input-textarea', 'Enter');

  // 回复播完、自动跟随停在底部：按钮不显示
  await expect(page.locator('button[title="终止"]')).toBeDisabled({ timeout: 20_000 });
  const jump = page.locator('button[data-jump-to-bottom="true"]');
  await expect(jump).toBeHidden();

  // 真实滚轮向上滚离底部：按钮浮现（高负载下 wheel→scroll→render 可能丢帧，整体重试）
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -400);
    await expect(jump).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  const scrolledUp = await page.evaluate(() => {
    const el = document.querySelector('.messages-container');
    if (!el) return false;
    return el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  });
  expect(scrolledUp).toBe(true);

  // 点击：回到底部（钉底判定）+ 按钮隐藏（userScrolledAway 复位、自动跟随恢复）
  await jump.click();
  await expect(jump).toBeHidden({ timeout: 5_000 });
  const pinned = await page.evaluate(() => {
    const el = document.querySelector('.messages-container');
    if (!el) return false;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  });
  expect(pinned).toBe(true);
});
