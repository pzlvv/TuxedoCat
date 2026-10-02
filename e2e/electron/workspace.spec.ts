import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-30 完整模式与悬浮窗切换 / US-35 多工作区标签页（打开集合恢复 / 切换 / 关闭）
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'ws-a.md': 'A' });
  mockLlm = await startMockLlm({ workspaceDir });
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-30 完整模式 ↔ 悬浮窗：侧栏隐藏，对话列表移交 webview 顶栏', async () => {
  app = await launchApp({ repoRoot: process.cwd().replace(/[\\/]e2e$/, ''), mockLlm, workspaceDir });
  const chatPage = await app.chatPage();
  const sidebarPage = await app.sidebarPage();
  const titlebarPage = await app.titlebarPage();

  // 完整模式：侧栏可见；对话列表归宿主渲染（webview 顶栏无历史按钮）
  await expect(sidebarPage.locator('#searchInput')).toBeVisible();
  await expect(chatPage.locator('button[title="对话历史"]')).toHaveCount(0);

  // 切到悬浮窗：对话列表渲染方切换为 webview（US-30 验收 2）
  await titlebarPage.locator('#btnMode').click();
  await expect(chatPage.locator('button[title="对话历史"]')).toBeVisible({ timeout: 15_000 });

  // 切回完整模式：webview 顶栏列表收回，侧栏恢复
  await titlebarPage.locator('#btnMode').click();
  await expect(chatPage.locator('button[title="对话历史"]')).toHaveCount(0, { timeout: 15_000 });
  await expect((await app.sidebarPage()).locator('#searchInput')).toBeVisible({ timeout: 15_000 });
});

test('US-35 多工作区标签页：恢复打开集合、切换活动工作区、会话按目录隔离', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-ws-alpha');
  const bDir = await makeWorkspace({ 'b.md': 'B' }, 'e2e-ws-beta');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const titlebarPage = await app.titlebarPage();
  const tabs = titlebarPage.locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-ws-alpha');
  await expect(tabs.nth(1)).toContainText('e2e-ws-beta');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // 点击第二个标签页：活动项切换，聊天区切到该工作区（按绑定工作区解析视图）
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const betaChat = await app.chatPage({ workspaceIncludes: 'e2e-ws-beta' });
  await expect(betaChat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  // 工作区 B 里发消息，会话落盘归属 B 的会话目录（US-35 验收 3：独立对话上下文）
  await betaChat.fill('textarea.input-textarea', '工作区 B 的消息');
  await betaChat.press('textarea.input-textarea', 'Enter');
  await expect(betaChat.getByText(/收到：工作区 B/).first()).toBeVisible({ timeout: 30_000 });

  const conversationsRoot = path.join(app.homeDir, '.tuxedo-cat', 'conversations');
  const projectDirs = fs.readdirSync(conversationsRoot);
  expect(projectDirs.length).toBe(1);
  const dirName = projectDirs[0];
  expect(decodeURIComponent(dirName)).toContain('e2e-ws-beta');

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});

test('US-35 关闭工作区标签页：集合移除、活动权移交相邻项', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({}, 'e2e-ws-close-a');
  const bDir = await makeWorkspace({}, 'e2e-ws-close-b');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir,
    openWorkspaces: [aDir, bDir],
    activeWorkspace: aDir,
  });

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  // 关闭当前活动标签（A）：剩一个标签且活动权移交 B，聊天区仍可用
  await tabs.first().hover();
  await tabs.first().locator('.ws-tab-close').click();
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-ws-close-b');
  await expect((await app.chatPage()).locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });

  await fs.promises.rm(aDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => undefined);
});
