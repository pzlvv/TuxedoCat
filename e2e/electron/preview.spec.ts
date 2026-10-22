import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, lastUserText } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-38 文件预览：Read 工具卡片路径可点击，打开 Monaco 预览窗口并定位内容
 *
 * mock LLM 脚本化一轮 Read 工具调用（真实 standalone core 执行读盘），
 * 点击卡片上的文件路径 → openFile → 主进程开 Monaco 窗口（dist/monaco）。
 */

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({
    'README.md': '# 工作区\n\n这是第二行内容。\n这是第三行内容。\n',
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

test('US-38 Read 卡片路径点击打开 Monaco 预览窗口', async () => {
  // 「读取文件 <名>」→ Read 工具轮；结果回传后终轮收尾
  mockLlm.setHandler((req) => {
    const last = req.body.messages[req.body.messages.length - 1];
    if (last?.role === 'tool') return { kind: 'text', text: '文件内容如上。' };
    if (lastUserText(req.body.messages).startsWith('读取文件')) {
      return {
        kind: 'tool', name: 'Read',
        args: { file_path: path.join(workspaceDir, 'README.md') },
        preamble: '我来读这个文件。',
      };
    }
    return { kind: 'text', text: '好的。' };
  });

  const chatPage = await app.chatPage();
  await chatPage.fill('textarea.input-textarea', '读取文件 README.md');
  await chatPage.press('textarea.input-textarea', 'Enter');

  // manual 询问模式下 Read 可能弹权限确认：出现就放行，不弹（读操作免确认）则直接继续
  const overlay = chatPage.locator('.user-choice-overlay');
  try {
    await overlay.waitFor({ state: 'visible', timeout: 8_000 });
    await overlay.getByRole('button', { name: /允许/ }).first().click();
  } catch {
    /* 免确认路径 */
  }

  // Read 卡片上架，路径为可点击链接（US-14 验收 3 / US-38 入口）
  const pathLink = chatPage.locator('.hover\\:underline').first();
  await expect(pathLink).toBeVisible({ timeout: 30_000 });

  // 点击路径 → Monaco 预览窗口打开（US-38 验收 1）
  await pathLink.click();
  const monacoPage = await app.waitForPage('monaco', 20_000);
  await expect(monacoPage.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });

  // specs/018 FR-001：本地文件被外部修改后自动刷新（不重开窗口）。
  // 滚动 / 光标保持由 monaco/main.ts 的 saveViewState / restoreViewState 负责；
  // Monaco 的滚动 DOM 在 Electron viewer 里不稳定，e2e 只断言内容刷新。
  await fs.promises.writeFile(
    path.join(workspaceDir, 'README.md'),
    '# 更新后\n\n这是刷新后的内容。\n',
    'utf-8',
  );
  await expect(monacoPage.locator('.view-lines')).toContainText('更新后', { timeout: 10_000 });
});

test('US-38 本地 Markdown 刷新保持滚动并显示删除标记', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => (i === 0 ? '# 工作区' : `第 ${i} 行内容`));
  await fs.promises.writeFile(path.join(workspaceDir, 'README.md'), `${lines.join('\n\n')}\n`, 'utf-8');
  await openFromSidebar('README.md');

  const previewPage = await app.waitForPage('data:text/html', 20_000);
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
