/**
 * PRODUCT_NAME - Electron 主进程入口
 *
 * 职责：
 * 1. 创建主窗口：左侧原生侧栏（对话列表）+ 右侧聊天 WebContentsView（每对话一个标签）
 * 2. 注册 IPC（webview-message）并委托给 ElectronUI（复用同一份 WebviewMessageHandler）
 * 3. 侧栏 IPC：对话列表读写、打开/新建对话、列表变化推送
 * 4. 初始化 core（setGlobalUI / initializeHistory / setExtensionPathProvider / 日志）
 * 5. 提供菜单：打开工作区、最近打开的工作目录、深色模式同步
 *
 * 与 VS Code 扩展的差异点（extension.ts）：
 * - workspace 路径由用户通过菜单选择（VS Code 从 workspaceFolders 获取）
 * - 对话列表由原生侧栏展示（VS Code 在 webview 内展示）
 * - 文件打开/虚拟文档/Mermaid/Spin 由 UIHost 提供 Electron 实现
 */

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, dialog, WebContentsView, shell, webContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ChatViewManager, SIDEBAR_WIDTH } from './ChatViewManager.js';
import { CONFIG_DIR_NAME, PRODUCT_NAME } from '../src/config/project.js';

/**
 * 判断 URL 是否为需要在系统浏览器打开的外部链接。
 * 内部链接（应用自身 file:// 页面、相对路径）不算外部链接。
 */
function isExternalUrl(targetUrl: string): boolean {
  return /^(https?|mailto|tel):/i.test(targetUrl);
}

let mainWindow: BrowserWindow | undefined;
let sidebarView: WebContentsView | undefined;
let chatViews: ChatViewManager | undefined;
let workspacePath: string | undefined;
// 已加载（打开过）的会话由 ChatViewManager 的视图列表派生，
// 侧栏列表（仅已发送消息的对话 + loaded 标记）通过 chatViews.getSidebarConversations() 获取

/**
 * 项目根目录（dist-electron 的上一级）
 * 注意：以 `electron.exe dist-electron/main.cjs` 方式启动时，
 * app.getAppPath() 返回 dist-electron，因此不能依赖它定位项目资源。
 */
const APP_ROOT = path.resolve(__dirname, '..');

