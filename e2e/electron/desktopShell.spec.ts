import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { Page } from '@playwright/test';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-27 内置命令分发 / US-31 窗口控制 / US-32 主题切换 / US-34 全局唤醒快捷键 /
 * US-37 最近工作区 / US-39 Spin 设计器
 *
 * Electron 整应用链路（standalone core + mock LLM）：标题栏 / 自绘菜单 / 全局快捷键
 * 都只能在整应用层验证。标题栏下拉菜单是主进程生成的 data: URL WebContentsView，
 * 经 CDP 目标列表按内容特征（.item[data-id]）解析后用 Playwright 驱动。
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

/**
 * 主进程求值（包一层 try 以便把错误带回断言信息）。
 * 入口 bundle 是 CJS，但 inspector 的全局求值上下文里没有裸 `require`，
 * 与 stubMainMessageBox 同口径经 `process.mainModule.require` 取 electron。
 */
function mainExpr<T>(body: string): Promise<T> {
  return app.evaluateInMain(
    `(function(){try{const e=process.mainModule?process.mainModule.require('electron'):require('electron');return ${body};}catch(err){return 'ERR '+err.message;}})()`,
  ).then((raw) => {
    // evaluateInMain 回的是 CDP 原始消息：解出 Runtime.evaluate 的值
    const envelope = raw as { result?: { result?: { value?: T }; exceptionDetails?: { text?: string } } };
    if (envelope?.result?.exceptionDetails) {
      throw new Error(`主进程求值抛错：${body}（${envelope.result.exceptionDetails.text ?? ''}）`);
    }
    return envelope?.result?.result?.value as T;
  });
}

/** 等待主进程求值结果满足谓词（窗口创建 / 快捷键换绑是异步落定的） */
async function pollMain<T>(expression: string, pred: (v: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await mainExpr(expression);
    if (pred(last as T)) return last as T;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`主进程断言超时：${expression} 最后结果 ${JSON.stringify(last)}`);
}

/** 在 CDP 目标列表里按内容特征找到自绘菜单视图 */
async function findMenuPage(): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const p of app.context.pages()) {
      if (!p.url().startsWith('data:')) continue;
      try {
        const isMenu = await p.evaluate(
          () => document.querySelector('.item[data-id], .item[data-submenu]') !== null,
        );
        if (isMenu) return p;
      } catch { /* 页面正在初始化 */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('自绘菜单视图未出现');
}

/** 点开标题栏菜单并返回其页面（菜单按钮在标题栏视图上） */
async function openMenuAndGetPage(): Promise<Page> {
  const titlebar = await app.titlebarPage();
  await titlebar.locator('#menubar .menu-btn').first().click();
  return findMenuPage();
}

/** 悬停展开一个二级分组并点中其中的条目（如 主题 → 浅色） */
async function clickSubmenuItem(menu: Page, submenuId: string, itemId: string): Promise<void> {
  // 二级面板由 hover（mouseenter）展开，点击父项只在键盘路径上切换
  await menu.locator(`.item[data-submenu="${submenuId}"]`).hover();
  const item = menu.locator(`.item[data-id="${itemId}"]`);
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();
}

test('US-31 标题栏最大化/还原切换窗口状态', async () => {
  const titlebar = await app.titlebarPage();
  const btnMaximize = titlebar.locator('#btnMaximize');

  await btnMaximize.click();
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.isMaximized())",
    (v) => v === true,
  );
  // 最大化后按钮语义切到「还原」（US-31 验收 1）
  await expect(btnMaximize).toHaveAttribute('aria-label', '还原', { timeout: 10_000 });

  await btnMaximize.click();
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.isMaximized())",
    (v) => v === false,
  );
  await expect(btnMaximize).toHaveAttribute('aria-label', '最大化', { timeout: 10_000 });
});

test('US-34 全局唤醒快捷键：按配置注册、改键保存后立即换绑', async () => {
  // 换一个实例：预置一个**独占组合键**（Ctrl+Alt+8）作为初始快捷键。
  // 默认 Ctrl+Alt+X 可能被本机其它程序或上一轮泄漏的实例占用（注册失败会落日志），
  // 断言改用不会被占用的组合，让用例只验证「配置 → 注册 → 换绑」这条产品链路。
  await app.close();
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir,
    stateOverrides: { shortcut: 'Ctrl+Alt+8' },
  });

  // 启动即按配置注册（US-34 验收 1 的注册事实；真实全局按键唤醒属 OS 层，不在此驱动）
  await pollMain<boolean>(
    "e.globalShortcut.isRegistered('Ctrl+Alt+8')",
    (v) => v === true,
  );

  // 菜单「快捷键...」打开改键对话框（返回布尔：CDP 求值不带 returnByValue，数组传不回）
  const menu = await openMenuAndGetPage();
  await menu.locator('.item[data-id="main.shortcut"]').click();
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.getTitle()==='唤醒快捷键')",
    (v) => v === true,
  );

  // 对话框页面与菜单视图同为 data: URL：按 #save 按钮特征区分
  const dialogDeadline = Date.now() + 10_000;
  let dialogPage: Page | null = null;
  while (!dialogPage && Date.now() < dialogDeadline) {
    for (const p of app.context.pages()) {
      if (!p.url().startsWith('data:')) continue;
      try {
        if (await p.evaluate(() => document.querySelector('#save') !== null)) { dialogPage = p; break; }
      } catch { /* 页面正在初始化 */ }
    }
    if (!dialogPage) await new Promise((r) => setTimeout(r, 150));
  }
  if (!dialogPage) throw new Error('改键对话框页面未出现');

  // 打开时显示当前配置的组合
  await dialogPage.waitForSelector('#key');
  await expect(dialogPage.locator('#key')).toHaveText('Ctrl+Alt+8', { timeout: 5_000 });

  // 捕获新组合：CDP 键盘事件不经过主进程 before-input-event（只接 OS 级输入），
  // 改用 Electron 的 sendInputEvent 从主进程注入同一输入管线
  await mainExpr(
    "e.BrowserWindow.getAllWindows().forEach(w=>{if(w.getTitle()==='唤醒快捷键')"
    + "w.webContents.sendInputEvent({type:'keyDown',modifiers:['ctrl','alt'],keyCode:'Y'})})",
  );
  await expect(dialogPage.locator('#key')).toHaveText('Ctrl+Alt+Y', { timeout: 5_000 });
  await dialogPage.locator('#save').click();

  // 保存后立即换绑：新组合注册、旧组合注销（US-34 验收 2）
  await pollMain<boolean>(
    "e.globalShortcut.isRegistered('Ctrl+Alt+Y')",
    (v) => v === true,
  );
  await pollMain<boolean>(
    "e.globalShortcut.isRegistered('Ctrl+Alt+8')",
    (v) => v === false,
  );
});

