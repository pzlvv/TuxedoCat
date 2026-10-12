import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-6 粘贴图片发送 / US-10 当前文件引用开关 / US-11 余额与缓存命中率展示
 *
 * 场景级：真实 webview bundle + 假宿主应答（`e2e/helpers/fakeHost.ts`）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 在输入框上派发一次携带图片文件的 paste 事件（1x1 PNG） */
async function pasteImage(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('textarea.input-textarea')!;
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test('US-6 粘贴图片出缩略图，可移除；仅图片也可发送，发送时携带图片', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '收到图片。', chunkDelayMs: 10 });

  // 粘贴 → 缩略图出现，右上角 hover 出「移除图片」按钮
  await pasteImage(page);
  const removeButton = page.locator('button[title="移除图片"]');
  await expect(removeButton).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('img[alt="pasted image"]')).toBeVisible();

  // 输入框为空但有图片：发送按钮可用（US-6 + US-1 的可用性口径）
  const sendButton = page.locator('button:has(.ti-send)').last();
  await expect(sendButton).toBeEnabled();

  // 移除按钮删掉缩略图后：无内容不可发送
  await removeButton.hover();
  await removeButton.click();
  await expect(page.locator('img[alt="pasted image"]')).toBeHidden();
  await expect(sendButton).toBeDisabled();

  // 再粘贴一张并随文本发送：sendMessage 携带 images（dataUrl + mediaType）
  await pasteImage(page);
  await page.fill('textarea.input-textarea', '看这张截图');
  await page.press('textarea.input-textarea', 'Enter');
  const sent = await host.waitForSent('sendMessage');
  expect(sent.images?.length).toBe(1);
  expect(String(sent.images[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
  expect(sent.images[0].mediaType).toBe('image/png');
});

test('US-10 文件 chip 展示与隐藏切换：隐藏态发送不携带文件信息', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '好的。', chunkDelayMs: 10 });
  await host.send({
    type: 'setCurrentFile',
    filePath: 'D:\\proj\\src\\app.ts',
    selectedLines: { start: 3, end: 8 },
  });

  // chip 显示文件名 + 行号区间（title 按 fileHidden 态在「点击恢复/点击隐藏」间切换）
  const chip = page.locator('span[title*="文件信息"]');
  await expect(chip).toBeVisible({ timeout: 5_000 });
  await expect(chip).toContainText('app.ts:3~8');

  // 初始为隐藏态（eye-off、半透明、title 是「点击恢复」）
  await expect(chip).toHaveAttribute('title', '点击恢复，文件信息将发给 LLM');

  // 点击 chip → 恢复携带态
  await chip.click();
  await expect(chip).toHaveAttribute('title', '点击隐藏，文件信息不发给 LLM');

  // 恢复态发送：filePath / selectedLines 随消息上报
  await page.fill('textarea.input-textarea', '看看这个文件');
  await page.press('textarea.input-textarea', 'Enter');
  const sent = await host.waitForSent('sendMessage');
  expect(sent.filePath).toBe('D:\\proj\\src\\app.ts');
  expect(sent.fileHidden).toBe(false);
  expect(sent.selectedLines).toEqual({ start: 3, end: 8 });
});

test('US-11 余额展示金额/无限/清空三态', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '好。', chunkDelayMs: 10 });
  await page.fill('textarea.input-textarea', '查余额');
  await page.press('textarea.input-textarea', 'Enter');
  const sent = await host.waitForSent('sendMessage');
  const sid = sent.sessionId as string;

  // 金额态：货币符号 + 两位小数
  await host.send({
    type: 'balanceUpdate', sessionId: sid,
    totalBalance: 12.34, currency: 'USD', isUnlimited: false, fetchedAt: Date.now(),
  });
  await expect(page.getByText('余额 $12.34')).toBeVisible({ timeout: 5_000 });

  // 无限额度态
  await host.send({
    type: 'balanceUpdate', sessionId: sid,
    totalBalance: null, currency: null, isUnlimited: true, fetchedAt: Date.now(),
  });
  await expect(page.getByText('余额 无限')).toBeVisible();

  // 查询失败态：清空显示
  await host.send({
    type: 'balanceUpdate', sessionId: sid,
    totalBalance: null, currency: null, isUnlimited: null, fetchedAt: Date.now(),
  });
  await expect(page.getByText('余额 无限')).toBeHidden({ timeout: 5_000 });
});

test('US-11 缓存命中率随流式 usage 累计，tooltip 含读写明细', async () => {
  const { page, host } = handle;
  // input 1000 中缓存读 600、缓存写 200 → 原始输入 200；命中率 600/(600+200)=75%
  await host.setTurn({
    text: '带缓存统计的回答。',
    chunkDelayMs: 10,
    usage: {
      input_tokens: 1000, output_tokens: 50,
      cache_read_input_tokens: 600, cache_creation_input_tokens: 200,
    },
  });
  await page.fill('textarea.input-textarea', '触发一轮带缓存用量的回复');
  await page.press('textarea.input-textarea', 'Enter');

  const cacheHit = page.getByText(/命中 75\.00%/);
  await expect(cacheHit).toBeVisible({ timeout: 15_000 });

  // tooltip：读取 / 创建 / 原始输入三项明细
  const title = await cacheHit.getAttribute('title');
  expect(title).toContain('600');
  expect(title).toContain('200');
});

/**
 * specs/006 FR-008：多行输入框高度随行数自适应。
 *
 * 高度上限只有一处来源（`maxRows`）：内容在 1–12 行内时高度恰好容纳、不出现滚动条，
 * 超过 12 行才停在上限并出现框内滚动条。此前 className 上还挂着 `max-h-[200px]`，
 * 像素上限把库算出的高度截短（11 / 12 行就冒出滚动条）。
 */
test('US-1 多行输入框高度自适应：未超上限不出现滚动条，超上限才滚动', async () => {
  const { page } = handle;
  const ta = page.locator('textarea.input-textarea');
  await expect(ta).toBeVisible({ timeout: 15_000 });
  const measure = () => ta.evaluate((el: HTMLTextAreaElement) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  const typeLines = async (count: number) => {
    await ta.fill('');
    await ta.click();
    await page.keyboard.insertText(Array.from({ length: count }, (_, i) => `line-${i + 1}`).join('\n'));
  };

  // 两行：高度恰好容纳（AC-17）
  await typeLines(2);
  const two = await measure();
  expect(two.scrollHeight).toBeLessThanOrEqual(two.clientHeight + 1);

  // 上限内（12 行）：仍不出现滚动条（AC-18）
  await typeLines(12);
  const twelve = await measure();
  expect(twelve.scrollHeight).toBeLessThanOrEqual(twelve.clientHeight + 1);

  // 超过上限（16 行）：高度停在上限，出现框内滚动条（AC-18）
  await typeLines(16);
  const sixteen = await measure();
  expect(sixteen.scrollHeight).toBeGreaterThan(sixteen.clientHeight + 1);
});
