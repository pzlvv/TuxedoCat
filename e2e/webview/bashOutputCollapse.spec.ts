import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-14 Bash 输出折叠（与 Edit/Write 预览同一套 usePreviewLimit 实现，
 * 限高为输出框常量高度）：执行完成后缩略态只显示**末尾**实测放得下的整行
 * （overflow hidden 不出现滚动条，可见窗口钉在底部）；提示条在输出框**上方**
 * （tail 变体，chevron 朝上），外框与 Edit/Write 的提示条镜像——自绘四边边框、
 * 倒圆上角，下边那一条即与输出框之间的分割线；
 * 点击提示条展开后**提示条让位**：输出框接管它的高度（卡片总高不变），换成框内
 * 滚动条，初始视点仍在底部、可向上滚动。
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
  boxWidth: number;
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
    // 提示条是输出容器（`px-3 py-2` 那层）的**前一个兄弟**——它整条铺满命令卡片，
    // 不随输出框一起内缩。
    const hint = (box.parentElement as HTMLElement).previousElementSibling as HTMLElement | null;
    const boxRect = box.getBoundingClientRect();
    const lineRect = lastLine.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(box).overflowY,
      boxHeight: boxRect.height,
      boxWidth: boxRect.width,
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
  // tail 提示条：自绘四边边框（与 Edit/Write 提示条镜像），下边那一条即与输出框
  // 之间的分割线
  expect(state.hintBorderTopStyle).toBe('solid');
  const divider = await page.evaluate(() => {
    const lastLine = Array.from(document.querySelectorAll('div'))
      .find((n) => n.textContent === 'line-060-END') as HTMLElement | undefined;
    if (!lastLine) throw new Error('末行未渲染');
    const container = lastLine.parentElement?.parentElement as HTMLElement | null;
    const hint = container?.previousElementSibling as HTMLElement | null;
    if (!hint) throw new Error('提示条未渲染');
    const style = getComputedStyle(hint);
    return {
      bottomStyle: style.borderBottomStyle,
      bottomWidth: style.borderBottomWidth,
      borderRadius: style.borderRadius,
      width: hint.getBoundingClientRect().width,
      height: hint.getBoundingClientRect().height,
    };
  });
  expect(divider.bottomStyle).toBe('solid');
  expect(divider.bottomWidth).toBe('1px');
  // 倒圆上角：与输出框上方相接的那一侧是直角
  expect(divider.borderRadius).toBe('4px 4px 0px 0px');
  // 整条铺满命令卡片（比内缩的输出框宽）
  expect(divider.width).toBeGreaterThan(state.boxWidth);
  // 固定高度：展开时「提示条高度整体转给输出框」靠它精确成立
  expect(divider.height).toBeGreaterThan(0);
  expect(divider.height).toBeLessThanOrEqual(23);

  await page.screenshot({ path: 'test-results/bash-collapse-collapsed.png', fullPage: true });
});

test('US-14 点击提示条展开：提示条让位、框高增加、出现框内滚动条、初始视点仍在底部', async () => {
  const { page } = handle;
  await addCompletedBashCard();

  const hint = page.getByText(/仅显示末尾 \d+ 行 \/ 共 60 行，点击显示全部/);
  await expect(hint).toBeVisible({ timeout: 15_000 });
  // 折叠态：提示条 + 输出框（展开后提示条让位，这段高度整体交给输出框）
  const collapsed = await page.evaluate(() => {
    const lastLine = Array.from(document.querySelectorAll('div'))
      .find((n) => n.textContent === 'line-060-END') as HTMLElement | undefined;
    if (!lastLine) throw new Error('末行未渲染');
    const box = lastLine.parentElement as HTMLElement;
    const hintEl = (box.parentElement as HTMLElement).previousElementSibling as HTMLElement | null;
    return {
      boxHeight: box.getBoundingClientRect().height,
      hintHeight: hintEl ? hintEl.getBoundingClientRect().height : 0,
    };
  });
  expect(collapsed.hintHeight).toBeGreaterThan(0);

  await hint.click();
  // 全部行渲染（整段 pre）；提示条不再渲染——它让出的高度归输出框
  await expect(page.getByText('line-001', { exact: false })).toBeVisible();
  await expect(page.getByText('共 60 行，已显示全部')).toHaveCount(0);

  // 展开态量测：经 line-001 所在 pre 找输出容器（展开态无逐行 div）
  const state = await page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => n.textContent?.includes('line-001'));
    if (!pre) throw new Error('展开内容未渲染');
    const box = pre.parentElement as HTMLElement;
    const rect = box.getBoundingClientRect();
    // 展开后提示条整条从 DOM 消失（外层只剩命令行那一行）
    const sibling = (box.parentElement as HTMLElement).previousElementSibling as HTMLElement | null;
    return {
      overflowY: getComputedStyle(box).overflowY,
      boxHeight: rect.height,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      scrollTop: box.scrollTop,
      hasHint: !!sibling && (sibling.textContent || '').includes('仅显示末尾'),
    };
  });
  // 提示条不再占据布局（卡片总高不变：提示条高度整体转给输出框）
  expect(state.hasHint).toBe(false);
  expect(state.boxHeight - collapsed.boxHeight).toBeGreaterThanOrEqual(collapsed.hintHeight - 1);
  expect(state.boxHeight - collapsed.boxHeight).toBeLessThanOrEqual(collapsed.hintHeight + 1);
  // 框内滚动条：内容高于框、overflow auto、视点钉在底部
  expect(state.overflowY).toBe('auto');
  expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  expect(state.scrollTop + state.clientHeight).toBeGreaterThanOrEqual(state.scrollHeight - 2);

  await page.screenshot({ path: 'test-results/bash-collapse-expanded.png', fullPage: true });
});

