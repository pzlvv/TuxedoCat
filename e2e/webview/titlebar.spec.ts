import { test, expect } from '@playwright/test';
import { openStaticPage } from '../helpers/webviewHarness';

/**
 * 标题栏标签页快照的时序（US-36）：陈旧的 get-state 回包不得覆盖较新的推送。
 *
 * 实测回归（打包版启动时序）：远程工作区建链失败发生在启动后约 2 秒，恰好落在
 * 「标题栏 init 已发出 get-state、主进程已处理（快照 = connecting）但回包还在途」
 * 的窗口里——主进程标红推送先到并画出红点，随后到达的 get-state 回包带着陈旧的
 * connecting 快照把红点覆盖回黄点；此后状态稳定不再有推送，黄点一直挂到用户
 * 点击标签页触发新的全量刷新为止。
 *
 * 修复：主进程给快照加单调 version（推送每次 +1，get-state 响应带当前值），
 * 渲染层丢弃 version 更小的快照。这里的假 titlebarAPI 手动控制 getState 的
 * resolve 时机与推送顺序，精确重放该竞态。
 */

interface TitlebarTestWindow {
  __getStateResolve: ((state: unknown) => void) | null;
  __workspacesListeners: Array<(state: unknown) => void>;
}

/** 假 titlebarAPI：getState 挂起等测试 resolve；推送回调收集起来供测试驱动 */
const FAKE_TITLEBAR_API = `
  (() => {
    const w = window;
    w.__getStateResolve = null;
    w.__workspacesListeners = [];
    const noop = () => undefined;
    w.titlebarAPI = {
      getState: () => new Promise((resolve) => { w.__getStateResolve = resolve; }),
      onWorkspacesChanged: (cb) => w.__workspacesListeners.push(cb),
      onWindowState: noop, onMenuState: noop, onModelChanged: noop,
      onModeState: noop, onWorkspaceActivity: noop,
      minimize: noop, toggleMaximize: noop, close: noop, toggleMode: noop,
      togglePin: noop, openMenu: noop, closeMenu: noop, activateWorkspace: noop,
      closeWorkspace: noop, showWorkspaceMenu: noop, reorderWorkspaces: noop,
    };
  })();
`;

/** 造一份 get-state / 推送通用的快照；availability 决定标签页挂红点还是黄点 */
function snapshot(availability: 'unavailable' | 'connecting', version?: number) {
  const workspaces = [
    { id: 'ws-remote', path: 'C:\\work\\remote-proj', name: 'remote-proj', remote: true, availability },
    { id: 'ws-local', path: 'C:\\work\\local-proj', name: 'local-proj', remote: false, availability: 'available' },
  ];
  const base = {
    workspaces,
    activeWorkspace: 'ws-local',
    activity: {},
    platform: 'win32',
    productName: 'Tuxedo Cat',
    maximized: false,
    sections: [],
    labels: undefined,
    mode: 'normal',
    pinned: false,
    canToggleMode: true,
    workspaceName: null,
  };
  return version === undefined ? base : { ...base, version };
}

test.describe('标题栏标签页快照时序（陈旧 get-state 回包不覆盖新推送）', () => {
  let close: (() => void) | null = null;

  test.afterEach(async () => {
    if (close) {
      await close();
      close = null;
    }
  });

  test('竞态重放：标红推送先到、陈旧 get-state 回包后到——红点不被覆盖回黄点', async ({ browser }) => {
    const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
    const opened = await openStaticPage(browser, `${repoRoot}/dist/titlebar`, FAKE_TITLEBAR_API);
    close = opened.close;
    const { page } = opened;

    // init 已跑起、getState 挂起（模拟主进程已处理 invoke 但回包未到达的窗口）
    await page.waitForFunction(() => (window as unknown as TitlebarTestWindow).__getStateResolve !== null);

    // 主进程标红并推送（version=2，新状态）
    await page.evaluate((state) => {
      const w = window as unknown as TitlebarTestWindow;
      for (const cb of w.__workspacesListeners) cb(state);
    }, snapshot('unavailable', 2));
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-dot')).toBeVisible();

    // 陈旧的 get-state 回包（version=1，仍是 connecting）后到
    await page.evaluate((state) => {
      const w = window as unknown as TitlebarTestWindow;
      w.__getStateResolve?.(state);
    }, snapshot('connecting', 1));

    // 修复后：陈旧回包被丢弃，红点保留；修复前：回包覆盖推送，红点变回黄点（回归）
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-dot')).toBeVisible();
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-loading')).toHaveCount(0);
  });

  test('正常顺序：get-state 回包先渲染，随后的推送正常更新', async ({ browser }) => {
    const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
    const opened = await openStaticPage(browser, `${repoRoot}/dist/titlebar`, FAKE_TITLEBAR_API);
    close = opened.close;
    const { page } = opened;

    await page.waitForFunction(() => (window as unknown as TitlebarTestWindow).__getStateResolve !== null);
    // 初始化快照（connecting，version=1）先渲染
    await page.evaluate((state) => {
      (window as unknown as TitlebarTestWindow).__getStateResolve?.(state);
    }, snapshot('connecting', 1));
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-loading')).toBeVisible();

    // 之后标红推送（version=2）到达并生效
    await page.evaluate((state) => {
      const w = window as unknown as TitlebarTestWindow;
      for (const cb of w.__workspacesListeners) cb(state);
    }, snapshot('unavailable', 2));
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-dot')).toBeVisible();
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-loading')).toHaveCount(0);
  });

  test('老版本主进程（快照无 version）行为不变：回包与推送都渲染', async ({ browser }) => {
    const repoRoot = process.cwd().replace(/[\\/]e2e$/, '');
    const opened = await openStaticPage(browser, `${repoRoot}/dist/titlebar`, FAKE_TITLEBAR_API);
    close = opened.close;
    const { page } = opened;

    await page.waitForFunction(() => (window as unknown as TitlebarTestWindow).__getStateResolve !== null);
    await page.evaluate((state) => {
      (window as unknown as TitlebarTestWindow).__getStateResolve?.(state);
    }, snapshot('connecting'));
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-loading')).toBeVisible();

    await page.evaluate((state) => {
      const w = window as unknown as TitlebarTestWindow;
      for (const cb of w.__workspacesListeners) cb(state);
    }, snapshot('unavailable'));
    await expect(page.locator('#workspaceTabs [role="tab"]').first().locator('.ws-tab-dot')).toBeVisible();
  });
});
