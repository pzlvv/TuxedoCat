import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-13 Mermaid 预览 / US-16 长消息折叠与用户消息置顶 / US-17 压缩历史展开
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

test('US-13 mermaid 代码块带「预览图表」按钮，点击上报 openMermaidPreview', async () => {
  const { page, host } = handle;
  await host.setTurn({
    text: '```mermaid\ngraph TD; A-->B; B-->C;\n```\n',
    chunkDelayMs: 10,
  });
  await page.fill('textarea.input-textarea', '画个流程图');
  await page.press('textarea.input-textarea', 'Enter');

  const previewButton = page.locator('button[title="预览图表"]');
  await expect(previewButton).toBeVisible({ timeout: 15_000 });
  await previewButton.click();

  // 宿主收到图表源码（US-13 验收 1）
  const sent = await host.waitForSent('openMermaidPreview');
  expect(String(sent.code)).toContain('graph TD');
  expect(String(sent.code)).toContain('A-->B');
});

test('US-16 超长用户消息默认折叠，可展开/收起', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '收到。', chunkDelayMs: 10 });
  // 重复正文 + 唯一结尾，确保只有展开后才会渲染完整高度
  const longText = `${'这是一段超长的用户消息，用来触发用户气泡的折叠判定。'.repeat(30)}【末尾独特结尾标记】`;
  await page.fill('textarea.input-textarea', longText);
  await page.press('textarea.input-textarea', 'Enter');
  await host.waitForSent('sendMessage');

  // 默认折叠：出现「显示完整内容」切换（US-16 验收 1）；折叠态没有「收起」
  const expandButton = page.getByText('显示完整内容');
  await expect(expandButton).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('收起', { exact: true })).toBeHidden();

  // 展开：内容容器放开高度（展开态不再判定为截断），切换变「收起」
  await expandButton.click();
  await expect(page.getByText('收起', { exact: true })).toBeVisible();
  await expect(page.getByText('显示完整内容')).toBeHidden();
  const expanded = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.messages-container p'))
      .find((n) => n.textContent?.includes('末尾独特结尾标记')) as HTMLElement | undefined;
    if (!el) return null;
    const clip = el.closest('div[style*="max-height"], div.overflow-hidden') as HTMLElement | null;
    return clip ? { clipped: clip.scrollHeight > clip.clientHeight + 2 } : { clipped: false };
  });
  expect(expanded?.clipped).toBe(false);

  // 再收起：回到折叠态（截断判定重新生效）
  await page.getByText('收起', { exact: true }).click();
  await expect(page.getByText('显示完整内容')).toBeVisible();
});

test('US-16 窗口宽度变化改变折行数时，折叠入口随之更新', async () => {
  const { page, host } = handle;
  await host.setTurn({ text: '收到。', chunkDelayMs: 10 });
  // 宽视口约 2 行（放得下），收窄后折成 7 行左右（超出折叠高度）
  const text = `${'窗口宽度变化会改变这段用户消息的折行数。'.repeat(8)}【宽度标记】`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.fill('textarea.input-textarea', text);
  await page.press('textarea.input-textarea', 'Enter');
  await host.waitForSent('sendMessage');
  await expect(page.getByText('【宽度标记】')).toBeVisible({ timeout: 15_000 });

  // 宽视口：内容完整放得下，不显示折叠入口
  await expect(page.getByText('显示完整内容')).toBeHidden();

  // 收窄视口：折行数增加、超出折叠高度 → 折叠入口出现（US-16 验收 1）
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByText('显示完整内容')).toBeVisible({ timeout: 5_000 });

  // 再拉宽：重新放得下 → 折叠入口消失
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByText('显示完整内容')).toBeHidden({ timeout: 5_000 });
});

