/**
 * PRODUCT_NAME - Electron 主进程入口
 *
 * 职责：
 * 1. 创建主窗口：左侧原生侧栏（对话列表）+ 右侧聊天 WebContentsView（每对话一个标签）
 * 2. 注册 IPC（webview-message）并委托给 WebViewUI（复用同一份 WebviewMessageHandler）
 * 3. 侧栏 IPC：对话列表读写、打开/新建对话、列表变化推送
 * 4. 初始化 core（setGlobalEventBus / initializeCoreEvents / initializeHistory / 日志）
 * 5. 提供菜单：打开工作区、最近打开的工作目录、深色模式同步
 *
 * 与 VS Code 扩展的差异点（extension.ts）：
 * - workspace 路径由用户通过菜单选择（VS Code 从 workspaceFolders 获取）
 * - 对话列表由原生侧栏展示（VS Code 在 webview 内展示）
 * - 文件打开/虚拟文档/Mermaid/Spin 由 UIHost 提供 Electron 实现
 */

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, dialog, WebContentsView, shell, webContents, globalShortcut, Tray, nativeImage, type NativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatViewManager, SIDEBAR_WIDTH } from './ChatViewManager.js';
import { ElectronUIHost } from './ElectronUIHost.js';
import { ElectronSpinDesign } from './ElectronSpinDesign.js';
import { ElectronConversationManager } from './ElectronConversationManager.js';
import { WebViewUI } from '../src/host/WebViewUI.js';
import { UserChoiceManager } from '../src/host/ui/userChoice.js';
import type { WebviewPoster } from '../src/host/ui/ports.js';
import { createTrayStatusIcon, deriveTrayStatus, deriveTrayStatusFromStates, type TrayStatus } from './trayStatusIcon.js';
import { startWebServer, type WebServerHandle, type WebServerClient } from './server/webServer.js';
import { getBrowserShimSource } from './server/browserShim.js';
import { PRODUCT_NAME } from '../src/config/project.js';
import { SERVER_HOST_INFO } from '../src/host/types.js';
import { DEFAULT_WAKE_SHORTCUT } from '../src/core/utils/shortcut.js';
import { resolveSmartTitle } from '../src/core/history/smartNaming.js';
import { readActiveProviderModelContextSync } from '../src/core/history/Config.js';

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
/** 当前 WebViewUI 实例（initCore 创建；消息路由 / 工作区切换使用） */
let webviewUi: WebViewUI | undefined;
/** 当前宿主实现（initCore 创建） */
let uiHost: ElectronUIHost | undefined;
/** 系统托盘：提供唤醒入口与退出入口（窗口不会因最小化而隐藏到托盘） */
let tray: Tray | undefined;
/** 内置 HTTP 服务器句柄（File 菜单 Start Server / Stop Server 控制） */
let serverHandle: WebServerHandle | undefined;
/** 内置 HTTP 服务器默认端口（被占用时自动向后尝试其它端口） */
const DEFAULT_SERVER_PORT = 3210;
/** 端口占用时最多向后尝试的端口数 */
const SERVER_PORT_RETRY = 20;
/** 当前已注册的全局唤醒快捷键（用于设置面板打开时临时注销） */
let registeredWakeShortcut: string | undefined;
/** 当前窗口是否由唤醒快捷键/托盘呼出，用于“再按一次回到托盘”的切换判断 */
let wakeToggleActive = false;
/**
 * 打开了设置面板的 webContents 集合。
 * 打开期间临时注销全局快捷键，避免干扰快捷键设置；
 * 用集合而不是布尔值，兼容多个会话视图同时打开设置面板的情况。
 */
const settingsPanelSenders = new Set<number>();
/** 应用退出中：避免 destroyed 回调里再尝试注册快捷键 */
let appQuitting = false;
/**
 * 白屏恢复用的重绘定时器句柄：
 * - repaintIntervalTimer：窗口可见期间 30 秒一次的兜底重绘
 * - focusRepaintTimer：窗口聚焦防抖后的单次重绘
 * 窗口销毁/应用退出时清理，避免句柄悬挂（纯防御性）。
 */
let repaintIntervalTimer: ReturnType<typeof setInterval> | null = null;
let focusRepaintTimer: ReturnType<typeof setTimeout> | null = null;
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
    // 启动早期 mainWindow 可能尚未创建，此时不做处理，避免与 main() 的初始化竞争
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindowFromTray();
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
  setupTray();
  setupMenu();
  // 系统主题变化时同步聊天视图（只注册一次，避免菜单重建时重复注册）
  nativeTheme.on('updated', () => {
    sendTheme();
  });
  setupIpc();
  initCore();
  // 注册全局唤醒快捷键（settings.json 中的 shortcut，默认 Ctrl+Alt+X）
  // 注册失败时弹窗提示，避免静默失效
  registerWakeShortcut();

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

  app.on('will-quit', () => {
    appQuitting = true;
    // 停止白屏恢复相关的重绘定时器（窗口销毁回调可能未触发，双保险）
    if (repaintIntervalTimer) {
      clearInterval(repaintIntervalTimer);
      repaintIntervalTimer = null;
    }
    if (focusRepaintTimer) {
      clearTimeout(focusRepaintTimer);
      focusRepaintTimer = null;
    }
    // 关闭内置 HTTP 服务器，断开浏览器连接
    if (serverHandle) {
      const handle = serverHandle;
      serverHandle = undefined;
      void handle.close().catch(() => undefined);
    }
    // 停止空闲巡检定时器
    try {
      const { stopSessionIdleMonitor } = require('../src/core/sessionIdle.js') as typeof import('../src/core/sessionIdle.js');
      stopSessionIdleMonitor();
    } catch {
      // 退出阶段的清理失败不应影响退出
    }
    globalShortcut.unregisterAll();
    registeredWakeShortcut = undefined;
    stopTrayBlink();
    tray?.destroy();
    tray = undefined;
    // 结束所有 MCP 子进程，避免留下孤儿进程
    try {
      const { getMcpManager } = require('../src/core/mcp/Manager.js');
      getMcpManager().shutdown();
    } catch {
      // 退出阶段的清理失败不应影响退出
    }
  });
}

