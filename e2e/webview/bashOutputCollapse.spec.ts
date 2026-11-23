import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-14 Bash 输出折叠（与 Edit/Write 预览同一套 usePreviewLimit，限高为输出框
 * 常量高度，测量口径是整段行盒）：执行完成后缩略态只显示**末尾**放得下的整行
 * （overflow hidden 不出现滚动条，可见窗口钉在底部）；提示条在输出框**上方**
 * （tail 变体，chevron 朝上），整条铺满命令卡片、只自绘下边那一条作为与输出框之间的
 * 分割线（上 / 左 / 右三边正好落在卡片已有的线条上，自绘就是双圈）；
 * 点击提示条展开后**提示条让位**：输出框接管它的高度（卡片总高不变），换成框内
 * 滚动条，初始视点仍在底部、可向上滚动。
 *
 * 三态（流式 / 缩略 / 展开）渲染的是同一段 <pre>，因此这里的量测都从 `pre`
 * 定位输出容器、用 Range 的 client rect 取具体视觉行。
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

/**
 * 读取输出容器与相邻提示条（位于容器上方）的折叠态指标。
 *
 * 内容是一整段 <pre>（三态同一套渲染，见 `Bash.tsx` 的 blockStyle 注释），
 * 末行不是独立的 div：用 Range 取**最后一个视觉行盒**的矩形来定位末行。
 */
async function readCollapseState(): Promise<{
  overflowY: string;
  boxHeight: number;
  boxWidth: number;
  lastLineBottom: number;
  boxBottom: number;
  hintTop: number;
  boxTop: number;
  hintBorderTopStyle: string;
  hintBorderLeftStyle: string;
  hintBorderRightStyle: string;
  hintBorderBottomStyle: string;
}> {
  return handle.page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => (n.textContent || '').includes('line-060-END')) as HTMLElement | undefined;
    if (!pre) throw new Error('末行未渲染');
    const box = pre.parentElement as HTMLElement;
    // 提示条是输出容器（`px-3 py-2` 那层）的**前一个兄弟**——它整条铺满命令卡片，
    // 不随输出框一起内缩。
    const hint = (box.parentElement as HTMLElement).previousElementSibling as HTMLElement | null;
    const boxRect = box.getBoundingClientRect();
    // 末行的行盒：整段文本的最后一个 client rect（每个视觉行一个）
    const range = document.createRange();
    range.selectNodeContents(pre);
    const rects = Array.from(range.getClientRects());
    const lastRect = rects[rects.length - 1];
    return {
      overflowY: getComputedStyle(box).overflowY,
      boxHeight: boxRect.height,
      boxWidth: boxRect.width,
      lastLineBottom: lastRect ? lastRect.bottom : NaN,
      boxBottom: boxRect.bottom,
      hintTop: hint ? hint.getBoundingClientRect().top : NaN,
      boxTop: boxRect.top,
      hintBorderTopStyle: hint ? getComputedStyle(hint).borderTopStyle : 'missing',
      hintBorderLeftStyle: hint ? getComputedStyle(hint).borderLeftStyle : 'missing',
      hintBorderRightStyle: hint ? getComputedStyle(hint).borderRightStyle : 'missing',
      hintBorderBottomStyle: hint ? getComputedStyle(hint).borderBottomStyle : 'missing',
    };
  });
}

