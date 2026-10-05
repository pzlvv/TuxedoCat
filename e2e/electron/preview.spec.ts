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
});
