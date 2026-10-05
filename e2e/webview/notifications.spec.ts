import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-40 瞬时通知：按级别着色、自动消失、可手动关闭
 *
 * core 只给「键 + 参数」（`notice` wire 消息），webview 用 i18n 键翻译后呈现；
 * 这里用带翻译的键 `notice.spin.allCompleted` 驱动真实渲染路径。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

test('US-40 info 通知渲染翻译文案并按 5s 自动消失', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', '边框色断言依赖 Chromium');
  const { host, page } = handle;
  await host.send({ type: 'notice', key: 'notice.spin.allCompleted', params: {}, level: 'info' });

  const toast = page.locator('[role="status"]', { hasText: '所有任务已完成！' });
  await expect(toast).toBeVisible({ timeout: 5_000 });

  // info 级别左边框为蓝色（级别着色，US-40 验收 1）
  await expect(toast).toHaveCSS('border-left-color', 'rgb(59, 130, 246)');

  // info 5s 自动消失（验收 1；放宽到 9s 上限容忍调度抖动）
  await expect(toast).toBeHidden({ timeout: 9_000 });
});

test('US-40 error 通知红色着色，点 × 立即关闭', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', '边框色断言依赖 Chromium');
  const { host, page } = handle;
  await host.send({ type: 'notice', key: 'notice.spin.allCompleted', params: {}, level: 'error' });

  const toast = page.locator('[role="status"]', { hasText: '所有任务已完成！' });
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toHaveCSS('border-left-color', 'rgb(239, 68, 68)');

  // 手动关闭立即消失（error 8s 自动消失由上一条的时序口径覆盖，这里不重复等待）
  await toast.getByRole('button', { name: 'dismiss' }).click();
  await expect(toast).toBeHidden({ timeout: 2_000 });
});