function createMainWindow(): void {
  // 防止 second-instance / activate 与启动流程并发创建出多个主窗口
  if (mainWindow && !mainWindow.isDestroyed()) return;
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

  // 最小化一律走系统默认行为：窗口最小化到任务栏并保留任务栏图标，
  // 不再隐藏到托盘（隐藏到托盘只由全局快捷键切换触发）。
  // 用户手动切换窗口/隐藏时，取消“再按一次回托盘”的切换态；
  // 下次按快捷键应重新把窗口唤到前台，而不是直接隐藏。
  mainWindow.on('blur', () => {
    wakeToggleActive = false;
  });
  mainWindow.on('hide', () => {
    wakeToggleActive = false;
  });

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
  let highlightLanguages: string[] = [];
  try {
    const { readUiLanguageSync, readHighlightLanguagesSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    uiLanguage = readUiLanguageSync();
    // Shiki 语法高亮全部按需加载：注入上次已使用过的语言，webview 启动后后台预热
    highlightLanguages = readHighlightLanguagesSync();
  } catch { /* 读取失败时使用 auto（跟随系统语言） */ }
  chatViews = new ChatViewManager({
    win: mainWindow,
    appRoot: APP_ROOT,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    workspacePath: workspacePath || '',
    locale: app.getLocale(),
    systemLocale: getSystemLocaleForStartup(),
    uiLanguage,
    highlightLanguages,
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
  mainWindow.on('focus', () => {
    // 从被遮挡状态恢复聚焦时也可能丢合成表面，防抖后重绘一次
    if (focusRepaintTimer) clearTimeout(focusRepaintTimer);
    focusRepaintTimer = setTimeout(repaintAllViews, 120);
  });

  // 用户打开/还原/聚焦界面后，取消任务栏与托盘的闪烁提醒
  mainWindow.on('show', cancelAttention);
  mainWindow.on('restore', cancelAttention);
  mainWindow.on('focus', cancelAttention);

  // 兜底：窗口可见期间周期性强制重绘，及时修复未触发上述事件的偶发白屏
  repaintIntervalTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      repaintAllViews();
    }
  }, 30_000);

  mainWindow.on('closed', () => {
    mainWindow = undefined;
    sidebarView = undefined;
    chatViews = undefined;
    // 窗口已销毁：停止白屏恢复相关的重绘定时器（纯防御性清理）
    if (repaintIntervalTimer) {
      clearInterval(repaintIntervalTimer);
      repaintIntervalTimer = null;
    }
    if (focusRepaintTimer) {
      clearTimeout(focusRepaintTimer);
      focusRepaintTimer = null;
    }
  });
}

/** 读取 settings.json 中的唤醒快捷键（失败时返回默认值） */
function readWakeShortcutFromSettings(): string {
  try {
    const { readWakeShortcutSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    return readWakeShortcutSync();
  } catch {
    return DEFAULT_WAKE_SHORTCUT;
  }
}

/**
 * 显示/唤醒主窗口。
 * 窗口被隐藏到托盘、最小化或尚未创建时都能恢复；供托盘点击、全局快捷键、
 * 第二实例启动复用。
 */
function showMainWindowFromTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    wakeToggleActive = true;
    createMainWindow();
    return;
  }
  // 顺序很重要：必须先 show() 再 restore()。
  // 窗口可能是被最小化到任务栏（或隐藏到托盘）后被唤醒的；
  // 若先调用 restore() 再 show()，Windows 上 WebContentsView 会丢失鼠标命中区域，
  // 表现为恢复后侧栏对话列表与聊天区都无法点击（Electron 43 可稳定复现）。
  // show() 本身会解除最小化，因此正常路径下 restore() 不会被执行，仅作兜底。
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  // Windows 上从托盘/后台恢复时，先置顶再取消，避免窗口只闪烁不聚焦
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  wakeToggleActive = true;
  // 用户已经打开界面，取消任务栏/托盘的闪烁提醒
  cancelAttention();
  layout();
}

/**
 * 全局快捷键切换：窗口在前台时按快捷键隐藏回托盘，
 * 不在前台时恢复并聚焦。托盘点击始终只显示窗口。
 */
function toggleMainWindowFromTray(): void {
  if (
    wakeToggleActive
    && mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.isVisible()
    && !mainWindow.isMinimized()
  ) {
    wakeToggleActive = false;
    mainWindow.hide();
    return;
  }
  showMainWindowFromTray();
  // 通过全局快捷键唤醒后聚焦输入框，用户可直接开始输入
  focusActiveChatInput();
}

/**
 * 唤醒窗口后聚焦当前聊天视图的输入框。
 * 视图可能尚未创建或仍在加载（应用刚启动时），因此做少量重试；
 * 页面加载中则等 did-finish-load 再发送，避免消息丢失。
 */
