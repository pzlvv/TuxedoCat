import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { Page } from '@playwright/test';
import type { MockLlm } from '../helpers/mockLlmServer';
import { CONFIG_DIR_NAME } from '../../src/config/project';

/**
 * US-27 内置命令分发 / US-31 窗口控制 / US-32 主题切换 / US-33 系统托盘与任务提醒 /
 * US-34 全局唤醒快捷键 / US-37 最近工作区 / US-39 Spin 设计器 /
 * US-53 标签页快捷键（录制改键 / 冲突拒绝 / 菜单同源展示）
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
 * 经 `process.mainModule.require` 取 electron。
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

/** 在 CDP 目标列表里按内容特征找到偏好设置窗口页面（data: URL + #sound-enabled）。
 *  等状态推入后再返回：主题单选已有勾选项，后续点击 / 断言不踩「状态未到」的竞态。 */
async function findPreferencePage(): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const p of app.context.pages()) {
      if (!p.url().startsWith('data:')) continue;
      try {
        const ready = await p.evaluate(
          () => document.querySelector('#sound-enabled') !== null
            && document.querySelector('input[name="theme"]:checked') !== null,
        );
        if (ready) return p;
      } catch { /* 页面正在初始化 */ }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('偏好设置窗口页面未出现');
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

test('US-34 全局唤醒快捷键：按配置注册、改键后立即换绑', async () => {
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

  // 菜单「偏好设置...」打开设置窗口（返回布尔：CDP 求值不带 returnByValue，数组传不回）
  const menu = await openMenuAndGetPage();
  await menu.locator('.item[data-id="main.preference"]').click();
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.getTitle()==='偏好设置')",
    (v) => v === true,
  );
  const dialogPage = await findPreferencePage();

  // 打开时显示当前配置的组合（唤醒行，specs/021 起快捷键区为三行、唤醒是第一行）
  await expect(dialogPage.locator('#shortcut-wake')).toHaveText('Ctrl+Alt+8', { timeout: 5_000 });

  // 点快捷键字段开始录制（等页面切到录制文案，确认主进程已进入录制态），再注入新组合：
  // CDP 键盘事件不经过主进程 before-input-event（只接 OS 级输入），
  // 改用 Electron 的 sendInputEvent 从主进程注入同一输入管线
  await dialogPage.locator('#shortcut-wake').click();
  await expect(dialogPage.locator('#shortcut-wake')).toHaveText('请按下新的组合键…', { timeout: 5_000 });
  await mainExpr(
    "e.BrowserWindow.getAllWindows().forEach(w=>{if(w.getTitle()==='偏好设置')"
    + "w.webContents.sendInputEvent({type:'keyDown',modifiers:['ctrl','alt'],keyCode:'Y'})})",
  );
  await expect(dialogPage.locator('#shortcut-wake')).toHaveText('Ctrl+Alt+Y', { timeout: 5_000 });

  // 关闭窗口后按最新偏好重新注册：新组合注册、旧组合注销（US-34 验收 2）
  await dialogPage.locator('#close').click();
  await pollMain<boolean>(
    "e.globalShortcut.isRegistered('Ctrl+Alt+Y')",
    (v) => v === true,
  );
  await pollMain<boolean>(
    "e.globalShortcut.isRegistered('Ctrl+Alt+8')",
    (v) => v === false,
  );
});

test('US-53 标签页快捷键：录制改键生效、冲突拒绝、菜单同源展示', async () => {
  // 菜单「偏好设置...」打开设置窗口（specs/021：快捷键区为三行）
  const menu = await openMenuAndGetPage();
  await menu.locator('.item[data-id="main.preference"]').click();
  await pollMain<boolean>(
    "e.BrowserWindow.getAllWindows().some(w=>w.getTitle()==='偏好设置')",
    (v) => v === true,
  );
  const dialogPage = await findPreferencePage();

  // 默认组合：下一 Ctrl+Tab、上一 Ctrl+Shift+Tab（specs/021 AC-6）
  await expect(dialogPage.locator('#shortcut-next')).toHaveText('Ctrl+Tab', { timeout: 5_000 });
  await expect(dialogPage.locator('#shortcut-prev')).toHaveText('Ctrl+Shift+Tab');

  // 录制下一标签 = Ctrl+J：sendInputEvent 走主进程同一输入管线（同 US-34 口径）
  await dialogPage.locator('#shortcut-next').click();
  await expect(dialogPage.locator('#shortcut-next')).toHaveText('请按下新的组合键…', { timeout: 5_000 });
  await mainExpr(
    "e.BrowserWindow.getAllWindows().forEach(w=>{if(w.getTitle()==='偏好设置')"
    + "w.webContents.sendInputEvent({type:'keyDown',modifiers:['ctrl'],keyCode:'J'})})",
  );
  await expect(dialogPage.locator('#shortcut-next')).toHaveText('Ctrl+J', { timeout: 5_000 });

  // 冲突拒绝（AC-10）：把上一标签录成 Ctrl+J（与下一标签相同）→ 行内报错；
  // 拒绝后录制态保留（可直接再按别的组合），按钮不回写、原值未动
  await dialogPage.locator('#shortcut-prev').click();
  await expect(dialogPage.locator('#shortcut-prev')).toHaveText('请按下新的组合键…', { timeout: 5_000 });
  await mainExpr(
    "e.BrowserWindow.getAllWindows().forEach(w=>{if(w.getTitle()==='偏好设置')"
    + "w.webContents.sendInputEvent({type:'keyDown',modifiers:['ctrl'],keyCode:'J'})})",
  );
  await expect(dialogPage.locator('#shortcut-error')).toContainText('下一标签', { timeout: 5_000 });
  await expect(dialogPage.locator('#shortcut-prev')).toHaveClass(/capturing/);

  // Esc 取消录制（AC-9）：退出录制态，原值保持
  await mainExpr(
    "e.BrowserWindow.getAllWindows().forEach(w=>{if(w.getTitle()==='偏好设置')"
    + "w.webContents.sendInputEvent({type:'keyDown',modifiers:[],keyCode:'Escape'})})",
  );
  await expect(dialogPage.locator('#shortcut-prev')).toHaveText('Ctrl+Shift+Tab', { timeout: 5_000 });
  await expect(dialogPage.locator('#shortcut-error')).toHaveText('', { timeout: 5_000 });

  // 持久化（AC-8 的落盘半边）：状态文件里 nextTabShortcut = Ctrl+J；
  // 重启读回自定义组合在 e2e/electron/workspace.spec.ts 的换键用例里驱动
  await pollMain<string>(
    "(()=>{const fs=process.mainModule.require('fs');"
    + "const e=process.mainModule.require('electron');"
    + "return JSON.parse(fs.readFileSync(e.app.getPath('userData')+'/workspace-state.json','utf-8')).nextTabShortcut;})()",
    (v) => v === 'Ctrl+J',
  );

  // 关窗后菜单同源（AC-13）：下一标签条目展示新组合
  await dialogPage.locator('#close').click();
  const menuAfter = await openMenuAndGetPage();
  await expect(menuAfter.locator('.item[data-id="main.nextWorkspaceTab"]')).toContainText('Ctrl+J', { timeout: 5_000 });
  await expect(menuAfter.locator('.item[data-id="main.prevWorkspaceTab"]')).toContainText('Ctrl+Shift+Tab');
});

