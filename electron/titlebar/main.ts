/**
 * 自绘标题栏（Electron 原生 UI，独立于 webview）
 *
 * 代替系统默认标题栏 + 菜单栏：
 *   - 最左侧：完整模式 ↔ 悬浮窗模式切换按钮（未打开工作区时禁用）
 *   - 品牌区（logo + 文案）：完整模式显示产品名，浮窗模式显示当前工作目录
 *   - 菜单按钮（File / View / Help），点击后由主进程在同窗口内展示自绘下拉菜单
 *   - 悬浮窗模式专属：总在最前（钉住）按钮
 *   - 右侧窗口控制按钮（最小化 / 最大化-还原 / 关闭），macOS 交给系统红绿灯
 *
 * 与主进程通过 preload 暴露的 titlebarAPI 通信：
 *   getState()          取平台 / 产品名 / 菜单分区 / 窗口状态 / 模式（初始化）
 *   minimize/close      窗口控制
 *   toggleMaximize()    最大化与还原切换
 *   openMenu/closeMenu  打开/关闭某个分区的下拉菜单
 *   toggleMode()        完整模式 ↔ 悬浮窗模式
 *   togglePin()         悬浮窗总在最前开关
 *   onWindowState()     订阅最大化状态变化（切换按钮图标）
 *   onMenuState()       订阅下拉菜单开关（按钮高亮）
 *   onModelChanged()    订阅菜单分区变化（最近工作区列表刷新）
 *   onModeState()       订阅窗口模式 / 置顶状态变化
 */

interface TitlebarSection {
  id: string;
  label: string;
}

type WindowMode = 'normal' | 'floating';

interface TitlebarModeState {
  mode: WindowMode;
  pinned: boolean;
  canToggleMode: boolean;
  /** 当前工作目录名（basename）：浮窗模式品牌位显示它（浮窗没有侧栏，这是唯一的上下文） */
  workspaceName: string | null;
}

/**
 * 按钮文案由主进程按当前 UI 语言下发（标题栏是独立页面，拿不到 core 的 i18n 上下文）。
 * 见 electron/main.ts 的 titlebar:get-state。
 */
interface TitlebarLabels {
  minimize: string;
  maximize: string;
  restore: string;
  close: string;
  alwaysOnTop: string;
  unpin: string;
  toggleToFloating: string;
  toggleToFull: string;
  modeDisabled: string;
  addWorkspace: string;
  closeWorkspace: string;
}

interface TitlebarState extends TitlebarModeState {
  platform: string;
  productName: string;
  maximized: boolean;
  sections: TitlebarSection[];
  labels: TitlebarLabels;
  workspaces?: TitlebarWorkspace[];
  activeWorkspace?: string | null;
}

interface TitlebarMenuAnchor {
  id: string;
  /** 菜单按钮左边缘（相对窗口内容区，标题栏视图位于 (0,0)，与视口坐标一致） */
  anchorX: number;
}

/** 工作目录标签页：path 为绝对路径，name 为主进程取好的目录名 */
interface TitlebarWorkspace {
  path: string;
  name: string;
}

/** 打开集合 + 活动项（标题栏标签页区渲染）；字段名与 get-state 一致（activeWorkspace） */
interface TitlebarWorkspacesState {
  workspaces: TitlebarWorkspace[];
  activeWorkspace: string | null;
}

interface TitlebarAPI {
  getState: () => Promise<TitlebarState>;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  openMenu: (anchor: TitlebarMenuAnchor) => void;
  closeMenu: () => void;
  toggleMode: () => void;
  togglePin: () => void;
  activateWorkspace: (path: string) => void;
  closeWorkspace: (path: string) => void;
  addWorkspace: () => void;
  /** 拖拽排序：提交完整的打开集合顺序（主进程按去重键校验） */
  reorderWorkspaces: (paths: string[]) => void;
  onWindowState: (callback: (state: { maximized: boolean }) => void) => void;
  onMenuState: (callback: (state: { openId: string | null }) => void) => void;
  onModelChanged: (callback: (state: { sections: TitlebarSection[] }) => void) => void;
  onModeState: (callback: (state: TitlebarModeState) => void) => void;
  onWorkspacesChanged: (callback: (state: TitlebarWorkspacesState) => void) => void;
}

declare global {
  interface Window {
    titlebarAPI?: TitlebarAPI;
  }
}

const api = window.titlebarAPI;

