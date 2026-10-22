import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-47 跳到底部按钮（US-47，规格 docs/hosts/webview-ui.md 第 11 节）
 *
 * 场景级：压低视口 + 长回复撑高消息列表，真实滚轮驱动显隐。显示触发源仅限「一次向下
 * 滚动手势累计位移 > 可视高度 1/3 且不在底部」（键盘 / 滚动条拖动 / 触摸不触发，向上
 * 滚不触发）；按钮右下角常驻挂载、opacity 淡入淡出——显隐断言一律用 data-hidden 属性
 * （opacity:0 在 Playwright 中仍算 visible，不能用 toBeVisible/toBeHidden）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 撑高消息列表并等回复播完（fakeHost 分块固定 ~6 块，文本长度不影响流式时长） */
async function setupTallConversation(page: import('@playwright/test').Page): Promise<void> {
  const { host } = handle;
  await page.setViewportSize({ width: 1280, height: 500 });
  await host.setTurn({ text: '段落内容，用于撑高消息列表。'.repeat(3000), chunkDelayMs: 5 });
  await page.fill('textarea.input-textarea', '撑高列表');
  await page.press('textarea.input-textarea', 'Enter');
  await expect(page.locator('button[title="终止"]')).toBeDisabled({ timeout: 30_000 });
}

/** 断言消息列表当前不在底部（可选最小距离，避开 2px 判定带） */
async function expectAwayFromBottom(page: import('@playwright/test').Page, minDistance = 2): Promise<void> {
  const away = await page.evaluate((min) => {
    const el = document.querySelector('.messages-container');
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight > min;
  }, minDistance);
  expect(away).toBe(true);
}

/** 读取消息列表距底部的距离；容器不存在时返回 null */
async function distanceFromBottom(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.messages-container');
    if (!el) return null;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

/** 断言消息列表已贴底（与 isAtBottom 同口径的 2px 判定带） */
async function expectAtBottom(page: import('@playwright/test').Page): Promise<void> {
  await expect.poll(() => distanceFromBottom(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
}

test('US-47 底部不显示；向上滚不触发；向下达标手势显示；点击回底并隐藏', async () => {
  const { page } = handle;
  await setupTallConversation(page);
  const jump = page.locator('button[data-jump-to-bottom="true"]');

  // 回复播完、自动跟随停在底部：按钮不显示
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 真实滚轮向上滚离底部：不再触发显示（触发源仅限向下的滚轮手势）；
  // 高负载下 wheel→scroll 可能丢帧，滚动到位断言整体重试
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await expectAwayFromBottom(page, 500);
  }).toPass({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 向下达标手势：两次 400px 连滚（间隔远小于 150ms 手势阈值）累计远超可视高度 1/3 → 淡入显示；
  // 环内同时断言未触底，防止重试累计下滚意外到底造成假通过
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, 400);
    await expectAwayFromBottom(page, 800);
    await expect(jump).not.toHaveAttribute('data-hidden');
  }).toPass({ timeout: 20_000 });

  // 等淡入过渡（150ms）结束后再取样式：shown 一通过就立即读，透明度还在过渡起点附近
  await page.waitForTimeout(250);

  // 显示期间：右下角定位（距右缘 / 底缘 12px，±2px 舍入）+ opacity 过渡声明（≤200ms 上界）
  const box = await page.locator('.messages-container').boundingBox();
  const jumpBox = await jump.boundingBox();
  expect(box).not.toBeNull();
  expect(jumpBox).not.toBeNull();
  expect(Math.abs((jumpBox!.x + jumpBox!.width) - (box!.x + box!.width - 12))).toBeLessThanOrEqual(2);
  expect(Math.abs((jumpBox!.y + jumpBox!.height) - (box!.y + box!.height - 12))).toBeLessThanOrEqual(2);
  const style = await jump.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { property: cs.transitionProperty, duration: cs.transitionDuration, opacity: cs.opacity };
  });
  expect(style.opacity).toBe('1');
  expect(style.property).toContain('opacity');
  const durations = style.duration.split(',').map((d) => parseFloat(d));
  expect(Math.max(...durations)).toBeGreaterThan(0);
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.2);

  // z 序回归锁：按钮必须压过置顶吸附容器——user-msg-pin 常驻 zIndex 10 且消息容器
  // 后于按钮绘制，同 z 序时落进按钮区域的用户消息会盖住按钮（遮挡缺陷）
  const zOrder = await page.evaluate(() => {
    const btn = document.querySelector('button[data-jump-to-bottom="true"]');
    if (!btn) return null;
    const pin = document.querySelector('.user-msg-pin');
    const rect = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      btnZ: getComputedStyle(btn).zIndex,
      pinZ: pin ? getComputedStyle(pin).zIndex : '0',
      hitIsButton: hit instanceof Element && hit.closest('button[data-jump-to-bottom="true"]') !== null,
    };
  });
  expect(zOrder).not.toBeNull();
  expect(Number(zOrder!.btnZ)).toBeGreaterThan(Number(zOrder!.pinZ));
  expect(zOrder!.hitIsButton).toBe(true);

  // 点击：回到底部（钉底判定）+ 按钮隐藏（自动跟随恢复）
  await jump.click();
  await expect(jump).toHaveAttribute('data-hidden', '');
  const pinned = await page.evaluate(() => {
    const el = document.querySelector('.messages-container');
    if (!el) return false;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  });
  expect(pinned).toBe(true);
});