function focusActiveChatInput(attempt = 0): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = chatViews?.getActiveWebContents();
  if (!target || target.isDestroyed()) {
    if (attempt < 20) {
      setTimeout(() => focusActiveChatInput(attempt + 1), 100);
    }
    return;
  }
  const send = (): void => {
    if (target.isDestroyed()) return;
    target.focus();
    target.send('webview-message', { type: 'focusInput' });
  };
  if (target.isLoading()) {
    target.once('did-finish-load', send);
    return;
  }
  send();
}

/** 托盘图标：在应用 Logo 右下角叠加状态圆点（绿=空闲 / 红=运行中 / 黄=等待用户） */
const TRAY_ICON_PATH = path.join(APP_ROOT, 'assets', 'logo.png');

/** 托盘当前展示的状态，避免状态未变化时重复重建图标 */
let trayStatus: TrayStatus | null = null;

/** 托盘提示文案（按系统语言输出中/英文） */
const TRAY_STATUS_LABEL: Record<TrayStatus, { zh: string; en: string }> = {
  idle: { zh: '全部任务空闲', en: 'All tasks idle' },
  running: { zh: '有任务运行中', en: 'Task running' },
  waiting: { zh: '等待用户确认', en: 'Waiting for your input' },
};

function trayTooltip(status: TrayStatus): string {
  const isZh = app.getLocale().toLowerCase().startsWith('zh');
  const label = TRAY_STATUS_LABEL[status];
  return `${PRODUCT_NAME} · ${isZh ? label.zh : label.en}`;
}

/** 提醒（任务栏 / 托盘）闪烁的间隔（毫秒） */
const TRAY_BLINK_INTERVAL_MS = 500;

/**
 * 闪烁“熄灭”相位的整体不透明度（0~1）。
 * 0 表示 Logo 与状态圆点一起完全消失；调成 0.2 左右则变为忽明忽暗的呼吸效果。
 */
const TRAY_BLINK_HIDDEN_ALPHA = 0;

/** 闪烁定时器；无闪烁时为 null */
let trayBlinkTimer: ReturnType<typeof setInterval> | null = null;

/** 当前闪烁使用的状态（决定状态圆点颜色），无闪烁时为 null */
let trayBlinkStatus: TrayStatus | null = null;

/** 按状态缓存“亮 / 灭”两个相位的图标，避免每次闪烁都重新合成位图 */
const trayBlinkImageCache = new Map<TrayStatus, { on: NativeImage; off: NativeImage }>();

/**
 * 是否有正在进行的“任务结束”提醒（任务栏图标闪烁 + 托盘图标闪烁）。
 * 由 startAttention 置位，用户打开界面（cancelAttention）时清除。
 */
let attentionActive = false;

function getTrayBlinkImages(status: TrayStatus): { on: NativeImage; off: NativeImage } | null {
  const cached = trayBlinkImageCache.get(status);
  if (cached) return cached;
  const on = createTrayStatusIcon(status, TRAY_ICON_PATH);
  const off = createTrayStatusIcon(status, TRAY_ICON_PATH, { alpha: TRAY_BLINK_HIDDEN_ALPHA });
  if (on.isEmpty() || off.isEmpty()) return null;
  const images = { on, off };
  trayBlinkImageCache.set(status, images);
  return images;
}

/** 停止托盘闪烁（不改动当前图标） */
function stopTrayBlink(): void {
  if (trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }
  trayBlinkStatus = null;
}

/** 停止闪烁并把托盘图标恢复为当前状态的静态图标（同时刷新提示文案） */
function restoreTrayIcon(): void {
  stopTrayBlink();
  if (!tray || !trayStatus) return;
  try {
    const image = createTrayStatusIcon(trayStatus, TRAY_ICON_PATH);
    if (!image.isEmpty()) tray.setImage(image);
    tray.setToolTip(trayTooltip(trayStatus));
  } catch (err) {
    console.error('[main] Failed to restore tray icon:', err);
  }
}

/**
 * 启动托盘闪烁：整个图标（Logo + 状态圆点）在“亮 / 灭”两个相位之间切换。
 * `status` 决定圆点颜色（空闲绿点 / 等待黄点）。
 * 返回是否成功启动（图标不可用时返回 false，调用方回退到静态图标）。
 */
function startTrayBlink(status: TrayStatus): boolean {
  if (trayBlinkTimer && trayBlinkStatus === status) return true;
  if (!tray) return false;
  const images = getTrayBlinkImages(status);
  if (!images) return false;
  stopTrayBlink();
  let visible = true;
  tray.setImage(images.on);
  trayBlinkStatus = status;
  trayBlinkTimer = setInterval(() => {
    if (!tray) {
      stopTrayBlink();
      return;
    }
    visible = !visible;
    tray.setImage(visible ? images.on : images.off);
  }, TRAY_BLINK_INTERVAL_MS);
  return true;
}

/**
 * 窗口是否处于后台——只有此时任务结束才需要闪烁提醒。
 * 三种情况都算后台：最小化、隐藏到托盘、可见但不在顶层（被其它窗口遮挡
 * 或切到了别的应用，即失去焦点）。
 */
function isWindowInBackground(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  if (mainWindow.isMinimized()) return true;
  if (!mainWindow.isVisible()) return true;
  return !mainWindow.isFocused();
}

/**
 * 是否需要闪烁任务栏图标：最小化，或可见但不在顶层（未聚焦）。
 * 隐藏到托盘时任务栏没有窗口按钮，无从闪烁，返回 false（此时仅闪烁托盘图标）。
 */
function shouldFlashTaskbar(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) return true;
  return mainWindow.isVisible() && !mainWindow.isFocused();
}

