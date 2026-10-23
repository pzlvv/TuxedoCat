/**
 * 远程终端窗口的页面逻辑（docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * 渲染端是**纯投影**：标签表由主进程整表推送（`terminal:tabs`），本页面只渲染
 * 标签条 / xterm / 连接中与断开态覆盖层，回传的动作只有 new-tab / input / resize /
 * close-tab / reconnect / close-window（docs/hosts/electron-multi-workspace.md 第 14.8 节）。终端仿真用
 * @xterm/xterm：输出按字节流写入（UTF-8 由 xterm 增量解码），键入经 API 送通道
 * stdin（FR-004）。
 *
 * 主题由主进程推送（`terminal:theme`），字号在开窗时经 query 注入、运行期不热切
 * （FR-009）。剪贴板快捷键走主进程 clipboard 模块（FR-005）。
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  XTERM_THEMES,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  type TerminalTheme,
} from './xtermThemes.js';
import { getTerminalLabels, type TerminalLabels } from './labels.js';
import { selectAdjacentId, type TabSwitchDirection } from '../tabSwitching.js';
import type { TerminalAPI, TerminalTab } from './types.js';

declare global {
  interface Window {
    terminalAPI?: TerminalAPI;
  }
}

const injectedApi = window.terminalAPI;
if (!injectedApi) throw new Error('terminalAPI is not injected');
// 提升的函数声明不继承 narrowing：这里收敛成非可选绑定供全部函数使用
const api: TerminalAPI = injectedApi;

/** 关闭按钮图标：主窗口标题栏标签关闭的同款（electron/titlebar/main.ts 的 ICON_TAB_CLOSE） */
const TAB_CLOSE_ICON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>';

/** loadFile query：locale（文案语言）与 fontSize（终端字号 px，开窗时定值） */
const query = new URLSearchParams(window.location.search);
const labels: TerminalLabels = getTerminalLabels(query.get('locale') ?? 'zh');
const fontSize = Number(query.get('fontSize') ?? '14');

interface PaneView {
  id: number;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
}

const panes = new Map<number, PaneView>();
let tabs: TerminalTab[] = [];
let activeTabId: number | null = null;
let target = '';
/**
 * 「新建标签后切到新页」的意图标记：new-tab 的应答不带 id，渲染端在下一帧
 * 标签表里认出新增项并激活（首标签自动开同样按新页处理）。
 */
let activateNextNewTab = false;
/** 窗口是否出现过至少一个标签（「最后标签关闭 → 关窗口」的判定前提） */
let hadTabs = false;

const tabsEl = document.getElementById('tabs') as HTMLElement;
const panesEl = document.getElementById('panes') as HTMLElement;

// ---------- 主题 ----------

/** 当前主题的配色；建页时直接取它，避免新建标签先闪一帧深色 */
let currentTheme: TerminalTheme = XTERM_THEMES.dark;

function applyTheme(isDark: boolean): void {
  currentTheme = XTERM_THEMES[isDark ? 'dark' : 'light'];
  document.body.classList.toggle('light', !isDark);
  // 页边露出的底色与 xterm 底色同源（配色表是唯一来源），否则两种底色之间会有一道缝
  document.body.style.setProperty('--term-bg', currentTheme.background);
  for (const pane of panes.values()) {
    pane.term.options.theme = currentTheme;
  }
}

// ---------- xterm 页 ----------

