import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * 真实 Electron 应用里空态背景 Logo 完全不可操作。
 *
 * webview 级用例（`e2e/webview/logoDrag.spec.ts`）锁同一份结构，这里补真实桌面壳的
 * 一层：原生拖影是引擎 / 宿主设置层面的行为，宿主换实现时可能绕过页面内的样式契约，
 * 只有拉起整个应用才能发现。
 */
let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'README.md': '# 工作区\n' });
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('真实应用：空态背景 Logo 不是图片节点，不可选中、不可拖拽', async () => {
  const chat = await app.chatPage();
  const logo = chat.locator('.placeholder-logo');
  await expect(logo).toBeVisible();

  const structure = await logo.evaluate((el) => ({
    tag: el.tagName,
    imageCount: document.querySelectorAll('img[alt="logo"]').length,
    pointerEvents: getComputedStyle(el).pointerEvents,
    userSelect: getComputedStyle(el).userSelect,
  }));
  expect(structure.tag).toBe('DIV');
  expect(structure.imageCount).toBe(0);
  expect(structure.pointerEvents).toBe('none');
  expect(structure.userSelect).toBe('none');

  await chat.evaluate(() => {
    const w = window as unknown as { __dragEvents: string[] };
    w.__dragEvents = [];
    document.addEventListener(
      'dragstart',
      (e) => {
        const t = e.target as HTMLElement | null;
        w.__dragEvents.push(`${t?.tagName}.${t?.className ?? ''}`);
      },
      true,
    );
  });
  const box = await logo.boundingBox();
  if (!box) throw new Error('logo boundingBox missing');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await chat.mouse.move(cx, cy);
  await chat.mouse.down();
  await chat.mouse.move(cx + 200, cy + 150, { steps: 8 });
  await chat.mouse.up();
  const dragged = await chat.evaluate(
    () => (window as unknown as { __dragEvents: string[] }).__dragEvents,
  );
  expect(dragged).toEqual([]);
});
