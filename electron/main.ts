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
import { ChatViewManager, SIDEBAR_WIDTH } from './ChatViewManager.js';
import { ElectronUIHost } from './ElectronUIHost.js';
import { ElectronSpinDesign } from './ElectronSpinDesign.js';
import { ElectronConversationManager } from './ElectronConversationManager.js';
import { WebViewUI } from '../src/host/WebViewUI.js';
import { createTrayStatusIcon, deriveTrayStatusFromStates, type TrayStatus } from './trayStatusIcon.js';
import { PRODUCT_NAME } from '../src/config/project.js';
import {
  DEFAULT_WAKE_SHORTCUT,
  acceleratorFromKeyboardEvent,
  formatAcceleratorForDisplay,
  normalizeAccelerator,
} from '../src/core/utils/shortcut.js';
import { tt } from '../src/core/i18n.js';
import { getShortcutDialogHtml } from './shortcutDialogHtml.js';
import { resolveSmartTitle } from '../src/core/history/smartNaming.js';

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
/** 对话列表的读取与分发（bootstrap 创建；sidebar:get-conversations 读它的列表快照） */
let conversations: ElectronConversationManager | undefined;
let workspacePath: string | undefined;
/** 当前 WebViewUI 实例（initCore 创建；消息路由 / 工作区切换使用） */
let webviewUi: WebViewUI | undefined;
/** core 侧进程级资源的释放入口（initCore 从共享骨架取得；will-quit 调用） */
let coreShutdown: (() => void) | undefined;
/** 当前宿主实现（initCore 创建） */
let uiHost: ElectronUIHost | undefined;
/** 系统托盘：提供唤醒入口与退出入口（窗口不会因最小化而隐藏到托盘） */
let tray: Tray | undefined;
/** 当前已注册的全局唤醒快捷键（快捷键设置对话框打开时临时注销） */
let registeredWakeShortcut: string | undefined;
/** 当前窗口是否由唤醒快捷键/托盘呼出，用于“再按一次回到托盘”的切换判断 */
let wakeToggleActive = false;
/**
 * 打开了「唤醒快捷键设置」对话框的 webContents 集合。
 * 打开期间临时注销全局快捷键，避免用户按下的组合键先触发唤醒；
 * 用集合而不是布尔值，兼容同时打开多个的情况。
 */
const shortcutDialogSenders = new Set<number>();
/** 唤醒快捷键设置对话框（File - Shortcut...；同一时刻只开一个） */
let shortcutDialogWindow: BrowserWindow | undefined;
/** 应用退出中：避免 destroyed 回调里再尝试注册快捷键 */
let appQuitting = false;
/**
 * 白屏恢复用的重绘定时器句柄：
 * - focusRepaintTimer：窗口聚焦防抖后的单次重绘
 * 窗口销毁/应用退出时清理，避免句柄悬挂（纯防御性）。
 */