const titlebarEl = document.getElementById('titlebar')!;
const menubarEl = document.getElementById('menubar')!;
const tabsEl = document.getElementById('workspaceTabs')!;
const brandNameEl = document.getElementById('brandName')!;
const brandLogoEl = document.getElementById('brandLogo') as HTMLImageElement;
const btnMode = document.getElementById('btnMode') as HTMLButtonElement;
const btnPin = document.getElementById('btnPin') as HTMLButtonElement;
const btnMinimize = document.getElementById('btnMinimize') as HTMLButtonElement;
const btnMaximize = document.getElementById('btnMaximize') as HTMLButtonElement;
const btnClose = document.getElementById('btnClose') as HTMLButtonElement;

/** 当前打开的分区 id（由主进程回推，用于按钮高亮） */
let openMenuId: string | null = null;
/** 产品名：完整模式下品牌位显示它，浮窗模式改显示工作目录 */
let productName = '';
/** 是否 macOS（macOS 保留系统红绿灯与系统菜单栏，不渲染自绘菜单） */
let isMac = false;
/**
 * 按钮文案。先给英文默认值，getState 成功后替换为主进程按 UI 语言下发的版本 ——
 * getState 失败时按钮仍要有可读的 title / aria-label。
 */
let labels: TitlebarLabels = {
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
  alwaysOnTop: 'Always on top',
  unpin: 'Stop always on top',
  toggleToFloating: 'Switch to floating window',
  toggleToFull: 'Switch to full mode',
  modeDisabled: 'Open a workspace first to switch mode',
  addWorkspace: 'Add workspace folder',
  closeWorkspace: 'Close workspace folder',
};

/** 三点图标（单一顶层菜单入口） */
const ICON_MENU = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.6" cy="8" r="1.35" fill="currentColor" /><circle cx="8" cy="8" r="1.35" fill="currentColor" /><circle cx="12.4" cy="8" r="1.35" fill="currentColor" /></svg>`;
/** 标签页关闭图标 */
const ICON_TAB_CLOSE = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>`;
/** 添加工作目录图标 */
const ICON_TAB_ADD = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>`;

/** 渲染菜单栏按钮（分区变化时重建）。
 *  单一分区时渲染成图标按钮（顶层菜单收编为一个图标），多分区时保持文字按钮（macOS 不渲染）。 */
function renderMenubar(sections: TitlebarSection[]): void {
  menubarEl.textContent = '';
  if (isMac) return; // macOS 走系统菜单栏
  const single = sections.length === 1;
  for (const section of sections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = single ? 'menu-btn menu-btn-icon' : 'menu-btn';
    if (single) {
      btn.innerHTML = ICON_MENU;
      btn.title = section.label;
      btn.setAttribute('aria-label', section.label);
    } else {
      btn.textContent = section.label;
    }
    btn.dataset.menuId = section.id;
    btn.setAttribute('role', 'menuitem');
    if (section.id === openMenuId) btn.classList.add('open');
    // mousedown 只阻断冒泡：避免落到标题栏空白处的「点一下关菜单」处理上，
    // 同时保留浏览器默认的聚焦行为（否则焦点会留在已隐藏的菜单视图里）
    btn.addEventListener('mousedown', (event) => event.stopPropagation());
    // click（而非 mousedown）以便键盘 Enter/Space 也能打开菜单
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!api) return;
      // 点同一个按钮＝关闭；点另一个＝直接切到那个菜单
      if (openMenuId === section.id) {
        api.closeMenu();
        return;
      }
      const rect = btn.getBoundingClientRect();
      api.openMenu({
        id: section.id,
        anchorX: Math.round(rect.left),
      });
    });
    menubarEl.appendChild(btn);
  }
}

/** 当前渲染的打开集合（拖拽排序时据此计算新顺序） */
let renderedWorkspaces: TitlebarWorkspace[] = [];
/** 正在被拖拽的标签页路径（null = 没有拖拽） */
let draggingPath: string | null = null;
/** 拖拽刚结束的一小段时间内抑制 click，避免「拖完误触发切换标签页」 */
let suppressTabClickUntil = 0;

