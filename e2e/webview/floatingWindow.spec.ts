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
  const popup = page.locator('.ant-dropdown:has(.conversation-dropdown)').first();
  // 弹层几何：左缘 >= 0（不越出窗口左缘）、右缘贴历史按钮右缘（bottomRight）、
  // 宽度 = min(400, 视口 - 96)（96 = 顶栏右缘固定 chrome，见 App.tsx dropdownRender）
  const expectGeometry = async (width: number) => {
    const expectedMax = Math.min(400, width - 96);
    await expect.poll(async () => {
      const box = await popup.boundingBox();
      return box ? Math.round(box.x) : -1;
    }, { message: `viewport=${width} 左缘` }).toBeGreaterThanOrEqual(0);
    const btnBox = await historyBtn.boundingBox();
    const box = await popup.boundingBox();
    expect(Math.round(box!.x + box!.width))
      .toBeLessThanOrEqual(Math.round(btnBox!.x + btnBox!.width) + 1);
    expect(Math.round(box!.width)).toBe(expectedMax);
  };

  await page.setViewportSize({ width: 480, height: 640 });
  await historyBtn.click();
  await expect(popup).toBeVisible();
  await expectGeometry(480);

  // 打开状态下缩放窗口：宽度实时跟随（有 400 上限），左缘始终 >= 0
  for (const width of [800, 280, 470]) {
    await page.setViewportSize({ width, height: 640 });
    await expectGeometry(width);
  }

  // 点击空白处关闭（Escape 不在 Dropdown 的关闭路径上）
  await page.mouse.click(20, 400);
  await expect(popup).toBeHidden();

  // 关掉再以最窄浮窗宽度打开：打开时刻的口径同样正确
  await page.setViewportSize({ width: 280, height: 640 });
  await historyBtn.click();
  await expect(popup).toBeVisible();
  await expectGeometry(280);
});
