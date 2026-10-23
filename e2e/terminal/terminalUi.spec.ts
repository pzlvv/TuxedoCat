import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { openStaticPage } from '../helpers/webviewHarness';

/**
 * 远程终端页面（`electron/terminal/`，specs/022-remote-ssh-terminal）。
 *
 * 真实链路要连上 SSH 服务器（豁免口径登记在 docs/features/user-stories.md 的未覆盖段）；这里对齐
 * `e2e/remoteWorkspace/picker.spec.ts` 的手法：静态伺服构建产物 `dist/terminal/`，
 * 以假 `window.terminalAPI`（内存标签表 + 回显 shell）驱动真实页面，锁定 US-55 的
 * 页面层验收（US-54 只覆盖首标签自动建立的页面侧）：
 * - 首标签随窗口自动建立（AC-1 的页面侧）；「+」新建 / ✕ 关闭与切换（FR-003）；
 * - 键入路由到 input、输出回显进 xterm（FR-004 数据面）；
 * - 断开态覆盖层（原因 + 重连按钮）与重连动作（FR-007）；连接中的 logo 加载动画
 *   （红色警示只属于断开态）；
 * - 主题推送跟随（FR-009）；复制 / 粘贴快捷键（FR-005）；
 * - 标签切换快捷键推方向（`terminal:switch-tab`，US-55 验收 6 的页面侧；
 *   主进程 before-input-event 拦截属真实 SSH 链路，按未覆盖段豁免）。
 *
 * 渲染端是纯投影：测试侧经 `window.__terminalCtl` 以主进程的口吻推事件
 * （tabs / output / theme / switch-tab），断言经 `window.__terminalState` 读渲染端回传的动作。
 */

const REPO_ROOT = process.cwd().replace(/[\\/]e2e$/, '');

/** 假 API 注入：内存标签表 + 回显通道 + 测试控制钩子 */
const FAKE_API_INIT = `
(() => {
  const state = {
    nextId: 1,
    tabs: [],
    listeners: { tabs: [], output: [], theme: [], switch: [] },
    inputs: [],
    reconnects: [],
    newTabCalls: 0,
    closeWindowCalled: false,
    clipboard: 'pwd',
  };
  const emitTabs = () => state.listeners.tabs.forEach((fn) => fn(state.tabs.map((t) => ({ ...t }))));
  const emitOutput = (tabId, text) => {
    const bytes = new TextEncoder().encode(text);
    state.listeners.output.forEach((fn) => fn(tabId, bytes));
  };

  window.terminalAPI = {
    init: async () => ({ isDark: true, target: 'ssh://deploy@10.0.0.1', tabs: state.tabs.map((t) => ({ ...t })) }),
    newTab: async (size) => {
      state.newTabCalls += 1;
      state.lastNewTabSize = { ...size };
      const tab = { id: state.nextId++, label: 'bash ' + (state.nextId - 1), status: 'ready', failure: null };
      state.tabs.push(tab);
      emitTabs();
      emitOutput(tab.id, 'welcome-' + tab.id + '\\r\\n');
    },
    input: async (payload) => {
      state.inputs.push(payload);
      emitOutput(payload.tabId, payload.data);
    },
    resize: async () => {},
    closeTab: async (tabId) => {
      state.tabs = state.tabs.filter((t) => t.id !== tabId);
      emitTabs();
    },
    reconnect: async (payload) => {
      state.reconnects.push(payload);
      const tab = state.tabs.find((t) => t.id === payload.tabId);
      if (!tab) return;
      tab.status = 'connecting';
      emitTabs();
      setTimeout(() => { tab.status = 'ready'; tab.failure = null; emitTabs(); emitOutput(tab.id, 'reconnected\\r\\n'); }, 30);
    },
    closeWindow: () => { state.closeWindowCalled = true; },
    copyText: (text) => { state.clipboard = text; },
    pasteText: async () => state.clipboard,
    onTabs: (fn) => state.listeners.tabs.push(fn),
    onOutput: (fn) => state.listeners.output.push(fn),
    onTheme: (fn) => state.listeners.theme.push(fn),
    onSwitchTab: (fn) => state.listeners.switch.push(fn),
  };

  // 测试控制钩子：以主进程的口吻推下行事件
  window.__terminalCtl = {
    disconnect(tabId, reason) {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.status = 'disconnected';
      tab.failure = reason;
      emitTabs();
    },
    connect(tabId) {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.status = 'connecting';
      tab.failure = null;
      emitTabs();
    },
    emitOutput(tabId, text) {
      emitOutput(tabId, text);
    },
    emitTheme(isDark) {
      state.listeners.theme.forEach((fn) => fn(isDark));
    },
    emitSwitchTab(direction) {
      state.listeners.switch.forEach((fn) => fn(direction));
    },
  };
  window.__terminalState = state;
})();
`;