// 单实例锁：避免多开导致会话文件冲突
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  // ── 强制 dark 配色 ──
  nativeTheme.themeSource = 'dark';

  // ── 工作区路径 ──
  // 不默认使用当前工作目录：优先命令行 --workspace=；未传入/无效时默认打开最近一次的工作目录
  // （最近工作区路径保存在 Windows app data 目录，即 Electron userData）
  workspacePath = undefined;
  const cliWorkspace = process.argv.find((a) => a.startsWith('--workspace='));
  if (cliWorkspace) {
    const cliPath = cliWorkspace.slice('--workspace='.length);
    if (cliPath && fs.existsSync(cliPath) && fs.statSync(cliPath).isDirectory()) {
      workspacePath = cliPath;
      saveLastWorkspace(workspacePath);
    }
  }
  if (!workspacePath) {
    workspacePath = readLastWorkspace();
  }

  createMainWindow();
  setupMenu();
  // 系统主题变化时同步聊天视图（只注册一次，避免菜单重建时重复注册）
  nativeTheme.on('updated', () => {
    sendTheme();
  });
  setupIpc();
  initCore();

  // GPU 进程异常（合成表面丢失 → 整个页面空白）时强制重绘所有视图
  app.on('child-process-gone', (_event, details) => {
    if (details.type === 'GPU') {
      console.error(`[main] GPU process gone: reason=${details.reason}`);
      setTimeout(repaintAllViews, 150); // 等待 GPU 进程重启完成后再重绘
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: PRODUCT_NAME,
    icon: path.join(APP_ROOT, 'assets', 'logo.png'),
    backgroundColor: '#16161b',
    show: false,
  });
  // WebContentsView 场景下 ready-to-show 不触发（Electron 已知行为，见 issue #42325），
  // 改用侧栏加载完成显示 + 超时兜底，确保窗口一定显示
  let windowShown = false;
  const showMainWindow = (): void => {
    if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
    windowShown = true;
    console.log('[main] showing window');
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', showMainWindow); // 无子视图场景仍可用
  setTimeout(showMainWindow, 3000); // 兜底：3 秒后强制显示

  // ── 左侧原生侧栏 ──
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'sidebarPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 防止窗口失焦/被遮挡时暂停渲染导致"整个页面空白，调整窗口大小后才恢复"
      backgroundThrottling: false,
    },
  });
  mainWindow.contentView.addChildView(sidebarView);
  void sidebarView.webContents.loadFile(path.join(APP_ROOT, 'dist', 'sidebar', 'index.html'));
  // 侧栏（本地文件）加载完成即显示窗口（兜底路径之一）
  sidebarView.webContents.on('did-finish-load', () => showMainWindow());

  // 渲染进程崩溃/GPU 异常时恢复侧栏显示
  sidebarView.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[sidebar] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
      setTimeout(() => {
        if (sidebarView?.webContents.isDestroyed()) return;
        if (sidebarView?.webContents.isCrashed()) sidebarView.webContents.reload();
      }, 500);
    }
  });

  // 外部链接防御（与聊天视图一致）：侧栏内点击链接不在 Electron 中打开，交给系统浏览器
  sidebarView.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl).catch((err) => {
        console.error(`[sidebar] Failed to open external URL (window.open): ${err}`);
      });
    }
    return { action: 'deny' };
  });
  sidebarView.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('file://')) return; // 应用内导航放行
    event.preventDefault();
    if (isExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl).catch((err) => {
        console.error(`[sidebar] Failed to open external URL (navigate): ${err}`);
      });
    }
  });

  // ── 右侧聊天视图管理器 ──
  let uiLanguage: 'auto' | 'zh' | 'en' = 'auto';
  try {
    const { readUiLanguageSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    uiLanguage = readUiLanguageSync();
  } catch { /* 读取失败时使用 auto（跟随系统语言） */ }
  chatViews = new ChatViewManager({
    win: mainWindow,
    appRoot: APP_ROOT,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    workspacePath: workspacePath || '',
    locale: app.getLocale(),
    systemLocale: getSystemLocaleForStartup(),
    uiLanguage,
    onActiveSessionChanged: (sessionId) => {
      sidebarView?.webContents.send('sidebar:active-session-changed', sessionId);
    },
    onViewCreated: (view) => {
      view.webContents.on('did-finish-load', () => {
        showMainWindow(); // 聊天视图加载完成再显示窗口，避免空白闪烁
        layout(); // 页面加载完成后按当前实际尺寸重排，避免初始视口偏差导致输入框被遮挡
        sendTheme();
        sendContextLimit();
        setTimeout(() => checkAndSendLLMConfig(), 1000);
      });
    },
  });

  // 初始打开一个新对话
  chatViews.openNewConversation();

  // 开发调试：--auto-open=<sessionId> 自动打开指定会话（与侧栏点击同路径）
  const autoOpen = process.argv.find((a) => a.startsWith('--auto-open='));
  if (autoOpen) {
    const sid = autoOpen.slice('--auto-open='.length);
    setTimeout(() => {
      chatViews?.openConversation(sid);
      refreshSidebar();
    }, 2000);
  }

  // ── 布局 ──
  mainWindow.on('resize', layout);
  layout();

  // 窗口首次显示后重新布局：Windows 上隐藏窗口的 getContentSize() 尚未扣除窗口框架，
  // 据此设置的视图初始高度会偏高，导致底部输入框被遮挡（调整窗口大小后才恢复）。
  // 显示后按实际内容尺寸重排，立即修正初始布局。
  mainWindow.once('show', () => {
    layout();
    setTimeout(layout, 100); // 等待窗口框架完全生效后再重算一次，双保险
  });

  // ── 白屏恢复：WebContentsView 偶发"整个页面空白，调整窗口大小后才恢复" ──
  // 根因是 GPU 合成表面丢失，resize 触发整帧重绘才恢复。这里在窗口状态变化
  // （显示/还原/最大化）及重新聚焦时强制重绘，等价于 resize 但不动窗口尺寸。
  mainWindow.on('show', scheduleRepaintOnVisible);
  mainWindow.on('restore', scheduleRepaintOnVisible);
  mainWindow.on('maximize', scheduleRepaintOnVisible);
  mainWindow.on('unmaximize', scheduleRepaintOnVisible);
  let focusRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  mainWindow.on('focus', () => {
    // 从被遮挡状态恢复聚焦时也可能丢合成表面，防抖后重绘一次
    if (focusRepaintTimer) clearTimeout(focusRepaintTimer);
    focusRepaintTimer = setTimeout(repaintAllViews, 120);
  });

  // 兜底：窗口可见期间周期性强制重绘，及时修复未触发上述事件的偶发白屏
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      repaintAllViews();
    }
  }, 30_000);

  mainWindow.on('closed', () => {
    mainWindow = undefined;
    sidebarView = undefined;
    chatViews = undefined;
  });
}