test('US-32 菜单切换主题，聊天视图底色立即跟随', async () => {
  const chatPage = await app.chatPage();
  const bg = (): Promise<string> => chatPage.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());

  // 初始主题可能跟随系统：先显式切到深色，拿到确定性的起点值
  let menu = await openMenuAndGetPage();
  await clickSubmenuItem(menu, 'main.theme', 'main.theme.dark');
  await chatPage.waitForTimeout(800);
  const darkBg = await bg();
  expect(darkBg).not.toBe('');

  // 主题 → 浅色：聊天视图根变量立即切换（US-32 验收 1）
  menu = await openMenuAndGetPage();
  await clickSubmenuItem(menu, 'main.theme', 'main.theme.light');
  await expect.poll(bg, { timeout: 10_000 }).not.toBe(darkBg);

  // 切回深色：恢复原值
  menu = await openMenuAndGetPage();
  await clickSubmenuItem(menu, 'main.theme', 'main.theme.dark');
  await expect.poll(bg, { timeout: 10_000 }).toBe(darkBg);
});

test('US-37 最近工作区列表过滤失效目录，关闭后可从最近重开', async () => {
  // 换一个实例：预置一条不存在的本地目录进 recentWorkspaces（菜单里应被过滤）
  await app.close();
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  const named = await makeWorkspace({ 'README.md': '# recent\n' }, 'recent-demo');
  const bogus = path.join(path.dirname(named), 'gone-folder');
  app = await launchApp({
    repoRoot, mockLlm, workspaceDir: named,
    stateOverrides: { recentWorkspaces: [bogus, named] },
  });

  const titlebar = await app.titlebarPage();
  await expect(titlebar.locator('.ws-tab', { hasText: 'recent-demo' })).toBeVisible({ timeout: 20_000 });

  // 菜单「添加最近的工作区」：列表只含存在的目录（US-37 验收 1 的过滤分支）。
  // 二级面板由 hover（mouseenter）展开
  let menu = await openMenuAndGetPage();
  await menu.locator('.item[data-submenu="main.recent"]').hover();
  const recentItems = menu.locator('.item[data-id^="main.recent."]:visible');
  await expect(recentItems.first()).toBeVisible({ timeout: 5_000 });
  const recentLabels = await recentItems.allTextContents();
  expect(recentLabels.some((t) => t.includes('recent-demo'))).toBe(true);
  expect(recentLabels.some((t) => t.includes('gone-folder'))).toBe(false);

  // 关掉标签页：打开集合清空（侧栏回到空态）
  await titlebar.locator('.ws-tab .ws-tab-close').first().click();
  await expect(titlebar.locator('.ws-tab')).toBeHidden({ timeout: 10_000 });

  // 从最近的工作区重开：标签页恢复并激活（US-37 验收 1 的「点击即打开」）
  menu = await openMenuAndGetPage();
  await menu.locator('.item[data-submenu="main.recent"]').hover();
  await menu.locator('.item[data-id^="main.recent."]:visible', { hasText: 'recent-demo' }).first().click();
  const tab = titlebar.locator('.ws-tab', { hasText: 'recent-demo' });
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await expect(tab).toHaveClass(/active/);

  await fs.promises.rm(named, { recursive: true, force: true }).catch(() => undefined);
});

test('US-39+US-27 Spin 设计器：命令与菜单两入口打开；内置命令不进 LLM', async () => {
  const chatPage = await app.chatPage();

  // 命令入口：/spin design 由 core 分发为客户端动作（US-27 验收 2）
  await chatPage.fill('textarea.input-textarea', '/spin design');
  await chatPage.press('textarea.input-textarea', 'Enter');
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Spin 设计')",
    (v) => v === true,
  );

  // 菜单入口：功能开关 → Spin 设计（已开则聚焦复用，US-39 验收 1）
  await chatPage.locator('button[title="功能开关"]').click();
  const menu = chatPage.locator('ul.agent-mode-menu');
  await expect(menu.getByText('Spin 设计')).toBeVisible();
  await menu.getByText('Spin 设计').click({ force: true });
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.getTitle()==='Spin 设计')",
    (v) => v === true,
  );

  // 内置命令全程没有 LLM 请求（不进 LLM 上下文，US-27 验收 2）
  expect(mockLlm.requests.length).toBe(0);
});
