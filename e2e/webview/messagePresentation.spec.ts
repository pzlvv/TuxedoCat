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

test('US-16 置顶条被下一条用户消息顶出时，滚动条上的背景延伸条随可见高度收窄', async ({ browserName }) => {
  // 缺陷规格 specs/defects/pinned-gutter-cover-stale-height.md RT-1：
  // 延伸条（.pin-gutter-cover）在滚动容器父级、不受滚动裁剪，被顶出的置顶消息
  // 若仍按完整高度铺 gutter，会在滚动条上留一截伸出消息实际底边的悬空色块
  test.skip(browserName !== 'chromium', '吸附测量依赖真实布局');
  const { page, host } = handle;
  await page.setViewportSize({ width: 1280, height: 480 });
  await host.setTurn({ text: `回答正文开头。\n\n${'这是较长的回答段落，用来把内容撑高。'.repeat(12)}\n\n`, chunkDelayMs: 5 });

  for (const label of ['第一条用户消息', '第二条用户消息', '第三条用户消息']) {
    await page.fill('textarea.input-textarea', label);
    await page.press('textarea.input-textarea', 'Enter');
    await expect(page.getByText(`${label}`).first()).toBeVisible({ timeout: 15_000 });
  }

  // 第一步：让「第二条用户消息」刚好吸附到容器顶（静态位置略越过顶边即被 sticky 拦下），
  // 并确认延伸条已铺上滚动条 gutter
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
  await expect(page.locator('.pin-gutter-cover')).toHaveCount(1);

  // 第二步：下滚让「第三条用户消息」顶部停在容器顶下 24px——仍在第二条的置顶窗口内
  // （二分查找阈值是容器顶 +0.5px），但第二条已被自身分组底边顶出、可见高度收窄到个位像素
  await page.evaluate(() => {
    const container = document.querySelector('.messages-container') as HTMLElement | null;
    if (!container) throw new Error('messages-container 不存在');
    const leaf = Array.from(container.querySelectorAll('*')).find((el) =>
      el.childElementCount === 0 && el.textContent === '第三条用户消息');
    if (!leaf) throw new Error('找不到下一条用户消息文本节点');
    const wrapper = (leaf as HTMLElement).closest('.user-msg-pin') ?? leaf;
    const cr = container.getBoundingClientRect();
    const wr = wrapper.getBoundingClientRect();
    container.scrollTop += (wr.top - cr.top) - 24;
  });

  // 中间态成立：第二条仍持置顶身份且延伸条还在渲染（消息尚有可见段）
  await expect(page.locator('.pin-gutter-cover')).toHaveCount(1);
  // 延伸条不得伸出置顶消息的实际底边（底边重合允许 1.5px 取整容差）
  await expect(async () => {
    const m = await page.evaluate(() => {
      const cover = document.querySelector('.pin-gutter-cover') as HTMLElement | null;
      const p = document.querySelector('[data-pinned="true"]') as HTMLElement | null;
      if (!cover || !p) throw new Error('延伸条或置顶条不存在');
      return { coverBottom: cover.getBoundingClientRect().bottom, pinnedBottom: p.getBoundingClientRect().bottom };
    });
    expect(m.coverBottom).toBeLessThanOrEqual(m.pinnedBottom + 1.5);
  }).toPass({ timeout: 5_000 });
  await expect(pinned).toContainText('第二条用户消息');
});