test('US-47 单次小幅滚动与键盘 PageDown 不触发显示', async () => {
  const { page } = handle;
  await setupTallConversation(page);
  const jump = page.locator('button[data-jump-to-bottom="true"]');

  // 大幅上滚留足余量：保证 PageDown 后仍远离底部，区分「键盘不触发」与「到底隐藏」
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await expectAwayFromBottom(page, 1500);
  }).toPass({ timeout: 20_000 });

  // 停顿超过手势阈值（150ms）后单次小幅下滚：累计不足可视高度 1/3，不显示
  await page.waitForTimeout(200);
  await page.mouse.move(640, 200);
  await page.mouse.wheel(0, 80);
  await page.waitForTimeout(150);
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 键盘 PageDown：把焦点放进滚动容器后真实按键（无 wheel 输入 → 不触发）
  await page.evaluate(() => {
    const el = document.querySelector('.messages-container') as HTMLElement | null;
    if (el) {
      el.setAttribute('tabindex', '-1');
      el.focus();
    }
  });
  const before = await page.evaluate(() => (document.querySelector('.messages-container') as HTMLElement)?.scrollTop ?? 0);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(150);
  // 防假阳性：PageDown 确实向下滚动了且仍未到底
  const after = await page.evaluate(() => {
    const el = document.querySelector('.messages-container') as HTMLElement | null;
    if (!el) return { scrollTop: 0, away: false };
    return {
      scrollTop: el.scrollTop,
      away: el.scrollHeight - el.scrollTop - el.clientHeight > 500,
    };
  });
  expect(after.scrollTop).toBeGreaterThan(before);
  expect(after.away).toBe(true);
  await expect(jump).toHaveAttribute('data-hidden', '');
});

test('US-47 滚动条拖动按下即隐藏且不恢复', async () => {
  const { page } = handle;
  await setupTallConversation(page);
  const jump = page.locator('button[data-jump-to-bottom="true"]');

  // 达标手势先让按钮显示
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, 400);
    await expect(jump).not.toHaveAttribute('data-hidden');
  }).toPass({ timeout: 20_000 });

  // 在滚动条槽（容器右缘内 3px）按下：按钮立即隐藏（Chromium 把滚动条事件派发给容器本身）
  const box = await page.locator('.messages-container').boundingBox();
  expect(box).not.toBeNull();
  const sbX = box!.x + box!.width - 3;
  const sbY = box!.y + box!.height / 2;
  await page.mouse.move(sbX, sbY);
  await page.mouse.down();
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 拖动 / 松开过程与结束后均不恢复（拖动产生的滚动没有 wheel 输入）
  await page.mouse.move(sbX, sbY - 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(jump).toHaveAttribute('data-hidden', '');
  await expectAwayFromBottom(page);
});

test('US-47 向上滚动任意幅度立即隐藏；重新显示需新的达标手势', async () => {
  const { page } = handle;
  await setupTallConversation(page);
  const jump = page.locator('button[data-jump-to-bottom="true"]');

  // 达标手势先让按钮显示
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, -800);
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, 400);
    await expectAwayFromBottom(page, 800);
    await expect(jump).not.toHaveAttribute('data-hidden');
  }).toPass({ timeout: 20_000 });

  // 向上滚动一点点（60px）：立即隐藏
  await page.mouse.move(640, 200);
  await page.mouse.wheel(0, -60);
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 小幅下滚不复现（手势累计已被向上滚动清零）
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, 80);
  await page.waitForTimeout(150);
  await expect(jump).toHaveAttribute('data-hidden', '');

  // 新的达标手势重新显示：先上滚腾出空间再下滚（上滚同时会隐藏按钮，属达标前的准备），
  // 重试每轮净余量 +400px，不会像纯下滚那样越试越贴近底部
  await expect(async () => {
    await page.mouse.move(640, 200);
    await page.mouse.wheel(0, -1200);
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, 400);
    await expectAwayFromBottom(page, 800);
    await expect(jump).not.toHaveAttribute('data-hidden');
  }).toPass({ timeout: 20_000 });
});

test('once 通知被更高新消息替换后仍贴底', async () => {
  const { page, host } = handle;
  const started = await host.waitForSent('startNewConversation');
  const sessionId = started.sessionId as string;
  await page.setViewportSize({ width: 1280, height: 500 });

  // 撑高时间线并停在底部：用户消息 + 长助手回复
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: '第一轮' });
  await host.send({
    type: 'addMessage', sessionId, role: 'assistant',
    content: '段落内容，用于撑高消息列表。'.repeat(200),
  });
  await expect(page.getByText('第一轮')).toBeVisible({ timeout: 10_000 });
  await expectAtBottom(page);

  // once 通知到达并停在末位：长度 +1，layoutEffect 强制回底
  await host.send({ type: 'addMessage', sessionId, role: 'system', content: '*User Interrupted*', once: true });
  const onceNode = page.getByText('*User Interrupted*', { exact: true });
  await expect(onceNode).toBeVisible({ timeout: 10_000 });
  await expectAtBottom(page);

  // 新消息覆盖 once：stripOnce 删一条 + 追加一条，messages.length 不变。
  // 新节点比 once 通知高——若自动滚动只按长度判定「没有新内容」，视口会停在中段。
  await host.send({
    type: 'addMessage', sessionId, role: 'assistant',
    content: `新回复开头标记\n\n${'这是新回复正文，用来撑高时间线。'.repeat(30)}`,
  });
  await expect(page.getByText('新回复开头标记')).toBeVisible({ timeout: 10_000 });
  await expect(onceNode).toHaveCount(0);
  await expectAtBottom(page);
});
