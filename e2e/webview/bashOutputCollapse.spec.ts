import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-14 Bash 输出折叠（与 Edit/Write 预览同一套 usePreviewLimit 实现，
 * 限高为输出框常量高度）：执行完成后缩略态只显示**末尾**实测放得下的整行
 * （overflow hidden 不出现滚动条，可见窗口钉在底部）；提示条在输出框**上方**
 * （tail 变体，chevron 朝上，flat 不自绘边框避免与命令卡片双圈）；点击提示条
 * 展开后**框高不变**，只换成框内滚动条，初始视点仍在底部、可向上滚动。
 *
 * 工具卡片挂在「用户消息开头的 segment」里渲染，注入方式与
 * bashBackgroundButton.spec.ts 同形（用户消息 → toolcall → updateToolStatus）。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

const TOTAL = 60;

/** 60 行编号输出：首行 line-001、末行 line-060-END，用于断言渲染的是末尾段 */
function bashOutput(): string {
  return Array.from({ length: TOTAL }, (_, i) =>
    i === TOTAL - 1
      ? 'line-060-END'
      : `line-${String(i + 1).padStart(3, '0')} ${'x'.repeat(24)}`,
  ).join('\n');
}

/** 注入一条用户消息 + 一张 Bash 卡片，随后以 60 行输出标记完成 */
async function addCompletedBashCard(): Promise<void> {
  const { host } = handle;
  const started = await host.waitForSent('startNewConversation');
  const sessionId = started.sessionId as string;
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: '跑个命令' });
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'toolcall',
    content: '',
    toolName: 'Bash',
    toolArgs: { command: 'echo done', description: 'Long output' },
    toolCallId: 'bash-collapse-1',
    status: 'running',
  });
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'bash-collapse-1',
    output: bashOutput(),
    status: 'success',
  });
}

/** 读取输出容器（末行 div 的父层）与相邻提示条（位于容器上方）的折叠态指标 */
async function readCollapseState(): Promise<{
  overflowY: string;
  boxHeight: number;
  lastLineBottom: number;
  boxBottom: number;
  hintTop: number;
  boxTop: number;
  hintBorderTopStyle: string;
}> {
  return handle.page.evaluate(() => {
    const lastLine = Array.from(document.querySelectorAll('div'))
      .find((n) => n.textContent === 'line-060-END') as HTMLElement | undefined;
    if (!lastLine) throw new Error('末行未渲染');
    const box = lastLine.parentElement as HTMLElement;
    const hint = box.previousElementSibling as HTMLElement | null;
    const boxRect = box.getBoundingClientRect();
    const lineRect = lastLine.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(box).overflowY,
      boxHeight: boxRect.height,
      lastLineBottom: lineRect.bottom,
      boxBottom: boxRect.bottom,
      hintTop: hint ? hint.getBoundingClientRect().top : NaN,
      boxTop: boxRect.top,
      hintBorderTopStyle: hint ? getComputedStyle(hint).borderTopStyle : 'missing',
    };
  });
}

test('US-14 完成态缩略：框高恒定、只显示末尾整行、无滚动条、提示条在上方', async () => {
  const { page } = handle;
  await addCompletedBashCard();

  // 提示条计数与实际可见整行数一致（行数随字号档位实测，不硬编码）
  await expect(page.getByText(/仅显示末尾 \d+ 行 \/ 共 60 行，点击显示全部/)).toBeVisible({ timeout: 15_000 });
  // 头部行不进 DOM：渲染的是末尾段而非开头段
  await expect(page.getByText('line-001', { exact: false })).toHaveCount(0);

  const state = await readCollapseState();
  // overflow hidden：结构上不可能出现滚动条
  expect(state.overflowY).toBe('hidden');
  // 框高恒定（与流式容器同高 115px + 1 容差），总高度与流式期间一致
  expect(state.boxHeight).toBeLessThanOrEqual(116);
  // 末行完整落在容器内（不被 overflow hidden 裁掉）
  expect(state.lastLineBottom).toBeLessThanOrEqual(state.boxBottom + 1);
  // 提示条位于输出框上方（tail 变体：更多内容在上方，向上展开）
  expect(state.hintTop).toBeLessThan(state.boxTop);
  // flat 提示条：边框只来自外层命令卡片（修复双圈边框）
  expect(state.hintBorderTopStyle).toBe('none');

  await page.screenshot({ path: 'test-results/bash-collapse-collapsed.png', fullPage: true });
});

test('US-14 点击提示条展开：框高不变、出现框内滚动条、初始视点仍在底部', async () => {
  const { page } = handle;
  await addCompletedBashCard();

  const hint = page.getByText(/仅显示末尾 \d+ 行 \/ 共 60 行，点击显示全部/);
  await expect(hint).toBeVisible({ timeout: 15_000 });
  const collapsedHeight = await page.evaluate(() => {
    const lastLine = Array.from(document.querySelectorAll('div'))
      .find((n) => n.textContent === 'line-060-END') as HTMLElement | undefined;
    if (!lastLine) throw new Error('末行未渲染');
    return (lastLine.parentElement as HTMLElement).getBoundingClientRect().height;
  });

  await hint.click();
  // 全部行渲染（整段 pre），提示条常驻上方、只换文案
  await expect(page.getByText('line-001', { exact: false })).toBeVisible();
  await expect(page.getByText('共 60 行，已显示全部')).toBeVisible();

  // 展开态量测：经 line-001 所在 pre 找输出容器（展开态无逐行 div）
  const state = await page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => n.textContent?.includes('line-001'));
    if (!pre) throw new Error('展开内容未渲染');
    const box = pre.parentElement as HTMLElement;
    const rect = box.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(box).overflowY,
      boxHeight: rect.height,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      scrollTop: box.scrollTop,
      hintTop: (box.previousElementSibling as HTMLElement).getBoundingClientRect().top,
      boxTop: rect.top,
    };
  });
  // 框高不变（展开只加滚动条）
  expect(state.boxHeight).toBeLessThanOrEqual(116);
  expect(Math.abs(state.boxHeight - collapsedHeight)).toBeLessThanOrEqual(1);
  // 框内滚动条：内容高于框、overflow auto、视点钉在底部
  expect(state.overflowY).toBe('auto');
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  expect(state.scrollTop + state.clientHeight).toBeGreaterThanOrEqual(state.scrollHeight - 2);
  // 提示条保持在输出框上方
  expect(state.hintTop).toBeLessThan(state.boxTop);

  await page.screenshot({ path: 'test-results/bash-collapse-expanded.png', fullPage: true });
});
