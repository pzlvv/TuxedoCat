import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, mainEval } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-38 文件预览：Read 工具卡片路径可点击，打开预览窗口
 * （代码文件 → Monaco 窗口定位内容；md 文件 → Markdown 预览窗口，渲染 / 文本切换）
 *
 * mock LLM 脚本化一轮 Read 工具调用（真实 standalone core 执行读盘），
 * 点击卡片上的文件路径 → openFile → 主进程按扩展名分流开窗。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({
    'README.md': '# 工作区\n\n这是第二行内容。\n这是第三行内容。\n',
    'notes.py': 'def main():\n    print("hello")\n',
  });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

/** 侧栏展开文件分区并双击根目录文件（specs/018 本地查看器刷新的入口） */
async function openFromSidebar(name: string): Promise<void> {
  const sidebar = await app.sidebarPage();
  await sidebar.locator('#filesHeader').click();
  const row = sidebar.locator(`.file-row[data-path="${name}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.dblclick();
}

/** mock LLM 脚本化一轮 Read 工具调用（args 可带 offset / limit 触发行号定位链接） */
async function readViaLlm(fileName: string, args: Record<string, unknown> = {}): Promise<void> {
  mockLlm.setHandler((req) => {
    const last = req.body.messages[req.body.messages.length - 1];
    if (last?.role === 'tool') return { kind: 'text', text: '文件内容如上。' };
    if (lastUserText(req.body.messages).startsWith('读取文件')) {
      return {
        kind: 'tool', name: 'Read',
        args: { file_path: path.join(workspaceDir, fileName), ...args },
        preamble: '我来读这个文件。',
      };
    }
    return { kind: 'text', text: '好的。' };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', `读取文件 ${fileName}`);
  await chatPage.press('textarea.input-textarea', 'Enter');

  // manual 询问模式下 Read 可能弹权限确认：出现就放行，不弹（读操作免确认）则直接继续
  const overlay = chatPage.locator('.user-choice-overlay');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 8_000 });
    await overlay.getByRole('button', { name: /允许/ }).first().click();
  } catch {
    /* 免确认路径 */
  }

  // Read 卡片上架，路径为可点击链接（US-14 验收 3 / US-38 入口）。
  // 用 title 精确锁定 Read 卡片的路径按钮：聊天页里 .hover\:underline 有多处
  // （上下文进度条、思考块展开行……），按类名取 first 会点错元素
  const pathLink = chatPage.locator(`button[title*="${fileName}"]`);
  await expect(pathLink).toBeVisible({ timeout: 30_000 });
  await pathLink.click();
}

test('US-38 Read 卡片路径点击打开 Monaco 预览窗口', async () => {
  await readViaLlm('notes.py');

  // 代码文件 → Monaco 预览窗口打开（US-38 验收 1）
  const monacoPage = await app.waitForPage('monaco/index.html', 20_000);
  await expect(monacoPage.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });

  // specs/018 FR-001：本地文件被外部修改后自动刷新（不重开窗口）。
  // 滚动 / 光标保持由 monaco/main.ts 的 saveViewState / restoreViewState 负责；
  // Monaco 的滚动 DOM 在 Electron viewer 里不稳定，e2e 只断言内容刷新。
  await fs.promises.writeFile(
    path.join(workspaceDir, 'notes.py'),
    'def main():\n    print("更新后")\n',
    'utf-8',
  );
  await expect(monacoPage.locator('.view-lines')).toContainText('更新后', { timeout: 10_000 });
});

test('US-38 md 文件链接打开 Markdown 预览窗口（默认渲染视图，可切文本）', async () => {
  await readViaLlm('README.md');

  // md 链接与侧栏双击同一预览窗口（US-38 验收 1）：无行号定位默认渲染视图，
  // 标题栏带「渲染 / 文本」切换按钮
  const previewPage = await app.waitForPage('monaco/markdown.html', 20_000);
  await expect(previewPage.locator('article.markdown-body h1')).toHaveText('工作区', { timeout: 20_000 });
  await expect(previewPage.locator('#markdown-titlebar .view-toggle')).toHaveText(/文本|Text/, { timeout: 10_000 });
});

test('US-38 md 链接带行号定位默认文本视图', async () => {
  // 部分读取的 Read 卡片带 selectedLines：渲染视图对应不了源行号，初始落文本视图
  await readViaLlm('README.md', { offset: 2, limit: 1 });

  const previewPage = await app.waitForPage('monaco/markdown.html', 20_000);
  await expect(previewPage.locator('article.markdown-body')).toBeHidden({ timeout: 10_000 });
  const sourceView = previewPage.locator('#markdown-source-view');
  await expect(sourceView).toBeVisible();
  await expect(sourceView.locator('.view-lines')).toContainText('# 工作区', { timeout: 20_000 });
});

test('US-38 本地 Markdown 刷新保持滚动并显示删除标记', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => (i === 0 ? '# 工作区' : `第 ${i} 行内容`));
  await fs.promises.writeFile(path.join(workspaceDir, 'README.md'), `${lines.join('\n\n')}\n`, 'utf-8');
  await openFromSidebar('README.md');

  const previewPage = await app.waitForPage('monaco/markdown.html', 20_000);
  await expect(previewPage.locator('article.markdown-body h1')).toHaveText('工作区', { timeout: 20_000 });
  await previewPage.evaluate(() => {
    document.scrollingElement!.scrollTop = 200;
  });
  await expect.poll(async () => previewPage.evaluate(() => document.scrollingElement!.scrollTop))
    .toBeGreaterThan(0);

  const updated = lines.map((line, i) => (i === 0 ? '# 更新后' : line));
  await fs.promises.writeFile(path.join(workspaceDir, 'README.md'), `${updated.join('\n\n')}\n`, 'utf-8');
  await expect(previewPage.locator('article.markdown-body h1')).toHaveText('更新后', { timeout: 10_000 });
  await expect.poll(async () => previewPage.evaluate(() => document.scrollingElement!.scrollTop))
    .toBeGreaterThan(100);

  await fs.promises.rm(path.join(workspaceDir, 'README.md'));
  await expect(previewPage).toHaveTitle(/文件已删除|file deleted/, { timeout: 10_000 });
});

test('Markdown 预览自绘标题栏：渲染/文本切换按钮在最小化左侧', async () => {
  await openFromSidebar('README.md');

  const previewPage = await app.waitForPage('monaco/markdown.html', 20_000);
  await expect(previewPage.locator('article.markdown-body h1')).toHaveText('工作区', { timeout: 20_000 });

  // 初始为渲染视图；切换按钮的标签是切换目标（当前渲染 → 显示「文本」）
  const toggle = previewPage.locator('#markdown-titlebar .view-toggle');
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await expect(toggle).toHaveText(/文本|Text/);

  // 几何断言：切换按钮整体位于最小化按钮左侧（同一控制行内）
  const ordering = await previewPage.evaluate(() => {
    const buttons = [...document.querySelectorAll('#markdown-titlebar .controls button')];
    const toggleRect = buttons[0].getBoundingClientRect();
    const minimizeRect = buttons[1].getBoundingClientRect();
    return {
      sameRow: Math.abs(toggleRect.top - minimizeRect.top) < 1,
      toggleRight: toggleRect.right,
      minimizeLeft: minimizeRect.left,
    };
  });
  expect(ordering.sameRow).toBe(true);
  // 相邻按钮存在亚像素取整（边界差 <0.001px），留 1px 容差
  expect(ordering.toggleRight).toBeLessThanOrEqual(ordering.minimizeLeft + 1);

  // 切到文本视图：渲染区隐藏，原始源文在只读编辑器（页内 Monaco）展示
  await toggle.click();
  await expect(previewPage.locator('article.markdown-body')).toBeHidden();
  const sourceView = previewPage.locator('#markdown-source-view');
  await expect(sourceView).toBeVisible();
  await expect(sourceView.locator('.view-lines')).toContainText('# 工作区', { timeout: 10_000 });

  // 切回渲染视图
  await expect(toggle).toHaveText(/渲染|Rendered/);
  await toggle.click();
  await expect(previewPage.locator('article.markdown-body h1')).toBeVisible();
  await expect(previewPage.locator('#markdown-source-view')).toBeHidden();
});

test('US-38 本地图片刷新保持缩放', async () => {
  const initialGif = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'base64',
  );
  const updatedGif = Buffer.from(
    'R0lGODlhAQABAIAAAP8AAAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==',
    'base64',
  );
  const imagePath = path.join(workspaceDir, 'pic.gif');
  await fs.promises.writeFile(imagePath, initialGif);
  await openFromSidebar('pic.gif');

  const viewerPage = await app.waitForPage('imageViewer', 20_000);
  const image = viewerPage.locator('#image');
  await expect(image).toBeVisible({ timeout: 20_000 });
  const before = await image.getAttribute('src');

  await viewerPage.mouse.move(450, 350);
  await viewerPage.mouse.wheel(0, -120);
  await expect(viewerPage.locator('#badge')).toHaveText('110%', { timeout: 5_000 });

  await fs.promises.writeFile(imagePath, updatedGif);
  await expect.poll(async () => image.getAttribute('src'), { timeout: 10_000 }).not.toBe(before);
  await expect(viewerPage.locator('#badge')).toHaveText('110%', { timeout: 5_000 });
});

/** 展开侧栏文件分区（只在用例开头点一次，重复点会折叠） */
async function expandFiles(): Promise<import('@playwright/test').Page> {
  const sidebar = await app.sidebarPage();
  await sidebar.locator('#filesHeader').click();
  return sidebar;
}

/** 当前存活的内置查看器窗口数（顶替路径的判据：名额只有一个） */
async function viewerWindowCount(): Promise<number> {
  const raw = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    return JSON.stringify(e.BrowserWindow.getAllWindows()
      .filter(function(w){ try { return !w.isDestroyed() && w.webContents.getURL().indexOf('imageViewer') >= 0; } catch (err) { return false; } })
      .map(function(w){ try { return { title: w.getTitle(), bounds: w.getNormalBounds() }; } catch (err) { return null; } })
      .filter(function(item){ return item !== null; }));
  } catch (err) { return 'ERR ' + err.message; }})()`);
  return (JSON.parse(raw) as unknown[]).length;
}