/** 停止任务栏图标闪烁 */
function stopTaskbarFlash(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.flashFrame(false);
  } catch {
    // 部分平台/状态下 flashFrame 可能抛错，忽略即可
  }
}

/**
 * 任务从运行中结束（变为空闲或等待用户确认）且窗口处于后台时的提醒：
 * 最小化或非顶层（可见但未聚焦）时闪烁任务栏图标（隐藏到托盘没有任务栏
 * 按钮，跳过），同时让托盘图标一起闪烁，颜色跟随当前状态（空闲绿点 /
 * 等待黄点）。
 */
function startAttention(status: TrayStatus): void {
  if (!isWindowInBackground()) return;
  attentionActive = true;
  if (shouldFlashTaskbar() && mainWindow) {
    try {
      mainWindow.flashFrame(true);
    } catch {
      // 闪烁失败不影响托盘提醒
    }
  }
  if (tray && !startTrayBlink(status)) restoreTrayIcon();
}

/** 用户打开/还原/聚焦界面后取消提醒（停止任务栏闪烁并恢复静态托盘图标） */
function cancelAttention(): void {
  if (!attentionActive) return;
  attentionActive = false;
  stopTaskbarFlash();
  restoreTrayIcon();
}

/** 创建系统托盘（只创建一次），提供“显示主窗口”和“退出”入口 */
function setupTray(): void {
  if (tray) return;
  try {
    const image = createTrayStatusIcon('idle', TRAY_ICON_PATH);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    trayStatus = 'idle';
    tray.setToolTip(trayTooltip('idle'));
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: `Show ${PRODUCT_NAME}`,
        click: () => showMainWindowFromTray(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]));
    tray.on('click', () => showMainWindowFromTray());
    tray.on('double-click', () => showMainWindowFromTray());
  } catch (err) {
    console.error('[main] Failed to create tray:', err);
    tray = undefined;
  }
}

/**
 * 根据侧栏对话列表刷新托盘状态点：
 * 有会话在等待用户确认/提问 → 黄点；有会话运行中 → 红点；全部空闲 → 绿点。
 * 状态未变化时不重建图标（createFromBitmap / resize 有一定开销）。
 *
 * 另外负责“任务结束提醒”：当任务从运行中变为空闲或等待用户确认、且窗口处于
 * 后台（最小化/隐藏/可见但非顶层）时，闪烁任务栏图标并让托盘图标一起闪烁，
 * 直到用户打开界面。
 */
function updateTrayStatusFromConversations(list: ReadonlyArray<Record<string, unknown>>): void {
  const status = deriveTrayStatus(list);
  if (status === trayStatus) return;
  const previous = trayStatus;
  trayStatus = status;

  // 新任务开始运行说明用户已在界面里操作，之前“任务结束”的提醒已过时，直接取消
  if (status === 'running' && attentionActive) {
    attentionActive = false;
    stopTaskbarFlash();
  }

  // 提醒进行中（窗口仍在后台）时让托盘闪烁跟随最新状态着色；否则显示静态图标
  if (attentionActive) {
    if (!startTrayBlink(status)) restoreTrayIcon();
  } else {
    restoreTrayIcon();
  }

  // 任务从运行中结束（变为空闲或等待用户确认）且窗口在后台 → 提醒用户
  if (previous === 'running' && (status === 'idle' || status === 'waiting')) {
    startAttention(status);
  }
}

/**
 * 托盘只吃状态流（阶段 3.6）：running / waiting 由 core 的 sessionRuntimeChanged
 * 全量推送，经 ElectronConversationManager.setStatusListener 到达这里；
 * 不再从对话列表推导。
 */
function updateTrayStatusFromStates(
  states: ReadonlyArray<import('../src/core/AssistantEventBus.js').SessionRuntimeState>,
): void {
  const status = deriveTrayStatusFromStates(states);
  if (status === trayStatus) return;
  const previous = trayStatus;
  trayStatus = status;

  if (status === 'running' && attentionActive) {
    attentionActive = false;
    stopTaskbarFlash();
  }

  if (attentionActive) {
    if (!startTrayBlink(status)) restoreTrayIcon();
  } else {
    restoreTrayIcon();
  }

  if (previous === 'running' && (status === 'idle' || status === 'waiting')) {
    startAttention(status);
  }
}

/**
 * 重新注册全局唤醒快捷键：先注销旧值，再读取 settings.json 并注册新值。
 * 注册失败（快捷键被系统或其它程序占用）时静默忽略，不弹窗也不报错。
 */
function registerWakeShortcut(): void {
  if (appQuitting) return;
  // 设置面板打开期间不注册全局快捷键，避免快捷键被占用/触发而影响用户录制新组合
  if (settingsPanelSenders.size > 0) return;
  if (registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
  }
  const shortcut = readWakeShortcutFromSettings();
  try {
    if (globalShortcut.register(shortcut, () => toggleMainWindowFromTray())) {
      registeredWakeShortcut = shortcut;
      console.log(`[main] Global wake shortcut registered: ${shortcut}`);
    }
  } catch {
    // 静默忽略：快捷键注册失败不影响应用主流程
  }
}

/** 设置面板打开：临时注销全局唤醒快捷键，避免影响用户录制新组合键 */
function suspendWakeShortcut(sender: Electron.WebContents): void {
  const senderId = sender.id;
  if (settingsPanelSenders.has(senderId)) return;
  settingsPanelSenders.add(senderId);
  // webview 被销毁（关闭会话/切换工作区/应用退出）时兜底释放，避免快捷键一直处于注销状态
  sender.once('destroyed', () => {
    if (settingsPanelSenders.delete(senderId) && settingsPanelSenders.size === 0) {
      resumeWakeShortcutInternal();
    }
  });
  if (settingsPanelSenders.size === 1 && registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
    console.log('[main] Global wake shortcut suspended while settings panel is open');
  }
}

