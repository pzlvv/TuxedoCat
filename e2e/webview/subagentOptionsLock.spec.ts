import { test, expect } from '@playwright/test';
import { openWebviewView } from '../helpers/webviewHarness';
import type { WebviewHandle } from '../helpers/webviewHarness';

/**
 * US-51 非 Master 子代理会话的选项菜单置灰（specs/020 FR-005，webview 层）。
 *
 * 假宿主直接下发带 `metadata.role` 的 `conversationLoaded`（meta.json 的 role 事实
 * 到达 webview 后的 UI 表现）：explorer 子代理视图三项置灰且点击无副作用，
 * Master 子代理与普通会话不置灰。
 */

let handle: WebviewHandle;

test.beforeEach(async ({ browser }) => {
  handle = await openWebviewView(browser, process.cwd().replace(/[\\/]e2e$/, ''));
});

test.afterEach(async () => {
  await handle.close();
});

/** 注入一条带指定 role 的 conversationLoaded（null = 不带 role，普通会话） */
async function loadSession(role: string | null): Promise<void> {
  const { host, page } = handle;
  await host.send({
    type: 'conversationLoaded',
    sessionId: 's-lock',
    conversation: {
      metadata: {
        sessionId: 's-lock',
        title: '浏览文件',
        ...(role ? { role } : {}),
      },
      messages: [],
    },
    hasCompactArchive: false,
    agentMode: 'risk',
  });
  await expect(page.locator('button[title="功能开关"]')).toBeVisible();
}

/** 菜单行的行内置灰透明度（span 沿祖先找第一个带 style.opacity 的 div） */
async function rowOpacity(menu: import('@playwright/test').Locator, text: string): Promise<string | null> {
  return menu.getByText(text, { exact: true }).evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    const li = el.closest('li');
    while (node && node !== li) {
      if (node.style && node.style.opacity) return node.style.opacity;
      node = node.parentElement;
    }
    return null;
  });
}

async function openMenu(): Promise<import('@playwright/test').Locator> {
  const { page } = handle;
  await page.locator('button[title="功能开关"]').click();
  const menu = page.locator('ul.agent-mode-menu');
  await expect(menu).toBeVisible();
  return menu;
}

test('US-51 explorer 视图：三项置灰且点击不上报', async () => {
  const { host } = handle;
  await loadSession('Explorer');

  const menu = await openMenu();
  expect(await rowOpacity(menu, '联网搜索')).toBe('0.45');
  expect(await rowOpacity(menu, '提示词模式')).toBe('0.45');
  expect(await rowOpacity(menu, 'MCP')).toBe('0.45');

  // 点击不产生任何变更 / 上报：点「极简」后普通仍高亮，且没有新的 setPromptMode 上行
  const selected = (label: string) =>
    menu.getByRole('button', { name: label, exact: true }).evaluate(
      (el) => getComputedStyle(el).color === 'rgb(255, 255, 255)',
    );
  expect(await selected('普通')).toBe(true);
  const sentBefore = (await host.sentAll()).filter((m) => m.type === 'setPromptMode').length;
  await menu.getByRole('button', { name: '极简', exact: true }).click({ force: true });
  await handle.page.waitForTimeout(300);
  expect(await selected('普通')).toBe(true);
  expect(await selected('极简')).toBe(false);
  const sentAfter = (await host.sentAll()).filter((m) => m.type === 'setPromptMode').length;
  expect(sentAfter).toBe(sentBefore);

  // 联网搜索行同样不上报（置灰行点击早退）
  const webSearchBefore = (await host.sentAll()).filter((m) => m.type === 'setWebSearch').length;
  await menu.getByText('联网搜索', { exact: true }).click({ force: true });
  await handle.page.waitForTimeout(300);
  const webSearchAfter = (await host.sentAll()).filter((m) => m.type === 'setWebSearch').length;
  expect(webSearchAfter).toBe(webSearchBefore);
});

test('US-51 Master 子代理与普通会话：不置灰', async () => {
  await loadSession('Master');
  let menu = await openMenu();
  expect(await rowOpacity(menu, '联网搜索')).toBe('1');
  expect(await rowOpacity(menu, '提示词模式')).toBe('1');
  expect(await rowOpacity(menu, 'MCP')).toBe('1');
  await handle.page.keyboard.press('Escape');

  // 普通（无 role）会话同样不置灰
  await loadSession(null);
  menu = await openMenu();
  expect(await rowOpacity(menu, '联网搜索')).toBe('1');
  expect(await rowOpacity(menu, '提示词模式')).toBe('1');
  expect(await rowOpacity(menu, 'MCP')).toBe('1');
});
