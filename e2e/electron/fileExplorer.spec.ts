import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, stubMainMessageBox, mainEval } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-42 侧栏文件浏览器（折叠 / 展开 50% / 懒加载树 / 刷新 / 跟随活动工作目录）
 * US-43 文件多选与右键菜单（复制完整 / 相对路径、删除确认）
 *
 * 驱动的是 Electron 原生侧栏（dist/sidebar），文件树数据来自主进程真实读盘，
 * 删除 / 复制经 stubMainMessageBox / 主进程剪贴板桩驱动两条分支。
 */
const SECTION = '#filesSection';
const TREE = '#filesTree';
const FILE_ROWS = `${TREE} .file-row[data-path]`;
const SELECTED_ROWS = `${TREE} .file-row.selected`;

/** 固定文件集：assets/src 两个目录在前（目录优先排序），notes.txt < readme.md */
const WORKSPACE_FILES: Record<string, string> = {
  'assets/logo.svg': '<svg/>',
  'readme.md': '# demo',
  'notes.txt': 'hello',
  'src/index.ts': 'export const a = 1;',
  'src/app/main.ts': 'export {};',
};

let mockLlm: MockLlm;
let app: AppHandle;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace(WORKSPACE_FILES);
  mockLlm = await startMockLlm({ workspaceDir });
  app = await launchApp({ repoRoot, mockLlm, workspaceDir });
});