test('US-14 完成态缩略：框高恒定、只显示末尾整行、无滚动条、提示条在上方', async () => {
  const { page } = handle;
  await addCompletedBashCard();

  // 提示条计数与实际可见整行数一致（行数随字号档位由行高算出，不硬编码）
  await expect(page.getByText(/仅显示末尾 \d+ 行 \/ 共 60 行，点击显示全部/)).toBeVisible({ timeout: 15_000 });

  const state = await readCollapseState();
  // 缩略态是「整段 <pre> + 固定框高 + overflow hidden」：首行留在 DOM 里，
  // 但被裁在框上方（视点钉底，看到的是末尾几行）
  const headClipped = await page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => (n.textContent || '').includes('line-060-END')) as HTMLElement | undefined;
    if (!pre) throw new Error('末行未渲染');
    const box = pre.parentElement as HTMLElement;
    const boxTop = box.getBoundingClientRect().top;
    const range = document.createRange();
    range.selectNodeContents(pre);
    const rects = Array.from(range.getClientRects());
    const firstRect = rects[0];
    return { firstTop: firstRect ? firstRect.top : NaN, boxTop };
  });
  expect(headClipped.firstTop).toBeLessThan(headClipped.boxTop);
  // overflow hidden：结构上不可能出现滚动条
  expect(state.overflowY).toBe('hidden');
  // 框高恒定（与流式容器同高 115px + 1 容差），总高度与流式期间一致
  expect(state.boxHeight).toBeLessThanOrEqual(116);
  // 末行完整落在容器内（不被 overflow hidden 裁掉）
  expect(state.lastLineBottom).toBeLessThanOrEqual(state.boxBottom + 1);
  // 提示条位于输出框上方（tail 变体：更多内容在上方，向上展开）
  expect(state.hintTop).toBeLessThan(state.boxTop);
  // tail 提示条：整条铺满命令卡片，上 / 左 / 右三边与卡片已有线条（命令行下边框、
  // 卡片外框）重合，只自绘下边那一条作分割线
  expect(state.hintBorderTopStyle).toBe('none');
  expect(state.hintBorderLeftStyle).toBe('none');
  expect(state.hintBorderRightStyle).toBe('none');
  expect(state.hintBorderBottomStyle).toBe('solid');
  const divider = await page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => (n.textContent || '').includes('line-060-END')) as HTMLElement | undefined;
    if (!pre) throw new Error('末行未渲染');
    const container = pre.parentElement?.parentElement as HTMLElement | null;
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
  // 不自绘外框：没有圆角
  expect(divider.borderRadius).toBe('0px');
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
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => (n.textContent || '').includes('line-060-END')) as HTMLElement | undefined;
    if (!pre) throw new Error('末行未渲染');
    const box = pre.parentElement as HTMLElement;
    const hintEl = (box.parentElement as HTMLElement).previousElementSibling as HTMLElement | null;
    return {
      boxHeight: box.getBoundingClientRect().height,
      hintHeight: hintEl ? hintEl.getBoundingClientRect().height : 0,
    };
  });
  expect(collapsed.hintHeight).toBeGreaterThan(0);

  await hint.click();
  // 全部行渲染（同一段 pre）；提示条不再渲染——它让出的高度归输出框
  await expect(page.getByText('line-001', { exact: false })).toBeVisible();
  await expect(page.getByText('共 60 行，已显示全部')).toHaveCount(0);

  // 展开态量测：经 line-001 所在 pre 找输出容器
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
 * CRLF 回归：PowerShell 风格输出带 \r\n 且段间有空行。行盒对孤立 \r 不产生
 * 换行（0px 高），而 \r\n 在 `white-space: pre` 里是真实换行——若源文本不归一，
 * 同一份输出的行数会随解析路径变化，框高围绕「放得下 ↔ 放不下」每帧翻转
 * （115 ↔ 自然高度），整页后半部分跟着闪烁。
 * 修复：previewText 归一 CRLF。这里以逐帧高度采样锁死不回归。
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
 * 只含 ANSI 转义的行：渲染后不产出任何节点、在 <pre> 里不占行盒，于是同一份
 * 输出「有多少行」在逐行形态与整段形态下不等（此前缩略态逐行 <div>、展开态整段
 * <pre>，两套实现），框高围绕 115 ↔ 自然高度逐帧翻转、整页跟着闪。
 *
 * 现在三态只有一套整段渲染，且逐行按「去掉 ANSI 后是否为空」补 \u00A0 占位，
 * 行数与行高严格一致。这里逐帧采样锁死高度恒定，并核对提示条行数与实际行盒数。
 */
const ANSI_ONLY_LINES = [
  '=== apt-get upgrade ===',
  '\u001b[32m\u001b[0m',
  'Reading package lists...',
  '\u001b[2K',
  'Building dependency tree...',
  '\u001b[0m',
  'Reading state information...',
  '\u001b[32m\u001b[0m',
  '0 upgraded, 0 newly installed.',
  '\u001b[0m',
];

test('US-14 含只读 ANSI 转义行的输出：折叠框高度稳定、行数与行盒一致', async () => {
  const { host, page } = handle;
  const started = await host.waitForSent('startNewConversation');
  const sessionId = started.sessionId as string;
  await host.send({ type: 'addMessage', sessionId, role: 'user', content: '升级一下' });
  await host.send({
    type: 'addMessage',
    sessionId,
    role: 'toolcall',
    content: '',
    toolName: 'Bash',
    toolArgs: { command: 'apt-get upgrade -y', description: 'ANSI only lines' },
    toolCallId: 'bash-collapse-ansi',
    status: 'running',
  });
  await host.send({
    type: 'updateToolStatus',
    sessionId,
    toolCallId: 'bash-collapse-ansi',
    output: ANSI_ONLY_LINES.join('\n'),
    status: 'success',
  });

  // 10 行全部计入（含 4 行只含转义序列的空行）
  await expect(page.getByText(/共 10 行/)).toBeVisible({ timeout: 15_000 });

  // 逐帧采样：40 帧内框高恒定。修复前两形态行数不等，实测在 115 ↔ 自然高度
  // （10 行 ≈ 176px）之间翻转，任何采样窗口内都会出现 ≥2 个高度值。
  const heights = await page.evaluate(() => {
    return new Promise<number[]>((resolve) => {
      const boxes = Array.from(
        document.querySelectorAll<HTMLElement>('div[title="点击查看完整输出"]'),
      );
      const box = boxes.find((b) => (b.textContent || '').includes('apt-get upgrade'));
      if (!box) throw new Error('ANSI 输出框未渲染');
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
  // 稳定在折叠态（框高与流式容器同高）
  expect(max).toBeLessThanOrEqual(116);

  // 展开后行盒数等于逻辑行数：只含 ANSI 的行也各占一行（逐行补占位的结果）
  await page.getByText(/仅显示末尾 \d+ 行 \/ 共 10 行，点击显示全部/).click();
  await expect(page.getByText('0 upgraded, 0 newly installed.')).toBeVisible();
  const lineBoxes = await page.evaluate(() => {
    const pre = Array.from(document.querySelectorAll('pre'))
      .find((n) => (n.textContent || '').includes('apt-get upgrade')) as HTMLElement | undefined;
    if (!pre) throw new Error('展开内容未渲染');
    const range = document.createRange();
    range.selectNodeContents(pre);
    // 每个视觉行一个 client rect；按 top 去重防止同一行被切成多个片段
    const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
    return tops.size;
  });
  expect(lineBoxes).toBe(ANSI_ONLY_LINES.length);
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