/** 设置面板关闭：所有面板都关闭后按最新 settings.json 恢复注册 */
function resumeWakeShortcut(sender: Electron.WebContents): void {
  if (settingsPanelSenders.delete(sender.id) && settingsPanelSenders.size === 0) {
    resumeWakeShortcutInternal();
  }
}

/** 所有设置面板关闭后恢复全局快捷键注册 */
function resumeWakeShortcutInternal(): void {
  if (appQuitting) return;
  registerWakeShortcut();
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

// ===================== 内置 HTTP 服务器（File 菜单 Start Server） =====================

/** 统一弹窗入口（主窗口不可用时退化为无父窗口弹窗） */
function showMessageBox(options: Electron.MessageBoxOptions): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, options).catch(() => undefined);
  } else {
    void dialog.showMessageBox(options).catch(() => undefined);
  }
}

/** 服务器可访问地址：localhost + 所有非回环 IPv4 网卡地址（局域网访问） */
function getServerUrlCandidates(port: number): string[] {
  const urls = [`http://localhost:${port}/`];
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const info of nets[name] ?? []) {
        if (!info || info.internal) continue;
        // Node 18+ family 为 'IPv4'，旧版本为数字 4，这里都兼容
        const isIPv4 = info.family === 'IPv4' || (info.family as unknown as number) === 4;
        if (isIPv4) {
          urls.push(`http://${info.address}:${port}/`);
        }
      }
    }
  } catch (err) {
    console.error('[main] Failed to enumerate network interfaces:', err);
  }
  return urls;
}

/**
 * 启动内置 HTTP 服务器：
 * - 前端：dist/webview（webview 构建产物），浏览器直接访问
 * - 后端：Electron 主进程（复用 WebViewUI / core），消息经 WebSocket 转发
 * 默认端口被占用时自动向后尝试，全部失败则弹窗提示。
 */
async function startServer(): Promise<void> {
  if (serverHandle) {
    openServerInBrowser();
    return;
  }
  if (!workspacePath) {
    const isZh = app.getLocale().toLowerCase().startsWith('zh');
    showMessageBox({
      type: 'warning',
      title: PRODUCT_NAME,
      message: isZh ? '请先打开工作目录' : 'Please open a workspace folder first',
      detail: isZh
        ? '内置服务器需要工作目录来运行后端（File - Open Workspace Folder...）。'
        : 'The built-in server needs a workspace folder to run the backend (File - Open Workspace Folder...).',
      buttons: [isZh ? '知道了' : 'OK'],
    });
    return;
  }

  const webRoot = path.join(APP_ROOT, 'dist', 'webview');
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    const isZh = app.getLocale().toLowerCase().startsWith('zh');
    showMessageBox({
      type: 'error',
      title: PRODUCT_NAME,
      message: isZh ? '未找到前端构建产物' : 'Frontend build not found',
      detail: isZh
        ? `缺少 ${webRoot}\\index.html，请先执行 npm run build:webview。`
        : `Missing ${webRoot}\\index.html. Run npm run build:webview first.`,
      buttons: [isZh ? '知道了' : 'OK'],
    });
    return;
  }

  const shimSource = getBrowserShimSource();
  let lastError: unknown;
  for (let i = 0; i < SERVER_PORT_RETRY; i++) {
    const port = DEFAULT_SERVER_PORT + i;
    try {
      serverHandle = await startWebServer({
        webRoot,
        host: '0.0.0.0',
        port,
        shimSource,
        // 每次请求 index.html 时读取最新宿主信息（工作区/语言等）
        getHostGlobals: () => ({
          workspacePath: workspacePath ?? '',
          hasWorkspace: !!workspacePath,
          vscodeLocale: app.getLocale(),
          systemLocale: getSystemLocaleForStartup(),
          uiLanguage: readUiLanguage(),
          highlightLanguages: readHighlightLanguages(),
          // 浏览器访问时尝试全屏显示（受浏览器用户手势限制，见 browserShim.ts）
          fullscreen: true,
          hostInfo: SERVER_HOST_INFO,
        }),
        onClientConnected: (client) => {
          chatViews?.registerExternalClient(client);
        },
        onClientMessage: (client, message) => {
          handleWebviewMessageFromSource({ kind: 'server', client }, message);
        },
        onClientDisconnected: (client) => {
          // ChatViewManager 内部已通过 client.onDestroyed 兜底清理，这里仅记录
          console.log(`[main] server client #${client.id} disconnected`);
        },
      });
      break;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE') break;
    }
  }

  if (!serverHandle) {
    const isZh = app.getLocale().toLowerCase().startsWith('zh');
    showMessageBox({
      type: 'error',
      title: PRODUCT_NAME,
      message: isZh ? 'HTTP 服务器启动失败' : 'Failed to start HTTP server',
      detail: String((lastError as Error)?.message ?? lastError ?? ''),
      buttons: [isZh ? '知道了' : 'OK'],
    });
    return;
  }

  setupMenu();
  const port = serverHandle.port;
  const isZh = app.getLocale().toLowerCase().startsWith('zh');
  showMessageBox({
    type: 'info',
    title: PRODUCT_NAME,
    message: isZh ? 'HTTP 服务器已启动' : 'HTTP server started',
    detail: (isZh
      ? '前端（webview）已就绪，可在浏览器中访问以下地址：\n\n'
      : 'Frontend (webview) is ready. Open one of the URLs below in a browser:\n\n')
      + getServerUrlCandidates(port).join('\n'),
    buttons: [isZh ? '确定' : 'OK'],
  });
}

