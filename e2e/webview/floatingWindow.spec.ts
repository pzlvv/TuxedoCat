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
  // 宽度 = min(400, 视口 - 96)（96 = 顶栏右缘固定 chrome，见 App.tsx dropdownRender）。
  //
  // headless 下 setViewportSize 的视口度量（100vw / clientWidth）立即生效，而
  // LayoutView 的实际 resize 随帧节流落地（实测滞后 ~250ms）：resize 事件先到，
  // antd 在「度量新 / 布局旧」的混合态里对齐，autoAdjustOverflow 还会因 bottomRight
  // 左越界翻成 bottomLeft，弹层停在越界 48px 的位置；按钮布局随后落地但位置平移
  // 不改尺寸，ResizeObserver 不触发，错位永不自愈（CI 上 Expected <= 385 /
  // Received 704 即过渡态样本）。真实浮窗拖拽缩放是连续 resize 事件流，最后一个
  // 事件必然落在布局稳定之后，产品里不存在该状态。因此每个样本在同一 JS 任务里
  // 强制同步布局 + 补发一次 resize（@rc-component/trigger 的 useWatch 监听 window
  // resize 同步 onAlign），等价于拖拽流最后一个事件的口径，再读几何快照；
  // 布局未落地的样本断言不过由轮询重采兜住。
  const expectGeometry = async (width: number) => {
    const expectedMax = Math.min(400, width - 96);
    // toPass 而不是 expect.poll：poll 只在「返回值匹配失败」时重试，回调内抛错
    // （含断言失败）会立即终止；toPass 对回调内任何错误都重试直到超时。
    await expect(async () => {
      const geo = await page.evaluate(() => {
        document.body.getBoundingClientRect();
        window.dispatchEvent(new Event('resize'));
        const btn = document.querySelector<HTMLButtonElement>('button[title="对话历史"]');
        const dropdown = document.querySelector<HTMLElement>(
          '.ant-dropdown:has(.conversation-dropdown) .conversation-dropdown',
        );
        if (!btn || !dropdown) {
          return null;
        }
        const btnRect = btn.getBoundingClientRect();
        const popupRect = dropdown.getBoundingClientRect();
        return {
          left: Math.round(popupRect.x),
          right: Math.round(popupRect.right),
          width: Math.round(popupRect.width),
          btnRight: Math.round(btnRect.right),
        };
      });
      if (!geo) {
        throw new Error(`viewport=${width} 几何目标未渲染（弹层未打开）`);
      }
      expect(geo.left, `viewport=${width} 左缘`).toBeGreaterThanOrEqual(0);
      expect(geo.right, `viewport=${width} 右缘收口`).toBeLessThanOrEqual(geo.btnRight + 1);
      expect(geo.width, `viewport=${width} 宽度`).toBe(expectedMax);
    }).toPass();
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