test('US-32 偏好设置切换主题，聊天视图底色立即跟随', async () => {
  const chatPage = await app.chatPage();
  const bg = (): Promise<string> => chatPage.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());

  // 菜单「偏好设置...」打开设置窗口，主题单选在其中
  const menu = await openMenuAndGetPage();
  await menu.locator('.item[data-id="main.preference"]').click();
  const dialogPage = await findPreferencePage();

  // 初始主题可能跟随系统：先显式切到深色，拿到确定性的起点值
  await dialogPage.locator('input[name="theme"][value="dark"]').click();
  await chatPage.waitForTimeout(800);
  const darkBg = await bg();
  expect(darkBg).not.toBe('');

  // 主题 → 浅色：聊天视图根变量立即切换（US-32 验收 1）
  await dialogPage.locator('input[name="theme"][value="light"]').click();
  await expect.poll(bg, { timeout: 10_000 }).not.toBe(darkBg);

  // 切回深色：恢复原值
  await dialogPage.locator('input[name="theme"][value="dark"]').click();
  await expect.poll(bg, { timeout: 10_000 }).toBe(darkBg);
});

test('US-33 偏好设置：提示音开关与音量落盘，音量条随开关显隐', async () => {
  // 菜单「偏好设置...」打开设置窗口
  const menu = await openMenuAndGetPage();
  await menu.locator('.item[data-id="main.preference"]').click();
  const dialogPage = await findPreferencePage();

  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.promises.readFile(app.stateFile, 'utf-8')) as Record<string, unknown>;

  // 提示音默认开启：音量条可见（US-33 验收 4）
  await expect(dialogPage.locator('#volume-row')).toBeVisible();

  // 关掉提示音：音量条隐藏，开关落盘
  await dialogPage.locator('#sound-enabled').uncheck();
  await expect(dialogPage.locator('#volume-row')).toBeHidden();
  await expect.poll(async () => (await readState()).soundEnabled).toBe(false);

  // 再打开：音量条回来
  await dialogPage.locator('#sound-enabled').check();
  await expect(dialogPage.locator('#volume-row')).toBeVisible();

  // 拖完音量滑条（input 只改显示、change 才落盘）：音量以 0–1 落盘
  await dialogPage.locator('#volume').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '40';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(async () => (await readState()).soundVolume as number).toBeCloseTo(0.4, 5);
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

  // 菜单「打开最近的工作区」：列表只含存在的目录（US-37 验收 1 的过滤分支）。
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

  // 保存经 Core 落到会话所在机器的会话目录（US-39 验收 2）
  const designPage = await app.waitForPage('data:text/html');
  await designPage.waitForSelector('#btnSave');
  await designPage.click('#btnSave');
  const findSpinJson = async (): Promise<string | null> => {
    const root = path.join(app.homeDir, CONFIG_DIR_NAME, 'conversations');
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(root);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const dir = path.join(root, entry);
      const spin = path.join(dir, 'spin.json');
      if (!fs.existsSync(spin)) continue;
      try {
        const meta = JSON.parse(
          await fs.promises.readFile(path.join(dir, 'workspace.meta.json'), 'utf-8'),
        ) as { workspacePath?: string };
        if (meta.workspacePath && path.resolve(meta.workspacePath) === path.resolve(workspaceDir)) {
          return spin;
        }
      } catch {
        // 缺项目清单的目录不算目标会话
      }
    }
    return null;
  };
  await expect.poll(findSpinJson, { timeout: 10_000 }).not.toBeNull();
  const spinPath = await findSpinJson();
  const saved = JSON.parse(await fs.promises.readFile(spinPath as string, 'utf-8')) as {
    nodes?: unknown;
  };
  expect(Array.isArray(saved.nodes)).toBe(true);

  // 内置命令全程没有 LLM 请求（不进 LLM 上下文，US-27 验收 2）
  expect(mockLlm.requests.length).toBe(0);
});
