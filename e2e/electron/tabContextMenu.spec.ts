import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import {
  launchApp, makeWorkspace, mainEval, waitForMessageBox, clickMessageBoxButton, messageBoxText,
} from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-48 标签页右键菜单
 *
 * 菜单是主进程 `Menu.buildFromTemplate` 现造的原生菜单（`electron/main.ts` 的
 * `popupTabContextMenu`），弹窗外观 Playwright 驱动不了；但**菜单构造、置灰终态与点击
 * 动作**都可以断言：用例在主进程桩住 `Menu.buildFromTemplate`，把 template 存进
 * `globalThis.__tabMenus` 并让 `popup()` 不真弹，随后右键标签页读回条目、直接调用
 * `click()` 驱动动作——与 `fileExplorer.spec.ts` 桩 `shell.showItemInFolder` 同一手法。
 *
 * 覆盖：条目集合与顺序、`关闭其它所有工作区` 的单/多工作区置灰、`关闭所有空闲会话`
 * 的忙闲置灰、`打开命令行` 的快捷键同源展示、`关闭` 与 `关闭其它所有工作区` 的动作
 * （后者在任一他区忙碌时先弹汇总确认，取消则不动）。
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
const tempDirs: string[] = [];

test.beforeEach(async () => {
  mockLlm = await startMockLlm({ workspaceDir: await makeWorkspace({ 'a.md': 'A' }) });
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  mockLlm.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface CapturedMenuItem {
  label: string | null;
  type: string;
  enabled: boolean;
  accelerator: string | null;
}

/**
 * 桩住 `Menu.buildFromTemplate`：只在 `popup()` 被调用时记录（托盘 / 应用菜单同样走
 * buildFromTemplate，不记录未弹出的菜单），并把真实 Menu 的 popup 换成空操作。
 */
async function installMenuStub(): Promise<void> {
  const result = await mainEval<string>(app!, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    if (!globalThis.__origBuildFromTemplate) {
      globalThis.__origBuildFromTemplate = e.Menu.buildFromTemplate.bind(e.Menu);
    }
    globalThis.__tabMenus = [];
    e.Menu.buildFromTemplate = function(template){
      const menu = globalThis.__origBuildFromTemplate(template);
      menu.popup = function(){
        globalThis.__tabMenus.push({
          items: template.map(function(t){
            return {
              label: t.label === undefined ? null : t.label,
              type: t.type === undefined ? 'normal' : t.type,
              enabled: t.enabled !== false,
              accelerator: t.accelerator === undefined ? null : t.accelerator,
            };
          }),
          clicks: template.map(function(t){ return typeof t.click === 'function' ? t.click : null; }),
        });
      };
      return menu;
    };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  if (result !== 'ok') throw new Error(`菜单桩注入失败：${result}`);
}

/** 右键标签页并读回被弹出的菜单条目（等主进程把菜单弹过一次） */
async function rightClickTab(label: string): Promise<CapturedMenuItem[]> {
  const titlebar = await app!.titlebarPage();
  const tab = titlebar.locator('.ws-tab', { hasText: label });
  await expect(tab).toBeVisible({ timeout: 20_000 });
  const before = await mainEval<number>(app!, 'globalThis.__tabMenus.length');
  await tab.click({ button: 'right' });
  await expect.poll(
    async () => mainEval<number>(app!, 'globalThis.__tabMenus.length'),
    { timeout: 10_000 },
  ).toBe(before + 1);
  const raw = await mainEval<string>(app!, 'JSON.stringify(globalThis.__tabMenus[globalThis.__tabMenus.length-1].items)');
  return JSON.parse(raw) as CapturedMenuItem[];
}

/** 调用最近一次弹出菜单的第 index 个条目的 click（模板里的原始回调） */
async function clickMenuItem(index: number): Promise<void> {
  const result = await mainEval<string>(app!, `(function(){
    const m = globalThis.__tabMenus[globalThis.__tabMenus.length-1];
    const fn = m.clicks[${index}];
    if (typeof fn !== 'function') return 'no-click';
    fn();
    return 'ok';
  })()`);
  if (result !== 'ok') throw new Error(`菜单条目 ${index} 无点击回调（${result}）`);
}

/** 发一条消息并等到助手回复落屏（把会话推进到「有对话且空闲」的稳定态） */
async function sendOneTurn(workspaceIncludes: string, text: string): Promise<void> {
  const chat = await app!.chatPage({ workspaceIncludes });
  await expect(chat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });
  await chat.fill('textarea.input-textarea', text);
  await chat.press('textarea.input-textarea', 'Enter');
  await expect(chat.getByText(/收到：/).first()).toBeVisible({ timeout: 30_000 });
}

test('US-48 单工作区本地：条目集合、置灰终态与「打开命令行」快捷键同源展示', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const dir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-us48-single');
  tempDirs.push(dir);
  app = await launchApp({ repoRoot, mockLlm, workspaceDir: dir });
  await installMenuStub();
  await sendOneTurn('e2e-us48-single', '准备一下');

  const items = await rightClickTab('e2e-us48-single');
  // 条目与顺序：关闭 / 关闭所有空闲会话 / 关闭其它所有工作区 / 分隔线 / 打开命令行
  expect(items.map((i) => i.label)).toEqual([
    '关闭', '关闭所有空闲会话', '关闭其它所有工作区', null, '打开命令行',
  ]);
  expect(items[3].type).toBe('separator');
  // 只有一个工作区：没有「其它」可关 → 置灰是终态
  expect(items[2].enabled).toBe(false);
  // 刚跑完一轮、会话空闲 → 可批量关闭
  expect(items[1].enabled).toBe(true);
  // 本地工作区是「打开命令行」分支，目录存在即可用，且尾随快捷键取宿主当前值
  expect(items[4].enabled).toBe(true);
  expect(items[4].accelerator).toBe('Ctrl+Alt+T');
});

test('US-48 会话忙碌时「关闭所有空闲会话」置灰', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const dir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-us48-busy');
  tempDirs.push(dir);
  // hang：不回响应，会话一直处于运行中
  mockLlm.setHandler(() => ({ kind: 'hang' }));
  app = await launchApp({ repoRoot, mockLlm, workspaceDir: dir });
  await installMenuStub();

  const chat = await app.chatPage({ workspaceIncludes: 'e2e-us48-busy' });
  await expect(chat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });
  await chat.fill('textarea.input-textarea', '一直跑着');
  await chat.press('textarea.input-textarea', 'Enter');
  // 忙碌事实到达：停止按钮转为可点（红色 = 前台查询运行中）
  await expect(chat.locator('button[data-abort-state="query"]')).toBeEnabled({ timeout: 30_000 });

  const items = await rightClickTab('e2e-us48-busy');
  expect(items[1].enabled).toBe(false);
});

