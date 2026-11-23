import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { startMockLlm } from '../helpers/mockLlmServer';
import { launchApp, mainEval, makeWorkspace } from '../helpers/electronApp';
import type { AppHandle } from '../helpers/electronApp';
import type { MockLlm } from '../helpers/mockLlmServer';

/**
 * 标题栏「加号」菜单关闭后不留 hover 高亮（docs/hosts/electron-multi-workspace.md 第 5 节）。
 *
 * 原生 `Menu.popup` 弹出期间鼠标输入被菜单独占，标题栏页面收不到 `mouseout`；菜单
 * 由「点别处」关闭时鼠标已经不在按钮上，但 `:hover` 还停在点开那一刻，表现为「菜单
 * 关了，加号仍然亮着」。修复是把 `menuLeave` 补送给标题栏，挂在 popup 的 `callback`
 * 上，所以这里桩住 `Menu.buildFromTemplate` 把 `popup` 换成记录参数的空操作，再手工
 * 调一次那个 `callback` 走「菜单关闭」的同一个出口。
 *
 * 原生菜单外观与系统级鼠标命中 Playwright 驱动不了（US-48 同一豁免口径），因此断言
 * 落在唯一可疑的那一环：`callback` 执行之后按钮不再是 `:hover`。
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
 * 桩住 `Menu.buildFromTemplate`：`popup()` 只把参数记进 `globalThis.__popupOptions`
 * （不真弹窗），其余行为保持真实。
 */
async function installMenuStub(): Promise<void> {
  const result = await mainEval<string>(app, `(function(){try{
    const e = process.mainModule ? process.mainModule.require('electron') : require('electron');
    if (!globalThis.__origBuildFromTemplate) {
      globalThis.__origBuildFromTemplate = e.Menu.buildFromTemplate.bind(e.Menu);
    }
    globalThis.__popupOptions = [];
    e.Menu.buildFromTemplate = function(template){
      const menu = globalThis.__origBuildFromTemplate(template);
      menu.popup = function(options){
        globalThis.__popupOptions.push({ hasCallback: typeof (options && options.callback) === 'function' });
        if (options && typeof options.callback === 'function') {
          globalThis.__popupCallback = options.callback;
        }
      };
      return menu;
    };
    return 'ok';
  } catch (err) { return 'ERR ' + err.message; }})()`);
  if (result !== 'ok') throw new Error(`菜单桩注入失败：${result}`);
}

/** 调用最近一次 popup 的 callback，等价于「菜单关闭」 */
async function closePopupThroughCallback(): Promise<void> {
  const result = await mainEval<string>(app, `(function(){
    if (typeof globalThis.__popupCallback !== 'function') return 'no-callback';
    globalThis.__popupCallback();
    return 'ok';
  })()`);
  if (result !== 'ok') throw new Error(`菜单关闭回调缺失（${result}）`);
}

test('加号菜单关闭后加号的 hover 高亮消失', async () => {
  await installMenuStub();
  const titlebar = await app.titlebarPage();
  const addBtn = titlebar.locator('.ws-add');
  await expect(addBtn).toBeVisible({ timeout: 20_000 });

  // 指针停在加号上：这是打开菜单前的正常状态
  await addBtn.hover();
  await expect.poll(() => addBtn.evaluate((el) => el.matches(':hover'))).toBe(true);

  // 点加号（桩住的 popup，不真弹窗）——鼠标仍停在按钮上没有移动
  await addBtn.click();
  await expect.poll(async () => mainEval<number>(app, 'globalThis.__popupOptions.length')).toBe(1);
  const captured = JSON.parse(
    await mainEval<string>(app, 'JSON.stringify(globalThis.__popupOptions)'),
  ) as Array<{ hasCallback: boolean }>;
  // 加号菜单的 popup 必须带 callback（这是「菜单关闭」的唯一通知出口）
  expect(captured[0].hasCallback).toBe(true);
  expect(await addBtn.evaluate((el) => el.matches(':hover'))).toBe(true);

  // 菜单关闭：callback 补发 mouseLeave，按钮的 :hover 归零
  await closePopupThroughCallback();
  await expect.poll(() => addBtn.evaluate((el) => el.matches(':hover'))).toBe(false);
});