test.afterEach(async () => {
  await app.close();
  mockLlm.close();
  await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

async function sidebar(): Promise<Page> {
  return app.sidebarPage();
}

/** 展开文件分区并等根目录条目渲染完成 */
async function expandFiles(sb: Page): Promise<void> {
  await expect(sb.locator(SECTION)).toBeVisible();
  await sb.locator('#filesHeader').click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src"]`)).toBeVisible({ timeout: 15_000 });
}

/** 替换主进程剪贴板，记录 writeText 调用（原生剪贴板内容无法直接断言） */
async function stubClipboard(): Promise<void> {
  const injected = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    globalThis.__clipboardWrites = [];
    e.clipboard.writeText = (text) => { globalThis.__clipboardWrites.push(String(text)); return true; };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  if (injected !== 'ok') throw new Error(`剪贴板注入失败：${injected}`);
}

async function clipboardWrites(): Promise<string[]> {
  return JSON.parse(
    await mainEval<string>(app, 'JSON.stringify(globalThis.__clipboardWrites)'),
  ) as string[];
}

test('US-42 文件分区默认折叠，展开占侧栏 50% 高度并按目录优先列出内容', async () => {
  const sb = await sidebar();
  await expect(sb.locator(SECTION)).toBeVisible();
  // 默认折叠：只有分区条，树不可见
  await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(0);
  await expect(sb.locator(TREE)).not.toBeVisible();
  const collapsed = await sb.locator(SECTION).boundingBox();
  expect(collapsed).not.toBeNull();
  expect(collapsed!.height).toBeLessThan(40);

  await sb.locator('#filesHeader').click();
  await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(1);
  // 展开后占侧栏一半高度（±2% 容差）
  const ratio = expect.poll(async () => {
    const box = await sb.locator(SECTION).boundingBox();
    const body = await sb.evaluate(() => document.body.clientHeight);
    return box && body ? box.height / body : 0;
  }, { timeout: 5_000 });
  await ratio.toBeGreaterThan(0.48);
  await ratio.toBeLessThan(0.52);

  // 目录在前、同类按名称排序（US-42 验收 2）
  const paths = await sb.locator(FILE_ROWS).evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-path')),
  );
  expect(paths).toEqual(['assets', 'src', 'notes.txt', 'readme.md']);
});

test('US-42 目录懒加载逐层展开，刷新按钮能看到外部新建的文件', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // 懒加载：未展开的目录不产生子条目
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toHaveCount(0);

  await sb.locator(`${FILE_ROWS}[data-path="src"] .file-chevron`).click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toBeVisible();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/app"]`)).toBeVisible();
  await sb.locator(`${FILE_ROWS}[data-path="src/app"] .file-chevron`).click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/app/main.ts"]`)).toBeVisible();

  // 外部新建文件 → 刷新 → 树出现新条目
  await fs.promises.writeFile(path.join(workspaceDir, 'fresh-file.txt'), 'new', 'utf8');
  await sb.locator('#filesRefresh').click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="fresh-file.txt"]`)).toBeVisible({ timeout: 15_000 });
});

test('US-42 切换活动工作目录后文件树重置为新目录', async () => {
  const dir2 = await makeWorkspace({ 'only-in-b.txt': 'B' }, 'e2e-ws-files-b');
  try {
    const sb = await sidebar();
    await expandFiles(sb);

    // addWorkspaces 把新目录置为活动项：文件树应重置为新目录的内容
    await sb.evaluate((p) =>
      (window as unknown as { sidebarAPI?: { addWorkspaces: (paths: string[]) => void } })
        .sidebarAPI!.addWorkspaces([p as string]), dir2);
    await expect(sb.locator(`${FILE_ROWS}[data-path="only-in-b.txt"]`)).toBeVisible({ timeout: 15_000 });
    // 旧目录的条目不再出现（树已整体重置，不是叠加）
    await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toHaveCount(0);
  } finally {
    await fs.promises.rm(dir2, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('US-43 右键菜单复制完整/相对路径，多选复制拼接多行', async () => {
  const sb = await sidebar();
  await expandFiles(sb);
  await stubClipboard();

  const readmeRow = sb.locator(`${FILE_ROWS}[data-path="readme.md"]`);
  await readmeRow.click({ button: 'right' });
  const menu = sb.locator('.files-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-menu="reveal"]')).toContainText('在文件资源管理器中打开');

  // 复制完整路径：工作目录内的绝对路径（原生分隔符）
  await menu.locator('[data-menu="copy-full"]').click();
  await expect.poll(() => clipboardWrites(), { timeout: 5_000 }).toHaveLength(1);
  expect((await clipboardWrites())[0]).toBe(path.join(workspaceDir, 'readme.md'));

  // 复制相对路径：相对工作目录根
  await readmeRow.click({ button: 'right' });
  await sb.locator('[data-menu="copy-rel"]').click();
  await expect.poll(() => clipboardWrites(), { timeout: 5_000 }).toHaveLength(2);
  expect((await clipboardWrites())[1]).toBe('readme.md');

  // Ctrl+点击多选后复制：全部选中项按换行拼接
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).click({ modifiers: ['Control'] });
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(2);
  await readmeRow.click({ button: 'right' });
  await sb.locator('[data-menu="copy-full"]').click();
  await expect.poll(() => clipboardWrites(), { timeout: 5_000 }).toHaveLength(3);
  expect((await clipboardWrites())[2]).toBe(
    [path.join(workspaceDir, 'readme.md'), path.join(workspaceDir, 'notes.txt')].join('\n'),
  );
});

test('US-42 目录单击即展开 / 折叠，文件单击只选中', async () => {
  const sb = await sidebar();
  await expandFiles(sb);
  const rows = sb.locator(FILE_ROWS);

  // 单击目录：展开 + 选中（US-42 验收 2：单展开，不要双击）
  await rows.nth(1).click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toBeVisible();
  await expect(sb.locator(`${SELECTED_ROWS}[data-path="src"]`)).toHaveCount(1);

  // 再单击：折叠，子条目消失
  await rows.nth(1).click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toHaveCount(0);

  // 单击文件：只选中，不改变树结构
  await rows.nth(3).click();
  await expect(sb.locator(`${SELECTED_ROWS}[data-path="readme.md"]`)).toHaveCount(1);
  await expect(sb.locator(`${FILE_ROWS}`)).toHaveCount(4);
});

test('US-43 点击/Ctrl/Shift 多选与 Esc 清空', async () => {
  const sb = await sidebar();
  await expandFiles(sb);
  const rows = sb.locator(FILE_ROWS);

  // 点击文件选中；Shift+点击另一端取连续段（Ctrl / Shift 多选不触发目录展开）
  await rows.nth(3).click();
  await rows.nth(0).click({ modifiers: ['Shift'] });
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(4);

  // Ctrl+点击已选中项 = 取消该项
  await rows.nth(3).click({ modifiers: ['Control'] });
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(3);

  // Ctrl+A 全选可见项；Esc 清空（焦点在树上，点击行时已移入）
  await sb.keyboard.press('Control+a');
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(4);
  await sb.keyboard.press('Escape');
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(0);
});

test('US-43 在文件资源管理器中打开只作用于右键项（主进程收到该项的绝对路径）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);
  // 桩掉 shell.showItemInFolder：验证调用链路与参数，不真的弹资源管理器窗口
  const injected = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    globalThis.__revealCalls = [];
    e.shell.showItemInFolder = (p) => { globalThis.__revealCalls.push(String(p)); return true; };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  if (injected !== 'ok') throw new Error(`showItemInFolder 注入失败：${injected}`);

  // 多选两项后右键其中一项：reveal 只作用于右键项，不吃选中集合
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).click();
  await sb.locator(`${FILE_ROWS}[data-path="readme.md"]`).click({ modifiers: ['Control'] });
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).click({ button: 'right' });
  await sb.locator('[data-menu="reveal"]').click();
  await expect.poll(async () => {
    const raw = await mainEval<string>(app, 'JSON.stringify(globalThis.__revealCalls)');
    return JSON.parse(raw) as string[];
  }, { timeout: 5_000 }).toEqual([path.join(workspaceDir, 'notes.txt')]);
});

test('US-43 删除需原生确认：取消不动，确认后移入回收站并刷新（Delete 键入口）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);
  const messageBox = await stubMainMessageBox(app);

  // 选中两项后按 Delete：先弹原生确认框，默认按钮是「取消」
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).click();
  await sb.locator(`${FILE_ROWS}[data-path="readme.md"]`).click({ modifiers: ['Control'] });
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(2);
  await sb.keyboard.press('Delete');
  await expect.poll(() => messageBox.calls(), { timeout: 10_000 }).toHaveLength(1);
  const call = (await messageBox.calls())[0];
  expect(call.buttons).toEqual(['移入回收站', '取消']);
  expect(call.message).toBe('要删除选中的 2 项吗？');

  // 取消（桩按 defaultId 应答）：文件仍在，树不变
  await expect(sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`)).toBeVisible();
  await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toBeVisible();
  expect(fs.existsSync(path.join(workspaceDir, 'notes.txt'))).toBe(true);
  expect(fs.existsSync(path.join(workspaceDir, 'readme.md'))).toBe(true);

  // 确认：文件移出工作目录，树自动刷新后条目消失
  await messageBox.setResponse(0);
  await sb.keyboard.press('Delete');
  await expect.poll(() => messageBox.calls(), { timeout: 10_000 }).toHaveLength(2);
  await expect(sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(
    () => fs.existsSync(path.join(workspaceDir, 'notes.txt'))
      || fs.existsSync(path.join(workspaceDir, 'readme.md')),
    { timeout: 15_000 },
  ).toBe(false);
});
