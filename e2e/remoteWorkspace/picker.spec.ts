import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { openStaticPage } from '../helpers/webviewHarness';

/**
 * 「选择远端目录」页面（`electron/remoteWorkspace/`，规格 `docs/core/core-daemon.md` 第 12.6 节）。
 *
 * 这一步要连上真实 SSH 才能走到，整应用 e2e（`e2e/electron/remoteWorkspace.spec.ts`）
 * 覆盖不到；这里按 webview-ui 同一手法直接伺服构建产物 `dist/remoteWorkspace/`，
 * 以假 `window.remoteWorkspaceAPI`（内存目录树）驱动真实页面逻辑，锁住：
 * - 路径框里删字母（不是删目录）后，列表回到该目录的全部内容（曾经停在上一轮过滤结果上）；
 * - 选中项恒在（默认第一项，`..` 除外）、上下方向键 / `Ctrl+N` / `Ctrl+P` 移动；
 * - `Tab` 把选中项补全进路径框（带尾分隔符并展开其内容），回车直接进入选中目录；
 * - 路径框常驻焦点（点标题 / 错误行 / 面板空白都不丢）；
 * - 「打开此目录」在路径框停在候选前缀上时作用于选中项。
 */

const REPO_ROOT = process.cwd().replace(/[\\/]e2e$/, '');

/** 假远端目录树：路径 → 子目录名。页面只经 `window.remoteWorkspaceAPI` 读写远端 */
const FAKE_TREE: Record<string, string[]> = {
  '/': ['abc', 'zzz'],
  '/abc': ['def', 'def2', 'other'],
  '/abc/def': ['x', 'y'],
  '/abc/def2': [],
  '/abc/other': [],
  '/zzz': [],
};

const FAKE_API_INIT = `
(() => {
  const dirs = new Map(Object.entries(${JSON.stringify(FAKE_TREE)}));
  const norm = (value) => '/' + String(value ?? '').split('/').filter((part) => part.length > 0 && part !== '.').join('/');
  const parentOf = (dir) => (dir === '/' ? null : dir.slice(0, dir.lastIndexOf('/')) || '/');
  const listing = (dir) => ({
    path: dir,
    parent: parentOf(dir),
    entries: (dirs.get(dir) ?? []).map((name) => ({ name, path: dir === '/' ? '/' + name : dir + '/' + name })),
  });
  const fail = (target) => ({ ok: false, error: 'cannot read ' + target });
  window.remoteWorkspaceAPI = {
    connect: async () => ({
      ok: true,
      listing: listing('/'),
      endpoint: { host: '10.0.0.1', port: 22, user: 'root' },
    }),
    sshHistory: async () => [],
    sshHistoryEntry: async () => null,
    removeSshHistoryEntry: async () => [],
    list: async (target) => (dirs.has(norm(target)) ? { ok: true, listing: listing(norm(target)) } : fail(target)),
    create: async (target) => { dirs.set(norm(target), []); return { ok: true, path: norm(target) }; },
    rename: async (target, name) => ({ ok: true, path: parentOf(norm(target)) + '/' + name }),
    remove: async (target) => {
      const dir = norm(target);
      const parent = parentOf(dir);
      dirs.set(parent, (dirs.get(parent) ?? []).filter((name) => name !== dir.slice(dir.lastIndexOf('/') + 1)));
      dirs.delete(dir);
      return { ok: true, path: dir };
    },
    open: async (target) => { window.__openedPath = target; return { ok: true }; },
    cancel: () => {},
  };
})();
`;

/** 页面里由假 API 记录的状态 */
interface PickerTestWindow {
  __openedPath?: string;
}

let handle: { page: Page; close: () => Promise<void> };

test.beforeEach(async ({ browser }) => {
  handle = await openStaticPage(
    browser,
    path.join(REPO_ROOT, 'dist', 'remoteWorkspace'),
    FAKE_API_INIT,
  );
  // 走真实页面的接入按钮：假 API 直接回主目录列举，进「选目录」这一步
  await handle.page.click('#connect');
  await handle.page.waitForSelector('#pickerView:not(.hidden)');
});