/** 获取系统 locale（复用 core 的实现） */
function getSystemLocaleForStartup(): string {
  try {
    const { getSystemLocale } = require('../src/core/i18n.js');
    return getSystemLocale();
  } catch {
    return app.getLocale();
  }
}

/**
 * 整体布局：侧栏固定左侧，聊天视图占右侧剩余空间。
 * 依赖均为模块级变量，因此可提升为模块级函数供 repaintAllViews 复用。
 */
function layout(): void {
  if (!mainWindow) return;
  const [, h] = mainWindow.getContentSize();
  sidebarView?.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height: h });
  chatViews?.layout();
}

/**
 * 从字符串末尾反向查找最后一个完整 JSON 对象（用于智能命名解析 LLM 输出），
 * 与 VSCodeUI/webviewMessageHandler.ts 中的实现保持一致。
 */
function extractLastJsonObject(text: string): string | null {
  let lastBrace = -1;
  let inString = false;
  let escape = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) {
      if (i > 0 && text[i - 1] === '\\') { i--; continue; }
      continue;
    }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString && ch === '{') { lastBrace = i; break; }
  }
  if (lastBrace < 0) return null;
  let depth = 0;
  inString = false;
  escape = false;
  for (let i = lastBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = text.substring(lastBrace, i + 1);
          try { const parsed = JSON.parse(jsonStr); if (parsed && typeof parsed.title === 'string') return jsonStr; } catch { }
          break;
        }
      }
    }
  }
  const remainingText = text.substring(0, lastBrace);
  if (remainingText.length > 0) return extractLastJsonObject(remainingText);
  return null;
}

/**
 * 打开/切换开发者工具（Ctrl+Shift+I）：
 * 优先调试当前聚焦的 webContents（聊天视图/侧栏），
 * 聚焦不可用时回退到活动聊天视图，最后回退到主窗口。
 */
function toggleDevTools(): void {
  const focused = webContents.getFocusedWebContents();
  if (focused && !focused.isDestroyed()) {
    focused.toggleDevTools();
    return;
  }
  const active = chatViews?.getActiveWebContents();
  if (active && !active.isDestroyed()) {
    active.toggleDevTools();
    return;
  }
  mainWindow?.webContents.toggleDevTools();
}

/**
 * 强制所有可见视图重绘：修复 WebContentsView 偶发"整个页面空白，
 * 调整窗口大小后才恢复"的 GPU 合成表面丢失问题。
 * invalidate() 等价于手动 resize 触发的整帧重绘，但不会改变窗口尺寸。
 */
function repaintAllViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  layout();
  for (const view of chatViews?.getAllViews() ?? []) {
    try { view.webContents.invalidate(); } catch { /* ignore */ }
  }
  try { sidebarView?.webContents.invalidate(); } catch { /* ignore */ }
}

/** 窗口从不可见/遮挡状态恢复可见时，延迟强制重绘一次 */
function scheduleRepaintOnVisible(): void {
  repaintAllViews();
  setTimeout(repaintAllViews, 100); // 等待窗口框架生效后再补一次，双保险
}

function setupMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void openWorkspaceDialog(); },
        },
        { type: 'separator' },
        {
          label: 'Recent Workspaces',
          submenu: buildRecentWorkspacesMenu(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => toggleDevTools(),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${PRODUCT_NAME}`,
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            void dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: `About ${PRODUCT_NAME}`,
              message: PRODUCT_NAME,
              detail: `Version ${app.getVersion()}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 构建“最近打开的工作目录”子菜单项（目录已不存在时自动过滤） */
function buildRecentWorkspacesMenu(): Electron.MenuItemConstructorOptions[] {
  const recents = readRecentWorkspaces();
  if (recents.length === 0) {
    return [{ label: 'No Recent Workspaces', enabled: false }];
  }
  return recents.map((p) => ({
    label: p,
    click: () => applyWorkspace(p),
  }));
}

/** 弹出系统目录选择框并应用所选工作区（未传 --workspace= 时的引导入口） */
async function openWorkspaceDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区文件夹',
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    applyWorkspace(result.filePaths[0]);
  }
}