interface TerminalTestWindow {
  __terminalState: {
    inputs: { tabId: number; data: string }[];
    reconnects: { tabId: number; cols: number; rows: number }[];
    newTabCalls: number;
    closeWindowCalled: boolean;
    clipboard: string;
  };
  __terminalCtl: {
    disconnect(tabId: number, reason: string): void;
    connect(tabId: number): void;
    emitOutput(tabId: number, text: string): void;
    emitTheme(isDark: boolean): void;
    emitSwitchTab(direction: 'next' | 'prev'): void;
  };
}

let handle: { page: Page; close: () => Promise<void> };

test.beforeEach(async ({ browser }) => {
  handle = await openStaticPage(
    browser,
    path.join(REPO_ROOT, 'dist', 'terminal'),
    FAKE_API_INIT,
  );
  // 真实页面初始化后自动开首个标签（AC-1）；等它出现再跑用例
  await expect(handle.page.locator('.tab')).toHaveCount(1);
});

test.afterEach(async () => {
  await handle.close();
});

/** 页面内记录的假 API 状态 */
function state(page: Page) {
  return page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalState);
}

test('首标签随窗口自动建立：标签条一行、xterm 已渲染、无覆盖层', async () => {
  const { page } = handle;
  await expect(page.locator('.tab')).toHaveText(/bash 1/);
  // dead 类挂在 .tab 上（CSS 用 .tab.dead .dot 给状态点着色）
  await expect(page.locator('.tab')).not.toHaveClass(/dead/);
  await expect(page.locator('#pane-1 .xterm')).toBeVisible();
  await expect(page.locator('.overlay')).toHaveCount(0);
  // 回显 welcome 已进终端（输出字节流 → xterm）
  await expect.poll(() => page.locator('#pane-1 .xterm-rows').textContent()).toContain('welcome-1');
});

test('「+」新建标签、点击切换、✕ 关闭', async () => {
  const { page } = handle;
  await page.click('#newtab');
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab').nth(1)).toContainText('bash 2');
  // 新标签自动成为活动页
  await expect(page.locator('.tab').nth(1)).toHaveClass(/active/);

  // 点第一个标签切回
  await page.locator('.tab').nth(0).click();
  await expect(page.locator('.tab').nth(0)).toHaveClass(/active/);

  // 活动页的 ✕ 关闭自己（hover 后可见）
  const first = page.locator('.tab').nth(0);
  await first.hover();
  await first.locator('.x').click();
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.tab').nth(0)).toHaveClass(/active/);
});

test('关闭最后一个标签时向主进程请求关窗口（specs/022 FR-003）', async () => {
  const { page } = handle;
  const active = page.locator('.tab').nth(0);
  await active.hover();
  await active.locator('.x').click();
  await expect.poll(async () => (await state(page)).closeWindowCalled).toBe(true);
});

test('键入路由到 input、输出回显进 xterm', async () => {  const { page } = handle;
  await page.locator('#pane-1').click();
  await page.keyboard.type('ls -la');
  await expect.poll(async () => (await state(page)).inputs.map((i) => i.data).join('')).toContain('ls -la');
  await expect.poll(() => page.locator('#pane-1 .xterm-rows').textContent()).toContain('ls -la');
});

test('断开态：覆盖层带原因与重连按钮，重连以当下尺寸发起', async () => {
  const { page } = handle;
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.disconnect(1, 'read ETIMEDOUT'));

  const overlay = page.locator('#pane-1 .overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.title')).toHaveText('与 ssh://deploy@10.0.0.1 的连接已断开');
  await expect(overlay.locator('.reason')).toHaveText('read ETIMEDOUT');
  await expect(page.locator('.tab').first()).toHaveClass(/dead/);

  await overlay.locator('button').click();
  await expect.poll(async () => (await state(page)).reconnects).toHaveLength(1);
  const reconnect = (await state(page)).reconnects[0];
  expect(reconnect.tabId).toBe(1);
  expect(reconnect.cols).toBeGreaterThan(0);
  expect(reconnect.rows).toBeGreaterThan(0);
  // 重连回 ready：覆盖层收起，新 shell 的回显进终端
  await expect(page.locator('#pane-1 .overlay')).toHaveCount(0);
  await expect.poll(() => page.locator('#pane-1 .xterm-rows').textContent()).toContain('reconnected');
});