test('US-16 滚动进行中延伸条与置顶消息可见段同帧对齐', async ({ browserName }) => {
  // 缺陷规格 specs/defects/pinned-gutter-cover-stale-height-2.md RT-2：
  // 延伸条高度若走 React state，滚动生效帧与测量提交帧之间至少差一拍（帧预算紧张时更多），
  // 滚动条上的延伸条会以旧高度闪现长条。在 scroll 监听器内（同帧、rAF 测量之前）采样，
  // 锁「延伸条底边 ≤ 置顶消息实际底边」在滚动进行中每帧成立。
  test.skip(browserName !== 'chromium', '吸附测量依赖真实布局');
  const { page, host } = handle;
  await page.setViewportSize({ width: 1280, height: 480 });
  await host.setTurn({ text: `回答正文开头。\n\n${'这是较长的回答段落，用来把内容撑高。'.repeat(12)}\n\n`, chunkDelayMs: 5 });

  for (const label of ['第一条用户消息', '第二条用户消息', '第三条用户消息']) {
    await page.fill('textarea.input-textarea', label);
    await page.press('textarea.input-textarea', 'Enter');
    await expect(page.getByText(`${label}`).first()).toBeVisible({ timeout: 15_000 });
  }

  // 让「第二条用户消息」吸附到容器顶（复用 RT-1 第一步的几何）
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
  await expect(page.locator('.pin-gutter-cover')).toHaveCount(1);

  // 先让「第三条用户消息」停在容器顶下 120px（第二条仍完整吸附，扫描起点在窗口上方），
  // 再逐帧下滚扫到 24px（步长 ≈9.6px，远大于 1.5px 容差）。采样用独立常驻 rAF 循环：
  // rAF 相位在 scroll 监听器之后、绘制之前——若延伸条高度要等 rAF 测量/React 提交才更新，
  // 此刻读到的必是上一帧残值；契约要求 scroll 生效帧内（rAF 时刻）高度已对齐。
  // scrollTop 赋值放任务态（setTimeout 续体），保证每帧一个新滚动位。
  // 采样对象固定为第二条（整个窗口内置顶身份不变）。
  const samples = await page.evaluate(async () => {
    const container = document.querySelector('.messages-container') as HTMLElement | null;
    if (!container) throw new Error('messages-container 不存在');
    const leaf = Array.from(container.querySelectorAll('*')).find((el) =>
      el.childElementCount === 0 && el.textContent === '第三条用户消息');
    if (!leaf) throw new Error('找不到下一条用户消息文本节点');
    const wrapper = (leaf as HTMLElement).closest('.user-msg-pin') ?? leaf;
    const cr = container.getBoundingClientRect();
    const wr = wrapper.getBoundingClientRect();
    container.scrollTop += (wr.top - cr.top) - 120; // 起点：第三条顶部在容器顶下 120px
    const total = 120 - 24; // 终点与 RT-1 一致：第三条顶部停在容器顶下 24px
    const steps = 10;
    const delta = total / steps;
    const collected: Array<{ coverBottom: number; pinnedBottom: number }> = [];
    let sampling = true;
    const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const sampleLoop = () => {
      if (!sampling) return;
      const cover = document.querySelector('.pin-gutter-cover') as HTMLElement | null;
      const p = document.querySelector('[data-pinned="true"]') as HTMLElement | null;
      // 高度收为 0（display:none）的帧不采样——「完全顶出未移交」窗口契约本就不渲染
      if (cover && p && cover.style.display !== 'none') {
        const cRect = container.getBoundingClientRect();
        const pRect = p.getBoundingClientRect();
        // 只采中间态：置顶消息仍有可见段（底边在容器顶之下）
        if (pRect.bottom > cRect.top + 1) {
          collected.push({ coverBottom: cover.getBoundingClientRect().bottom, pinnedBottom: pRect.bottom });
        }
      }
      requestAnimationFrame(sampleLoop);
    };
    requestAnimationFrame(sampleLoop);
    try {
      for (let i = 0; i < steps; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0)); // 任务态节拍：一帧一步
        container.scrollTop += delta;
        await raf();
      }
    } finally {
      sampling = false;
    }
    return collected;
  });

  // 扫描确实穿过中间态（防 vacuous 绿）：至少 3 个有效样本
  expect(samples.length).toBeGreaterThanOrEqual(3);
  for (const s of samples) {
    expect(s.coverBottom).toBeLessThanOrEqual(s.pinnedBottom + 1.5);
  }
});

test('US-17 压缩历史：展开按钮 → expandCompact → 整批替换并隐藏按钮', async () => {
  const { page, host } = handle;
  const DAY = 3600_000;
  const msg = (uuid: string, role: 'user' | 'assistant', text: string, ts: number) => ({
    type: role, uuid, parentUuid: null, timestamp: ts,
    message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
  });
  const t0 = Date.now() - 2 * DAY;
  await host.setConversations([{
    sessionId: 'sess-compact', title: '被压缩的对话', createdAt: t0, updatedAt: t0, messageCount: 2,
    hasCompactArchive: true,
    messages: [
      msg('c-u1', 'user', '压缩前的用户问题', t0),
      msg('c-a1', 'assistant', '压缩摘要：之前讨论了一些内容。', t0 + 1000),
    ],
  }]);
  // expandCompact 应答：归档里的原始消息整批替换（messagesReplaced 的单项是扁平
  // MessageData：role + 字符串 content，宿主侧 buildReplayMessageData 已把内容块拍平）
  await host.setExpandedMessages([
    { role: 'user', content: '压缩前的用户问题' },
    { role: 'assistant', content: '压缩前的完整回答第一段。' },
    { role: 'user', content: '压缩前的追问' },
    { role: 'assistant', content: '压缩前的完整回答第二段。' },
  ]);

  // 打开历史并加载该会话
  await page.locator('button[title="对话历史"]').click();
  await page.getByText('被压缩的对话').click();

  // 存在压缩归档：展开按钮出现，摘要先展示（US-17 验收 1）
  const expandButton = page.getByText('展开压缩的对话历史');
  await expect(expandButton).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('压缩摘要').first()).toBeVisible();

  // 点击展开：宿主收到 expandCompact，返回后整批替换显示（验收 2）
  await expandButton.click();
  await host.waitForSent('expandCompact');
  await expect(page.getByText('压缩前的完整回答第一段。').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('压缩前的追问').first()).toBeVisible();
  await expect(expandButton).toBeHidden();
});