/** 停止内置 HTTP 服务器并断开所有浏览器连接 */
async function stopServer(): Promise<void> {
  const handle = serverHandle;
  if (!handle) return;
  serverHandle = undefined;
  setupMenu();
  try {
    await handle.close();
    console.log('[main] HTTP server stopped');
  } catch (err) {
    console.error('[main] Failed to stop HTTP server:', err);
  }
}

/** 用系统默认浏览器打开服务器首页 */
function openServerInBrowser(): void {
  if (!serverHandle) return;
  void shell.openExternal(serverHandle.url).catch((err) => {
    console.error('[main] Failed to open server URL:', err);
  });
}

/** 读取 settings.json 中的界面语言（失败时回退 auto） */
function readUiLanguage(): 'auto' | 'zh' | 'en' {
  try {
    const { readUiLanguageSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    return readUiLanguageSync();
  } catch {
    return 'auto';
  }
}

/** 读取 settings.json 中已使用过的 Shiki 高亮语言（失败时返回空数组） */
function readHighlightLanguages(): string[] {
  try {
    const { readHighlightLanguagesSync } = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
    return readHighlightLanguagesSync();
  } catch {
    return [];
  }
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
        // 内置 HTTP 服务器：把 webview 作为前端对外提供，Electron 作为后端处理请求
        {
          label: serverHandle ? 'Stop Server' : 'Start Server',
          click: () => { void (serverHandle ? stopServer() : startServer()); },
        },
        {
          label: 'Open Server in Browser',
          enabled: !!serverHandle,
          click: () => openServerInBrowser(),
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
  uiHost?.setWorkspacePath(workspacePath);
  // 后续新建的聊天视图携带新 --workspace= 参数
  chatViews?.setWorkspacePath(workspacePath);
  // 工作区变化：清空旧聊天视图并新建
  chatViews?.disposeAll();
  chatViews?.openNewConversation();
  // 旧工作区的会话已全部关闭：清空空闲关闭计时状态
  try {
    const { resetSessionIdleState } = require('../src/core/sessionIdle.js') as typeof import('../src/core/sessionIdle.js');
    resetSessionIdleState();
  } catch (err) {
    console.error('[main] resetSessionIdleState error:', err);
  }
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
  // 工作区切换后浏览器客户端的会话已失效：通知页面重载，重新初始化新工作区的会话
  serverHandle?.broadcast({ type: 'serverReload' });
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

/**
 * 消息来源：原生聊天视图（WebContents）或内置 HTTP 服务器的浏览器客户端。
 * 两者的消息协议完全一致，仅会话注册/回推方式不同。
 */
type WebviewMessageSource =
  | { kind: 'webcontents'; sender: Electron.WebContents }
  | { kind: 'server'; client: WebServerClient };

/**
 * 处理一条来自 webview（原生视图或浏览器客户端）的消息。
 * 与 extension.ts AssistantViewProvider 的专用消息处理保持一致，
 * 其余消息统一委托给 WebViewUI（复用同一份 WebviewMessageHandler）。
 */
function handleWebviewMessageFromSource(source: WebviewMessageSource, message: any): void {
  if (!message || typeof message.type !== 'string') return;

  const ui = webviewUi;
  if (!ui) return;
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;

  // 浏览器页面会带上自己的 clientId：登记到对应连接后，
  // 宿主回推的「只回给发起端」消息（查看文件 / 打开设置面板）就能精确定位到该连接，
  // 不会落到原生视图或其它浏览器端。
  if (source.kind === 'server' && typeof message.clientId === 'string' && message.clientId) {
    chatViews?.setExternalClientToken(source.client, message.clientId);
  }

  // 用户发出了新对话的第一条消息：该会话开始落盘，不再是「新建但还没发过消息」的对话。
  // 清除该标记后，下次点侧栏「新建」才会创建新的聊天视图，而不是复用这个已有内容的对话。
  if ((message.type === 'sendMessage' || message.type === 'queueMessage') && sessionId) {
    chatViews?.markSessionUsed(sessionId);
  }

  // 新建对话/会话切换时，将来源关联到 sessionId：
  // - 原生视图：把临时 new- 视图转为正式会话条目
  // - 浏览器客户端：登记该连接当前展示的会话，并维护 MCP 引用
  if (message.type === 'setActiveSessionId' || message.type === 'startNewConversation') {
    if (sessionId) {
      if (source.kind === 'webcontents') {
        chatViews?.registerSession(source.sender, sessionId);
        refreshSidebar();
      } else {
        chatViews?.setExternalClientSession(source.client, sessionId);
      }
    }
  }

  // 浏览器端加载指定会话：先登记会话，后续 conversationLoaded 才能按 sessionId 投递
  if (message.type === 'loadConversation') {
    if (sessionId && source.kind === 'server') {
      chatViews?.setExternalClientSession(source.client, sessionId);
    }
  }

  // webview 内点击子代理/回复/From 链接等跳转到指定会话：
  // - 原生视图：新起一个 webview 加载该对话（chatViews.openConversation 创建/切换视图）
  // - 浏览器客户端：不支持新起原生视图，退化为在当前页面内重新加载（loadConversation）
  if (message.type === 'openConversation') {
    if (sessionId) {
      if (source.kind === 'webcontents') {
        chatViews?.openConversation(sessionId);
        refreshSidebar();
      } else {
        chatViews?.setExternalClientSession(source.client, sessionId);
        void ui.handleWebviewMessage({ ...message, type: 'loadConversation' });
      }
    }
    return;
  }

  // 关闭按钮：卸内存 + 销毁视图走 WebViewUI.closeConversation（与侧栏「关闭」同一入口），
  // 再刷新侧栏（已加载状态/空对话）。浏览器客户端没有可销毁的原生视图，直接忽略。
  if (message.type === 'closeWebview') {
    if (source.kind === 'webcontents') {
      const closedSessionId = chatViews?.closeViewByWebContents(source.sender);
      if (closedSessionId) {
        webviewUi?.closeConversation(closedSessionId);
      }
      refreshSidebar();
    }
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
  // 设置面板打开期间临时注销全局快捷键，关闭后恢复（仅原生视图需要）
  if (message.type === 'suspendWakeShortcut') {
    if (source.kind === 'webcontents') suspendWakeShortcut(source.sender);
    return;
  }
  if (message.type === 'resumeWakeShortcut') {
    if (source.kind === 'webcontents') resumeWakeShortcut(source.sender);
    return;
  }

  // 设置保存不在这里重新注册：设置面板打开期间快捷键已临时注销，
  // 等面板关闭后由 resumeWakeShortcut 按最新 settings.json 统一恢复。
  ui.handleWebviewMessage(message).catch((err: any) => {
    console.error(`[main] handleWebviewMessage error (${message.type}):`, err);
  });
}

function setupIpc(): void {
  ipcMain.on('webview-message', (event, message: any) => {
    handleWebviewMessageFromSource({ kind: 'webcontents', sender: event.sender }, message);
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

  // 关闭指定会话（UI → core 走 WebViewUI.closeConversation：
  // 发 UiEvent.conversationClosed 卸内存 + 宿主销毁视图；列表刷新走 conversationListChanged 流）
  ipcMain.on('sidebar:close-conversation', (_event, sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId) {
      webviewUi?.closeConversation(sessionId);
      refreshSidebar();
    }
  });

  // ── 侧栏对话操作：删除 / 重命名 / 智能命名 ──
  ipcMain.handle('sidebar:delete-conversation', async (_event, sessionId: string) => {
    try {
      // 宿主只负责「关视图」：对受影响闭包逐个调 WebViewUI.closeConversation
      // （卸内存 + 销毁视图，5.5 节约定顺序）；删盘与列表广播由 core 的
      // conversationDeleted 订阅（deleteConversation → conversationListChanged）承担。
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
      for (const sid of affected) {
        webviewUi?.closeConversation(sid);
      }
      // 删盘（core 消费方：算闭包已由宿主完成，这里只发 root）
      const { requireEventBus } = await import('../src/core/AssistantEventBus.js');
      requireEventBus().emitToCore({ type: 'conversationDeleted', sessionId });
      // 等待 core 删盘完成后刷新侧栏（会话列表事件随后也会刷新）
      await new Promise((resolve) => setTimeout(resolve, 300));
      refreshSidebar();
      return { ok: true };
    } catch (err) {
      console.error('[main] sidebar:delete-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('sidebar:rename-conversation', async (_event, sessionId: string, title: string) => {
    try {
      // UI → core：重命名走总线（core 写 meta.json → CoreEvent.titleChanged /
      // conversationListChanged 广播，多端同步）
      const { requireEventBus } = await import('../src/core/AssistantEventBus.js');
      requireEventBus().emitToCore({ type: 'conversationRenamed', sessionId, title });
      // 标题回推与列表刷新由 core 广播；这里只保证侧栏尽快更新
      setTimeout(() => refreshSidebar(), 100);
      return { ok: true };
    } catch (err) {
      console.error('[main] sidebar:rename-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('sidebar:smart-name-conversation', async (_event, sessionId: string) => {
    try {
      // 智能命名编排属 core（与 webview 版 handleRequestSmartNaming 同一逻辑：
      // 取最近 5 条用户/助手文本 → LLM 生成标题 → 写 meta.json）；
      // 标题写盘走 UiEvent.conversationRenamed，后续广播（titleChanged / 列表刷新）走 core
      const { loadConversation } = await import('../src/core/history/index.js');
      const conversation = await loadConversation(sessionId);
      const title = await resolveSmartTitle(sessionId, (conversation.messages || []) as any[]);
      const { requireEventBus } = await import('../src/core/AssistantEventBus.js');
      requireEventBus().emitToCore({ type: 'conversationRenamed', sessionId, title });
      setTimeout(() => refreshSidebar(), 200);
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
      updateTrayStatusFromConversations(list);
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
    // 与 extension.ts 共用同一份读取逻辑：
    // - 显式传入 model 时用该模型；否则回退到 activeProvider.defaultModel → models[0]
    // - 同时读取 activeProvider.modelConfigs，让 settings.json 中每个模型的
    //   context/output 覆盖生效（此前 Electron 只按内置注册表计算，切换模型后
    //   webview 里的 context window 不会跟随变化）。
    const { model: modelName, modelConfigs } = readActiveProviderModelContextSync(model);
    const contextWindow = getContextWindow(modelName || '', modelConfigs);
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
    // 只推给触发本次检查的原生视图（按会话路由），不要广播到浏览器端，
    // 否则桌面端打开新对话会把设置面板弹到所有浏览器端。
    const activeSessionId = chatViews?.getActiveSessionId();
    if (!activeSessionId) return;
    chatViews?.sendTo(activeSessionId, {
      type: 'showLLMConfig',
      ...payload,
      language: readUiLanguageSync(),
      sessionId: activeSessionId,
    });
  } catch (err) {
    console.error('[main] checkAndSendLLMConfig error:', err);
  }
}

/** 初始化 core 层（与 extension.ts activate 对应） */
function initCore(): void {
  const { setGlobalEventBus } = require('../src/core/AssistantEventBus.js');
  const { createEventBus } = require('../src/host/EventBus.js');
  const { initializeCoreEvents } = require('../src/core/initializeCoreEvents.js');
  const { initializeHistory, initializeSessionQueue } = require('../src/core/Integration.js');
  const { setExtensionPathProvider } = require('../src/core/history/Config.js');
  const { setLogCallback, setLogToConsole } = require('../src/core/Logger.js');
  const { ensureConfigDirs } = require('../src/core/history/index.js');
  const { setCoreLocale } = require('../src/core/i18n.js');

  setCoreLocale(app.getLocale().startsWith('zh') ? 'zh' : 'en');

  // 事件总线：core 与 UI 的唯一耦合点（DEVELOPMENT.md 第 3 节）。
  // 顺序：注册总线 → 注册 core 侧 UiEvent 订阅 → 创建 UI（其构造函数注册 CoreEvent 处理器）。
  const bus = createEventBus();
  setGlobalEventBus(bus);
  initializeCoreEvents(bus);
  const host = new ElectronUIHost();
  const spinDesign = new ElectronSpinDesign(host, (win) => host.trackPreviewWindow(win));
  const conversations = new ElectronConversationManager(
    host,
    (channel: string, payload: unknown) => {
      if (sidebarView && !sidebarView.webContents.isDestroyed()) {
        sidebarView.webContents.send(channel, payload);
      }
    },
  );
  // 托盘只吃状态流（阶段 3.6）：running / waiting 来自 core 的 sessionRuntimeChanged
  conversations.setStatusListener((states) => updateTrayStatusFromStates(states));
  const ui = WebViewUI.create(
    host,
    bus,
    spinDesign,
    conversations,
    {
      log: (...args: unknown[]) => {
        console.log('[WebViewUI]', args.map(a => String(a)).join(' '));
      },
      createUserChoiceManager: (post, closePreview, uiPort) =>
        new UserChoiceManager({
          outputChannel: { appendLine: (line: string) => console.log('[WebViewUI]', line) },
          postToWebview: post,
          closePreview,
          getActiveSessionIdInternal: () => uiPort.getActiveSessionId(),
          onShowDiffInVirtualDocumentCallback: undefined,
          // 用户选择框弹出（ask user / 权限确认）：刷新侧栏，流水灯显示黄色
          onChoiceShown: () => {
            // 用户选择框弹出（ask user / 权限确认）：列表流刷新侧栏（waiting 走状态流）
            void conversations.refresh();
          },
        }),
    },
  );
  host.setMainWindow(mainWindow!);
  host.setSidebarView(sidebarView!);
  host.setChatViewManager(chatViews!);
  host.setWorkspacePath(workspacePath);
  webviewUi = ui;
  uiHost = host;
  // 侧栏黄色流水灯的「等待用户」判定
  chatViews?.setWaitingForUserProvider((sessionId: string) => ui.hasPendingUserChoice(sessionId));
  // trim / disposeAll / 关闭按钮统一走 WebViewUI.closeConversation（core 卸内存 + 宿主销毁视图）
  chatViews!.closeConversation = (sessionId: string) => ui.closeConversation(sessionId);

  // 日志：输出到控制台（Electron 无 OutputChannel）
  setLogToConsole(true);
  setLogCallback((message: string) => {
    console.log(message);
  });

  // 项目根目录提供者（从宿主实现获取工作区）
  initializeHistory(ui);
  // 初始化会话队列回调
  try {
    initializeSessionQueue();
  } catch (err) {
    console.error('[main] initializeSessionQueue error:', err);
  }

  // 空闲对话自动关闭：非激活对话 2 小时无活动后销毁其聊天视图并释放引擎 / 消息缓存
  try {
    const {
      startSessionIdleMonitor,
      setSessionIdleCloseHandler,
      setSessionWaitingForUserProvider,
      setSessionActiveProvider,
      releaseSessionResources,
    } = require('../src/core/sessionIdle.js') as typeof import('../src/core/sessionIdle.js');

    // 当前激活的对话以 ChatViewManager 为准：切换到已加载的视图时不会再发 setActiveSessionId
    setSessionActiveProvider(() => chatViews?.getActiveSessionId() ?? null);
    setSessionWaitingForUserProvider((sessionId: string) => ui.hasPendingUserChoice(sessionId));
    setSessionIdleCloseHandler(async (sessionId: string) => {
      // 先销毁聊天视图（内部会 abort 该会话的查询并释放 MCP 引用）
      chatViews?.closeView(sessionId);
      // 再释放引擎与消息缓存：再次打开该对话时由新视图 loadConversation 从磁盘重建
      await releaseSessionResources(sessionId);
      refreshSidebar();
    });
    startSessionIdleMonitor();
  } catch (err) {
    console.error('[main] init idle session monitor error:', err);
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

  // MCP：引用计数模型下，进程由「打开的对话」驱动，启动时只做残留清理，
  // 不主动连接任何服务器；对话打开（openConversation / registerSession）时才 acquire。
  (async () => {
    try {
      const { getMcpManager } = require('../src/core/mcp/Manager.js');
      await getMcpManager().prune();
    } catch (error) {
      console.error('[main] Failed to initialize MCP servers:', error);
    }
  })();
}