function createPane(tab: TerminalTab): PaneView {
  const host = document.createElement('div');
  host.className = 'pane';
  host.id = `pane-${tab.id}`;
  panesEl.appendChild(host);
  const term = new Terminal({
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 14,
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    cursorBlink: true,
    // 回看缓冲下限（docs/hosts/electron-multi-workspace.md 第 14.4 节：不少于 1000 行）
    scrollback: 1000,
    // 彩色前后景组合（`ls` 的 777 目录是蓝字绿底）靠它兜底可读性
    minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
    theme: currentTheme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => {
    void api.input({ tabId: tab.id, data });
  });
  attachClipboardShortcuts(term, tab.id);
  const view: PaneView = { id: tab.id, term, fit, host };
  panes.set(tab.id, view);
  return view;
}

function disposePane(tabId: number): void {
  const pane = panes.get(tabId);
  if (!pane) return;
  pane.term.dispose();
  pane.host.remove();
  panes.delete(tabId);
}

function fitActivePane(): void {
  if (activeTabId === null) return;
  const pane = panes.get(activeTabId);
  if (!pane) return;
  // display:none 里 fit 出来的是 0：先让布局落定再量（激活 / 尺寸变化都走这里）
  requestAnimationFrame(() => {
    if (activeTabId !== pane.id) return;
    pane.fit.fit();
    void api.resize({ tabId: pane.id, cols: pane.term.cols, rows: pane.term.rows });
  });
}

/**
 * 剪贴板（docs/hosts/electron-multi-workspace.md 第 14.4 节）：Windows / Linux Ctrl+Shift+C / Ctrl+Shift+V，
 * macOS Cmd+C / Cmd+V（有选区才拦复制，未选中时交给 xterm 默认行为）。
 * 返回 false 表示事件已消费、不再进终端。
 */
function attachClipboardShortcuts(term: Terminal, tabId: number): void {
  const isMac = navigator.userAgent.includes('Mac');
  term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
    if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
    if (isMac ? !event.metaKey : !(event.ctrlKey && event.shiftKey)) return true;
    if (event.code === 'KeyC' && term.hasSelection()) {
      api.copyText(term.getSelection());
      return false;
    }
    if (event.code === 'KeyV') {
      void api.pasteText().then((text) => {
        if (text.length > 0) void api.input({ tabId, data: text });
      });
      return false;
    }
    return true;
  });
}

// ---------- 标签条渲染 ----------

function renderTabs(next: readonly TerminalTab[]): void {
  tabs = [...next];

  // 「+」/ 首开的新页要在建面板前认出来：先记旧集合再对齐
  const previousIds = new Set(panes.keys());
  // 面板与标签表对齐：新增建、消失卸
  for (const tab of tabs) {
    if (!panes.has(tab.id)) createPane(tab);
  }
  for (const id of [...panes.keys()]) {
    if (!tabs.some((tab) => tab.id === id)) disposePane(id);
  }

  // 活动标签被关掉时落到最后一个标签；新页自动成为活动页
  if (activateNextNewTab) {
    const created = tabs.find((tab) => !previousIds.has(tab.id));
    if (created) {
      activeTabId = created.id;
      activateNextNewTab = false;
    }
  }
  if (activeTabId === null || !tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
  }

  tabsEl.textContent = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab'
      + (tab.id === activeTabId ? ' active' : '')
      + (tab.status === 'disconnected' ? ' dead' : '');
    el.title = tab.status === 'disconnected' ? labels.statusDisconnected : labels.statusRunning;

    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.label;
    const close = document.createElement('span');
    close.className = 'x';
    close.innerHTML = TAB_CLOSE_ICON;
    close.title = labels.closeTab;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.closeTab(tab.id);
    });

    el.append(dot, label, close);
    el.addEventListener('click', () => activateTab(tab.id));
    tabsEl.appendChild(el);
  }

  // 面板可见性与覆盖层
  for (const tab of tabs) {
    const pane = panes.get(tab.id);
    if (!pane) continue;
    const visible = tab.id === activeTabId;
    pane.host.classList.toggle('visible', visible);
    if (visible) fitActivePane();
    renderOverlay(tab, pane);
  }

  // 最后一个标签关闭 → 关窗口（specs/022 FR-003）：曾经出现过标签才算——
  // 开窗瞬间首标签还没建好的空表不是「用户关完了」
  if (hadTabs && tabs.length === 0) {
    api.closeWindow();
  }
  hadTabs = hadTabs || tabs.length > 0;
}

function activateTab(tabId: number): void {
  if (activeTabId === tabId) return;
  activeTabId = tabId;
  renderTabs(tabs);
  panes.get(tabId)?.term.focus();
}

/**
 * 快捷键切相邻终端标签（docs/hosts/electron-multi-workspace.md 第 14.4 节）：与工作区
 * 标签页同一组合、同一环绕语义（`selectAdjacentId` 单一实现）；不足 2 个标签 / 活动
 * 标签不在表里时无相邻项可去，静默不动。方向由主进程 before-input-event 拦截转发，
 * 页面只算目标并复用点击激活的同一管线（焦点随激活交给该页 xterm）。
 */
function switchTabByShortcut(direction: TabSwitchDirection): void {
  const target = selectAdjacentId(
    tabs.map((tab) => tab.id),
    activeTabId,
    direction,
  );
  if (target !== null) activateTab(target);
}

// ---------- 覆盖层（连接中 / 断开态，docs/hosts/electron-multi-workspace.md 第 14.6 节） ----------