test('连接中：覆盖层是 logo 加载动画，红色警示不出现', async () => {
  const { page } = handle;
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.connect(1));

  const overlay = page.locator('#pane-1 .overlay');
  await expect(overlay).toHaveClass(/connecting/);
  // 连接中展示对话加载同款动画（波纹 + logo + 圆点），没有红色警示
  await expect(overlay.locator('.loading')).toBeVisible();
  await expect(overlay.locator('.loading-logo')).toBeVisible();
  await expect(overlay.locator('.warn')).toBeHidden();
  // connecting 态没有重连按钮
  await expect(overlay.locator('button')).toBeHidden();

  // 回到断开态：警示与重连按钮回归，动画收起
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.disconnect(1, 'read ETIMEDOUT'));
  await expect(overlay.locator('.warn')).toBeVisible();
  await expect(overlay.locator('.loading')).toBeHidden();
});

test('全屏程序的模式查询（DECRQM）后渲染仍存活（specs/defects/terminal-vim-freeze RT-1）', async () => {
  const { page } = handle;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // vim / htop 启动即发的模式请求（CSI ? 2026 $ p，同步输出查询）：
  // 压缩产物里 xterm 的 requestMode 被破坏时会当场抛 ReferenceError 并杀死渲染续写链
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitOutput(1, '\x1b[?2026$p'));
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitOutput(1, 'after-decrqm\r\n'));

  // 渲染链活着：查询之后的文本必须照常渲染
  await expect.poll(() => page.locator('#pane-1 .xterm-rows').textContent()).toContain('after-decrqm');
  // DECRQM 处理不允许抛任何页面错误
  expect(errors).toEqual([]);
});

test('主题推送跟随：body 深浅切换', async () => {
  const { page } = handle;
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitTheme(false));
  await expect(page.locator('body')).toHaveClass(/light/);
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitTheme(true));
  await expect(page.locator('body')).not.toHaveClass(/light/);
});

test('复制选区与粘贴快捷键', async () => {
  const { page } = handle;
  await page.locator('#pane-1').click();
  await page.keyboard.type('hello world');

  // 等回显渲染出来，用鼠标在第 0 行拖选一段 → Ctrl+Shift+C 复制。
  // 字符切片受字体度量影响，断言收在「复制到的是回显文本的一段非空子串」。
  await expect.poll(() => page.locator('#pane-1 .xterm-rows').textContent()).toContain('hello');
  const rows = page.locator('#pane-1 .xterm-rows');
  const box = await rows.boundingBox();
  if (!box) throw new Error('xterm rows not rendered');
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 8, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Control+Shift+c');
  await expect.poll(async () => (await state(page)).clipboard).not.toBe('');
  const copied = (await state(page)).clipboard;
  expect('welcome-1hello world'.includes(copied)).toBe(true);

  // Ctrl+Shift+V 把剪贴板内容原样送进 stdin
  await page.keyboard.press('Control+Shift+v');
  await expect.poll(async () => (await state(page)).inputs.map((i) => i.data).join('')).toContain(copied);
});

test('标签切换快捷键推方向：切相邻终端标签并环绕（US-55 验收 6 的页面侧）', async () => {
  // 主进程 before-input-event 拦截与真实组合键需要 SSH 环境（豁免口径登记在
  // docs/features/user-stories.md 未覆盖段）；这里以主进程的口吻推
  // `terminal:switch-tab`，锁定渲染端的相邻计算与环绕
  const { page } = handle;
  await page.click('#newtab');
  await expect(page.locator('.tab')).toHaveCount(2);
  // 新标签（bash 2）是活动页：下一标签环绕回首标签
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitSwitchTab('next'));
  await expect(page.locator('.tab').nth(0)).toHaveClass(/active/);
  // 首标签的上一标签环绕回末标签
  await page.evaluate(() => (window as unknown as TerminalTestWindow).__terminalCtl.emitSwitchTab('prev'));
  await expect(page.locator('.tab').nth(1)).toHaveClass(/active/);
});