/** 清掉所有标签页的放置指示线 */
function clearDropIndicators(): void {
  tabsEl.querySelectorAll('.ws-tab').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

/**
 * 计算把 fromPath 移到 toPath 前 / 后的新顺序。
 * 返回 null 表示顺序未变化或参数非法（调用方据此不发提交）。
 */
function computeReorderedPaths(fromPath: string, toPath: string, after: boolean): string[] | null {
  const order = renderedWorkspaces.map((w) => w.path);
  const fromIdx = order.indexOf(fromPath);
  if (fromIdx < 0) return null;
  order.splice(fromIdx, 1);
  let toIdx = order.indexOf(toPath);
  if (toIdx < 0) return null;
  if (after) toIdx += 1;
  order.splice(toIdx, 0, fromPath);
  if (order.every((p, i) => p === renderedWorkspaces[i].path)) return null;
  return order;
}

/**
 * 渲染工作目录标签页（打开集合变化时重建）。
 * 标签页占用原菜单栏区域；活动项高亮；每张标签页带关闭按钮、可拖拽排序；末尾是「添加」按钮。
 */
function renderWorkspaces(workspaces: TitlebarWorkspace[], active: string | null): void {
  renderedWorkspaces = workspaces;
  draggingPath = null;
  tabsEl.textContent = '';
  // 打开集合为空时不渲染标签页区域（规格 §5）：添加目录入口在侧栏空态与菜单里
  if (workspaces.length === 0) return;

  for (const ws of workspaces) {
    const isActive = ws.path === active;
    // 键盘可达：tab 可聚焦，Enter / Space 切换；关闭按钮是真实 button，
    // 通过 :focus-within 在聚焦时显现（否则 visibility: hidden 不可聚焦）
    const tab = document.createElement('div');
    tab.className = 'ws-tab' + (isActive ? ' active' : '');
    tab.dataset.path = ws.path;
    tab.title = ws.path;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = 0;

    const label = document.createElement('span');
    label.className = 'ws-tab-label';
    label.textContent = ws.name || ws.path;
    tab.appendChild(label);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ws-tab-close';
    closeBtn.title = labels.closeWorkspace;
    closeBtn.setAttribute('aria-label', `${labels.closeWorkspace}: ${ws.name || ws.path}`);
    closeBtn.innerHTML = ICON_TAB_CLOSE;
    closeBtn.addEventListener('mousedown', (event) => event.stopPropagation());
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      api?.closeWorkspace(ws.path);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener('mousedown', (event) => event.stopPropagation());
    tab.addEventListener('click', (event) => {
      event.stopPropagation();
      // 刚拖拽排序完：抑制这次 click，避免顺带切换标签页
      if (Date.now() < suppressTabClickUntil) return;
      if (!isActive) api?.activateWorkspace(ws.path);
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!isActive) api?.activateWorkspace(ws.path);
    });

    // ── 拖拽排序 ──
    tab.draggable = true;
    tab.addEventListener('dragstart', (event) => {
      // 从关闭按钮起拖不触发排序（关闭按钮是 tab 的子元素，默认会带起 tab 的拖拽）
      if ((event.target as HTMLElement | null)?.closest('.ws-tab-close')) {
        event.preventDefault();
        return;
      }
      draggingPath = ws.path;
      tab.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', ws.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', () => {
      draggingPath = null;
      suppressTabClickUntil = Date.now() + 250;
      tab.classList.remove('dragging');
      clearDropIndicators();
    });
    tab.addEventListener('dragover', (event) => {
      if (!draggingPath || draggingPath === ws.path) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      // 越过中线即视为插到目标之后，否则插到之前
      const rect = tab.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      clearDropIndicators();
      tab.classList.add(after ? 'drop-after' : 'drop-before');
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drop-before', 'drop-after');
    });
    tab.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = draggingPath;
      clearDropIndicators();
      if (!from || from === ws.path) return;
      const rect = tab.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const next = computeReorderedPaths(from, ws.path, after);
      if (next) api?.reorderWorkspaces(next);
    });

    tabsEl.appendChild(tab);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ws-add';
  addBtn.title = labels.addWorkspace;
  addBtn.setAttribute('aria-label', labels.addWorkspace);
  addBtn.innerHTML = ICON_TAB_ADD;
  addBtn.addEventListener('mousedown', (event) => event.stopPropagation());
  addBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    api?.addWorkspace();
  });
  tabsEl.appendChild(addBtn);
}

/** 同步菜单按钮高亮状态 */
function syncMenuHighlight(): void {
  menubarEl.querySelectorAll<HTMLButtonElement>('.menu-btn').forEach((btn) => {
    btn.classList.toggle('open', btn.dataset.menuId === openMenuId);
  });
}

/** 应用窗口最大化状态（切换最大化/还原图标） */
function applyWindowState(maximized: boolean): void {
  document.body.classList.toggle('maximized', maximized);
  const label = maximized ? labels.restore : labels.maximize;
  btnMaximize.title = label;
  btnMaximize.setAttribute('aria-label', label);
}