function renderOverlay(tab: TerminalTab, pane: PaneView): void {
  const host = pane.host;
  let overlay = host.querySelector<HTMLElement>('.overlay');
  if (tab.status === 'ready') {
    overlay?.remove();
    return;
  }
  if (!overlay) {
    overlay = buildOverlay(pane);
    host.appendChild(overlay);
  }
  // 连接中不是错误：红色警示只给断开态，连接中换成对话加载同款的 logo 动画
  overlay.classList.toggle('connecting', tab.status === 'connecting');
  const title = overlay.querySelector<HTMLElement>('.title');
  const reason = overlay.querySelector<HTMLElement>('.reason');
  const button = overlay.querySelector<HTMLButtonElement>('button');
  if (title) title.textContent = tab.status === 'connecting'
    ? labels.connectingHint(target)
    : labels.disconnectedTitle(target);
  if (reason) reason.textContent = tab.failure ?? '';
  if (button) {
    // connecting 态没有可点的动作：按钮整个收起
    button.style.display = tab.status === 'connecting' ? 'none' : '';
    button.textContent = labels.reconnect;
  }
}

function buildOverlay(pane: PaneView): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const warn = document.createElement('div');
  warn.className = 'warn';
  warn.textContent = '⚠';
  // 连接中的加载动画：对话加载同款（logo + 扩散波纹 + 弹跳圆点，形态对齐
  // src/webview 的 ConversationLoading；logo 走 publicDir 拷进产物根目录）
  const loading = document.createElement('div');
  loading.className = 'loading';
  const ripple = document.createElement('div');
  ripple.className = 'loading-ripple';
  const ring1 = document.createElement('span');
  ring1.className = 'loading-ring';
  const ring2 = document.createElement('span');
  ring2.className = 'loading-ring';
  const logo = document.createElement('img');
  logo.className = 'loading-logo';
  logo.src = './logo.png';
  logo.alt = '';
  logo.draggable = false;
  ripple.append(ring1, ring2, logo);
  const dots = document.createElement('div');
  dots.className = 'loading-dots';
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dots.appendChild(dot);
  }
  loading.append(ripple, dots);
  const title = document.createElement('div');
  title.className = 'title';
  const reason = document.createElement('div');
  reason.className = 'reason';
  const button = document.createElement('button');
  button.type = 'button';
  button.addEventListener('click', () => {
    // 以当下窗口尺寸重建 shell（docs/hosts/electron-multi-workspace.md 第 14.6 节）
    void api.reconnect({ tabId: pane.id, cols: pane.term.cols, rows: pane.term.rows });
  });
  overlay.append(warn, loading, title, reason, button);
  return overlay;
}

// ---------- 启动 ----------

void api.init().then((info) => {
  target = info.target;
  document.title = target;
  applyTheme(info.isDark);
  api.onTheme(applyTheme);
  api.onTabs(renderTabs);
  api.onOutput((tabId, data) => {
    panes.get(tabId)?.term.write(data);
  });
  api.onSwitchTab(switchTabByShortcut);
  renderTabs(info.tabs);

  // 首个标签随窗口自动开（docs/hosts/electron-multi-workspace.md 第 14.2 节）：PTY 初值先给缺省，页面装好后
  // fitActivePane 会按实际窗口尺寸发 resize（状态机在就绪前记账、就绪后补齐）
  if (tabs.length === 0) {
    activateNextNewTab = true;
    void api.newTab({ cols: 80, rows: 24 });
  }

  const newTabBtn = document.getElementById('newtab');
  if (newTabBtn) {
    // 加号的悬浮提示 / 无障碍名与主窗口加号同一套（labels.newTab）
    newTabBtn.title = labels.newTab;
    newTabBtn.setAttribute('aria-label', labels.newTab);
    newTabBtn.addEventListener('click', () => {
      const pane = activeTabId !== null ? panes.get(activeTabId) : undefined;
      // 新标签以当前活动页的窗口尺寸发起（PTY 初值，docs/hosts/electron-multi-workspace.md 第 14.4 节），并切到新页
      activateNextNewTab = true;
      void api.newTab({ cols: pane?.term.cols ?? 80, rows: pane?.term.rows ?? 24 });
    });
  }

  // 窗口尺寸变化 → fit → 同步远端 PTY（docs/hosts/electron-multi-workspace.md 第 14.4 节）
  new ResizeObserver(() => fitActivePane()).observe(panesEl);
});