test('US-16 用户消息滚出视口顶部时吸附置顶，点击回到原位', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', '吸附测量依赖真实布局');
  const { page, host } = handle;
  // 压低视口 + 拉高每轮回复，保证滚动容器可滚
  await page.setViewportSize({ width: 1280, height: 480 });
  await host.setTurn({ text: `回答正文开头。\n\n${'这是较长的回答段落，用来把内容撑高。'.repeat(12)}\n\n`, chunkDelayMs: 5 });

  // 三轮对话：中间的用户消息是置顶断言对象
  for (const label of ['第一条用户消息', '第二条用户消息', '第三条用户消息']) {
    await page.fill('textarea.input-textarea', label);
    await page.press('textarea.input-textarea', 'Enter');
    await expect(page.getByText(`${label}`).first()).toBeVisible({ timeout: 15_000 });
  }

  // 把「第二条用户消息」滚到容器顶部之上：该消息吸附为置顶条（data-pinned）
  await page.evaluate(() => {
    const container = document.querySelector('.messages-container') as HTMLElement | null;
    if (!container) throw new Error('messages-container 不存在');
    const leaf = Array.from(container.querySelectorAll('*')).find((el) =>
      el.childElementCount === 0 && el.textContent === '第二条用户消息');
    if (!leaf) throw new Error('找不到目标用户消息文本节点');
    // 按置顶包裹层（含 padding/边框）整体滚出容器顶边，触发 sticky 吸附
    const wrapper = (leaf as HTMLElement).closest('.user-msg-pin') ?? leaf;
    const cr = container.getBoundingClientRect();
    const wr = wrapper.getBoundingClientRect();
    container.scrollTop += (wr.top - cr.top) + wr.height + 8;
  });
  const pinned = page.locator('[data-pinned="true"]');
  await expect(pinned).toBeVisible({ timeout: 5_000 });
  await expect(pinned).toContainText('第二条用户消息');

  // 点击置顶条空白处：跳回原位、取消置顶（US-16 验收 2）
  await pinned.click({ position: { x: 40, y: 8 } });
  await expect(page.locator('[data-pinned="true"]')).toBeHidden({ timeout: 5_000 });
});
test('US-16 置顶条只铺内容区：不盖滚动条槽、无延伸层', async ({ browserName }) => {
  // US-16 验收 2（L2 改版）基线锁：置顶条是单层渲染——sticky 容器的负边距背景铺到
  // 滚动条槽左缘为止，滚动条槽上没有任何延伸/覆盖元素。历史上曾用容器外延伸层把
  // 背景接到滚动条上，两层拼接在合成器滚动下必然撕裂（specs/defects/
  // pinned-gutter-cover-stale-height*），已随本基线整体移除；此用例防止它悄悄回来。
  test.skip(browserName !== 'chromium', '吸附测量依赖真实布局');
  const { page, host } = handle;
  await page.setViewportSize({ width: 1280, height: 480 });
  await host.setTurn({ text: `回答正文开头。\n\n${'这是较长的回答段落，用来把内容撑高。'.repeat(12)}\n\n`, chunkDelayMs: 5 });

  for (const label of ['第一条用户消息', '第二条用户消息', '第三条用户消息']) {
    await page.fill('textarea.input-textarea', label);
    await page.press('textarea.input-textarea', 'Enter');
    await expect(page.getByText(`${label}`).first()).toBeVisible({ timeout: 15_000 });
  }

  // 把「第二条用户消息」吸附到容器顶（静态位置略越过顶边即被 sticky 拦下）
  await page.evaluate(() => {
    const container = document.querySelector('.messages-container') as HTMLElement | null;
    if (!container) throw new Error('messages-container 不存在');
    const leaf = Array.from(container.querySelectorAll('*')).find((el) =>
      el.childElementCount === 0 && el.textContent === '第二条用户消息');
    if (!leaf) throw new Error('找不到目标用户消息文本节点');
    const wrapper = (leaf as HTMLElement).closest('.user-msg-pin') ?? leaf;
    const cr = container.getBoundingClientRect();
    const wr = wrapper.getBoundingClientRect();
    container.scrollTop += (wr.top - cr.top) + 4;
  });
  const pinned = page.locator('[data-pinned="true"]');
  await expect(pinned).toBeVisible({ timeout: 5_000 });
  await expect(pinned).toContainText('第二条用户消息');

  // 无延伸层：不存在任何盖在滚动条上的置顶背景元素
  await expect(page.locator('.pin-gutter-cover')).toHaveCount(0);

  // 置顶条右缘 = 滚动条槽左缘（内容区整宽）：左右都留 1.5px 取整容差
  const edges = await page.evaluate(() => {
    const container = document.querySelector('.messages-container') as HTMLElement;
    const p = document.querySelector('[data-pinned="true"]') as HTMLElement;
    const cRect = container.getBoundingClientRect();
    const pRect = p.getBoundingClientRect();
    return { pinnedRight: pRect.right, contentRight: cRect.left + container.clientWidth };
  });
  expect(Math.abs(edges.pinnedRight - edges.contentRight)).toBeLessThanOrEqual(1.5);
});