let focusRepaintTimer: ReturnType<typeof setTimeout> | null = null;
// 侧栏三条流各自单一 owner（DEVELOPMENT.md 第 5.4 节）：
// - 列表（纯磁盘元数据）→ ConversationManager.dispatchList → sidebar:conversations-updated
// - 运行时状态（idle / waiting）→ ConversationManager.dispatchStates → sidebar:session-states-updated
// - loaded（视图层）→ ChatViewManager.onLoadedChanged → sidebar:session-loaded-changed

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
  // 系统主题变化时同步所有聊天视图（只注册一次，避免菜单重建时重复注册）。
  // onThemeChanged(null) 广播而不是只发活动视图：隐藏的对话视图与后台预热视图
  // 同样要更新，否则它们被切回前台时会带着过期的主题。
  nativeTheme.on('updated', () => {
    uiHost?.onThemeChanged(null);
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

  // 本应用任意窗口（主窗口 / 快捷键设置对话框等）获得焦点即取消闪烁提醒。
  // 只监听 mainWindow 的 focus 会漏掉子窗口聚焦的情况——子窗口聚焦时主窗口
  // 失去焦点，但用户正在使用本应用，不应继续闪烁。
  app.on('browser-window-focus', () => cancelAttention());

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    appQuitting = true;
    // 停止白屏恢复相关的重绘定时器（窗口销毁回调可能未触发，双保险）
    if (focusRepaintTimer) {
      clearTimeout(focusRepaintTimer);
      focusRepaintTimer = null;
    }
    globalShortcut.unregisterAll();
    registeredWakeShortcut = undefined;
    stopTrayBlink();
    tray?.destroy();
    tray = undefined;
    // core 侧的进程级资源（MCP 子进程）统一由共享骨架释放
    coreShutdown?.();
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
    onLoadedChanged: (sessionIds) => {
      // 视图层「已打开会话」集合单独推送（不并入对话列表流），见 DEVELOPMENT.md 第 5.4 节
      sidebarView?.webContents.send('sidebar:session-loaded-changed', sessionIds);
    },
    onViewCreated: (view) => {
      view.webContents.on('did-finish-load', () => {
        showMainWindow(); // 聊天视图加载完成再显示窗口，避免空白闪烁
        layout(); // 页面加载完成后按当前实际尺寸重排，避免初始视口偏差导致输入框被遮挡
        // 主题 / 上下文限制按「本视图」直发：后台预热的视图不是活动视图，
        // 走 sendToActive 会发错对象（预热视图将一直停在 Loading）。
        sendThemeToSource(view.webContents);
        sendContextLimit(view.webContents);
        setTimeout(() => {
          // 后台预热视图仍在后台时不弹设置页：它被切到前台时会走
          // handleStartNewConversation 的同一段逻辑（那时也才真正需要配置面板）。
          // 否则面板会在预热视图里悄悄打开，用户配置完成后仍残留。
          if (chatViews?.isPrewarmWebContents(view.webContents)) return;
          void checkAndSendLLMConfig(view.webContents);
        }, 1000);
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

  // 用户打开/还原/聚焦界面后，取消托盘闪烁提醒
  mainWindow.on('show', cancelAttention);
  mainWindow.on('restore', cancelAttention);
  mainWindow.on('focus', cancelAttention);

  mainWindow.on('closed', () => {
    // 后台预热的聊天视图未挂在窗口上，需显式清理（其余视图随窗口销毁）
    chatViews?.dispose();
    mainWindow = undefined;
    sidebarView = undefined;
    chatViews = undefined;
    // 窗口已销毁：停止白屏恢复相关的重绘定时器（纯防御性清理）
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
  // 用户已经打开界面，取消托盘闪烁提醒
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
    const host = uiHost;
    if (host) host.sendToWebviewView(host.webviewHandleFor(target), { type: 'focusInput' });
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

/** 提醒（托盘图标）闪烁的间隔（毫秒） */
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
 * 是否有正在进行的“任务结束”提醒（仅闪烁托盘图标）。
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
    // 兜底：窗口/应用重新获得焦点后立即停止闪烁并恢复静态图标。
    // 正常情况下 focus 事件已调用 cancelAttention，这里防止事件丢失导致
    // 有焦点时仍持续闪烁。不复用 cancelAttention 是因为它在 attentionActive
    // 为 false 时会提前返回，可能把图标停在“熄灭”相位。
    if (!isWindowInBackground()) {
      attentionActive = false;
      restoreTrayIcon();
      return;
    }
    visible = !visible;
    tray.setImage(visible ? images.on : images.off);
  }, TRAY_BLINK_INTERVAL_MS);
  return true;
}

/**
 * 本应用是否有任一窗口处于前台（拥有焦点）。
 *
 * 不能只看 `mainWindow.isFocused()`：唤醒快捷键设置对话框是带 parent 的独立
 * BrowserWindow，它聚焦时主窗口失去焦点，但用户其实正在使用本应用，此时不应
 * 再闪烁提醒。`BrowserWindow.getFocusedWindow()` 会覆盖主窗口与所有子窗口。
 */
function isAppFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  return !!focused && !focused.isDestroyed();
}

/**
 * 窗口是否处于后台——只有此时任务结束才需要闪烁提醒。
 * 三种情况都算后台：最小化、隐藏到托盘、可见但不在顶层（被其它窗口遮挡
 * 或切到了别的应用，即失去焦点）。只要本应用还有窗口拥有焦点（如快捷键
 * 设置对话框），就算前台，不提醒。
 */
function isWindowInBackground(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  if (mainWindow.isMinimized()) return true;
  if (!mainWindow.isVisible()) return true;
  return !isAppFocused();
}

/**
 * 任务从运行中结束（变为空闲或等待用户确认）且窗口处于后台时的提醒：
 * 只闪烁托盘图标（颜色跟随当前状态：空闲绿点 / 等待黄点），不闪烁窗口 /
 * 任务栏图标——窗口闪烁过于打扰，提醒入口统一收敛到托盘。
 */
function startAttention(status: TrayStatus): void {
  if (!isWindowInBackground()) return;
  attentionActive = true;
  if (tray && !startTrayBlink(status)) restoreTrayIcon();
}

/** 用户打开/还原/聚焦界面后取消提醒（停止托盘闪烁并恢复静态托盘图标） */
function cancelAttention(): void {
  if (!attentionActive) return;
  attentionActive = false;
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
 * 托盘状态点：running / waiting 由 core 的 sessionRuntimeChanged 全量推送，
 * 经 ElectronConversationManager.setStatusListener 到达这里；不再从对话列表推导。
 *
 * 有会话在等待用户确认/提问 → 黄点；有会话运行中 → 红点；全部空闲 → 绿点。
 * 状态未变化时不重建图标（createFromBitmap / resize 有一定开销）。
 *
 * 另外负责“任务结束提醒”：当任务从运行中变为空闲或等待用户确认、且窗口处于
 * 后台（最小化/隐藏/可见但非顶层）时，只闪烁托盘图标，直到用户打开界面。
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
  registerWakeShortcutValue(readWakeShortcutFromSettings());
}

/** 按指定值注册全局唤醒快捷键（先注销旧值）；注册失败静默忽略 */
function registerWakeShortcutValue(shortcut: string): void {
  if (appQuitting) return;
  // 快捷键设置对话框打开期间不注册全局快捷键，避免用户按下的组合键被占用/触发
  if (shortcutDialogSenders.size > 0) return;
  if (registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
  }
  try {
    if (globalShortcut.register(shortcut, () => toggleMainWindowFromTray())) {
      registeredWakeShortcut = shortcut;
      console.log(`[main] Global wake shortcut registered: ${shortcut}`);
    }
  } catch {
    // 静默忽略：快捷键注册失败不影响应用主流程
  }
}

/** 快捷键设置对话框打开：临时注销全局唤醒快捷键，避免用户按下的组合键直接触发唤醒 */
function suspendWakeShortcut(sender: Electron.WebContents): void {
  const senderId = sender.id;
  if (shortcutDialogSenders.has(senderId)) return;
  shortcutDialogSenders.add(senderId);
  // 窗口被销毁（关闭 / 应用退出）时兜底释放，避免快捷键一直处于注销状态
  sender.once('destroyed', () => {
    if (shortcutDialogSenders.delete(senderId) && shortcutDialogSenders.size === 0) {
      resumeWakeShortcutInternal();
    }
  });
  if (shortcutDialogSenders.size === 1 && registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
    console.log('[main] Global wake shortcut suspended while the shortcut dialog is open');
  }
}

/** 所有设置对话框关闭后恢复全局快捷键注册（按最新 settings.json） */
function resumeWakeShortcutInternal(): void {
  if (appQuitting) return;
  registerWakeShortcut();
}

/**
 * 打开唤醒快捷键设置对话框（File - Shortcut...）。
 *
 * 快捷键是 Electron 专属能力（webview 里做不了：页面收不到被系统抢占的组合键，
 * 也没法注销已注册的全局快捷键），因此单独一个对话框：
 * - 打开期间注销当前全局快捷键（suspendWakeShortcut），关闭后按最新 settings.json 恢复
 * - 按键捕获在主进程的 before-input-event 里做，复用 core 的快捷键解析；
 *   页面只负责显示，通过 preload 的 shortcutAPI 通信
 * - 保存时经 `UIHost.updateSettingsJson` 写盘（写 settings.json 是宿主能力），写完后关闭
 */
function openShortcutDialog(): void {
  if (shortcutDialogWindow && !shortcutDialogWindow.isDestroyed()) {
    shortcutDialogWindow.focus();
    return;
  }

  /** 候选快捷键：随用户按键更新，保存时才落盘 */
  let candidate = readWakeShortcutFromSettings();
  let error: string | undefined;

  // 主窗口可见时才挂为子窗口：窗口最小化到托盘时挂隐藏的父窗口会让对话框也显示不出来
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined;
  const win = new BrowserWindow({
    width: 420,
    height: 268,
    ...(parent ? { parent } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: tt('唤醒快捷键', 'Wake Shortcut'),
    icon: path.join(APP_ROOT, 'assets', 'logo.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'shortcutPreload.cjs'),
    },
  });
  shortcutDialogWindow = win;

  const currentState = (): { display: string; error?: string } => ({
    display: formatAcceleratorForDisplay(candidate),
    error,
  });
  const pushState = (): void => {
    if (!win.isDestroyed()) win.webContents.send('shortcut-dialog:state', currentState());
  };
  const closeDialog = (): void => {
    if (!win.isDestroyed()) win.close();
  };

  /**
   * 保存：写 settings.json 是宿主能力（core 只读不写），写盘完成后关闭对话框——
   * 关闭回调按最新 settings.json 重新注册全局快捷键。
   */
  const save = (): void => {
    const normalized = normalizeAccelerator(candidate);
    if (!normalized) {
      error = tt('快捷键无效，请重新设置', 'Invalid shortcut. Please set it again.');
      pushState();
      return;
    }
    if (!uiHost) {
      error = tt('保存失败', 'Failed to save');
      pushState();
      return;
    }
    error = undefined;
    void uiHost.updateSettingsJson((cfg) => {
      cfg.shortcut = normalized;
    })
      .then(() => closeDialog())
      .catch((err: unknown) => {
        console.error('[main] save wake shortcut failed:', err);
        error = tt('保存失败', 'Failed to save');
        pushState();
      });
  };

  // 打开期间注销全局快捷键：否则用户按下的组合键会先触发唤醒
  suspendWakeShortcut(win.webContents);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    event.preventDefault();
    if (input.key === 'Escape') {
      closeDialog();
      return;
    }
    if (input.key === 'Enter') {
      save();
      return;
    }
    const accelerator = acceleratorFromKeyboardEvent({
      code: input.code,
      key: input.key,
      ctrlKey: input.control,
      altKey: input.alt,
      metaKey: input.meta,
      shiftKey: input.shift,
    });
    if (!accelerator) return; // 只按了修饰键，继续等待
    candidate = accelerator;
    error = undefined;
    pushState();
  });

  ipcMain.handle('shortcut-dialog:get-state', () => currentState());
  ipcMain.on('shortcut-dialog:save', save);
  ipcMain.on('shortcut-dialog:cancel', closeDialog);
  win.on('closed', () => {
    ipcMain.removeHandler('shortcut-dialog:get-state');
    ipcMain.removeListener('shortcut-dialog:save', save);
    ipcMain.removeListener('shortcut-dialog:cancel', closeDialog);
    if (shortcutDialogWindow === win) shortcutDialogWindow = undefined;
  });

  win.once('ready-to-show', () => win.show());

  const html = getShortcutDialogHtml({
    isDark: nativeTheme.shouldUseDarkColors,
    locale: app.getLocale().startsWith('zh') ? 'zh' : 'en',
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
        // 唤醒快捷键：Electron 专属能力（最小化到托盘后用该快捷键呼出窗口）
        {
          label: 'Shortcut...',
          click: () => openShortcutDialog(),
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
  // 清除对话列表缓存：切换工作目录后项目对话目录改变，
  // 必须重新从磁盘加载新项目的对话列表，否则侧栏仍显示旧项目的对话
  conversations?.invalidateCachedList();
  try {
    const { resetConversationListCache } = require('../src/core/history/index.js');
    resetConversationListCache();
  } catch (err) {
    console.error('[main] resetConversationListCache error:', err);
  }
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

/**
 * 处理一条来自 webview（原生聊天视图）的消息。
 * 与 extension.ts AssistantViewProvider 的专用消息处理保持一致，
 * 其余消息统一委托给 WebViewUI（复用同一份 WebviewMessageHandler）。
 */
function handleWebviewMessageFromSource(sender: Electron.WebContents, message: any): void {
  if (!message || typeof message.type !== 'string') return;

  const ui = webviewUi;
  if (!ui) return;
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;

  // 用户发出了新对话的第一条消息：该会话开始落盘，不再是「新建但还没发过消息」的对话。
  // 清除该标记后，下次点侧栏「新建」才会创建新的聊天视图，而不是复用这个已有内容的对话。
  if ((message.type === 'sendMessage' || message.type === 'queueMessage') && sessionId) {
    chatViews?.markSessionUsed(sessionId);
  }

  // 视图的会话身份变化时，把临时 new- 视图转为正式会话条目。
  // 只有这两条消息表达「这个视图现在是哪个会话」：
  // - startNewConversation：webview 新建对话（含预热视图激活）
  // - loadConversation：webview 请求加载某个会话（含 switchToSession 触发的自动跳转）
  // 对「key 已经等于 sessionId」的调用，registerSession 是提前返回的空操作。
  if (message.type === 'startNewConversation' || message.type === 'loadConversation') {
    if (sessionId) {
      chatViews?.registerSession(sender, sessionId);
    }
  }

  // webview 内点击子代理/回复/From 链接等跳转到指定会话：新起一个 webview 加载该对话
  if (message.type === 'openConversation') {
    if (sessionId) {
      chatViews?.openConversation(sessionId);
    }
    return;
  }

  // 关闭按钮：卸内存 + 销毁视图走 WebViewUI.closeConversation（与侧栏「关闭」同一入口）。
  // loaded 变化由 ChatViewManager 单独推给侧栏，列表变化由 core 的 conversationListChanged 推。
  if (message.type === 'closeWebview') {
    const closedSessionId = chatViews?.closeViewByWebContents(sender);
    if (closedSessionId) {
      webviewUi?.closeConversation(closedSessionId);
    }
    return;
  }

  // 后台预热视图报告「已挂载」：若它已被切到前台，补发激活消息
  // （用户可能在页面加载完成前就点了「新建」）
  if (message.type === 'prewarmViewReady') {
    chatViews?.handlePrewarmViewReady(sender);
    return;
  }

  // webview 内“打开工作目录”按钮（未设置工作区时的引导）
  if (message.type === 'openWorkspace') {
    void openWorkspaceDialog();
    return;
  }

  // 其余消息统一走 WebViewUI 的共享分发表（requestTheme / requestContextLimit
  // 已收编进 WebviewMessageHandler，按 ctx.sender 定向回包：预热视图等
  // 非活动视图发起的请求也能收到回包）。
  ui.handleWebviewMessage(message, { sender: uiHost?.webviewHandleFor(sender) ?? null }).catch((err: any) => {
    console.error(`[main] handleWebviewMessage error (${message.type}):`, err);
  });
}

function setupIpc(): void {
  ipcMain.on('webview-message', (event, message: any) => {
    handleWebviewMessageFromSource(event.sender, message);
  });

  // ── 侧栏 IPC ──
  // 列表流：纯磁盘元数据（单一来源 loadConversationList；loaded / running / waiting 走各自通道）
  ipcMain.handle('sidebar:get-conversations', async () => {
    // 优先返回最近一次推送的列表快照（ConversationManager.getCachedList），
    // 不再每次拉取都重读磁盘——列表变化本来就会经 conversationListChanged 推送并更新快照。
    const cached = conversations?.getCachedList();
    if (cached) return cached;
    // 尚无快照（刚启动 / 刚切换工作区）：读一次盘（refresh 顺带推送给侧栏并填充快照）
    if (!conversations) return [];
    try {
      await conversations.refresh();
      return conversations.getCachedList() ?? [];
    } catch (err) {
      console.error('[main] sidebar:get-conversations error:', err);
      return [];
    }
  });

  // 视图流：已打开会话集合（owner 是 ChatViewManager）
  ipcMain.handle('sidebar:get-loaded-sessions', () => {
    return chatViews?.getLoadedSessionIds() ?? [];
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
    }
  });

  // ── 侧栏对话操作：删除 / 重命名 / 智能命名 ──
  ipcMain.handle('sidebar:delete-conversation', async (_event, sessionId: string) => {
    try {
      // 宿主只负责「关视图」：对受影响闭包逐个调 WebViewUI.closeConversation
      // （卸内存 + 销毁视图，5.5 节约定顺序）。闭包由 core 的
      // collectConversationClosure 算出——与 deleteConversation 同一条规则，
      // 不再在宿主里重写一遍；删盘与列表广播由 core 的 conversationDeleted
      // 订阅（deleteConversation → conversationListChanged）承担。
      const { loadConversationList, collectConversationClosure } = await import('../src/core/history/index.js');
      const affected = collectConversationClosure(sessionId, await loadConversationList());
      for (const sid of affected) {
        webviewUi?.closeConversation(sid);
      }
      // 删盘（core 消费方：算闭包已由宿主完成，这里只发 root）
      const { requireEventBus } = await import('../src/core/AssistantEventBus.js');
      requireEventBus().emitToCore({ type: 'conversationDeleted', sessionId });
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
      // 标题回推与列表刷新由 core 广播（titleChanged / conversationListChanged）
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
      // 标题回推与列表刷新由 core 广播（titleChanged / conversationListChanged）
      return { ok: true, title };
    } catch (err) {
      console.error('[main] sidebar:smart-name-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });
}

/**
 * 把当前主题直发某个来源视图（did-finish-load 初始化；requestTheme 回包
 * 已收编进 WebviewMessageHandler，不再经过这里）。
 *
 * 后台预热的视图不是活动视图，必须按来源 webContents 直发，否则它会一直停在
 * 「Loading」（webview 的 setTheme 是解除启动 loading 的条件）。
 * 系统主题变化那条路走 `uiHost.onThemeChanged(null)`，广播到所有视图。
 */
function sendThemeToSource(source: Electron.WebContents): void {
  const host = uiHost;
  if (host) host.onThemeChanged(host.webviewHandleFor(source));
}

/**
 * 把上下文限制直发某个来源视图（did-finish-load 初始化）。
 *
 * 读取与组装在 WebViewUI 的共享实现里（与 webview 的 `requestContextLimit` 同一份）；
 * 这里只负责把来源 webContents 包成句柄传进去。
 */
function sendContextLimit(target: Electron.WebContents): void {
  webviewUi?.pushContextLimit(uiHost?.webviewHandleFor(target) ?? null);
}

/**
 * 视图加载完成后补弹 LLM 配置面板（active provider 已配置但缺 apiKey 时）。
 *
 * target 指定时定向到该视图（视图创建完成后的初始化），否则定向到当前活动视图。
 * 配置读取与消息组装在 WebViewUI；这里只触发，且只推一个视图（不广播），
 * 否则打开新对话会把设置面板弹到所有聊天视图。
 */
async function checkAndSendLLMConfig(target?: Electron.WebContents): Promise<void> {
  try {
    const sessionId = target
      ? chatViews?.getKeyByWebContents(target) ?? chatViews?.getActiveSessionId() ?? null
      : chatViews?.getActiveSessionId() ?? null;
    if (!sessionId) return;
    await webviewUi?.showLLMConfigPanel('startup', sessionId);
  } catch (err) {
    console.error('[main] checkAndSendLLMConfig error:', err);
  }
}

/** 初始化 core 层（与 extension.ts activate 对应） */
function initCore(): void {
  const { bootstrapCore, bootstrapSnapshot, shutdownCore } = require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');

  const host = new ElectronUIHost();
  const spinDesign = new ElectronSpinDesign(host);
  const conversationsMgr = new ElectronConversationManager(
    host,
    (channel: string, payload: unknown) => {
      if (sidebarView && !sidebarView.webContents.isDestroyed()) {
        sidebarView.webContents.send(channel, payload);
      }
    },
  );
  conversations = conversationsMgr;
  // 托盘只吃状态流（阶段 3.6）：running / waiting 来自 core 的 sessionRuntimeChanged
  conversationsMgr.setStatusListener((states) => updateTrayStatusFromStates(states));

  // 共享启动接线：locale / 日志 / 总线 / core 侧订阅 / WebViewUI / 历史 / 会话队列 /
  // 等待用户读取器 / 配置目录 / 环境预热 / MCP 残留清理（DEVELOPMENT.md 第 3.5、8.6 节）
  const { ui } = bootstrapCore(host, spinDesign, conversationsMgr, {
    locale: app.getLocale(),
    log: (...args: unknown[]) => {
      console.log('[WebViewUI]', args.map(a => String(a)).join(' '));
    },
    logToConsole: true,
    extensionPath: APP_ROOT,
  });

  host.setMainWindow(mainWindow!);
  host.setSidebarView(sidebarView!);
  host.setChatViewManager(chatViews!);
  host.setWorkspacePath(workspacePath);
  webviewUi = ui;
  uiHost = host;
  // 视图销毁序列（closeView / LRU trim / disposeAll）在销毁视图前只卸内存：
  // 指向 WebViewUI.releaseConversation（不回调 closeConversationView，避免与视图销毁互相回调成环）
  chatViews!.closeConversation = (sessionId: string) => ui.releaseConversation(sessionId);

  console.log(`[bootstrap] ${JSON.stringify(bootstrapSnapshot())}`);
  // 退出路径（will-quit）复用同一份 core 清理入口
  coreShutdown = shutdownCore;
}