/** 取唯一查看器窗口的标题与矩形（没有窗口时返回 null） */
async function viewerWindow(): Promise<{ title: string; bounds: { x: number; y: number; width: number; height: number } } | null> {
  const raw = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    const w = e.BrowserWindow.getAllWindows().find(function(win){
      try { return !win.isDestroyed() && win.webContents.getURL().indexOf('imageViewer') >= 0; } catch (err) { return false; }
    });
    return JSON.stringify(w ? { title: w.getTitle(), bounds: w.getNormalBounds() } : null);
  } catch (err) { return 'ERR ' + err.message; }})()`);
  return JSON.parse(raw) as { title: string; bounds: { x: number; y: number; width: number; height: number } } | null;
}

/** 读 workspace-state.json 里记忆的查看器矩形（文件可能尚未创建 / 正在写） */
function savedViewerRect(): { x: number; y: number; width: number; height: number } | null {
  try {
    const state = JSON.parse(fs.readFileSync(app.stateFile, 'utf-8')) as Record<string, unknown>;
    const rect = state.viewerWindowRect as Record<string, number> | undefined;
    if (!rect) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

const PNG_ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * 矩形近似相等：尺寸允许 ±4px、位置允许 ±2px 的 OS/DPI 取整偏差。
 * Windows 高分屏（如 ARM64 150% 缩放）上 setBounds 与实际 bounds 之间
 * 实测出现过 ±2px 的整窗取整（520 → 522），精确相等断言会把取整当回归。
 */
function rectNear(
  actual: { x: number; y: number; width: number; height: number } | null | undefined,
  target: { x: number; y: number; width: number; height: number },
): boolean {
  return actual != null
    && Math.abs(actual.x - target.x) <= 2
    && Math.abs(actual.y - target.y) <= 2
    && Math.abs(actual.width - target.width) <= 4
    && Math.abs(actual.height - target.height) <= 4;
}

function expectRectNear(
  actual: { x: number; y: number; width: number; height: number } | null | undefined,
  target: { x: number; y: number; width: number; height: number },
): void {
  expect(
    rectNear(actual, target),
    `矩形应为 ${JSON.stringify(target)}，实得 ${JSON.stringify(actual)}（允许 DPI 取整偏差 ±2/±4）`,
  ).toBe(true);
}

test('US-38 查看器单实例顶替：再开一张图沿用同一窗口，旧窗口被销毁', async () => {
  await fs.promises.writeFile(path.join(workspaceDir, 'pic-a.png'), PNG_ONE_PIXEL);
  await fs.promises.writeFile(path.join(workspaceDir, 'pic-b.png'), PNG_ONE_PIXEL);
  const sb = await expandFiles();

  await sb.locator('.file-row[data-path="pic-a.png"]').dblclick();
  const firstPage = await app.waitForPage('imageViewer', 20_000);
  await expect(firstPage.locator('#image')).toBeVisible({ timeout: 20_000 });
  await expect(firstPage).toHaveTitle('pic-a.png', { timeout: 10_000 });
  expect(await viewerWindowCount()).toBe(1);

  // 再开第二张：名额被顶替，不叠开第二个查看器窗口
  await sb.locator('.file-row[data-path="pic-b.png"]').dblclick();
  // 轮询「存活窗口的标题」而不是窗口数——顶替发生前后窗口数都是 1，
  // 对「旧窗口尚未销毁」的采样窗口不敏感，直接数窗口会过早放行读到旧图
  await expect.poll(async () => (await viewerWindow())?.title, { timeout: 15_000 }).toBe('pic-b.png');
  // 标题已是新图后再等旧窗口销毁完（数量收敛到 1）：两件事不同步，得分别等
  await expect.poll(viewerWindowCount, { timeout: 15_000 }).toBe(1);
  // 旧页面已被销毁：上下文里只剩一个查看器页面，且是新的那张图
  // （窗口销毁与页面列表更新不同步，数量也用轮询收敛）
  await expect.poll(
    () => app.context.pages().filter((p) => p.url().includes('imageViewer')).length,
    { timeout: 15_000 },
  ).toBe(1);
  const viewerPages = app.context.pages().filter((p) => p.url().includes('imageViewer'));
  await expect(viewerPages[0].locator('#image')).toBeVisible({ timeout: 20_000 });
  await expect(viewerPages[0]).toHaveTitle('pic-b.png', { timeout: 10_000 });
});

test('US-38 查看器窗口位置记忆：移动后关闭，再开沿用上次矩形', async () => {
  await fs.promises.writeFile(path.join(workspaceDir, 'pic.png'), PNG_ONE_PIXEL);
  const sb = await expandFiles();

  await sb.locator('.file-row[data-path="pic.png"]').dblclick();
  const viewerPage = await app.waitForPage('imageViewer', 20_000);
  await expect(viewerPage.locator('#image')).toBeVisible({ timeout: 20_000 });

  // 把窗口摆到主屏工作区内的一块确定矩形（planViewerSlotBounds 只做可见性校验，不改尺寸）
  const target = JSON.parse(await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    const wa = e.screen.getPrimaryDisplay().workArea;
    const w = e.BrowserWindow.getAllWindows().find(function(win){
      return !win.isDestroyed() && win.webContents.getURL().indexOf('imageViewer') >= 0;
    });
    if (!w) return 'no-window';
    const rect = { x: wa.x + 80, y: wa.y + 60, width: 720, height: 520 };
    w.setBounds(rect);
    return JSON.stringify(rect);
  } catch (err) { return 'ERR ' + err.message; }})()`)) as { x: number; y: number; width: number; height: number };
  expectRectNear((await viewerWindow())?.bounds, target);

  // 矩形落盘有 2s 防抖：等状态文件里出现同一矩形（轮询谓词本身，
  // 不能用 toBeDefined——savedViewerRect 无矩形时返回 null，会立即放行）
  await expect.poll(() => rectNear(savedViewerRect(), target), { timeout: 15_000 }).toBe(true);

  // 关闭查看器（close 时补记一次最终矩形），再打开同一张图
  const closed = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    const w = e.BrowserWindow.getAllWindows().find(function(win){
      return !win.isDestroyed() && win.webContents.getURL().indexOf('imageViewer') >= 0;
    });
    if (!w) return 'no-window';
    w.close();
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  expect(closed).toBe('ok');
  await expect.poll(viewerWindowCount, { timeout: 15_000 }).toBe(0);

  await sb.locator('.file-row[data-path="pic.png"]').dblclick();
  // 轮询「重开窗口的矩形与记忆一致」这一个谓词：先数窗口再取窗口是两次独立
  // mainEval 采样，之间窗口仍可能在创建/销毁（实测出现过计数=1、取窗口=null
  // 的互相矛盾），拆开采样会让断言采到两个不同的窗口
  await expect.poll(async () => rectNear((await viewerWindow())?.bounds, target), { timeout: 20_000 }).toBe(true);
});