/** 应用工作区：记录最近工作区、通知 UI、重建聊天视图并刷新侧栏 */
function applyWorkspace(p: string): void {
  workspacePath = p;
  saveLastWorkspace(p);
  // 工作区变化后重建菜单，使“最近打开的工作目录”列表保持最新
  setupMenu();
  const ui = require('./ElectronUI.js').ElectronUI.getInstance();
  ui.setWorkspacePath(workspacePath);
  // 后续新建的聊天视图携带新 --workspace= 参数
  chatViews?.setWorkspacePath(workspacePath);
  // 工作区变化：清空旧聊天视图并新建
  chatViews?.disposeAll();
  chatViews?.openNewConversation();
  // 清除对话列表缓存：切换工作目录后项目对话目录改变，
  // 必须重新从磁盘加载新项目的对话列表，否则侧栏仍显示旧项目的对话
  try {
    const { resetConversationListCache } = require('../src/core/history/index.js');
    resetConversationListCache();
  } catch (err) {
    console.error('[main] resetConversationListCache error:', err);
  }
  refreshSidebar();
  broadcastWorkspace();
}

/** 推送工作区路径到侧栏 */
function broadcastWorkspace(): void {
  sidebarView?.webContents.send('sidebar:workspace-changed', workspacePath ?? null);
}

/**
 * 工作区状态文件。
 * 位于 Electron userData 目录（Windows 下即 %APPDATA%\<PRODUCT_NAME>\），
 * 用于记录最近一次打开的工作目录与最近打开的工作目录列表（最多 10 个），
 * 其中 lastWorkspace 供下次启动默认打开，recentWorkspaces 供菜单展示。
 * 文件格式：
 * {
 *   "lastWorkspace": "C:\\path\\to\\ws",
 *   "recentWorkspaces": ["C:\\path\\to\\ws2", "C:\\path\\to\\ws", ...]
 * }
 */
const MAX_RECENT_WORKSPACES = 10;

function getWorkspaceStateFile(): string {
  return path.join(app.getPath('userData'), 'workspace-state.json');
}

/** 读取工作区状态文件（损坏/不存在时返回空对象） */
function readWorkspaceState(): { lastWorkspace?: string; recentWorkspaces?: string[] } {
  try {
    const file = getWorkspaceStateFile();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || typeof data !== 'object') return {};
    return data as { lastWorkspace?: string; recentWorkspaces?: string[] };
  } catch {
    // 读取失败时忽略，回到未选择工作区状态
    return {};
  }
}

