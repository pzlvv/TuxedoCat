import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace, waitForMessageBox, clickMessageBoxButton, messageBoxText, mainEval } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * US-42 侧栏文件浏览器（折叠 / 展开 50% / 懒加载树 / 刷新 / 跟随活动工作目录）
 * US-43 文件多选与右键菜单（复制完整 / 相对路径、删除确认）
 * US-44 侧栏宽度拖拽（右缘手柄、持久化、双击恢复默认）
 *
 * 驱动的是 Electron 原生侧栏（dist/sidebar），文件树数据来自主进程真实读盘，
 * 删除确认经自绘消息框窗口驱动（waitForMessageBox / clickMessageBoxButton）、复制经主进程剪贴板桩。
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

/** 按路径切换活动工作区（走主进程 openWorkspace，与侧栏点击工作区同一路径） */
async function openWorkspaceByPath(sb: Page, wsPath: string): Promise<void> {
  await sb.evaluate(async (p) => {
    const w = window as unknown as {
      sidebarAPI?: {
        getWorkspaces: () => Promise<{ workspaces: Array<{ id: string; path: string }> }>;
        openWorkspace: (id: string) => void;
      };
    };
    const state = await w.sidebarAPI!.getWorkspaces();
    const target = state.workspaces.find((t) => t.path === (p as string));
    if (target) w.sidebarAPI!.openWorkspace(target.id);
  }, wsPath);
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

test('US-42 文件树状态按工作区独立：切换标签页不清空、不失效，切回原样保留', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // A：展开 src 目录（单击展开）
  await sb.locator(`${FILE_ROWS}[data-path="src"]`).click();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toBeVisible();

  // 添加第二个工作区（自动激活）：折叠状态按工作区记忆，B 是折叠的
  const dir2 = await makeWorkspace({ 'only-in-b.txt': 'B' }, 'e2e-ws-files-b');
  try {
    await sb.evaluate((p) =>
      (window as unknown as { sidebarAPI?: { addWorkspaces: (paths: string[]) => void } })
        .sidebarAPI!.addWorkspaces([p as string]), dir2);
    await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(0, { timeout: 15_000 });

    // 展开 B：只看到 B 的内容（A 的树缓存不会串进来）
    await sb.locator('#filesHeader').click();
    await expect(sb.locator(`${FILE_ROWS}[data-path="only-in-b.txt"]`)).toBeVisible({ timeout: 15_000 });

    // 切回 A：分区仍是展开的（各自记忆），src 仍展开、条目原样保留（树没被重置 / 失效）
    await sb.evaluate(async (wsPath) => {
      const w = window as unknown as {
        sidebarAPI?: {
          getWorkspaces: () => Promise<{ workspaces: Array<{ id: string; path: string }> }>;
          openWorkspace: (id: string) => void;
        };
      };
      const state = await w.sidebarAPI!.getWorkspaces();
      const target = state.workspaces.find((t) => t.path === (wsPath as string));
      if (target) w.sidebarAPI!.openWorkspace(target.id);
    }, app.workspaceDir);
    await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toBeVisible({ timeout: 15_000 });
    await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toBeVisible();
  } finally {
    await fs.promises.rm(dir2, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('US-42 折叠态下树 DOM 被清空后，再次展开仍显示缓存内容（无需手动刷新）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // A 折叠：此后任何一次 renderFiles（折叠态不渲染，会把树 DOM 清空）都会抹掉 A 的树
  await sb.locator('#filesHeader').click();
  await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(0);

  const dir2 = await makeWorkspace({ 'only-in-b.txt': 'B' }, 'e2e-ws-files-c');
  try {
    // 添加 B（自动激活、默认折叠）→ 折叠态 renderFiles 清空 A 的树 DOM
    await sb.evaluate((p) =>
      (window as unknown as { sidebarAPI?: { addWorkspaces: (paths: string[]) => void } })
        .sidebarAPI!.addWorkspaces([p as string]), dir2);
    // 展开 B 并等它渲染：DOM 变成 B 的条目，用于确认随后「切回 A」确实发生了
    await sb.locator('#filesHeader').click();
    await expect(sb.locator(`${FILE_ROWS}[data-path="only-in-b.txt"]`)).toBeVisible({ timeout: 15_000 });

    // 切回 A（仍折叠）：renderFiles 把 DOM 清空 → 条目归零即「切回已生效」的信号
    await openWorkspaceByPath(sb, app.workspaceDir);
    await expect(sb.locator(FILE_ROWS)).toHaveCount(0, { timeout: 15_000 });
    await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(0);

    // 展开 A：命中缓存也必须重画，不能停在空树
    await sb.locator('#filesHeader').click();
    await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toBeVisible({ timeout: 15_000 });
    await expect(sb.locator(`${FILE_ROWS}[data-path="src"]`)).toBeVisible();
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

test('US-43 删除需自绘确认：取消不动，确认后移入回收站并刷新（Delete 键入口）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // 选中两项后按 Delete：先弹自绘确认框，默认按钮是「取消」
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).click();
  await sb.locator(`${FILE_ROWS}[data-path="readme.md"]`).click({ modifiers: ['Control'] });
  await expect(sb.locator(SELECTED_ROWS)).toHaveCount(2);
  await sb.keyboard.press('Delete');
  const box = await waitForMessageBox(app);
  const call = await messageBoxText(box);
  expect(call.buttons).toEqual(['移入回收站', '取消']);
  expect(call.message).toBe('要删除选中的 2 项吗？');

  // 取消：文件仍在，树不变
  await clickMessageBoxButton(box, 1);
  await expect(sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`)).toBeVisible();
  await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toBeVisible();
  expect(fs.existsSync(path.join(workspaceDir, 'notes.txt'))).toBe(true);
  expect(fs.existsSync(path.join(workspaceDir, 'readme.md'))).toBe(true);

  // 确认（按钮 0「移入回收站」）：文件移出工作目录，树自动刷新后条目消失
  await sb.keyboard.press('Delete');
  const box2 = await waitForMessageBox(app);
  await clickMessageBoxButton(box2, 0);
  await expect(sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(sb.locator(`${FILE_ROWS}[data-path="readme.md"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(
    () => fs.existsSync(path.join(workspaceDir, 'notes.txt'))
      || fs.existsSync(path.join(workspaceDir, 'readme.md')),
    { timeout: 15_000 },
  ).toBe(false);
});

test('US-42 双击文件行打开：文本进 Monaco（与 Edit 预览同效果）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // 文本（.txt / 代码等）进 Monaco；Markdown 走内置预览窗口（下一条用例）
  await sb.locator(`${FILE_ROWS}[data-path="notes.txt"]`).dblclick();
  const monacoPage = await app.waitForPage('monaco', 20_000);
  await expect(monacoPage.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
});

test('US-42 双击 Markdown 文件行：进内置 Markdown 预览窗口（fileOpen 的 .md 分流）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // .md / .markdown 不进 Monaco：openLocalWorkspaceFile 把它分给渲染后的只读
  // 预览窗口（data: URL 页面，`src/host/markdownHtml.ts` 生成）
  await sb.locator(`${FILE_ROWS}[data-path="readme.md"]`).dblclick();
  const previewPage = await app.waitForPage('data:text/html', 20_000);
  await expect(previewPage.locator('article.markdown-body h1')).toHaveText('demo', { timeout: 20_000 });
});

test('US-42 双击文件行打开：目录净效果仍是展开（双击不翻转）', async () => {
  const sb = await sidebar();
  await expandFiles(sb);

  // 双击目录 = 两次单击但第二下被忽略：src 保持展开、子条目在
  await sb.locator(`${FILE_ROWS}[data-path="src"]`).dblclick();
  await expect(sb.locator(`${FILE_ROWS}[data-path="src/index.ts"]`)).toBeVisible();
});

test('US-42 双击文件行打开：图片进内置查看器，二进制调系统应用', async () => {
  // 1x1 PNG（真实字节，能被 <img> 解码）+ 含 NUL 字节的未知扩展名（嗅探判二进制）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await fs.promises.writeFile(path.join(workspaceDir, 'pic.png'), png);
  await fs.promises.writeFile(path.join(workspaceDir, 'payload.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const sb = await sidebar();
  await expandFiles(sb);

  // 图片 → 内置图片查看器窗口（dist/imageViewer）
  await sb.locator(`${FILE_ROWS}[data-path="pic.png"]`).dblclick();
  const viewerPage = await app.waitForPage('imageViewer', 20_000);
  await expect(viewerPage.locator('#image')).toBeVisible({ timeout: 20_000 });

  // 滚轮缩放：向上滚一档 → 110%（1x1 像素图初始就是 100%，缩放角标同步显示）
  await viewerPage.mouse.move(450, 350);
  await viewerPage.mouse.wheel(0, -120);
  await expect(viewerPage.locator('#badge')).toHaveText('110%', { timeout: 5_000 });

  // 二进制 → shell.openPath（桩掉：验证调用链路与参数，不真的拉起系统应用）
  const injected = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    globalThis.__openPathCalls = [];
    e.shell.openPath = async (p) => { globalThis.__openPathCalls.push(String(p)); return ''; };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  if (injected !== 'ok') throw new Error(`openPath 注入失败：${injected}`);
  await sb.locator(`${FILE_ROWS}[data-path="payload.bin"]`).dblclick();
  await expect.poll(async () => {
    const raw = await mainEval<string>(app, 'JSON.stringify(globalThis.__openPathCalls)');
    return JSON.parse(raw) as string[];
  }, { timeout: 10_000 }).toEqual([path.join(workspaceDir, 'payload.bin')]);
});

test('US-44 拖拽侧栏右缘改宽度并持久化，双击恢复默认', async () => {
  const sb = await sidebar();
  await expect(sb.locator('#resizeHandle')).toBeAttached();
  const width = () => sb.evaluate(() => window.innerWidth);
  // 默认 280（无持久化记录）
  await expect.poll(width, { timeout: 5_000 }).toBe(280);

  // 合成指针序列驱动拖拽（277 → 397：280 + 120 = 400）。pointer capture 对合成
  // pointer 不可用，拖拽逻辑挂在 window 级监听上照常工作；主进程按 IPC 夹取后应用
  await sb.evaluate(() => {
    const fire = (target: EventTarget, type: string, x: number): void => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, pointerId: 7, button: 0,
      }));
    };
    fire(document.getElementById('resizeHandle')!, 'pointerdown', 277);
    fire(window, 'pointermove', 397);
    fire(window, 'pointerup', 397);
  });
  await expect.poll(width, { timeout: 5_000 }).toBe(400);

  // 松手（final: true）落盘：workspace-state.json 记下 400（文件可能尚未创建，读不到按未落盘重试）
  const persistedWidth = async (): Promise<number | undefined> => {
    try {
      const raw = await fs.promises.readFile(app.stateFile, 'utf-8');
      return (JSON.parse(raw) as { sidebarWidth?: number }).sidebarWidth;
    } catch {
      return undefined;
    }
  };
  await expect.poll(persistedWidth, { timeout: 5_000 }).toBe(400);

  // 双击手柄恢复默认宽度，同样落盘
  await sb.locator('#resizeHandle').dblclick();
  await expect.poll(width, { timeout: 5_000 }).toBe(280);
  await expect.poll(persistedWidth, { timeout: 5_000 }).toBe(280);
});

/**
 * specs/006 FR-002：右缘手柄与对话列表滚动条分居。
 *
 * 手柄吸附侧栏右缘、占据最右侧一条竖带；对话列表（含其滚动条）在该竖带左侧结束，
 * 于是「拖滚动条」与「拖宽度」落在互不重叠的两条带上（US-44 验收 1 的补充）。
 */
test('US-44 右缘手柄与对话列表滚动条分居（滚动条不再压在手柄下）', async () => {
  const sb = await sidebar();
  await expect(sb.locator('#resizeHandle')).toBeAttached();
  const geom = await sb.evaluate(() => {
    const list = document.getElementById('list')!;
    const handle = document.getElementById('resizeHandle')!;
    const listRect = list.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    return {
      listRight: listRect.right,
      handleLeft: handleRect.left,
      handleWidth: handleRect.width,
      viewportWidth: window.innerWidth,
      listOverflowY: getComputedStyle(list).overflowY,
    };
  });
  // 手柄吸附右缘（right: 0）
  expect(Math.abs(geom.handleLeft + geom.handleWidth - geom.viewportWidth)).toBeLessThanOrEqual(1);
  // 列表右缘（滚动条所在处）不进入手柄竖带
  expect(geom.listRight).toBeLessThanOrEqual(geom.handleLeft + 0.5);
  expect(geom.listOverflowY).toBe('auto');
});

/**
 * specs/006 FR-004：切换工作区标签页时文件分区不做过渡。
 *
 * 过渡 / 淡入只挂在用户点击路径上的 `.files-anim`；因切换活动工作区导致的状态变化
 * 直接生效（每个工作区各自记忆展开态，切过去时不该再演一遍动画）。
 */
test('US-42 切换工作区标签页时文件分区不做过渡动画', async () => {
  const sb = await sidebar();
  await expect(sb.locator(SECTION)).toBeVisible();

  // 用户点击展开：临时挂 .files-anim，过渡 / 淡入生效
  await sb.locator('#filesHeader').click();
  const onExpand = await sb.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    return {
      hasAnim: el.classList.contains('files-anim'),
      duration: getComputedStyle(el).transitionDuration,
    };
  }, SECTION);
  expect(onExpand.hasAnim).toBe(true);
  expect(onExpand.duration).not.toBe('0s');
  await expect(sb.locator(`${FILE_ROWS}[data-path="src"]`)).toBeVisible({ timeout: 15_000 });
  // 动画播完即摘掉标记，切换工作区时不会带上过渡属性
  await expect(sb.locator(`${SECTION}.files-anim`)).toHaveCount(0, { timeout: 5_000 });

  // 添加第二个工作区（自动激活、默认折叠）：切过去时状态直接生效，不播放过渡
  const dir2 = await makeWorkspace({ 'only-in-b.txt': 'B' }, 'e2e-ws-files-anim');
  try {
    await sb.evaluate((p) =>
      (window as unknown as { sidebarAPI?: { addWorkspaces: (paths: string[]) => void } })
        .sidebarAPI!.addWorkspaces([p as string]), dir2);
    await expect(sb.locator(`${SECTION}.expanded`)).toHaveCount(0, { timeout: 15_000 });
    const onSwitch = await sb.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const body = el.querySelector('.files-body') as HTMLElement | null;
      return {
        hasAnim: el.classList.contains('files-anim'),
        duration: getComputedStyle(el).transitionDuration,
        animationName: body ? getComputedStyle(body).animationName : 'none',
      };
    }, SECTION);
    expect(onSwitch.hasAnim).toBe(false);
    expect(onSwitch.duration).toBe('0s');
    expect(onSwitch.animationName).toBe('none');
  } finally {
    await fs.promises.rm(dir2, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * specs/006 FR-007：刷新后保留文件树的滚动位置。
 *
 * 刷新会清空并重读整棵树（DOM 高度先塌后涨），滚动位置在内容重新铺满后回填。
 */
test('US-42 刷新后保留文件树的滚动位置', async () => {
  const sb = await sidebar();
  // 造出可滚动的长列表（刷新会重读磁盘，新文件照常出现）
  for (let i = 0; i < 60; i += 1) {
    await fs.promises.writeFile(path.join(workspaceDir, `bulk-${String(i).padStart(2, '0')}.txt`), 'x', 'utf8');
  }
  await expandFiles(sb);
  await expect(sb.locator(`${FILE_ROWS}[data-path="bulk-59.txt"]`)).toBeAttached({ timeout: 15_000 });
  // 等展开过渡走完（.files-anim 摘掉）再量基准高度：过渡中分区高度还在变，
  // 此时量到的 clientHeight 偏小，刷新后会被误判成「位置没还原」
  await expect(sb.locator(`${SECTION}.files-anim`)).toHaveCount(0, { timeout: 5_000 });

  const body = sb.locator('#filesBody');
  const before = await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  expect(before.scrollTop).toBeGreaterThan(0);

  await sb.locator('#filesRefresh').click();
  // 刷新后内容重新长回来，滚动位置回到刷新前（内容不足时贴底）
  await expect.poll(async () => body.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const after = await body.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    rows: document.querySelectorAll('#filesTree .file-row[data-path]').length,
  }));
  expect(
    Math.abs(after.scrollTop - before.scrollTop),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  ).toBeLessThanOrEqual(2);
});
