import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * 「打开远程工作区」对话框（`electron/remoteWorkspace/`，规格 `docs/client-connection.md` 第 4.2 节）：
 * - 接入方式只有 SSH 表单，打开不聚焦任何输入框，窗口不建菜单栏（Alt 不呼出菜单）；
 * - SSH 连接历史候选：host 聚焦弹出（最多 6 条）、文案 `<user>@<host>(:port)`
 *   （端口 22 不显示）、关键字前缀匹配排在非前缀匹配之前（同级按时间）、
 *   选定候选回填整表单（含口令）、候选行右侧删除按钮清历史并落盘。
 */

let mockLlm: MockLlm;
let app: AppHandle | null = null;
let workspaceDir: string;

test.beforeEach(async () => {
  const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
  workspaceDir = await makeWorkspace({ 'ws.md': 'ws' });
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

/** 走真实 UI 路径打开对话框：标题栏菜单 → 「打开远程工作区…」 */
async function openDialog(currentApp: AppHandle): Promise<Page> {
  const titlebar = await currentApp.titlebarPage();
  await titlebar.locator('.menu-btn').first().click();
  const menu = await currentApp.waitForPage('data:text/html');
  await menu.locator('[data-id="main.addRemoteWorkspace"]').click();
  return currentApp.waitForPage('dist/remoteWorkspace/index.html');
}

/**
 * 主进程求值：入口 bundle 是 CJS，inspector 的全局求值上下文里没有裸 `require`，
 * 与 `desktopShell.spec.ts` 同口径经 `process.mainModule.require` 取 electron。
 * 表达式要回**基本类型**（对象走 `JSON.stringify`）——CDP 默认按引用回对象，取不到 `value`。
 */
function mainExpr<T>(currentApp: AppHandle, body: string): Promise<T> {
  return currentApp.evaluateInMain(
    `(function(){try{const e=process.mainModule?process.mainModule.require('electron'):require('electron');return ${body};}catch(err){return 'ERR '+err.message;}})()`,
  ).then((raw) => {
    const envelope = raw as { result?: { result?: { value?: T } } };
    return envelope?.result?.result?.value as T;
  });
}

/** 预置的 SSH 连接历史（数组顺序即时间序：第 0 条最近连接） */
const HISTORY = [
  { host: '10.0.0.1', port: 22, user: 'root', password: 'pw-root-1' },
  { host: 'build-1', port: 2222, user: 'dev', password: 'pw-dev' },
  { host: 'web-2', port: 22, user: 'carol', password: 'pw-carol' },
  { host: 'db-2', port: 22, user: 'alice', password: 'pw-alice' },
  { host: 'web-1', port: 22, user: 'root', password: 'pw-root-2' },
  { host: '10.0.0.9', port: 2200, user: 'bob', password: 'pw-bob' },
  { host: 'cache-1', port: 22, user: 'root', password: 'pw-root-3' },
  { host: 'build-2', port: 22, user: 'dave', password: 'pw-dave' },
];

function suggestionTexts(page: Page): Promise<string[]> {
  return page.locator('#sshSuggestions .suggestion-text').allTextContents();
}

test('接入方式只有 SSH 表单且打开不聚焦输入框，无历史时不弹候选', async () => {
  const launched = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir,
  });
  app = launched;
  const dialog = await openDialog(launched);

  // 接入方式只有 SSH 表单：没有连接串页签
  await expect(dialog.locator('#tabConnectionString')).toHaveCount(0);
  await expect(dialog.locator('#tabSsh')).toHaveCount(0);
  await expect(dialog.locator('#paneConnectionString')).toHaveCount(0);
  // 打开不抢输入框焦点：activeElement 停在 body（不是任何一个输入框）
  await expect(dialog.locator('#paneSsh')).toBeVisible();
  await expect
    .poll(() => dialog.evaluate(() => document.activeElement?.tagName ?? ''))
    .not.toBe('INPUT');
  // 用户点进 host 才聚焦
  await dialog.locator('#sshHost').click();
  await expect
    .poll(() => dialog.evaluate(() => document.activeElement?.id ?? ''))
    .toBe('sshHost');
  // 无历史时不弹候选
  await expect(dialog.locator('#sshSuggestions')).toBeHidden();

  // 窗口不建菜单栏（`autoHideMenuBar: false` + `setMenu(null)`）：Alt 不会呼出菜单
  await expect
    .poll(async () => JSON.parse(await mainExpr<string>(launched, `JSON.stringify((() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('dist/remoteWorkspace/index.html'));
      return win ? { autoHide: win.autoHideMenuBar, visible: win.isMenuBarVisible() } : null;
    })())`)))
    .toEqual({ autoHide: false, visible: false });
});