/** 应用窗口模式与置顶状态 */
function applyModeState(state: TitlebarModeState): void {
  const floating = state.mode === 'floating';
  document.body.classList.toggle('mode-floating', floating);
  btnMode.disabled = !state.canToggleMode;
  btnMode.title = !state.canToggleMode
    ? labels.modeDisabled
    : floating
      ? labels.toggleToFull
      : labels.toggleToFloating;
  btnMode.setAttribute('aria-label', btnMode.title);
  btnPin.classList.toggle('active', state.pinned);
  btnPin.setAttribute('aria-pressed', String(state.pinned));
  btnPin.title = state.pinned ? labels.unpin : labels.alwaysOnTop;
  // 品牌位：完整模式只保留软件图标（不显示产品名），浮窗模式显示当前工作目录名
  // （浮窗没有侧栏，这是窗口里唯一的上下文）。目录名由主进程取 basename，
  // 超长时 CSS 省略号收住。
  const workspaceName = typeof state.workspaceName === 'string' ? state.workspaceName : '';
  const brandText = floating && workspaceName ? workspaceName : '';
  brandNameEl.textContent = brandText;
  // 完整模式品牌位没有文字：把产品名挂在 title 上，悬停软件图标仍能看到应用名
  brandNameEl.title = brandText || productName;
}

/** 按当前 labels 刷新窗口按钮的 title / aria-label（含 getState 失败时的英文默认值） */
function applyWindowControlLabels(): void {
  btnMinimize.title = labels.minimize;
  btnMinimize.setAttribute('aria-label', labels.minimize);
  btnClose.title = labels.close;
  btnClose.setAttribute('aria-label', labels.close);
  btnMaximize.title = labels.maximize;
  btnMaximize.setAttribute('aria-label', labels.maximize);
}

async function init(): Promise<void> {
  if (!api) {
    console.error('[titlebar] titlebarAPI 未注入');
    return;
  }

  // 先绑定窗口控制与模式按钮：标题栏是无边框窗口唯一的拖动/最小化/关闭入口，
  // 即使 getState 失败（主进程异常、通道未注册）也必须可用。
  applyWindowControlLabels();
  btnMode.addEventListener('click', () => api.toggleMode());
  btnPin.addEventListener('click', () => api.togglePin());
  btnMinimize.addEventListener('click', () => api.minimize());
  btnMaximize.addEventListener('click', () => api.toggleMaximize());
  btnClose.addEventListener('click', () => api.close());

  // 点在标题栏空白处：关掉已打开的下拉菜单（按钮自身已 stopPropagation）
  titlebarEl.addEventListener('mousedown', () => {
    if (openMenuId) api.closeMenu();
  });

  // Esc 关闭下拉菜单。菜单视图未获得焦点时按键会落到这里（标题栏持有焦点）
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openMenuId) {
      event.preventDefault();
      api.closeMenu();
    }
  });

  // 双击标题栏空白处最大化/还原（macOS 由系统行为处理）
  titlebarEl.addEventListener('dblclick', (event) => {
    if (isMac) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('.menubar, .workspace-tabs, .window-controls, .tb-btn')) return;
    api.toggleMaximize();
  });

  api.onWindowState((s) => applyWindowState(s?.maximized === true));
  api.onMenuState((s) => {
    openMenuId = s?.openId ?? null;
    syncMenuHighlight();
  });
  api.onModelChanged((s) => renderMenubar(s?.sections ?? []));
  api.onModeState((s) => { if (s) applyModeState(s); });
  api.onWorkspacesChanged((s) => renderWorkspaces(s?.workspaces ?? [], s?.activeWorkspace ?? null));

  let state: TitlebarState;
  try {
    state = await api.getState();
  } catch (err) {
    console.error('[titlebar] getState failed; window controls remain available:', err);
    return;
  }
  if (!state) {
    console.error('[titlebar] getState returned empty state');
    return;
  }

  if (state.labels) labels = state.labels;
  applyWindowControlLabels();
  isMac = state.platform === 'darwin';
  document.body.classList.add(`platform-${state.platform}`);
  productName = state.productName;
  // 品牌位文字由 applyModeState 按模式决定（完整模式为空，只显示软件图标）
  brandNameEl.title = productName;
  // 图标缺失时隐藏占位（避免破图）；已加载失败的情况 error 事件不会再触发，需按 naturalWidth 判断
  if (brandLogoEl.complete && brandLogoEl.naturalWidth === 0) {
    brandLogoEl.style.display = 'none';
  } else {
    brandLogoEl.addEventListener('error', () => { brandLogoEl.style.display = 'none'; });
  }
  renderMenubar(state.sections ?? []);
  renderWorkspaces(state.workspaces ?? [], state.activeWorkspace ?? null);
  applyWindowState(state.maximized);
  applyModeState(state);
}

void init();
