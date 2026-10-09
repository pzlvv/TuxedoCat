import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import { FAKE_HOST_INIT_FLOATING } from '../helpers/fakeHost';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * Electron 浮窗形态的 webview 行为。
 *
 * 浮窗宿主与默认假宿主的差异：多视图（顶栏多「关闭」按钮）+ 对话列表在 webview
 * 顶栏（`FAKE_HOST_INIT_FLOATING`）。窗口窄（默认 480、最小 280），顶栏弹层的
 * 落位在这里最容易越界。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''), FAKE_HOST_INIT_FLOATING);
});

test.afterEach(async () => {
  await handle.close();
});

test('浮窗窄窗口：历史对话下拉不越出窗口左缘（bottomRight 弹层按锚点收口）', async () => {
  const { page, host } = handle;
  const DAY = 24 * 60 * 60 * 1000;
  await host.setConversations([
    {
      sessionId: 'sess-alpha', title: '调研笔记', createdAt: Date.now() - DAY,
      updatedAt: Date.now() - DAY, messageCount: 2,
      messages: [
        { type: 'user', uuid: 'u1', parentUuid: null, timestamp: Date.now() - DAY, message: { role: 'user', content: '帮我做点调研' } },
      ],
    },
  ]);

  const historyBtn = page.locator('button[title="对话历史"]');
  // 480 = 浮窗默认宽度；280 = 浮窗最小宽度。宽度收口在「打开瞬间」实测锚点，
  // 所以每个宽度都要先关掉上一次的弹层再重新打开。
  for (const width of [480, 280]) {
    await page.setViewportSize({ width, height: 640 });
    await historyBtn.click();
    const popup = page.locator('.ant-dropdown:has(.conversation-dropdown)').first();
    await expect(popup).toBeVisible();
    await expect.poll(async () => {
      const box = await popup.boundingBox();
      return box ? Math.round(box.x) : -1;
    }, { message: `viewport=${width}` }).toBeGreaterThanOrEqual(0);
    // 右缘仍与历史按钮对齐（bottomRight 语义保留）
    const btnBox = await historyBtn.boundingBox();
    const popupBox = await popup.boundingBox();
    expect(Math.round(popupBox!.x + popupBox!.width))
      .toBeLessThanOrEqual(Math.round(btnBox!.x + btnBox!.width) + 1);
    // 点击空白处关闭（Escape 不在 Dropdown 的关闭路径上）
    await page.mouse.click(20, 400);
    await expect(popup).toBeHidden();
  }
});