/**
 * CRLF 回归：PowerShell 风格输出带 \r\n 且段间有空行。行 div 对孤立 \r 不产生
 * 换行（0px 高），整段 <pre> 里 \r\n 是真实换行——若源文本不归一，同一输出在
 * 「缩略候选段」与「整段 pre」两种形态下高度不等，实测围绕「放得下 ↔ 放不下」
 * 每帧翻转，框高 115 ↔ 自然高度来回跳，整页后半部分跟着闪烁。
 * 修复：previewText 归一 CRLF 后两形态等价。这里以逐帧高度采样锁死不回归。
 */
const CRLF_LINES = [
  '=== nvlddmkm service ===',
  '',
  'Name      : nvlddmkm',
  '',
  'Status    : Running',
  'StartMode : Auto',
  'ExitCode  : 0',
];

test('US-14 CRLF 输出（含空行）折叠框高度稳定不振荡', async () => {
  const { host, page } = handle;
  const started = await host.waitForSent('startNewConversation');
  const sessionId = started.sessionId as string;
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: '查一下服务' });
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'toolcall',
    content: '',
    toolName: 'Bash',
    toolArgs: { command: 'powershell Get-Service nvlddmkm', description: 'CRLF output' },
    toolCallId: 'bash-collapse-crlf',
    status: 'running',
  });
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'bash-collapse-crlf',
    output: CRLF_LINES.join('\r\n'),
    status: 'success',
  });

  // 完成态渲染出折叠提示条（输出 7 行：缩略内容放得下与否取决于空行实测）
  await expect(page.getByText(/仅显示末尾 \d+ 行 \/ 共 7 行，点击显示全部/)).toBeVisible({ timeout: 15_000 });

  // 逐帧采样输出框高度：40 帧内必须恒定（±1px）。振荡形态是 115 ↔ 自然高度
  // （7 行 ≈ 123px+）每帧翻转，任何采样窗口内都会出现 ≥2 个高度值。
  const heights = await page.evaluate(() => {
    return new Promise<number[]>((resolve) => {
      const boxes = Array.from(
        document.querySelectorAll<HTMLElement>('div[title="点击查看完整输出"]'),
      );
      const box = boxes.find((b) => (b.textContent || '').includes('nvlddmkm'));
      if (!box) throw new Error('CRLF 输出框未渲染');
      const out: number[] = [];
      let i = 0;
      const step = () => {
        out.push(Math.round(box.getBoundingClientRect().height * 2) / 2);
        i += 1;
        if (i < 40) requestAnimationFrame(step);
        else resolve(out);
      };
      requestAnimationFrame(step);
    });
  });
  expect(heights.length).toBe(40);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  expect(max - min, `40 帧内输出框高度必须稳定，实际 ${JSON.stringify([...new Set(heights)])}`).toBeLessThanOrEqual(1);
  // 稳定在折叠态（框高与流式容器同高），而不是稳定在某个错误形态
  expect(max).toBeLessThanOrEqual(116);
});

/**
 * 超大输出被持久化到磁盘时，「完整输出」入口与复制按钮并排放在命令行那一行，
 * 不再单独占一行（旧形态是输出区顶部一条 justify-end 的按钮栏）。
 */
test('US-14 持久化输出：「完整输出」按钮与复制按钮并排在同一行', async () => {
  const { host, page } = handle;
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
    toolCallId: 'bash-persisted-1',
    status: 'running',
  });
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'bash-persisted-1',
    output: [
      '<persisted-output>',
      'Output too large (128KB). Full output saved to: C:\\tmp\\out.txt',
      '',
      'Preview (first 2K + last 2K):',
      bashOutput(),
      '</persisted-output>',
    ].join('\n'),
    status: 'success',
  });

  const fullOutput = page.getByTitle('打开完整输出文件');
  const copy = page.getByTitle('复制命令');
  await expect(fullOutput).toBeVisible({ timeout: 15_000 });
  await expect(copy).toBeVisible();

  const fullBox = await fullOutput.boundingBox();
  const copyBox = await copy.boundingBox();
  expect(fullBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  // 同一行：两个按钮的垂直中心差在 2px 内
  const fullCenter = (fullBox?.y ?? 0) + (fullBox?.height ?? 0) / 2;
  const copyCenter = (copyBox?.y ?? 0) + (copyBox?.height ?? 0) / 2;
  expect(Math.abs(fullCenter - copyCenter)).toBeLessThanOrEqual(2);
  // 「完整输出」在复制按钮左侧，紧邻
  expect((fullBox?.x ?? 0) + (fullBox?.width ?? 0)).toBeLessThanOrEqual((copyBox?.x ?? 0) + 1);

  // 字号与同行的命令文字同档（ui-fs-12）——不能靠 `font: inherit` 简写吃外层字号
  const command = page.getByTitle('点击查看完整命令');
  const [fullFont, commandFont] = await Promise.all([
    fullOutput.evaluate((el) => getComputedStyle(el).fontSize),
    command.evaluate((el) => getComputedStyle(el).fontSize),
  ]);
  expect(fullFont).toBe(commandFont);
});