test('US-48 两个工作区：「关闭其它所有工作区」可用，点「关闭」只关右键那张标签', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-us48-a');
  const bDir = await makeWorkspace({ 'b.md': 'B' }, 'e2e-us48-b');
  tempDirs.push(aDir, bDir);
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir, openWorkspaces: [aDir, bDir], activeWorkspace: aDir,
  });
  await installMenuStub();

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  const items = await rightClickTab('e2e-us48-a');
  expect(items[2].enabled).toBe(true);

  // 点「关闭」：只关右键的那张标签，另一张留下
  await clickMenuItem(0);
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(tabs.first()).toContainText('e2e-us48-b');
});

test('US-48 他区忙碌时「关闭其它所有工作区」先弹汇总确认，取消则不动', async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const aDir = await makeWorkspace({ 'a.md': 'A' }, 'e2e-us48-confirm-a');
  const bDir = await makeWorkspace({ 'b.md': 'B' }, 'e2e-us48-confirm-b');
  tempDirs.push(aDir, bDir);
  mockLlm.setHandler(() => ({ kind: 'hang' }));
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: aDir, openWorkspaces: [aDir, bDir], activeWorkspace: bDir,
  });
  await installMenuStub();

  const tabs = (await app.titlebarPage()).locator('#workspaceTabs [role="tab"]');
  await expect(tabs).toHaveCount(2, { timeout: 20_000 });

  // 让 B 忙起来（hang 一轮），再从 A 的标签右键「关闭其它所有工作区」
  const betaChat = await app.chatPage({ workspaceIncludes: 'e2e-us48-confirm-b' });
  await expect(betaChat.locator('textarea.input-textarea')).toBeEnabled({ timeout: 30_000 });
  await betaChat.fill('textarea.input-textarea', '在 B 里跑着');
  await betaChat.press('textarea.input-textarea', 'Enter');
  await expect(betaChat.locator('button[data-abort-state="query"]')).toBeEnabled({ timeout: 30_000 });

  await rightClickTab('e2e-us48-confirm-a');
  await clickMenuItem(2);

  const box = await waitForMessageBox(app);
  const text = await messageBoxText(box);
  expect(text.message).toContain('其它工作区中仍有对话在运行');
  expect(text.buttons).toEqual(['仍然关闭', '取消']);
  // 取消：两个标签都还在
  await clickMessageBoxButton(box, 1);
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
});