/** 判断路径是否仍为存在的目录 */
function isValidWorkspaceDir(p: unknown): p is string {
  return typeof p === 'string' && p.trim().length > 0 && fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/** 读取最近一次使用的工作区路径（目录仍存在时返回） */
function readLastWorkspace(): string | undefined {
  const { lastWorkspace } = readWorkspaceState();
  if (isValidWorkspaceDir(lastWorkspace)) {
    return lastWorkspace;
  }
  return undefined;
}

/** 读取最近打开的工作目录列表（仅保留仍存在的目录，最多 10 个，最近的在最前） */
function readRecentWorkspaces(): string[] {
  const { recentWorkspaces } = readWorkspaceState();
  if (!Array.isArray(recentWorkspaces)) return [];
  const recents: string[] = [];
  for (const ws of recentWorkspaces) {
    if (recents.length >= MAX_RECENT_WORKSPACES) break;
    if (isValidWorkspaceDir(ws) && !recents.includes(ws)) {
      recents.push(ws);
    }
  }
  return recents;
}

/** 保存最近使用的工作区：更新 lastWorkspace，并把该目录置顶写入最近列表（去重、最多 10 个） */
function saveLastWorkspace(p: string): void {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const prev = readWorkspaceState();
    const prevRecents = Array.isArray(prev.recentWorkspaces) ? prev.recentWorkspaces : [];
    const recentWorkspaces = [p, ...prevRecents.filter((ws) => ws !== p)]
      .filter((ws): ws is string => typeof ws === 'string' && ws.trim().length > 0)
      .slice(0, MAX_RECENT_WORKSPACES);
    fs.writeFileSync(getWorkspaceStateFile(), JSON.stringify({ lastWorkspace: p, recentWorkspaces }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[main] Failed to save last workspace:', err);
  }
}

function setupIpc(): void {
  ipcMain.on('webview-message', (event, message: any) => {
    if (!message || typeof message.type !== 'string') return;

    const ui = require('./ElectronUI.js').ElectronUI.getInstance();

    // 新建对话/会话切换时，将来源 webContents 关联到 sessionId
    if (message.type === 'setActiveSessionId' || message.type === 'startNewConversation') {
      if (message.sessionId && typeof message.sessionId === 'string') {
        chatViews?.registerSession(event.sender, message.sessionId);
        refreshSidebar();
      }
    }

    // webview 内点击子代理/回复/From 链接等跳转到指定会话：
    // App 与 VS Code 不同，新起一个 webview 加载该对话（chatViews.openConversation 创建/切换视图）
    if (message.type === 'openConversation') {
      if (message.sessionId && typeof message.sessionId === 'string') {
        chatViews?.openConversation(message.sessionId);
        refreshSidebar();
      }
      return;
    }

    // 关闭按钮：销毁来源 webview（释放渲染进程资源），并刷新侧栏（已加载状态/空对话）
    if (message.type === 'closeWebview') {
      chatViews?.closeViewByWebContents(event.sender);
      refreshSidebar();
      return;
    }

    // webview 内“打开工作目录”按钮（未设置工作区时的引导）
    if (message.type === 'openWorkspace') {
      void openWorkspaceDialog();
      return;
    }

    // 与 extension.ts AssistantViewProvider 一致的专用消息处理
    if (message.type === 'requestTheme') {
      sendTheme();
      return;
    }
    if (message.type === 'requestContextLimit') {
      sendContextLimit(message.model);
      return;
    }
    if (message.type === 'requestSkills') {
      ui.handleWebviewMessage(message).catch((err: any) => console.error(err));
      return;
    }

    ui.handleWebviewMessage(message).catch((err: any) => {
      console.error(`[main] handleWebviewMessage error (${message.type}):`, err);
    });
  });

  // ── 侧栏 IPC ──
  ipcMain.handle('sidebar:get-conversations', async () => {
    try {
      return (await chatViews?.getSidebarConversations()) ?? [];
    } catch (err) {
      console.error('[main] sidebar:get-conversations error:', err);
      return [];
    }
  });

  ipcMain.handle('sidebar:get-active-session', () => {
    return chatViews?.getActiveSessionId() ?? null;
  });

  ipcMain.handle('sidebar:get-workspace', () => workspacePath ?? null);

  ipcMain.on('sidebar:open-workspace', () => {
    void openWorkspaceDialog();
  });

  ipcMain.on('sidebar:open-conversation', (_event, sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId) {
      chatViews?.openConversation(sessionId);
      refreshSidebar();
    }
  });

  ipcMain.on('sidebar:new-conversation', () => {
    chatViews?.openNewConversation();
  });

  // 关闭指定会话的聊天视图（释放渲染进程资源），并刷新侧栏（已加载状态）
  ipcMain.on('sidebar:close-conversation', (_event, sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId) {
      chatViews?.closeView(sessionId);
      refreshSidebar();
    }
  });

  // ── 侧栏对话操作：删除 / 重命名 / 智能命名 ──
  ipcMain.handle('sidebar:delete-conversation', async (_event, sessionId: string) => {
    try {
      // 受影响会话 = 根 + 所有直接/间接子会话（删除根时子会话一并删除）
      const list = (await chatViews?.getSidebarConversations()) ?? [];
      const affected = new Set<string>([sessionId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of list) {
          const pid = c.parentSessionId as string | undefined;
          if (pid && affected.has(pid) && !affected.has(c.sessionId as string)) {
            affected.add(c.sessionId as string);
            grew = true;
          }
        }
      }
      // 先关闭对应聊天视图（若删除的是当前活动会话，closeView 会自动切换到其他会话或新建）
      for (const sid of affected) {
        chatViews?.closeView(sid);
      }
      const { deleteConversation } = await import('../src/core/history/index.js');
      await deleteConversation(sessionId);
      refreshSidebar();
      return { ok: true };
    } catch (err) {
      console.error('[main] sidebar:delete-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('sidebar:rename-conversation', async (_event, sessionId: string, title: string) => {
    try {
      const { updateConversationMetadataTitle } = await import('../src/core/history/Conversation.js');
      await updateConversationMetadataTitle(sessionId, title);
      // 若该会话有打开的聊天视图，同步更新 webview 头部标题
      chatViews?.sendTo(sessionId, { type: 'setTitle', title });
      refreshSidebar();
      return { ok: true };
    } catch (err) {
      console.error('[main] sidebar:rename-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('sidebar:smart-name-conversation', async (_event, sessionId: string) => {
    try {
      // 与 webview 版本 handleRequestSmartNaming 一致的智能命名逻辑：
      // 取最近 5 条用户/助手文本 → LLM 生成标题 → 写回 meta.json → 刷新侧栏
      const { loadConversation } = await import('../src/core/history/index.js');
      const conversation = await loadConversation(sessionId);
      const msgs = (conversation.messages || []) as any[];
      const contentMessages: string[] = [];
      for (const m of msgs) {
        if (m.type === 'user' && typeof m.message?.content === 'string') {
          contentMessages.push(`[用户]: ${m.message.content.substring(0, 500)}`);
          if (contentMessages.length >= 5) break;
        } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            if (block?.type === 'text' && block.text) {
              contentMessages.push(`[助手]: ${block.text.substring(0, 500)}`);
              if (contentMessages.length >= 5) break;
            }
          }
          if (contentMessages.length >= 5) break;
        }
      }
      const { callLLM } = await import('../src/core/llm/index.js');
      const { getConfig } = await import('../src/core/llm/config.js');
      const systemPrompt = '你是一个对话标题生成器。\n\n'
        + '示例1:\n对话内容：[用户]: 帮我写一个Python排序函数\n[助手]: 以下是冒泡排序实现...\n'
        + '输出：{"title": "Python排序函数"}\n\n'
        + '示例2:\n对话内容：[用户]: 今天天气怎么样\n[助手]: 今天北京晴转多云...\n'
        + '输出：{"title": "查询天气"}\n\n'
        + '现在请为以下对话生成标题（不超过20个字），只输出 JSON：';
      const modelConfig = await getConfig();
      let rawResult = '';
      for await (const event of callLLM({
        messages: [
          { role: 'user' as const, content: `${systemPrompt}\n\n对话内容：\n${contentMessages.join('\n\n')}` },
        ],
        tools: [],
        signal: null,
        modelConfig,
        sessionId,
      })) {
        if (event.type === 'text_delta') {
          rawResult += event.text;
        } else if (event.type === 'assistant') {
          const ct = event.message?.content;
          if (Array.isArray(ct)) {
            for (const block of ct) {
              if (block.type === 'text' && block.text) {
                rawResult = block.text;
              }
            }
          }
        }
      }
      let title = '';
      const jsonStr = extractLastJsonObject(rawResult);
      if (jsonStr) {
        try { const parsed = JSON.parse(jsonStr); title = parsed.title || ''; } catch { /* ignore */ }
      }
      if (!title) {
        const tMatch = rawResult.match(/\{\s*"title"\s*:\s*"([^"]+)"\s*\}/);
        if (tMatch) { title = tMatch[1]; }
        else {
          const lines = rawResult.split('\n').filter(l => l.trim());
          title = lines[lines.length - 1]?.trim()?.substring(0, 50) || '智能命名';
        }
      }
      const { updateConversationMetadataTitle } = await import('../src/core/history/Conversation.js');
      await updateConversationMetadataTitle(sessionId, title);
      chatViews?.sendTo(sessionId, { type: 'setTitle', title });
      refreshSidebar();
      return { ok: true, title };
    } catch (err) {
      console.error('[main] sidebar:smart-name-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });
}

/** 刷新侧栏对话列表（对话创建/删除/切换后调用） */
function refreshSidebar(): void {
  (async () => {
    try {
      const list = (await chatViews?.getSidebarConversations()) ?? [];
      sidebarView?.webContents.send('sidebar:conversations-updated', list);
    } catch (err) {
      console.error('[main] refreshSidebar error:', err);
    }
  })();
}

function sendTheme(): void {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  console.log(`[main] sendTheme: ${theme} (themeSource=${nativeTheme.themeSource})`);
  chatViews?.sendToActive({
    type: 'setTheme',
    theme,
  });
}

function sendContextLimit(model?: string): void {
  try {
    const { getContextWindow } = require('../src/core/utils/modelConfig.js');
    let modelName = model;
    if (!modelName) {
      const settingsPath = path.join(require('os').homedir(), CONFIG_DIR_NAME, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        modelName = cfg?.defaultModel || cfg?.llm?.model;
      }
    }
    const contextWindow = getContextWindow(modelName || '');
    chatViews?.sendToActive({
      type: 'contextLimitUpdated',
      maxContextTokens: contextWindow,
    });
  } catch (err) {
    console.error('[main] sendContextLimit error:', err);
  }
}

/** 检测 LLM 配置是否完整，未配置 active provider 或其 apiKey 为空时弹出配置面板（与 extension.ts checkAndSendLLMConfig 一致） */
async function checkAndSendLLMConfig(): Promise<void> {
  try {
    const { getLLMConfigPanelPayload, hasActiveProviderSetting } = await import('../src/core/llm/config.js');
    const payload = await getLLMConfigPanelPayload();
    const hasActiveProvider = await hasActiveProviderSetting();
    // 仅在 active provider 已设置但缺少 apiKey 时补弹；
    // 没有 active provider 的场景由 handleStartNewConversation 在新对话时弹设置页
    if (!hasActiveProvider || payload.apiKey) {
      return;
    }

    const { readUiLanguageSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    chatViews?.sendToActive({
      type: 'showLLMConfig',
      ...payload,
      language: readUiLanguageSync(),
    });
  } catch (err) {
    console.error('[main] checkAndSendLLMConfig error:', err);
  }
}

/** 初始化 core 层（与 extension.ts activate 对应） */
function initCore(): void {
  const { setGlobalUI } = require('../src/core/AssistantUI.js');
  const { initializeHistory, initializeSessionQueue } = require('../src/core/Integration.js');
  const { setExtensionPathProvider } = require('../src/core/history/Config.js');
  const { setLogCallback, setLogToConsole } = require('../src/core/Logger.js');
  const { ensureConfigDirs } = require('../src/core/history/index.js');
  const { setCoreLocale } = require('../src/core/i18n.js');

  setCoreLocale(app.getLocale().startsWith('zh') ? 'zh' : 'en');

  const ui = require('./ElectronUI.js').ElectronUI.getInstance();
  ui.setMainWindow(mainWindow!);
  ui.setSidebarView(sidebarView!);
  ui.setChatViewManager(chatViews!);
  ui.setWorkspacePath(workspacePath);
  setGlobalUI(ui);

  // 日志：输出到控制台（Electron 无 OutputChannel）
  setLogToConsole(true);
  setLogCallback((message: string) => {
    console.log(message);
  });

  // 项目根目录提供者（从 ElectronUI 获取工作区）
  initializeHistory(ui);
  // 初始化会话队列回调
  try {
    initializeSessionQueue();
  } catch (err) {
    console.error('[main] initializeSessionQueue error:', err);
  }

  // 扩展路径提供者：ripgrep/pandoc 等资源位于 <root>/dist/resources
  setExtensionPathProvider(() => APP_ROOT);

  // 配置目录
  ensureConfigDirs().then(() => {
    console.log('[main] ensureConfigDirs done');
  }).catch((error: Error) => {
    console.error('[main] Failed to initialize config directories:', error);
  });

  // 预热系统动态环境信息
  (async () => {
    try {
      if (!workspacePath) return; // 未选择工作区时跳过（getProjectRoot 不可用）
      const { warmupSystemDynamicInfo } = require('../src/core/prompt/SystemEnvironment.js');
      const { getProjectRoot } = require('../src/core/history/Config.js');
      const cwd = getProjectRoot();
      warmupSystemDynamicInfo(cwd);
    } catch {
      // 预热失败不影响主流程
    }
  })();
}