test.afterEach(async () => {
  await handle.close();
});

/** 列表当前渲染出的行文本（含 `..` 与内联编辑行） */
function rowTexts(page: Page): Promise<string[]> {
  return page.locator('#entries .row').allTextContents();
}

test('路径框里删字母：删掉最后一段后列表回到该目录全部内容', async () => {
  const { page } = handle;
  await page.fill('#pathInput', '/abc/def');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'def', 'def2']);

  // 用户报告的场景：在输入框里退掉 def 三个字母（不是删目录），列表必须跟着回到 /abc 全部内容
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(page.locator('#pathInput')).toHaveValue('/abc/');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'def', 'def2', 'other']);
});

test('选中项恒在且默认第一项（`..` 除外），上下方向键 / Ctrl+N / Ctrl+P 移动', async () => {
  const { page } = handle;
  await page.fill('#pathInput', '/abc/');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'def', 'def2', 'other']);
  const selected = page.locator('#entries .row.selected');
  await expect(selected).toHaveText('def');

  await page.keyboard.press('Control+n');
  await expect(selected).toHaveText('def2');
  await page.keyboard.press('Control+p');
  await expect(selected).toHaveText('def');
  await page.keyboard.press('ArrowDown');
  await expect(selected).toHaveText('def2');
  // `..` 也在候选里；到头即停
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(selected).toHaveText('..');
  await page.keyboard.press('ArrowUp');
  await expect(selected).toHaveText('..');
});

test('Tab 补全带尾分隔符并展开，回车直接进入选中目录', async () => {
  const { page } = handle;
  const input = page.locator('#pathInput');

  // 前缀 → Tab 补全：写入选中项并带尾分隔符，列表随即展开它的内容
  await page.fill('#pathInput', '/abc/de');
  await expect(page.locator('#entries .row.selected')).toHaveText('def');
  await page.keyboard.press('Tab');
  await expect(input).toHaveValue('/abc/def/');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'x', 'y']);

  // 回车：一次进入选中目录（路径框回写自带尾分隔符）
  await page.fill('#pathInput', '/abc/de');
  await expect(page.locator('#entries .row.selected')).toHaveText('def');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('/abc/def/');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'x', 'y']);
});

test('删除目录后列表回到该目录全部内容（确认中也不停在过滤结果上）', async () => {
  const { page } = handle;
  await page.fill('#pathInput', '/abc/def');
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'def', 'def2']);

  await page.locator('#entries .row', { hasText: 'def' }).first().click({ button: 'right' });
  await page.click('#menuDelete');
  // 路径框已回写成 /abc/：列表必须同时退回全部内容（.. + 确认行 + def2 + other）
  await expect(page.locator('#pathInput')).toHaveValue('/abc/');
  await expect(page.locator('.row-confirm')).toHaveCount(1);
  await expect.poll(() => rowTexts(page)).toEqual(['..', expect.any(String), 'def2', 'other']);

  await page.locator('.row-confirm button').first().click();
  await expect.poll(() => rowTexts(page)).toEqual(['..', 'def2', 'other']);
});

test('路径框常驻焦点：点标题、错误行、面板空白都不丢', async () => {
  const { page } = handle;
  const input = page.locator('#pathInput');
  await expect(input).toBeFocused();
  await page.click('#pickerSubtitle');
  await expect(input).toBeFocused();
  await page.click('#pickerError');
  await expect(input).toBeFocused();
  await page.click('#pickerView', { position: { x: 5, y: 5 } });
  await expect(input).toBeFocused();
});

test('「打开此目录」在路径框停在候选前缀上时作用于选中项', async () => {
  const { page } = handle;
  await page.fill('#pathInput', '/abc/ot');
  await expect(page.locator('#entries .row.selected')).toHaveText('other');
  await page.click('#open');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as PickerTestWindow).__openedPath))
    .toBe('/abc/other');
});