test('host 聚焦弹出最近 6 条候选，端口 22 不显示、非 22 追加 :port', async () => {
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir,
    stateOverrides: { recentSshConnections: HISTORY },
  });
  const dialog = await openDialog(app);

  // 点进 host 才聚焦：候选自动弹出，最多 6 条、按时间序
  await dialog.locator('#sshHost').click();
  await expect(dialog.locator('#sshSuggestions .suggestion')).toHaveCount(6);
  await expect(dialog.locator('#sshSuggestions .suggestion-text')).toHaveText([
    'root@10.0.0.1',
    'dev@build-1:2222',
    'carol@web-2',
    'alice@db-2',
    'root@web-1',
    'bob@10.0.0.9:2200',
  ]);
  // 每条候选右侧都有删除按钮
  await expect(dialog.locator('#sshSuggestions .suggestion-remove')).toHaveCount(6);
});

test('关键字筛选：前缀匹配排在更近的非前缀匹配之前，无匹配收起', async () => {
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir,
    stateOverrides: { recentSshConnections: HISTORY },
  });
  const dialog = await openDialog(app);
  await dialog.locator('#sshHost').click();
  await dialog.waitForSelector('#sshSuggestions .suggestion');

  // 'ro'：三条 root@ 是前缀匹配；carol 只是子串包含（ca-ro-l），
  // 虽然比 root@web-1 / root@cache-1 更近，仍排在全部前缀匹配之后
  await dialog.fill('#sshHost', 'ro');
  await expect(dialog.locator('#sshSuggestions .suggestion-text')).toHaveText([
    'root@10.0.0.1',
    'root@web-1',
    'root@cache-1',
    'carol@web-2',
  ]);

  // 'build'：按裸 host 前缀命中两条，同级内按时间序
  await dialog.fill('#sshHost', 'build');
  await expect(dialog.locator('#sshSuggestions .suggestion-text')).toHaveText([
    'dev@build-1:2222',
    'dave@build-2',
  ]);

  // 无匹配：收起
  await dialog.fill('#sshHost', 'zzz');
  await expect(dialog.locator('#sshSuggestions')).toBeHidden();
});

test('选定候选回填整表单（host / 端口 / 用户 / 口令）并收起候选', async () => {
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir,
    stateOverrides: { recentSshConnections: HISTORY },
  });
  const dialog = await openDialog(app);

  await dialog.fill('#sshHost', 'build');
  await dialog.locator('#sshSuggestions .suggestion', { hasText: 'dev@build-1:2222' }).click();
  await expect(dialog.locator('#sshHost')).toHaveValue('build-1');
  await expect(dialog.locator('#sshPort')).toHaveValue('2222');
  await expect(dialog.locator('#sshUser')).toHaveValue('dev');
  await expect(dialog.locator('#sshPassword')).toHaveValue('pw-dev');
  await expect(dialog.locator('#sshSuggestions')).toBeHidden();
});

test('候选行删除按钮清掉这条历史并同步落盘', async () => {
  app = await launchApp({
    repoRoot: process.cwd().replace(/[\\/]e2e$/, ''),
    mockLlm,
    workspaceDir,
    stateOverrides: { recentSshConnections: HISTORY },
  });
  const dialog = await openDialog(app);
  await dialog.locator('#sshHost').click();
  await dialog.waitForSelector('#sshSuggestions .suggestion');

  await dialog
    .locator('#sshSuggestions .suggestion', { hasText: 'root@10.0.0.1' })
    .locator('.suggestion-remove')
    .click();

  // 候选立即刷新：被删的条目消失，后面的顶上来
  await expect(dialog.locator('#sshSuggestions .suggestion-text').first()).toHaveText('dev@build-1:2222');
  expect(await suggestionTexts(dialog)).not.toContain('root@10.0.0.1');

  // 落盘同步：状态文件里也少了这一条
  await expect
    .poll(async () => {
      const state = JSON.parse(await fs.promises.readFile(app!.stateFile, 'utf-8'));
      return Array.isArray(state.recentSshConnections) ? state.recentSshConnections.length : -1;
    })
    .toBe(HISTORY.length - 1);

  // 失焦再聚焦：历史（此时 7 条）按时间弹出前 6 条，已删的不在其中。
  // 候选是覆盖层（盖住下方字段），先 Esc 收起再去点其它输入框
  await dialog.keyboard.press('Escape');
  await expect(dialog.locator('#sshSuggestions')).toBeHidden();
  await dialog.locator('#sshUser').click();
  await dialog.locator('#sshHost').click();
  await dialog.waitForSelector('#sshSuggestions .suggestion');
  const texts = await suggestionTexts(dialog);
  expect(texts).not.toContain('root@10.0.0.1');
  expect(texts).toEqual([
    'dev@build-1:2222',
    'carol@web-2',
    'alice@db-2',
    'root@web-1',
    'bob@10.0.0.9:2200',
    'root@cache-1',
  ]);
});
