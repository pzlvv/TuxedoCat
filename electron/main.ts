/**
 * PRODUCT_NAME - Electron 主进程入口
 *
 * 职责：
 * 1. 创建主窗口：左侧原生侧栏（对话列表）+ 右侧聊天 WebContentsView（每对话一个标签）
 * 2. 注册 IPC（webview-message）并委托给 WebViewUI（复用同一份 WebviewMessageHandler）
 * 3. 侧栏 IPC：对话列表读写、打开/新建对话、列表变化推送
 * 4. 初始化 core（bootstrapCore：总线 / core 侧订阅 / 宿主环境与工作目录经总线传递）
 * 5. 提供单一图标菜单（添加工作区 / 添加最近的工作区 / 快捷键 / 开发者工具 / 关于 / 退出）；
 *    标题栏「加号」菜单同样带「打开最近的工作区」
 * 6. 多工作目录：打开集合 + 活动项，标题栏标签页，按对话解析工作目录
 *
 * 与 VS Code 扩展的差异点（extension.ts）：
 * - 工作目录由用户添加（VS Code 从 workspaceFolders 获取）；可同时打开多个，标题栏标签页呈现
 * - 对话列表由原生侧栏展示（VS Code 在 webview 内展示）
 * - 文件打开/虚拟文档/Mermaid/Spin 由 UIHost 提供 Electron 实现
 */

import { fileLogger } from '../src/core/Logger.js';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, dialog, WebContentsView, shell, webContents, globalShortcut, Tray, nativeImage, screen, type NativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChatViewManager, SIDEBAR_WIDTH, TITLEBAR_HEIGHT, chatViewBackgroundColor } from './ChatViewManager.js';
import {
  getTitlebarMenuHtml,
  TITLEBAR_MENU_WIDTH,
  TITLEBAR_SUBMENU_WIDTH,
  type TitlebarMenuNode,
} from './titlebarMenuHtml.js';
import { ElectronUIHost } from './ElectronUIHost.js';
import { ElectronSpinDesign } from './ElectronSpinDesign.js';
import { ElectronConversationManager } from './ElectronConversationManager.js';
import { WebViewUI } from '../src/host/WebViewUI.js';
import type { WebviewToHostMessage } from '../src/host/webviewMessages.js';
import { normalizeWorkspacePath, sameWorkspace, dedupeWorkspacePaths } from '../src/host/workspacePaths.js';
import { buildRemoteEndpoint, type RemoteConnectError } from '../src/host/remoteConnect.js';
import {
  parseSshHistory,
  rememberSshEntry,
  removeSshEntry,
  type SshHistoryEntry,
} from '../src/host/sshHistory.js';
import { DirectoryOperationError } from '../src/host/standalone/CoreDaemon.js';
import {
  localWorkspaceRef,
  remoteWorkspaceRef,
  sameWorkspaceRef,
  workspaceRefDisplayPath,
  workspaceRefKey,
  type WorkspaceEndpoint,
  type WorkspaceRef,
} from '../src/host/workspaceRef.js';
import { getChatPlaceholderHtml } from './chatPlaceholderHtml.js';
import { WorkspaceAvailabilityState } from './workspaceAvailability.js';
import {
  parseWorkspaceEntry as parseWorkspaceEntryShared,
  serializeWorkspaceRef as serializeWorkspaceRefShared,
  type SerializedWorkspaceRef,
} from '../src/host/workspaceState.js';

import { createTrayStatusIcon, deriveTrayStatusFromStates, type TrayStatus } from './trayStatusIcon.js';
import { PRODUCT_NAME, EXTENSION_NAME, SETTINGS_FILE_NAME } from '../src/config/project.js';
import { resolveConfigDir } from '../src/config/configDir.js';
import {
  DEFAULT_WAKE_SHORTCUT,
  acceleratorFromKeyboardEvent,
  formatAcceleratorForDisplay,
  normalizeAccelerator,
} from './shortcut.js';
import { tt, onHostLocaleChanged, getHostLocale } from '../src/host/i18n.js';
import { requireEventBus } from '../src/core/AssistantEventBus.js';
import { getShortcutDialogHtml } from './shortcutDialogHtml.js';
import { resolveSmartTitle } from '../src/core/history/smartNaming.js';

/**
 * 判断 URL 是否为需要在系统浏览器打开的外部链接。
 * 内部链接（应用自身 file:// 页面、相对路径）不算外部链接。
 */
function isExternalUrl(targetUrl: string): boolean {
  return /^(https?|mailto|tel):/i.test(targetUrl);
}

/**
 * 应用自有 WebContentsView 的导航防御（与侧栏 / 聊天视图同策略）：
 * 拒绝一切 window.open，应用内 file:// 导航放行，其余一律拦下并交给系统浏览器。
 *
 * 标题栏 / 菜单视图虽然只加载本地文件与 data: URL，但页面一旦被拖放或脚本导航到
 * 外部页面，preload 会在新页面重跑、把 titlebarAPI / titlebarMenuAPI 交给外部页面，
 * 外部页面即可调用菜单动作（含退出）。这里补上第二道防线。
 */
function guardViewNavigation(wc: Electron.WebContents): void {
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl).catch((err) => {
        console.error(`[view] Failed to open external URL (window.open): ${err}`);
      });
    }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('file://')) return; // 应用内导航放行
    event.preventDefault();
    if (isExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl).catch((err) => {
        console.error(`[view] Failed to open external URL (navigate): ${err}`);
      });
    }
  });
}

/**
 * 加载自绘标题栏页面。
 *
 * 失败时只留一条日志的后果很严重：无边框窗口（Windows/Linux）没有系统标题栏，
 * 用户既不能拖动也不能最小化/关闭。这里延迟重试一次（覆盖「构建产物还没落盘」的
 * 开发期场景），并在日志里给出可执行的修复命令。
 */
function loadTitlebarView(wc: Electron.WebContents): void {
  const file = path.join(APP_ROOT, 'dist', 'titlebar', 'index.html');
  let retried = false;
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[titlebar] load failed: ${code} ${desc} (${url})`);
    if (retried) return;
    retried = true;
    // 开发期最常见的原因是 dist/titlebar 还没构建（见 scripts/watch-app.js）：
    // 延迟重试一次，给构建脚本一点落盘时间。注意 Electron 无法在运行期给窗口加回系统
    // 边框，所以这里没有「降级为带边框窗口」的兜底，只能重试 + 明确报错。
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      wc.loadFile(file).catch((err) => {
        console.error('[titlebar] retry failed; run `npm run build:titlebar`:', err);
      });
    }, 800);
  });
  void wc.loadFile(file).catch((err) => {
    console.error('[titlebar] loadFile rejected; run `npm run build:titlebar`:', err);
  });
}

/**
 * 菜单项定义：原生菜单（macOS 系统菜单栏 / 平台约定）与自绘标题栏菜单的唯一来源。
 * 两处共用同一份定义与同一批动作，避免「原生能点、自绘点不了」这类不一致。
 */
interface MenuItemDef {
  /** 菜单项唯一 id（自绘菜单点击与快捷键兜底都按 id 找动作） */
  id?: string;
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  /** 自绘菜单里的危险色（如删除/退出类） */
  danger?: boolean;
  /**
   * 菜单项类型：
   * - separator 分隔线
   * - radio / checkbox 可勾选项（原生菜单用对应类型，自绘菜单画勾）
   */
  type?: 'separator' | 'radio' | 'checkbox';
  /** radio / checkbox 是否选中 */
  checked?: boolean;
  /** 子菜单：原生菜单保留层级，自绘菜单平铺为 header + items */
  submenu?: MenuItemDef[];
  /** macOS 原生菜单角色（与 run 二选一，role 优先） */
  role?: Electron.MenuItemConstructorOptions['role'];
  run?: () => void;
}

/** 菜单分区（File / View / Help ...） */
interface MenuSectionDef {
  id: string;
  label: string;
  items: MenuItemDef[];
}

/** 自绘下拉菜单的分区（items 已平铺为展示节点） */
interface TitlebarMenuSection {
  id: string;
  label: string;
  items: TitlebarMenuNode[];
}

let mainWindow: BrowserWindow | undefined;
let sidebarView: WebContentsView | undefined;
/** 顶部自绘标题栏（品牌区 + 菜单按钮 + 窗口控制按钮） */
let titlebarView: WebContentsView | undefined;
let chatViews: ChatViewManager | undefined;
/**
 * 自绘下拉菜单视图（主窗口内的 WebContentsView，按需创建后复用）。
 *
 * 刻意不用独立 BrowserWindow：窗口 show()/focus() 会触发系统窗口动画与
 * 层级窗口合成，表现为菜单「闪一下」；视图只是同一窗口内的一块合成区域，
 * 定位即显示，没有任何开窗动画。
 */
let titlebarMenuView: WebContentsView | undefined;
/** 当前打开的下拉菜单分区 id（null = 未打开） */
let titlebarMenuOpenId: string | null = null;
/** 菜单视图里当前渲染的分区 id（用于判断是否需要重新 loadURL） */
let titlebarMenuLoadedId: string | null = null;
/** 菜单测量结果缓存（分区 id → 尺寸与左偏移），命中后再次打开无需重新测量 */
const titlebarMenuSizeCache = new Map<string, { width: number; height: number; offsetX: number }>();
/** 下拉菜单左边缘（相对内容区，由标题栏视图上报） */
let titlebarMenuAnchorX = 0;
/**
 * 打开菜单前持有焦点的视图 id。菜单视图会主动获取焦点（Esc / 方向键依赖它），
 * 关闭时把焦点还回去，否则焦点会停在已隐藏的菜单视图上，用户敲键盘没反应。
 */
let titlebarMenuPrevFocusId: number | undefined;
/** 标题栏菜单分区（子菜单已平铺为展示项） */
let titlebarMenuSections: TitlebarMenuSection[] = [];
/** 菜单项 id → 动作（原生菜单与自绘菜单共用同一份） */
let titlebarMenuActions = new Map<string, () => void>();
/** 规范化 accelerator → 菜单项 id（无边框窗口下兜底处理快捷键） */
let titlebarMenuAccelerators = new Map<string, string>();
/** 同一次按键可能同时触发原生菜单与兜底处理，按 id 去重 */
const recentMenuActionAt = new Map<string, number>();

/**
 * 窗口模式：
 * - normal：完整模式，左侧多对话侧栏 + 右侧聊天视图，对话列表由原生侧栏渲染
 * - floating：悬浮窗模式，隐藏侧栏、对话列表移到 webview 顶栏，可置顶
 * 视图模式不随窗口模式变化：Electron 恒为多视图（每会话一个 webview），浮窗只换
 * 列表 / 新建入口的渲染方（见 src/host/types.ts 的 HostInfo）。
 * 两种模式的位置与尺寸各自独立存储（见 readSavedWindowRect / saveWindowRect）。
 */
type WindowMode = 'normal' | 'floating';
let windowMode: WindowMode = 'normal';
/** 浮窗模式是否总在最前（浮窗专属；默认开启，符合「悬浮窗」语义） */
let floatingPinned = true;
/** 模式切换进行中（applyWindowMode 含 await）：用于防重入 */
let windowModeSwitching = false;
/** 对话列表的读取与分发（bootstrap 创建；sidebar:get-conversations 读它的列表快照） */
let conversations: ElectronConversationManager | undefined;
/**
 * 打开集合：已打开的工作区引用，按标签页顺序排列（进程内事实）。
 *
 * 本地与远程同构（`docs/client-connection.md` 第 4 节）：本地 `endpoint === null`，
 * 远程带 `{ host, port, user, auth }`。标签页 / 侧栏用 `workspaceRefKey` 作稳定 id。
 */
let openWorkspaces: WorkspaceRef[] = [];
/** 活动工作区（打开集合中的一项；集合为空时 undefined） */
let workspacePath: WorkspaceRef | undefined;
/** 会话 → 工作目录 索引：按对话解析工作目录（打开某个对话时用它注入 --workspace=） */
const sessionWorkspaces = new Map<string, string>();
/** 工作区打开 / 关闭 / 激活的订阅者（ElectronUIHost 的 WorkspaceProvider 契约） */
const workspaceChangeListeners = new Set<(change: { type: 'opened' | 'closed' | 'activated'; ref: WorkspaceRef }) => void>();

/** 工作区引用的稳定 id（跨进程 IPC 与标签页身份用） */
function refKey(ref: WorkspaceRef): string {
  return workspaceRefKey(ref);
}

/** 建链探测超时（启动恢复与重新连接共用）：用户等待失败信号的上限 */
const CONNECT_PROBE_TIMEOUT_MS = 3_000;

/** 工作区引用的展示路径（本地即路径，远程带 `tcp://host` 前缀） */
function refDisplay(ref: WorkspaceRef): string {
  return workspaceRefDisplayPath(ref);
}

/** 在打开集合里按引用判等查找（同一目标的同一目录视为同一项） */
function findWorkspace(ref: WorkspaceRef): WorkspaceRef | undefined {
  return openWorkspaces.find((candidate) => sameWorkspaceRef(candidate, ref));
}

/**
 * 工作目录的规范化口径（`docs/client-connection.md` 第 4 节）。
 *
 * 本地路径按宿主口径规范化（大小写 / 尾分隔符）；**远程路径是目标机器上的字符串，
 * 原样保留**——对 `/home/pz/proj` 跑本地规范化会得到 `D:\home\pz\proj`，之后按路径
 * 找 Connection、注入 `--workspace=` 全都对不上（表现为远端工作区发消息没有响应）。
 */
function canonicalWorkspacePath(target: string): string {
  const remote = openWorkspaces.find((ref) => ref.endpoint !== null && ref.path === target);
  return remote ? remote.path : normalizeWorkspacePath(target);
}

/** 工作目录路径是否属于该引用（本地按宿主口径判等，远程逐字比较） */
function workspacePathMatches(ref: WorkspaceRef, target: string): boolean {
  return ref.endpoint ? ref.path === target : sameWorkspace(ref.path, target);
}

/** 两个可能为空的工作区引用是否指向同一项（都为空视为相同） */
function sameRef(a: WorkspaceRef | undefined, b: WorkspaceRef | undefined): boolean {
  if (!a || !b) return a === b;
  return sameWorkspaceRef(a, b);
}

/** 通知工作区变化（Client 据此建立 / 销毁 Connection） */
function emitWorkspaceChange(type: 'opened' | 'closed' | 'activated', ref: WorkspaceRef): void {
  for (const listener of [...workspaceChangeListeners]) {
    try {
      listener({ type, ref });
    } catch (err) {
      console.error('[main] workspace change listener error:', err);
    }
  }
}

/**
 * 标签页连接状态机（available / unavailable / connecting 三态，按去重键）。
 *
 * 三态流转规则与「落定不可用必须清建链中」的时序不变量见 `workspaceAvailability.ts`
 * 模块头注释；这里只保留 Electron 侧的使用口径：
 * - 不可用的工作区**保留在打开集合里**：标签页照常显示并带红点，可以点击激活——
 *   但聊天区不显示对话列表与 webview，改显占位页（`syncChatAreaForActiveWorkspace`），
 *   远程不可连时占位页提供「重新连接」按钮。不为它建立 Connection
 *   （`getOpenWorkspaceRefs` 过滤掉）。只在启动期判定——运行期新增的工作区
 *   在添加入口已验证过，默认可用。
 */
const workspaceAvailabilityState = new WorkspaceAvailabilityState();

/** 工作区当前是否可用（未在启动期被判定为不可用） */
function isWorkspaceAvailable(ref: WorkspaceRef): boolean {
  return workspaceAvailabilityState.isAvailable(refKey(ref));
}

/** 标签页连接状态：available 可用 / unavailable 不可用（红点）/ connecting 建链中（黄色呼吸点） */
function workspaceAvailability(ref: WorkspaceRef): 'available' | 'unavailable' | 'connecting' {
  return workspaceAvailabilityState.availabilityOf(refKey(ref));
}

/**
 * 启动期判定为不可用的工作区，若不可用的原因已消失则恢复可用并返回 true。
 * 本地目录重新存在即恢复；远程的可达性由调用入口验证（本地 / 远程目录选择器都
 * 只提交已验证的目标，「最近打开」点击没有验证、不恢复）。恢复后由调用方补发
 * opened 建立 Connection，否则激活后是一个没有 Core 的空壳工作区。
 */
function reviveWorkspaceIfRecovered(ref: WorkspaceRef): boolean {
  const key = refKey(ref);
  if (workspaceAvailabilityState.availabilityOf(key) !== 'unavailable') return false;
  if (ref.endpoint === null && !isValidWorkspaceDir(ref.path)) return false;
  workspaceAvailabilityState.revokeUnavailable(key);
  return true;
}
/** 当前 WebViewUI 实例（initCore 创建；消息路由 / 工作区切换使用） */
let webviewUi: WebViewUI | undefined;
/** core 侧进程级资源的释放入口（initCore 从共享骨架取得；will-quit 调用） */
let coreShutdown: (() => Promise<void>) | undefined;
/** 当前宿主实现（initCore 创建） */
let uiHost: ElectronUIHost | undefined;
/**
 * 当前生效的主题模式（内存事实）。
 * 启动时从 settings.json 载入，菜单里切换后立即更新——菜单勾选态据此渲染，
 * 不直接读盘：写盘是异步队列，读盘可能读到尚未落盘的旧值。
 */
let currentThemeMode: ThemeMode = 'system';
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

/**
 * 隐藏的多实例开关（不对外公开，仅供本地测试）。
 *
 *   --multi-instance           随机实例后缀
 *   --multi-instance=<id>      指定实例后缀（便于脚本重复启动同一实例）
 *
 * 命中时跳过单实例锁，并把 userData 隔离到 `<EXTENSION_NAME>-multi-<id>`：
 * 多开时 Chromium 的 profile 与窗口位置 / 工作目录状态都在同一份 userData 里，
 * 不隔离会互相覆盖。注意对话与 settings.json 仍在用户主目录的共享配置目录下，
 * 多实例共用（测试时留意并发写）。
 *
 * 同一 `<id>` 并发启动仍会共用同一份 userData（profile / 窗口状态互相覆盖），
 * 固定 id 只用于「跨次启动保留状态」；并发多开请用不同 id。
 */
const multiInstanceArg = process.argv.find(
  (a) => a === '--multi-instance' || a.startsWith('--multi-instance='),
);
const multiInstance = multiInstanceArg !== undefined;
/** 多实例后缀：显式 <id> 取过滤后的值，否则用短随机串（同一次启动内稳定） */
const multiInstanceSuffix = (() => {
  if (!multiInstance) return '';
  const explicit = multiInstanceArg!.startsWith('--multi-instance=')
    ? multiInstanceArg!.slice('--multi-instance='.length)
    : '';
  const safe = explicit.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return safe || crypto.randomBytes(3).toString('hex');
})();

/**
 * 统一 userData 目录（工作目录状态 / 窗口位置 / 缓存都落在这里）。
 *
 * 不指定时 Electron 按应用名推导：开发态用 `electron dist-electron/main.cjs` 启动时
 * 应用名是默认的 "Electron"，打包态是 productName（含空格），两者会落到不同目录。
 * 这里显式指向配置里的应用目录名（`src/config/project.json` 的 extensionName），
 * 保证开发态与打包态读写同一份状态。必须在 `app.whenReady()` 之前设置。
 *
 * --multi-instance 时追加实例后缀，让每个实例有独立 userData。
 */
app.setPath(
  'userData',
  path.join(
    app.getPath('appData'),
    multiInstance ? `${EXTENSION_NAME}-multi-${multiInstanceSuffix}` : EXTENSION_NAME,
  ),
);

// 单实例锁：避免多开导致会话文件冲突（--multi-instance 测试开关命中时跳过）
if (multiInstance) {
  void main();
} else {
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
}

async function main(): Promise<void> {
  await app.whenReady();

  // ── 宿主本地状态（userData/workspace-state.json）──
  // 旧版本的状态文件（旧 userData 目录 / lastWorkspace 字段）在这里一次性迁移；
  // 旧版本写在 core settings.json 里的 theme / shortcut 也在这里搬进状态文件。
  migrateLegacyWorkspaceState();
  migrateLegacyThemeAndShortcut();

  // ── 宿主语言 ──
  // 在创建任何原生 UI（托盘 / 菜单 / 标题栏）之前先把界面语言收敛进进程内 i18n。
  // 共享骨架 bootstrapCore 里也会做同一步，但它在 initCore() 时才跑，而托盘在
  // initCore() 之前就已创建；提前到这里，托盘 / 菜单从第一帧就用对语言。
  primeHostLocaleForStartup();

  // ── 主题 ──
  // 读取宿主本地偏好（workspace-state.json 的 theme 字段，默认跟随系统）并应用。
  // themeSource 同时驱动原生配色与所有渲染进程的 prefers-color-scheme，
  // 自绘标题栏 / 侧栏据此切浅色样式；聊天 webview 由 setTheme 消息单独同步。
  // 必须在 createMainWindow 之前设置：窗口 backgroundColor 按当前主题取值。
  currentThemeMode = readThemeModeSync();
  nativeTheme.themeSource = currentThemeMode;

  // ── 工作目录 ──
  // 不默认使用当前工作目录：恢复上次打开的打开集合与活动项；
  // 命令行 --workspace= 作为额外的一项加入打开集合并置为活动项。
  // 保存的活动项不可用（本地目录不存在）或建链中（远程探测未落定）时**保持为活动项**：
  // 聊天区由 `syncChatAreaForActiveWorkspace` 改显占位页，不回退到别的标签页
  // （远程可达性由 initCore 之后的探测异步判定，10 秒超时）。
  openWorkspaces = readOpenWorkspaces();
  // 远程工作区从启动起进入建链中（黄色呼吸点）：可达性由 initCore 之后的探测落定
  for (const ref of openWorkspaces) {
    if (ref.endpoint) workspaceAvailabilityState.markConnecting(refKey(ref));
  }
  workspacePath = readActiveWorkspace(openWorkspaces);
  const cliWorkspace = process.argv.find((a) => a.startsWith('--workspace='));
  if (cliWorkspace) {
    const cliPath = cliWorkspace.slice('--workspace='.length);
    if (isValidWorkspaceDir(cliPath)) {
      // 与 addWorkspaces 同一口径：规范化 + 按去重键判等，避免同一目录的不同写法
      // 变成两张标签页（也避免原始路径与视图登记值不一致导致切标签时找不到视图）
      const ref = localWorkspaceRef(cliPath);
      const existing = findWorkspace(ref);
      // CLI 显式指定且目录存在：启动期对它的不可用判定作废（若此前有过）
      if (existing) reviveWorkspaceIfRecovered(existing);
      if (!existing) openWorkspaces.push(ref);
      workspacePath = existing ?? ref;
      rememberRecentWorkspace(ref);
      saveOpenWorkspaces(openWorkspaces, workspacePath);
    }
  }

  createMainWindow();
  setupTray();
  // 系统主题变化时同步所有聊天视图（只注册一次，避免菜单重建时重复注册）。
  // onThemeChanged(null) 广播而不是只发活动视图：隐藏的对话视图与后台预热视图
  // 同样要更新，否则它们被切回前台时会带着过期的主题。
  // 跟随系统时 OS 切换也会走这里，因此一并刷新窗口 / 视图的兜底背景色。
  nativeTheme.on('updated', () => {
    uiHost?.onThemeChanged(null);
    chatViews?.setBackgroundColor(chatViewBackgroundColor());
    mainWindow?.setBackgroundColor(windowBackgroundColor());
    // 自绘菜单的配色是生成 HTML 时烘进内联样式的，且打开时命中缓存直接复用页面；
    // 不在这里作废的话，跟随系统模式下 OS 切换主题后菜单仍会显示旧配色。
    closeTitlebarMenu();
    invalidateTitlebarMenuCache();
  });
  setupIpc();
  initCore();
  // 启动探测上一次打开的远程工作区可达性（连接已在 initCore 里发起，这里等结果）；
  // 连不上的 endpoint 对应标签页标红点并禁选，活动项随之回退
  probeStartupRemoteWorkspaces();
  // 宿主语言已在 main 开头（primeHostLocaleForStartup）与 bootstrapCore 里收敛好，
  // 这里建菜单一定拿到正确语言。运行期在设置面板改语言不会自动重建，订阅语言变化补一次：
  // 主菜单与托盘右键菜单（系统菜单）都要跟着换语言。
  onHostLocaleChanged(() => {
    setupMenu();
    refreshTrayLocale();
  });
  setupMenu();
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
    // core 侧的进程级资源（MCP 子进程 / Standalone Core 进程）统一由共享骨架释放；
    // Standalone 下关闭 Core 进程需要一点时间，此处不阻塞退出——Core 也会在
    // 标准输入关闭（EOF）时自行退出。
    void coreShutdown?.();
  });
}

/** 主窗口默认宽度（无历史尺寸时使用） */
const DEFAULT_WINDOW_WIDTH = 1280;
/** 主窗口最小尺寸（与 BrowserWindow 的 minWidth/minHeight 保持一致） */
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;
/** 浮窗默认宽度；高度取工作区高度的 80% */
const FLOATING_WINDOW_WIDTH = 480;
/** 浮窗最小尺寸（窄窗，允许用户继续收窄） */
const MIN_FLOATING_WIDTH = 280;
const MIN_FLOATING_HEIGHT = 240;

/**
 * 最近一次由程序设置的目标窗口矩形（创建窗口 / 切换模式时记录）。
 *
 * Windows 会对无边框窗口做 1~4 DIP 的尺寸微调（请求 1294 实际得到 1296）；
 * 若把微调后的实际值落盘、下次再按它请求，尺寸会逐次变大。落盘时若实际值与
 * 目标值偏差很小就用目标值，用户真正拖动/缩放产生的大偏差仍按实际值保存。
 */
let lastRequestedWindowRect: { x: number; y: number; width: number; height: number } | undefined;
/** 视为「OS 微调」而非「用户改动」的最大偏差（DIP） */
const WINDOW_RECT_DRIFT_TOLERANCE = 8;

function createMainWindow(): void {
  // 防止 second-instance / activate 与启动流程并发创建出多个主窗口
  if (mainWindow && !mainWindow.isDestroyed()) return;
  // 模式优先沿用上次退出时的：只有「上次是浮窗」且本次确实打开了工作区才恢复浮窗
  // （浮窗隐藏侧栏，没有工作区就没法再选，因此这种情况下退回完整模式）
  windowMode = readLastWindowMode() === 'floating' && canToggleWindowMode() ? 'floating' : 'normal';
  // 「总在最前」同样沿用上次的（默认开启）
  floatingPinned = readLastFloatingPinned();

  // 尺寸与位置优先用该模式上次退出时保存的值（存在 workspace-state.json）；
  // 没有记录时才用默认值：高度取主屏工作区（已排除任务栏/Dock）的 80%，
  // 不写死，大屏不会过高、小屏也不会超出可视区域。宽度保持固定默认值。
  const primaryWorkArea = screen.getPrimaryDisplay().workAreaSize;
  const savedRect = readSavedWindowRect(windowMode);
  const fallbackRect = windowMode === 'floating'
    ? defaultFloatingWindowRect()
    : { width: DEFAULT_WINDOW_WIDTH, height: Math.round(primaryWorkArea.height * 0.8) };
  const targetWidth = savedRect ? savedRect.width : fallbackRect.width;
  const targetHeight = savedRect ? savedRect.height : fallbackRect.height;
  // 位置：只有旧坐标仍落在某个显示器工作区内才复用，否则交给 Electron 居中
  const savedPosition =
    savedRect && savedRect.x !== undefined && savedRect.y !== undefined
    && isRectVisibleOnSomeDisplay({ x: savedRect.x, y: savedRect.y, width: targetWidth, height: targetHeight })
      ? { x: savedRect.x, y: savedRect.y }
      : {};
  const isMac = process.platform === 'darwin';
  const minSize = minWindowSizeFor(windowMode);
  // 夹取用「窗口实际会落在的那块屏」的工作区，而不是主屏：
  // 上次停在较小的副屏时，按主屏高度建窗会让窗口大面积超出副屏可视区。
  const targetDisplay = savedPosition.x !== undefined
    ? screen.getDisplayMatching({ x: savedPosition.x, y: savedPosition.y, width: targetWidth, height: targetHeight })
    : screen.getPrimaryDisplay();
  const { width: workAreaWidth, height: workAreaHeight } = targetDisplay.workAreaSize;
  const windowWidth = Math.max(minSize.width, Math.min(targetWidth, workAreaWidth));
  const windowHeight = Math.max(minSize.height, Math.min(targetHeight, workAreaHeight));
  mainWindow = new BrowserWindow({
    ...savedPosition,
    width: windowWidth,
    height: windowHeight,
    minWidth: minSize.width,
    minHeight: minSize.height,
    title: windowTitleForCurrentState(),
    icon: path.join(APP_ROOT, 'assets', 'logo.png'),
    backgroundColor: windowBackgroundColor(),
    show: false,
    // ── 自绘标题栏 ──
    // Windows/Linux：去掉系统边框（同时去掉系统标题栏与系统菜单栏），
    // 由顶部 WebContentsView 自绘品牌区 / 菜单 / 最小化-最大化-关闭按钮。
    // macOS：保留系统红绿灯与系统菜单栏（平台约定），只隐藏标题栏文字。
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 13 } }
      : { frame: false }),
  });
  // 记录目标矩形：尺寸用请求值（抵消 OS 微调），位置没有记录时用居中后的实际值
  const createdBounds = mainWindow.getBounds();
  lastRequestedWindowRect = {
    x: savedPosition.x ?? createdBounds.x,
    y: savedPosition.y ?? createdBounds.y,
    width: windowWidth,
    height: windowHeight,
  };
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

  // 完整模式最小化走系统默认行为：窗口最小化到任务栏并保留任务栏图标。
  // 浮窗模式最小化改走「隐藏到系统托盘」：最小化后立即 hide()，
  // 隐藏的窗口不在任务栏保留按钮；唤醒入口是托盘图标（单击 / 双击）与全局快捷键
  // （标题栏最小化按钮在 IPC 处已直接走 hide()，这里覆盖系统级最小化路径）。
  // 用户手动切换窗口/隐藏时，取消“再按一次回托盘”的切换态；
  // 下次按快捷键应重新把窗口唤到前台，而不是直接隐藏。
  mainWindow.on('minimize', () => {
    if (windowMode !== 'floating') return;
    mainWindow?.hide();
  });
  mainWindow.on('blur', () => {
    wakeToggleActive = false;
    // 整个窗口失活（切到别的应用）：已打开的下拉菜单一并关掉
    closeTitlebarMenu();
  });
  mainWindow.on('hide', () => {
    wakeToggleActive = false;
    closeTitlebarMenu();
  });

  // ── 窗口位置与大小持久化 ──
  // 位置与尺寸都落盘，且完整模式 / 浮窗模式各存一份（见 saveWindowRect）。
  // resize 在拖拽过程中会高频触发，防抖到停止调整后再写盘；close 时补一次，
  // 避免最后一次调整因防抖未触发而丢失。
  const win = mainWindow;
  let sizeSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistWindowRect = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    // 最大化/全屏时用 normal bounds，保存的是还原后的位置与尺寸，而不是铺满屏幕的
    // 按当前模式分别存储：完整模式与浮窗模式的位置/尺寸互不覆盖
    saveWindowRect(windowMode, resolvePersistableWindowRect(win.getNormalBounds()));
  };
  win.on('resize', () => {
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(persistWindowRect, 2000);
    // 窗口尺寸变化会让已打开菜单的定位失效，直接关掉（与原生菜单一致）
    closeTitlebarMenu();
    // 菜单页的 maxHeight / availableRight 在 loadURL 时烘进 HTML，尺寸缓存必须一起作废：
    // 否则缩小窗口后重开菜单会命中缓存不重载，菜单按旧高度布局、超出部分被视图裁掉。
    invalidateTitlebarMenuCache();
  });
  // 位置变化同样要落盘（拖拽移动窗口后切换模式要能还原）
  win.on('move', () => {
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(persistWindowRect, 2000);
    // 窗口被拖动后菜单的锚点失效，直接关掉（与原生菜单一致）
    closeTitlebarMenu();
  });
  win.on('close', () => {
    if (sizeSaveTimer) {
      clearTimeout(sizeSaveTimer);
      sizeSaveTimer = undefined;
    }
    persistWindowRect();
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
  // 焦点移到侧栏（点了对话列表/工作区）：关掉标题栏下拉菜单
  sidebarView.webContents.on('focus', () => closeTitlebarMenu());

  // 渲染进程崩溃/GPU 异常时恢复侧栏显示
  sidebarView.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[sidebar] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
      setTimeout(() => {
        // webContents 可能已随视图销毁变为 undefined（同 ChatViewManager 的视图销毁竞态）
        const wc = sidebarView?.webContents as Electron.WebContents | undefined;
        if (!wc || wc.isDestroyed()) return;
        if (wc.isCrashed()) wc.reload();
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
  // 无边框窗口下原生菜单栏不再绘制，菜单快捷键用 before-input-event 兜底
  sidebarView.webContents.on('before-input-event', handleMenuAccelerator);

  // ── 顶部自绘标题栏 ──
  // 独立 WebContentsView 占满窗口顶部：模式切换 + 品牌区 + 菜单按钮 + 窗口控制按钮。
  // 下拉菜单不画在这里（会被视图 bounds 裁掉），由另一个 WebContentsView 承载，见 openTitlebarMenu。
  titlebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'titlebarPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 contextBridge/ipcRenderer，页面是本地静态文件，开沙箱即可
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.contentView.addChildView(titlebarView);
  loadTitlebarView(titlebarView.webContents);
  guardViewNavigation(titlebarView.webContents);
  titlebarView.webContents.on('before-input-event', handleMenuAccelerator);
  // 刻意不监听标题栏的 blur 来关菜单：显示菜单视图会让焦点重新计算（可能变成
  // 「无焦点视图」），据此关菜单会让菜单刚弹出就被自己关掉。关闭触发点改为：
  // 侧栏 / 聊天视图获得焦点（点了别处）、窗口失活、窗口移动或缩放、Esc、点标题栏空白。

  // 最大化 / 全屏状态变化推给标题栏（切换「最大化 / 还原」按钮图标）
  const pushTitlebarWindowState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    sendToTitlebar('titlebar:window-state', { maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('maximize', pushTitlebarWindowState);
  mainWindow.on('unmaximize', pushTitlebarWindowState);
  mainWindow.on('enter-full-screen', pushTitlebarWindowState);
  mainWindow.on('leave-full-screen', pushTitlebarWindowState);

  // ── 右侧聊天视图管理器 ──
  let uiLanguage: 'auto' | 'zh' | 'en' = 'auto';
  let uiFontSize: 'medium' | 'large' | 'xlarge' = 'medium';
  let highlightLanguages: string[] = [];
  try {
    // UI 专属字段（界面语言 / 界面字号 / 高亮语言）归宿主：读宿主自己的 settings.json 快照
    // （`docs/core-ui-separation.md` 第 4.8 / 4.9 节），不问 core。
    const { getSettingsStore } = require('../src/host/SettingsStore.js') as typeof import('../src/host/SettingsStore.js');
    const settingsStore = getSettingsStore();
    // createMainWindow 在 initCore 之前：首帧语言 / 字号 / 高亮语言要先拿到，所以这里先读盘。
    // initCore 里的 loadSync 会再读一次（幂等），不会漏掉之后的改动。
    settingsStore.loadSync();
    uiLanguage = settingsStore.readUiLanguage();
    uiFontSize = settingsStore.readUiFontSize();
    // Shiki 语法高亮全部按需加载：注入上次已使用过的语言，webview 启动后后台预热
    highlightLanguages = settingsStore.readHighlightLanguages();
  } catch { /* 读取失败时使用 auto（跟随系统语言） */ }
  chatViews = new ChatViewManager({
    win: mainWindow,
    appRoot: APP_ROOT,
    preloadPath: path.join(__dirname, 'preload.cjs'),
    chatPlaceholderPreloadPath: path.join(__dirname, 'chatPlaceholderPreload.cjs'),
    workspacePath: workspacePath?.path ?? '',
    locale: app.getLocale(),
    systemLocale: getSystemLocaleForStartup(),
    uiLanguage,
    uiFontSize,
    highlightLanguages,
    // 聊天视图整体下移，给顶部自绘标题栏让位
    topInset: TITLEBAR_HEIGHT,
    // 对话列表渲染方随窗口模式推导：悬浮窗隐藏原生侧栏，列表改由 webview 顶栏渲染
    // （视图模式不变，Electron 恒为多视图）
    conversationListOwner: windowMode === 'floating' ? 'webview' : 'host',
    onActiveSessionChanged: (sessionId) => {
      sidebarView?.webContents.send('sidebar:active-session-changed', sessionId);
      // 同步 UI 侧的「当前活跃会话」：切到已打开的视图不会再走 loadConversation /
      // startNewConversation，不同步的话按会话解析的数据（project skills / MCP 启用
      // 列表）会停在旧视图，取到别的标签页的工作目录。
      webviewUi?.setActiveSessionId(sessionId ?? undefined);
    },
    onLoadedChanged: (sessionIds) => {
      // 视图层「已打开会话」集合单独推送（不并入对话列表流），见 DEVELOPMENT.md 第 5.4 节
      sidebarView?.webContents.send('sidebar:session-loaded-changed', sessionIds);
      // 同步 UI 侧的「已打开会话」集合：UserChoiceQueue 据此判定待答请求能否投递
      // （open 即投递到该会话自己的视图；open 与 active/selected 是两个概念）
      webviewUi?.setOpenSessions(sessionIds);
    },
    onViewCreated: (view) => {
      // 无边框窗口下原生菜单栏不再绘制，菜单快捷键用 before-input-event 兜底
      view.webContents.on('before-input-event', handleMenuAccelerator);
      // 焦点移到聊天视图：关掉标题栏下拉菜单
      view.webContents.on('focus', () => closeTitlebarMenu());
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
          // 视图可能在这 1 秒内被销毁（关闭对话 / 切工作区销毁预热视图）：
          // webContents.close() 后 WebContentsView.webContents 变为 undefined
          // （类型标注已不反映运行时），配置检查对死视图无意义，直接跳过——
          // 设计允许的瞬时状态，同一会话之后新建的视图有自己的本定时器兜底。
          const wc = view.webContents as Electron.WebContents | undefined;
          if (!wc || wc.isDestroyed()) return;
          if (chatViews?.isPrewarmWebContents(wc)) return;
          void checkAndSendLLMConfig(wc);
        }, 1000);
      });
    },
  });

  // 布局模式已由构造参数 conversationListOwner 决定（浮窗启动即隐藏侧栏），无需再补一次

  // 初始对齐聊天区：活动工作区可用 → 打开新对话（无工作目录时空态视图）；
  // 建链中 / 不可用 → 占位页（远程建链 10 秒超时后转「无法连接」+ 重连按钮）
  syncChatAreaForActiveWorkspace();

  // 首次启动：为非活动的工作目录各预加载一个聊天视图，点标签页时直接 show()，
  // 不再现建视图 + 等页面加载（消除首次切换的闪烁）。
  // 错开创建，避免启动瞬间同时拉起多个渲染进程造成卡顿。
  openWorkspaces
    .filter((ref) => isWorkspaceAvailable(ref)
      && !(workspacePath && sameWorkspaceRef(ref, workspacePath)))
    .forEach((ref, index) => {
      setTimeout(() => {
        // 定时器触发时该目录可能已被关闭：仍在打开集合里才预加载
        if (findWorkspace(ref)) chatViews?.preloadWorkspace(ref.path);
      }, 400 + index * 250);
    });

  // 开发调试：--auto-open=<sessionId> 自动打开指定会话（与侧栏点击同路径）
  const autoOpen = process.argv.find((a) => a.startsWith('--auto-open='));
  if (autoOpen) {
    const sid = autoOpen.slice('--auto-open='.length);
    setTimeout(() => {
      // 与 sidebar:open-conversation 同一口径：先解析该会话自己的工作目录并登记到
      // core，否则 loadConversation 会按活动工作目录读取（非活动目录的会话打不开）
      syncSessionWorkspaceIndex();
      const workspace = sessionWorkspaces.get(sid);
      if (workspace) void registerCoreSessionWorkspace(sid, workspace);
      chatViews?.openConversation(sid, workspace);
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
    // 浮窗模式启动时按钉住状态置顶（置顶要在窗口显示后落，隐藏时设置可能不生效）
    if (windowMode === 'floating') applyAlwaysOnTop(floatingPinned);
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
    titlebarView = undefined;
    titlebarMenuView = undefined;
    chatViews = undefined;
    // 菜单状态是模块级的，必须随窗口一起复位：窗口销毁后重建（托盘/activate）时，
    // 残留的 openId 会让该分区点不开，残留的尺寸缓存会让新视图直接显示空白面板。
    titlebarMenuOpenId = null;
    titlebarMenuPrevFocusId = undefined;
    invalidateTitlebarMenuCache();
    // 窗口已销毁：停止白屏恢复相关的重绘定时器（纯防御性清理）
    if (focusRepaintTimer) {
      clearTimeout(focusRepaintTimer);
      focusRepaintTimer = null;
    }
  });
}

/** 主窗口 / 标题栏兜底背景色：与自绘 UI 的深/浅底色保持一致，避免加载期闪白或闪黑 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#16161b' : '#f4f4f5';
}

/**
 * 应用主题模式（菜单「主题」子菜单的动作）。
 *
 * - `nativeTheme.themeSource`：驱动系统级配色、原生对话框，以及各渲染进程的
 *   prefers-color-scheme（自绘标题栏 / 侧栏 / Monaco 预览据此切换深浅）；
 * - 显式 `onThemeChanged(null)`：聊天 webview 不监听 prefers-color-scheme，
 *   主题值靠 setTheme 消息下发；重复选择同一项时不会触发 nativeTheme 的
 *   updated 事件，因此这里主动广播一次，保证值一致；
 * - 持久化落在宿主本地偏好（core 不参与）；
 * - 重建菜单：刷新子菜单当前选中项的勾选态。
 */
function applyThemeMode(mode: ThemeMode): void {
  currentThemeMode = mode;
  nativeTheme.themeSource = mode;
  try {
    writeThemeMode(mode);
  } catch (err) {
    console.error('[main] persist theme failed:', err);
  }
  uiHost?.onThemeChanged(null);
  chatViews?.setBackgroundColor(chatViewBackgroundColor());
  mainWindow?.setBackgroundColor(windowBackgroundColor());
  setupMenu();
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
  // Windows 上从托盘/后台恢复时，先置顶再取消，避免窗口只闪烁不聚焦。
  // 浮窗模式下「取消置顶」要回到该模式的置顶状态（钉住时保持置顶）。
  applyAlwaysOnTop(true);
  mainWindow.focus();
  applyAlwaysOnTop(windowMode === 'floating' && floatingPinned);
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

/** 托盘提示文案（按当前宿主语言输出中/英文） */
const TRAY_STATUS_LABEL: Record<TrayStatus, { zh: string; en: string }> = {
  idle: { zh: '全部任务空闲', en: 'All tasks idle' },
  running: { zh: '有任务运行中', en: 'Task running' },
  waiting: { zh: '等待用户确认', en: 'Waiting for your input' },
};

function trayTooltip(status: TrayStatus): string {
  const label = TRAY_STATUS_LABEL[status];
  return `${PRODUCT_NAME} · ${tt(label.zh, label.en)}`;
}

/**
 * 托盘右键菜单（系统菜单）。
 *
 * 文案与主菜单同源，走 `tt()` 按宿主语言取词；语言在运行期变化时由
 * `onHostLocaleChanged` 订阅重建（见 main 的接线），不能只在创建时定一次。
 */
function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: tt(`显示 ${PRODUCT_NAME}`, `Show ${PRODUCT_NAME}`),
      click: () => showMainWindowFromTray(),
    },
    { type: 'separator' },
    {
      label: tt('退出', 'Quit'),
      click: () => app.quit(),
    },
  ]);
}

/** 按当前宿主语言刷新托盘提示与右键菜单（语言变化时调用） */
function refreshTrayLocale(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  if (trayStatus) tray.setToolTip(trayTooltip(trayStatus));
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
    tray.setContextMenu(buildTrayMenu());
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
 * 重新注册全局唤醒快捷键：先注销旧值，再读取宿主本地偏好并注册新值。
 * 注册失败（快捷键被系统或其它程序占用）时静默忽略，不弹窗也不报错。
 */
function registerWakeShortcut(): void {
  registerWakeShortcutValue(readWakeShortcutSync());
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
 * - 打开期间注销当前全局快捷键（suspendWakeShortcut），关闭后按最新偏好恢复
 * - 按键捕获在主进程的 before-input-event 里做，复用宿主的快捷键解析；
 *   页面只负责显示，通过 preload 的 shortcutAPI 通信
 * - 保存时写入宿主本地偏好，写完后关闭
 */
function openShortcutDialog(): void {
  if (shortcutDialogWindow && !shortcutDialogWindow.isDestroyed()) {
    shortcutDialogWindow.focus();
    return;
  }

  /** 候选快捷键：随用户按键更新，保存时才落盘 */
  let candidate = readWakeShortcutSync();
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
   * 保存：写入宿主本地偏好，写完后关闭对话框——
   * 关闭回调按最新偏好重新注册全局快捷键。
   */
  const save = (): void => {
    const normalized = normalizeAccelerator(candidate);
    if (!normalized) {
      error = tt('快捷键无效，请重新设置', 'Invalid shortcut. Please set it again.');
      pushState();
      return;
    }
    error = undefined;
    try {
      writeWakeShortcut(normalized);
      closeDialog();
    } catch (err: unknown) {
      console.error('[main] save wake shortcut failed:', err);
      error = tt('保存失败', 'Failed to save');
      pushState();
    }
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
    const { getSystemLocale } = require('../src/host/i18n.js');
    return getSystemLocale();
  } catch {
    return app.getLocale();
  }
}

/**
 * 在创建原生 UI 之前收敛宿主语言（`DEVELOPMENT.md` 第 8.7 节）。
 *
 * 界面语言是宿主自己的 `settings.json` 字段：先 `loadSync()` 读盘，再交给
 * `primeHostLocale()`（读 `uiLanguage` + 宿主 locale，收敛到进程内 i18n）。
 * 必须早于托盘 / 菜单 / 标题栏的创建，否则它们会按默认英文建好、之后才被改成中文。
 */
function primeHostLocaleForStartup(): void {
  try {
    const { getSettingsStore } = require('../src/host/SettingsStore.js') as typeof import('../src/host/SettingsStore.js');
    getSettingsStore().loadSync();
  } catch (err) {
    console.error('[main] Failed to load settings before priming host locale:', err);
  }
  const { primeHostLocale } = require('../src/host/coreFacts.js') as typeof import('../src/host/coreFacts.js');
  primeHostLocale(app.getLocale());
}

/**
 * 整体布局：侧栏固定左侧，聊天视图占右侧剩余空间。
 * 浮窗模式下隐藏侧栏，聊天视图占满整宽。
 * 依赖均为模块级变量，因此可提升为模块级函数供 repaintAllViews 复用。
 */
function layout(): void {
  if (!mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  // 顶部标题栏整条占满宽度；侧栏与聊天视图整体下移 TITLEBAR_HEIGHT
  titlebarView?.setBounds({ x: 0, y: 0, width: w, height: TITLEBAR_HEIGHT });
  const contentHeight = Math.max(0, h - TITLEBAR_HEIGHT);
  if (windowMode === 'floating') {
    // 浮窗模式：侧栏收成 0 尺寸，聊天视图占满整宽。
    // 刻意用 0×0 bounds 而不是 setVisible(false)：本仓库已知 WebContentsView 被标记隐藏后
    // 重新显示时可能丢合成表面（整页空白，需 resize 才恢复），收成 0 尺寸不触发那条路径。
    sidebarView?.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 });
  } else {
    sidebarView?.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: SIDEBAR_WIDTH, height: contentHeight });
  }
  chatViews?.layout();
}

/**
 * 设置窗口置顶。
 *
 * Electron 44 在部分 Windows 环境下默认层级（floating）不会真正落下
 * WS_EX_TOPMOST（`isAlwaysOnTop()` 仍为 false），「钉住」看起来没生效；
 * 这里逐级兜底：默认层级 → 显式 pop-up-menu → 先取消再设 pop-up-menu。
 */
function applyAlwaysOnTop(on: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(on);
  if (!on || mainWindow.isAlwaysOnTop()) return;
  // 兜底 1：显式 pop-up-menu 层级（部分环境下默认层级不生效）
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  if (mainWindow.isAlwaysOnTop()) return;
  // 兜底 2：个别环境下「flag 不变、只换层级」会被忽略，先取消再设置一次
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
}

/** 当前模式是否允许切换（未打开工作区时禁用：浮窗隐藏侧栏，无法再选工作区） */
function canToggleWindowMode(): boolean {
  return !!workspacePath;
}

/**
 * 向标题栏视图发消息。
 *
 * 统一判存活：窗口拆除期间（blur/hide 会触发关闭菜单）视图可能已销毁，
 * 直接 send 会抛 "Object has been destroyed" 并中断关闭流程。
 */
function sendToTitlebar(channel: string, payload: unknown): void {
  const wc = titlebarView?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

/**
 * 该 IPC 是否来自应用自有的标题栏 / 菜单视图。
 * titlebar:* 与 titlebar-menu:* 能触发退出、切工作区、改窗口模式等动作，
 * 不能仅凭「有 ipcRenderer 就能调」放行。
 */
function isTitlebarSender(sender: Electron.WebContents): boolean {
  const titlebar = titlebarView?.webContents;
  if (titlebar && !titlebar.isDestroyed() && sender === titlebar) return true;
  const menu = titlebarMenuView?.webContents;
  return !!menu && !menu.isDestroyed() && sender === menu;
}

/** 把窗口模式 / 置顶状态 / 工作区推给标题栏（按钮高亮、禁用态、浮窗标题） */
function pushTitlebarModeState(): void {
  sendToTitlebar('titlebar:mode-state', {
    mode: windowMode,
    pinned: windowMode === 'floating' && floatingPinned,
    canToggleMode: canToggleWindowMode(),
    // 浮窗没有侧栏，品牌位改显示当前工作目录名，给用户上下文
    workspaceName: workspaceDisplayName() || null,
  });
}

/**
 * 落盘用的窗口矩形。
 *
 * Windows 会对无边框窗口的尺寸做 1~4 DIP 的微调（请求 1294 实际得到 1296）。
 * 若把微调后的实际值落盘、下次再按它请求，尺寸会逐次变大；这里与「程序设置过的
 * 目标矩形」偏差在容差内时改用目标值，消除漂移。用户真正拖动/缩放造成的偏差更大，
 * 此时按实际值保存，并把基线更新为实际值（后续以它为准）。
 */
function resolvePersistableWindowRect(
  actual: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const target = lastRequestedWindowRect;
  if (!target) return actual;
  const drift = Math.max(
    Math.abs(actual.x - target.x),
    Math.abs(actual.y - target.y),
    Math.abs(actual.width - target.width),
    Math.abs(actual.height - target.height),
  );
  if (drift <= WINDOW_RECT_DRIFT_TOLERANCE) return { ...target };
  lastRequestedWindowRect = { ...actual };
  return actual;
}

/** 记录当前模式的窗口位置与大小（切换模式前调用，避免新模式覆盖旧模式的记录） */
function captureCurrentWindowRect(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  saveWindowRect(windowMode, resolvePersistableWindowRect(mainWindow.getNormalBounds()));
}

/**
 * 等待一次窗口事件，最多等 timeoutMs 后放行。
 *
 * 用于「先还原最大化 / 退出全屏，再 setBounds」：这两个状态变化都是异步的，
 * 事件没落定就 setBounds 会被忽略或只改「还原尺寸」。超时兜底避免事件不来时永久卡住。
 */
function waitForWindowEvent(
  win: BrowserWindow,
  event: 'unmaximize' | 'leave-full-screen',
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    // BrowserWindow.once 的重载不接受联合类型的事件名，这里按 EventEmitter 使用
    const emitter = win as unknown as NodeJS.EventEmitter;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      emitter.removeListener(event, finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    emitter.once(event, finish);
  });
}

/**
 * 切换窗口模式。
 *
 * - normal → floating：记录完整模式尺寸 → 收窄到浮窗尺寸（默认 480 宽 / 工作区 80% 高）、
 *   隐藏侧栏（列表改由 webview 顶栏渲染）、按钉住状态置顶
 * - floating → normal：记录浮窗尺寸 → 恢复到完整模式尺寸、显示侧栏、取消置顶
 *
 * 尺寸按模式独立存储；切换过程中复用同一个窗口与聊天 webview，不重新加载对话。
 */
async function applyWindowMode(mode: WindowMode): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === windowMode) return;
  // 浮窗模式隐藏侧栏，未打开工作区时无从选择工作区，因此禁用切换
  if (mode === 'floating' && !canToggleWindowMode()) return;
  // 切换过程含 await：期间用户再点一次切换按钮会重入，直接把状态改乱
  if (windowModeSwitching) return;
  windowModeSwitching = true;
  try {
    // 最大化/全屏时先还原，否则 setBounds 会被忽略或只改「还原尺寸」。
    // 两个状态变化都是异步的（macOS 退出全屏还有过渡动画），必须等事件落定再 setBounds。
    if (mainWindow.isFullScreen()) {
      // 先挂监听再触发动作，避免事件在注册前就发出、白等一个超时
      const leftFullScreen = waitForWindowEvent(mainWindow, 'leave-full-screen', 1000);
      mainWindow.setFullScreen(false);
      await leftFullScreen;
    }
    if (mainWindow.isMaximized()) {
      const unmaximized = waitForWindowEvent(mainWindow, 'unmaximize', 1000);
      mainWindow.unmaximize();
      await unmaximized;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // 先按旧模式落盘当前位置与尺寸，再切换（后续 move/resize 会写入新模式的槽位）
    captureCurrentWindowRect();
    windowMode = mode;

    if (mode === 'floating') {
      mainWindow.setMinimumSize(MIN_FLOATING_WIDTH, MIN_FLOATING_HEIGHT);
      // 按浮窗自己记录的位置与尺寸还原；没有记录时沿用当前位置、用默认尺寸
      applyWindowRect(readSavedWindowRect('floating') ?? defaultFloatingWindowRect());
      // 置顶放在 setBounds 之后：尺寸变更会把 z-order 层级重置回普通
      applyAlwaysOnTop(floatingPinned);
    } else {
      mainWindow.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
      applyWindowRect(readSavedWindowRect('normal') ?? defaultNormalWindowRect());
      applyAlwaysOnTop(false);
    }

    // 悬浮窗隐藏原生侧栏：webview 顶栏接管对话列表（历史对话入口）。
    // 该调用同时负责布局（聊天视图左边距）与能力声明，不要再单独改布局开关。
    // 视图模式不随之变化：切换会话照旧复用 / 另开视图，不原地重载。
    chatViews?.setConversationListOwner(mode === 'floating' ? 'webview' : 'host');
    // 记录模式供下次启动恢复；浮窗模式下标题显示当前工作目录
    saveLastWindowMode(mode);
    syncWindowTitle();
    layout();
    pushTitlebarModeState();
  } finally {
    windowModeSwitching = false;
  }
}

/** 读取上次使用的窗口模式（非法/缺失时按完整模式处理） */
function readLastWindowMode(): WindowMode {
  const { windowMode: saved } = readWorkspaceState();
  return saved === 'floating' ? 'floating' : 'normal';
}

/** 记录当前窗口模式（切换模式时写盘，下次启动按它恢复） */
function saveLastWindowMode(mode: WindowMode): void {
  writeWorkspaceState({ ...readWorkspaceState(), windowMode: mode });
}

/** 读取上次浮窗的「总在最前」状态（缺失/非法时默认开启） */
function readLastFloatingPinned(): boolean {
  const { floatingPinned: saved } = readWorkspaceState();
  return typeof saved === 'boolean' ? saved : true;
}

/** 记录浮窗的「总在最前」状态（切换钉住时写盘，下次启动按它恢复） */
function saveFloatingPinned(pinned: boolean): void {
  writeWorkspaceState({ ...readWorkspaceState(), floatingPinned: pinned });
}

/**
 * 当前应显示的窗口标题。
 * 浮窗模式下显示当前工作目录（悬浮窗没有侧栏，标题是任务栏/Alt-Tab 里唯一的上下文），
 * 其余情况显示产品名。
 */
function windowTitleForCurrentState(): string {
  const name = workspaceDisplayName();
  return windowMode === 'floating' && name ? name : PRODUCT_NAME;
}

/**
 * 当前工作目录的显示名（浮窗标题用）。
 *
 * 用目录名而不是完整路径：浮窗标题栏只有 480px 宽、任务栏标签也会从右侧截断，
 * 而路径里最有信息量的恰好是尾部目录名。路径可能带尾部分隔符、混用 / 与 \，
 * 先去掉尾部分隔符再取 basename；取不到（如盘符根目录）时退回原路径。
 */
function workspaceDisplayName(): string {
  return workspaceDisplayNameOf(workspacePath);
}

/** 指定工作区的显示名（标题栏标签页 / 浮窗品牌位用）；远程带上主机名区分同名目录 */
function workspaceDisplayNameOf(ref: WorkspaceRef | undefined): string {
  if (!ref) return '';
  const trimmed = ref.path.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed) || ref.path;
  return ref.endpoint ? `${ref.endpoint.host}:${base}` : base;
}

/** 把窗口标题同步到当前模式 / 工作区 */
function syncWindowTitle(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(windowTitleForCurrentState());
}

/** 标签页流水灯的聚合状态：waiting（黄，优先）> running（蓝） */
type WorkspaceActivityLevel = 'waiting' | 'running';

/**
 * 汇总每个打开的工作目录的运行时状态，供标题栏标签页流水灯使用：
 * 该目录下任一会话在等待用户操作（ask user / 权限确认）→ `waiting`（黄，优先）；
 * 否则任一会话非 idle（查询 / 压缩 / 后台 Bash / 子代理）→ `running`（蓝）。
 *
 * 两份输入都取宿主自己的投影，不 require `src/core` 的进程内状态（第 12.6 节
 * 「core 描述事实，UI 决定表现」）：
 * - 状态：`ConversationManager` 缓存的全量快照——core 的 `sessionRuntimeChanged`
 *   经 Connection 推到宿主后存在这里。Standalone（产品形态）下 core 在独立进程，
 *   主进程里的 `src/core/sessionRuntime` 永远是空的，读它流水灯恒不亮；
 * - 归属：宿主的「会话 → 工作目录」索引（打开 / 加载对话时登记，见
 *   `syncSessionWorkspaceIndex`），即 core 那张表在本进程的投影。
 */
function collectWorkspaceActivity(): Record<string, WorkspaceActivityLevel> {
  const result: Record<string, WorkspaceActivityLevel> = {};
  for (const state of conversations?.getSessionStatesSnapshot() ?? []) {
    // idle 且非 waiting = 空闲，不点亮
    if (state.idle && !state.waiting) continue;
    const workspace = sessionWorkspaces.get(state.sessionId);
    if (!workspace) continue;
    // 会话登记的目录与打开集合可能写法不同（本地：大小写 / 分隔符 / 尾斜杠；
    // 远程路径逐字比较），统一按引用口径匹配
    const target = openWorkspaces.find((candidate) => workspacePathMatches(candidate, workspace));
    if (!target) continue;
    const key = refKey(target);
    if (state.waiting) result[key] = 'waiting';
    else if (result[key] !== 'waiting') result[key] = 'running';
  }
  return result;
}

/** 把标签页流水灯状态推给标题栏（状态流每次变化时调用，就地更新不重建标签页） */
function syncTitlebarActivity(): void {
  sendToTitlebar('titlebar:workspace-activity', collectWorkspaceActivity());
}

/**
 * 该工作目录下是否有非 idle 的对话（与标签页流水灯读同一份事实，见 collectWorkspaceActivity）。
 * 关闭标签页前用它判定要不要让用户二次确认。
 */
function workspaceHasBusySession(ref: WorkspaceRef): boolean {
  return collectWorkspaceActivity()[refKey(ref)] !== undefined;
}

/**
 * 该对话当前是否非 idle：读宿主缓存的会话运行时快照（与 `collectWorkspaceActivity`
 * 同一份事实、同一条来源），未登记任何事实（含新建中的 `new-` 临时 key）＝ 空闲。
 */
function sessionIsBusy(sessionId: string): boolean {
  const states = conversations?.getSessionStatesSnapshot() ?? [];
  const state = states.find((candidate) => candidate.sessionId === sessionId);
  return state !== undefined && !state.idle;
}

/**
 * 关闭前的二次确认（原生模态对话框）：返回 true 表示用户确认关闭。
 * 窗口不可用时没有可确认的对象，按「继续关闭」处理（与无确认路径同行为）。
 */
async function confirmCloseBusy(message: string, detail: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [tt('仍然关闭', 'Close Anyway'), tt('取消', 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message,
    detail,
  });
  return response === 0;
}

/**
 * 打开集合快照的单调版本号：每次推送 +1，get-state 响应带上当前值。
 *
 * 标题栏的 get-state 回包只反映主进程处理 invoke 时刻的状态，回包在途期间状态可能
 * 已变化并经推送先一步到达；渲染层按版本号丢弃陈旧回包，避免把新状态覆盖回旧值
 * （实测竞态：探测失败标红的推送被随后到达的 get-state 回包覆盖回黄点）。
 */
let workspaceStateVersion = 0;

/** 把打开集合与活动项推给标题栏（标签页区渲染；字段名与 get-state 统一为 activeWorkspace） */
function syncTitlebarWorkspaces(): void {
  workspaceStateVersion += 1;
  const payload = {
    version: workspaceStateVersion,
    workspaces: openWorkspaces.map((ref) => workspaceTabState(ref)),
    activeWorkspace: workspacePath ? refKey(workspacePath) : null,
    // 重建标签页时带上当前流水灯状态，避免重建后指示灯短暂消失
    activity: collectWorkspaceActivity(),
  };
  sendToTitlebar('titlebar:workspaces', payload);
  // 诊断（远程可用性排查）：推送的快照内容 + 标题栏页面当时是否加载完成——
  // 页面加载完成前 webContents.send 的消息会丢失，这条日志直接区分「没推」与「推了没收到」
  fileLogger.info(
    'workspace-tab',
    `push v${payload.version}: `
      + payload.workspaces.map((w) => `${w.name}=${w.availability}`).join(', ')
      + `, active=${payload.activeWorkspace ?? '-'}`
      + (titlebarView && !titlebarView.webContents.isDestroyed()
        ? ` (titlebar loading=${titlebarView.webContents.isLoading()})`
        : ' (no titlebar)'),
  );
}

/** 标题栏 / 侧栏用的工作区项：id 是稳定身份，path 是展示路径，availability 是连接状态 */
function workspaceTabState(ref: WorkspaceRef): {
  id: string;
  path: string;
  name: string;
  remote: boolean;
  availability: 'available' | 'unavailable' | 'connecting';
} {
  return {
    id: refKey(ref),
    path: refDisplay(ref),
    name: workspaceDisplayNameOf(ref),
    remote: ref.endpoint !== null,
    availability: workspaceAvailability(ref),
  };
}

/**
 * 侧栏「最近打开」列表：与标签页同一形态。
 *
 * 下发 id 而不是路径：远程项按路径没法唯一定位（同一路径可以在多台机器上），
 * 点开时由主进程按 id 回查引用（连同落盘的凭证一起）。
 */
function recentWorkspaceTabs(): Array<ReturnType<typeof workspaceTabState>> {
  return readRecentWorkspaces().map((ref) => workspaceTabState(ref));
}

/** 完整模式默认窗口：固定宽度 + 主屏工作区高度的 80% */
function defaultNormalWindowRect(): { width: number; height: number } {
  return {
    width: DEFAULT_WINDOW_WIDTH,
    height: Math.round(screen.getPrimaryDisplay().workAreaSize.height * 0.8),
  };
}

/**
 * 按目标位置与尺寸调整窗口，并夹回对应显示器工作区内
 * （切换模式后窗口变窄/变矮，原坐标可能让右边缘或下边缘超出屏幕）。
 *
 * rect 不带 x/y（首次切换 / 历史数据只存过宽高）时沿用窗口当前位置。
 */
function applyWindowRect(rect: { x?: number; y?: number; width: number; height: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const probe = { x: rect.x ?? current.x, y: rect.y ?? current.y, width: rect.width, height: rect.height };
  // 记录的位置可能已经失效（换屏 / 拔显示器），失效时退回当前位置
  const useSavedPosition =
    rect.x !== undefined && rect.y !== undefined && isRectVisibleOnSomeDisplay(probe);
  const anchorX = useSavedPosition ? rect.x! : current.x;
  const anchorY = useSavedPosition ? rect.y! : current.y;
  const { workArea } = screen.getDisplayMatching({ ...probe, x: anchorX, y: anchorY });
  // 最小尺寸按当前模式取：完整模式的最小尺寸（800x600）与浮窗（280x240）不同，
  // 用浮窗的最小值夹完整模式会让 setMinimumSize 成为唯一约束，语义错误且脆弱
  const min = minWindowSizeFor(windowMode);
  const width = Math.max(min.width, Math.min(Math.round(rect.width), workArea.width));
  const height = Math.max(min.height, Math.min(Math.round(rect.height), workArea.height));
  const x = Math.min(Math.max(anchorX, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(anchorY, workArea.y), workArea.y + workArea.height - height);
  mainWindow.setBounds({ x, y, width, height });
  // 记录目标矩形：OS 可能对无边框窗口尺寸做微调，落盘时用它抵消
  lastRequestedWindowRect = { x, y, width, height };
}

/** 切换浮窗的「总在最前」 */
function toggleFloatingPinned(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowMode !== 'floating') return;
  floatingPinned = !floatingPinned;
  applyAlwaysOnTop(floatingPinned);
  // 落盘：下次启动（或下次进浮窗）沿用这次的选择
  saveFloatingPinned(floatingPinned);
  pushTitlebarModeState();
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
  try { titlebarView?.webContents.invalidate(); } catch { /* ignore */ }
}

/** 窗口从不可见/遮挡状态恢复可见时，延迟强制重绘一次 */
function scheduleRepaintOnVisible(): void {
  repaintAllViews();
  setTimeout(repaintAllViews, 100); // 等待窗口框架生效后再补一次，双保险
}

/** 显示「关于」对话框（原生菜单与自绘菜单共用） */
function showAboutDialog(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `About ${PRODUCT_NAME}`,
    message: PRODUCT_NAME,
    detail: `Version ${app.getVersion()}`,
  });
}

/**
 * 构建菜单定义（原生菜单与自绘标题栏菜单的唯一来源）。
 * 分区内的 items 支持 separator / item / submenu；自绘菜单会把 submenu 平铺展开。
 */
function buildMenuSections(): MenuSectionDef[] {
  const isMac = process.platform === 'darwin';
  const sections: MenuSectionDef[] = [];

  // macOS 的应用菜单在屏幕顶部系统菜单栏里（平台约定），保留原生 role
  if (isMac) {
    sections.push({
      id: 'app',
      label: app.name,
      items: [
        { id: 'app.about', label: `About ${PRODUCT_NAME}`, role: 'about' },
        { type: 'separator' },
        { id: 'app.quit', label: `Quit ${PRODUCT_NAME}`, role: 'quit' },
      ],
    });
  }

  // 添加工作区：Electron 专属能力（VS Code 从 workspaceFolders 获取）
  const addWorkspaceItem: MenuItemDef = {
    id: 'main.addWorkspace',
    label: tt('打开本地工作区...', 'Open Local Workspace...'),
    accelerator: 'CmdOrCtrl+O',
    run: () => { void openWorkspaceDialog(); },
  };
  // 打开远程工作区：连接远端 Core（ip:端口 + token），随后弹出远端目录选择
  const addRemoteWorkspaceItem: MenuItemDef = {
    id: 'main.addRemoteWorkspace',
    label: tt('打开远程工作区...', 'Open Remote Workspace...'),
    accelerator: 'CmdOrCtrl+Shift+O',
    run: () => { openRemoteWorkspaceDialog(); },
  };
  const recentWorkspaceItem: MenuItemDef = {
    id: 'main.recent',
    label: tt('添加最近的工作区', 'Add Recent Workspace'),
    submenu: buildRecentWorkspacesMenu(),
  };
  // 主题：跟随系统 / 浅色 / 深色（二级菜单，单选；持久化在 settings.json 的 theme 字段）
  const themeItem: MenuItemDef = {
    id: 'main.theme',
    label: tt('主题', 'Theme'),
    submenu: buildThemeMenu(),
  };
  // 唤醒快捷键：Electron 专属能力（最小化到托盘后用该快捷键呼出窗口）
  const shortcutItem: MenuItemDef = {
    id: 'main.shortcut',
    label: tt('快捷键...', 'Shortcut...'),
    run: () => openShortcutDialog(),
  };
  const devToolsItem: MenuItemDef = {
    id: 'main.devTools',
    label: tt('开发者工具', 'Toggle Developer Tools'),
    accelerator: 'CmdOrCtrl+Shift+I',
    run: () => toggleDevTools(),
  };
  const aboutItem: MenuItemDef = {
    id: 'main.about',
    label: tt(`关于 ${PRODUCT_NAME}`, `About ${PRODUCT_NAME}`),
    run: () => showAboutDialog(),
  };

  if (isMac) {
    // macOS 沿用系统菜单栏的分区（自绘标题栏在 macOS 不渲染菜单）
    sections.push({
      id: 'file',
      label: 'File',
      items: [
        addWorkspaceItem,
        addRemoteWorkspaceItem,
        recentWorkspaceItem,
        { type: 'separator' },
        themeItem,
        shortcutItem,
        { type: 'separator' },
        { id: 'file.close', label: 'Close Window', role: 'close' as const },
      ],
    });
    sections.push({ id: 'view', label: 'View', items: [devToolsItem] });
    sections.push({ id: 'help', label: 'Help', items: [aboutItem] });
    return sections;
  }

  // Windows / Linux：全部收编到单一菜单分区，标题栏用一个图标按钮表示
  sections.push({
    id: 'main',
    label: PRODUCT_NAME,
    items: [
      addWorkspaceItem,
      addRemoteWorkspaceItem,
      recentWorkspaceItem,
      { type: 'separator' },
      themeItem,
      shortcutItem,
      { type: 'separator' },
      devToolsItem,
      { type: 'separator' },
      aboutItem,
      { type: 'separator' },
      { id: 'main.quit', label: tt('退出', 'Exit'), run: () => app.quit() },
    ],
  });

  return sections;
}

/**
 * 构建「主题」二级菜单：跟随系统 / 浅色 / 深色，单选。
 * 勾选态取内存里的 currentThemeMode（切换后立即重建菜单，不读盘）。
 */
function buildThemeMenu(): MenuItemDef[] {
  const options: Array<{ mode: ThemeMode; zh: string; en: string }> = [
    { mode: 'system', zh: '跟随系统', en: 'Follow System' },
    { mode: 'light', zh: '浅色', en: 'Light' },
    { mode: 'dark', zh: '深色', en: 'Dark' },
  ];
  return options.map(({ mode, zh, en }) => ({
    id: `main.theme.${mode}`,
    label: tt(zh, en),
    type: 'radio' as const,
    checked: currentThemeMode === mode,
    run: () => applyThemeMode(mode),
  }));
}

/**
 * 构建「添加最近的工作区」子菜单项。
 *
 * 本地项已不存在的目录会被过滤掉；远程项无法本地检查，原样列出（连同凭证一起落盘，
 * 点开即重新连接）。
 */
function buildRecentWorkspacesMenu(): MenuItemDef[] {
  const recents = readRecentWorkspaces();
  if (recents.length === 0) {
    return [{ id: 'main.recent.none', label: tt('无最近的工作区', 'No Recent Workspaces'), enabled: false }];
  }
  return recents.map((ref, index) => ({
    id: `main.recent.${index}`,
    label: refDisplay(ref),
    run: () => { addWorkspaceRefs([ref]); },
  }));
}

/** 定义 → 原生菜单项（子菜单保留层级） */
function toNativeMenuItem(def: MenuItemDef): Electron.MenuItemConstructorOptions {
  if (def.type === 'separator') return { type: 'separator' };
  const item: Electron.MenuItemConstructorOptions = { label: def.label };
  if (def.type === 'radio' || def.type === 'checkbox') {
    item.type = def.type;
    item.checked = def.checked === true;
  }
  if (def.accelerator) item.accelerator = def.accelerator;
  if (def.enabled === false) item.enabled = false;
  if (def.submenu) {
    item.submenu = def.submenu.map(toNativeMenuItem);
  } else if (def.role) {
    item.role = def.role;
  } else if (def.id && def.run) {
    item.click = () => invokeMenuAction(def.id!);
  }
  return item;
}

/** 定义 → 自绘菜单展示节点（子菜单保留为二级飞出菜单，默认收起） */
function toTitlebarMenuNodes(defs: MenuItemDef[]): TitlebarMenuNode[] {
  const nodes: TitlebarMenuNode[] = [];
  for (const def of defs) {
    if (def.type === 'separator') {
      nodes.push({ type: 'separator' });
      continue;
    }
    if (def.submenu) {
      if (!def.id) continue;
      nodes.push({
        type: 'submenu',
        id: def.id,
        label: def.label ?? '',
        enabled: def.enabled !== false,
        items: toTitlebarMenuNodes(def.submenu),
      });
      continue;
    }
    if (!def.id) continue;
    // 仅 radio / checkbox 传 checked + checkType（未定义 = 不是可勾选项，自绘菜单不预留勾选位，
    // 也不会把普通项渲染成 menuitemradio）
    const checkType = def.type === 'radio' || def.type === 'checkbox' ? def.type : undefined;
    nodes.push({
      type: 'item',
      id: def.id,
      label: def.label ?? '',
      accelerator: def.accelerator ? formatAcceleratorForDisplay(def.accelerator) : undefined,
      enabled: def.enabled !== false,
      danger: def.danger,
      ...(checkType ? { checked: def.checked === true, checkType } : {}),
    });
  }
  return nodes;
}

/** 收集 id → 动作 */
function collectMenuActions(defs: MenuItemDef[], actions: Map<string, () => void>): void {
  for (const def of defs) {
    if (def.submenu) collectMenuActions(def.submenu, actions);
    else if (def.id && def.run) actions.set(def.id, def.run);
  }
}

/** 收集 规范化 accelerator → id（无边框窗口下 before-input-event 兜底用） */
function collectMenuAccelerators(defs: MenuItemDef[], index: Map<string, string>): void {
  for (const def of defs) {
    if (def.submenu) {
      collectMenuAccelerators(def.submenu, index);
      continue;
    }
    if (!def.id || !def.run || !def.accelerator) continue;
    const normalized = normalizeAccelerator(def.accelerator);
    if (normalized) index.set(normalized, def.id);
  }
}

/**
 * 执行菜单项动作。
 * 原生菜单 accelerator 与 before-input-event 兜底可能对同一次按键都触发，
 * 因此按 id 做短时间去重（250ms），避免「按一次 Ctrl+O 弹出两个对话框」。
 */
function invokeMenuAction(id: string): void {
  const run = titlebarMenuActions.get(id);
  if (!run) return;
  const now = Date.now();
  if (now - (recentMenuActionAt.get(id) ?? 0) < 250) return;
  recentMenuActionAt.set(id, now);
  try {
    run();
  } catch (err) {
    console.error(`[main] menu action failed (${id}):`, err);
  }
}

/**
 * 菜单快捷键兜底。
 *
 * 主窗口改为无边框后系统菜单栏不再绘制，原生 accelerator 是否仍然生效依赖平台实现；
 * 这里在 before-input-event 里按同一份 accelerator 定义再兜一次。
 * 两处都命中时由 invokeMenuAction 去重，不会重复执行。
 * macOS 保留系统菜单栏（原生 accelerator 可用），不走兜底。
 */
function handleMenuAccelerator(event: Electron.Event, input: Electron.Input): void {
  if (process.platform === 'darwin') return;
  if (input.type !== 'keyDown' || input.isAutoRepeat) return;
  const accelerator = acceleratorFromKeyboardEvent({
    code: input.code,
    key: input.key,
    ctrlKey: input.control,
    altKey: input.alt,
    metaKey: input.meta,
    shiftKey: input.shift,
  });
  if (!accelerator) return;
  const id = titlebarMenuAccelerators.get(accelerator);
  if (!id) return;
  event.preventDefault();
  invokeMenuAction(id);
}

/**
 * 建立菜单：原生菜单与自绘标题栏菜单共用同一份定义。
 *
 * 原生菜单在 macOS 是屏幕顶部的系统菜单栏，在 Windows/Linux 无边框窗口下不绘制
 * （保留它可让 role 类平台行为保持一致）；自绘菜单负责实际展示。
 */
function setupMenu(): void {
  const sections = buildMenuSections();

  const actions = new Map<string, () => void>();
  const accelerators = new Map<string, string>();
  for (const section of sections) {
    collectMenuActions(section.items, actions);
    collectMenuAccelerators(section.items, accelerators);
  }
  titlebarMenuActions = actions;
  titlebarMenuAccelerators = accelerators;
  titlebarMenuSections = sections.map((section) => ({
    id: section.id,
    label: section.label,
    items: toTitlebarMenuNodes(section.items),
  }));

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      sections.map((section) => ({
        label: section.label,
        submenu: section.items.map(toNativeMenuItem),
      })),
    ),
  );

  // 已打开的菜单先关掉并作废测量缓存，避免重建后仍展示旧内容
  // （切换工作区会重建「最近打开」列表，尺寸也随之变化）
  closeTitlebarMenu();
  invalidateTitlebarMenuCache();
  // 通知标题栏重建菜单按钮（最近工作区变化时也要刷新）
  sendToTitlebar('titlebar:model-changed', {
    sections: titlebarMenuSections.map((s) => ({ id: s.id, label: s.label })),
  });
}

/** 创建（或复用）自绘下拉菜单视图：挂在主窗口内容区，关闭时隐藏（不销毁，复用已渲染页面） */
function ensureTitlebarMenuView(): WebContentsView {
  if (titlebarMenuView && !titlebarMenuView.webContents.isDestroyed()) return titlebarMenuView;

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'titlebarMenuPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 页面由主进程生成的 data: URL 渲染、preload 只用 contextBridge，可开沙箱
      sandbox: true,
      // 与侧栏同理：避免被遮挡/隐藏时暂停渲染，重新显示时出现空白帧
      backgroundThrottling: false,
    },
  });
  // 页面内容完全由主进程生成，但仍拒绝任何导航 / window.open：
  // 一旦被拖放导航到外部页面，preload 重跑会把 titlebarMenuAPI 交给外部页面
  guardViewNavigation(view.webContents);
  // 视图自身背景必须透明：页面底色透明只解决页面内部，视图默认是白底，
  // 二级飞出面板之外多出来的那块会露出白边（实测踩过）
  view.setBackgroundColor('#00000000');
  // 先给一个正常视口尺寸再隐藏：页面需要视口才能量出菜单自然高度
  view.setBounds({ x: 0, y: 0, width: TITLEBAR_MENU_WIDTH, height: 480 });
  view.setVisible(false);
  // 菜单视图始终置于最上层：聊天视图是动态 addChildView 的，会盖在它上面
  mainWindow?.contentView.addChildView(view);
  titlebarMenuView = view;
  return view;
}

/** 隐藏菜单视图（保留 bounds，便于下次打开时页面已按正常视口完成布局） */
function hideTitlebarMenuView(): void {
  const view = titlebarMenuView;
  if (!view || view.webContents.isDestroyed()) return;
  view.setVisible(false);
  // 页面会被复用（不重新加载），通知它收起二级飞出面板，避免下次打开时残留展开态
  view.webContents.send('titlebar-menu:reset');
}

/** 关闭下拉菜单（视图复用，只隐藏），并把焦点还给打开前的视图 */
function closeTitlebarMenu(): void {
  const id = titlebarMenuOpenId;
  if (!id) return;
  titlebarMenuOpenId = null;
  hideTitlebarMenuView();
  sendToTitlebar('titlebar:menu-state', { openId: null });
  restoreFocusAfterMenu();
}

/** 把焦点还给打开菜单前的视图（窗口仍在前台时才还，避免抢回已切走的焦点） */
function restoreFocusAfterMenu(): void {
  const prevId = titlebarMenuPrevFocusId;
  titlebarMenuPrevFocusId = undefined;
  if (prevId === undefined) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) return;
  const prev = webContents.fromId(prevId);
  if (prev && !prev.isDestroyed()) prev.focus();
}

/**
 * 按当前锚点与菜单尺寸把菜单视图摆到标题栏下方并显示。
 *
 * 尺寸由菜单页上报：主面板 ∪ 二级飞出面板。offsetX 是页面相对锚点的左偏移
 * （二级面板向左展开时为负），视图左边要跟着左移，主面板才能对齐菜单按钮。
 */
function showTitlebarMenu(size: { width: number; height: number; offsetX?: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = titlebarMenuView;
  if (!view || view.webContents.isDestroyed()) return;

  const content = mainWindow.getContentBounds();
  const offsetX = Math.round(size.offsetX ?? 0);
  // 上限放到「主面板 + 二级面板」，避免把二级菜单裁掉
  const maxWidth = TITLEBAR_MENU_WIDTH + TITLEBAR_SUBMENU_WIDTH;
  const width = Math.max(160, Math.min(maxWidth, Math.round(size.width) || TITLEBAR_MENU_WIDTH));
  // 高度兜底：菜单页已按 maxHeight 自限，这里防止异常尺寸超出窗口
  const height = Math.max(
    36,
    Math.min(Math.round(size.height) || 120, Math.max(36, content.height - TITLEBAR_HEIGHT - 8)),
  );
  const minX = content.x;
  const maxX = content.x + content.width - width;
  const anchorX = content.x + titlebarMenuAnchorX + offsetX;
  const x = Math.min(Math.max(minX, anchorX), Math.max(minX, maxX));
  const y = content.y + TITLEBAR_HEIGHT + 2;

  // 内容区坐标系：把屏幕坐标换算回相对内容区的位置
  view.setBounds({
    x: Math.round(x - content.x),
    y: Math.round(y - content.y),
    width,
    height,
  });
  view.setVisible(true);
  // 重新 addChildView 把它提到最上层（聊天视图可能在其后添加过）。
  // 注意不要先 removeChildView：那会让焦点掉成「无视图」，菜单会随即被关掉。
  mainWindow.contentView.addChildView(view);
  // 焦点交给菜单视图：Esc / 方向键 / 点击菜单项都依赖它
  view.webContents.focus();
}

/** 打开指定分区的下拉菜单（标题栏菜单按钮点击） */
function openTitlebarMenu(payload: { id?: string; anchorX?: number }): void {
  if (process.platform === 'darwin') return; // macOS 用系统菜单栏，不弹自绘菜单
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const id = typeof payload?.id === 'string' ? payload.id : '';
  const section = titlebarMenuSections.find((s) => s.id === id);
  if (!section) return;
  if (titlebarMenuOpenId === id) return; // 已经是打开状态，不重复加载

  titlebarMenuOpenId = id;
  // 数值兜底：NaN / Infinity 会一路传到 showTitlebarMenu 的 Math.min/max，
  // 最终 setBounds({ x: NaN }) 抛错
  const anchorX = Number(payload.anchorX);
  titlebarMenuAnchorX = Number.isFinite(anchorX) ? Math.max(0, Math.round(anchorX)) : 0;
  // 记下当前焦点视图，关闭时还回去（菜单视图会抢走焦点）
  const focusedBefore = webContents.getFocusedWebContents();
  titlebarMenuPrevFocusId = focusedBefore && !focusedBefore.isDestroyed() ? focusedBefore.id : undefined;

  const view = ensureTitlebarMenuView();
  const cached = titlebarMenuSizeCache.get(id);
  if (cached && titlebarMenuLoadedId === id) {
    // 尺寸已知且页面就是这一份：直接摆位显示，零加载、零闪烁
    showTitlebarMenu(cached);
  } else {
    // 先隐藏并给一个正常视口再换内容：避免旧菜单内容在换页过程中被看到，
    // 同时保证页面能量出菜单自然高度
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: TITLEBAR_MENU_WIDTH, height: 480 });
    titlebarMenuLoadedId = id;
    const content = mainWindow.getContentBounds();
    // 菜单最大高度：窗口内容区扣掉标题栏与上下留白；超出时菜单内部滚动
    const maxHeight = Math.max(80, content.height - TITLEBAR_HEIGHT - 8);
    // 锚点右侧剩余宽度：不够放二级飞出面板时，菜单页会改成向左展开
    const availableRight = content.width - titlebarMenuAnchorX - 4;
    const html = getTitlebarMenuHtml({
      items: section.items,
      isDark: nativeTheme.shouldUseDarkColors,
      maxHeight,
      availableRight,
      // 每次生成新 nonce：菜单页的内联 style/script 只认这一个，注入的脚本无法执行
      nonce: crypto.randomBytes(16).toString('base64'),
    });
    // 失败必须复位 openId：否则该分区的按钮再也点不开（openTitlebarMenu 开头会提前返回）
    view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err) => {
      console.error(`[titlebar] menu load failed (${id}):`, err);
      closeTitlebarMenu();
    });
  }
  sendToTitlebar('titlebar:menu-state', { openId: id });
}

/**
 * 菜单页渲染完成后上报尺寸。
 * 首次打开（或菜单内容变化后）走这里：缓存尺寸并落到最终位置。
 */
function positionTitlebarMenu(size: { width?: number; height?: number; offsetX?: number }): void {
  const id = titlebarMenuOpenId;
  if (!id) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = titlebarMenuView;
  if (!view || view.webContents.isDestroyed()) return;

  const measured = {
    width: Math.max(160, Math.round(Number(size?.width) || TITLEBAR_MENU_WIDTH)),
    height: Math.max(36, Math.round(Number(size?.height) || 120)),
    offsetX: Math.round(Number(size?.offsetX) || 0),
  };
  const cached = titlebarMenuSizeCache.get(id);
  // 尺寸与偏移都没变且已经显示：跳过二次 setBounds，避免抖动。
  // 二级面板展开/收起会改变尺寸与偏移，必须走 setBounds。
  if (
    cached
    && cached.width === measured.width
    && cached.height === measured.height
    && cached.offsetX === measured.offsetX
    && view.getVisible()
  ) {
    return;
  }
  titlebarMenuSizeCache.set(id, measured);
  showTitlebarMenu(measured);
}

/** 菜单内容重建（切换工作区等）后清掉测量缓存，下次打开重新测量 */
function invalidateTitlebarMenuCache(): void {
  titlebarMenuSizeCache.clear();
  titlebarMenuLoadedId = null;
}

/** 弹出系统目录选择框并把所选目录加入打开集合（支持多选，按选择顺序） */
async function openWorkspaceDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: tt('选择工作区目录', 'Select Workspace Folder'),
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  addWorkspaces(result.filePaths);
}

/**
 * 标题栏「加号」的添加工作区菜单：打开本地工作区 / 打开远程工作区 / 打开最近的工作区。
 *
 * 最近列表本地与远程同形态，点开即打开（远程项按落盘的凭证重新连接）。
 * 用原生菜单在当前鼠标位置弹出；标题栏页面只发一条 IPC，不自己渲染菜单。
 */
function popupWorkspaceMenu(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const recents = readRecentWorkspaces();
  const recentItems: Electron.MenuItemConstructorOptions[] = recents.length === 0
    ? [{ label: tt('无最近的工作区', 'No Recent Workspaces'), enabled: false }]
    : recents.map((ref) => ({
        label: refDisplay(ref),
        click: () => { addWorkspaceRefs([ref]); },
      }));
  const menu = Menu.buildFromTemplate([
    {
      label: tt('打开本地工作区...', 'Open Local Workspace...'),
      click: () => { void openWorkspaceDialog(); },
    },
    {
      label: tt('打开远程工作区...', 'Open Remote Workspace...'),
      click: () => { openRemoteWorkspaceDialog(); },
    },
    { type: 'separator' },
    {
      label: tt('打开最近的工作区', 'Open Recent Workspace'),
      submenu: recentItems,
    },
  ]);
  menu.popup({ window: mainWindow });
}

/** 「打开远程工作区」窗口（连接远端 daemon → 选择远端目录） */
let remoteWorkspaceWindow: BrowserWindow | undefined;

/**
 * 两步各自的窗口尺寸（内容区，`useContentSize`）。
 * 第一步是 SSH 表单，窗口就按它定；连接成功后换成选目录的尺寸。
 */
const CONNECT_SIZE = { width: 520, height: 400 };
const PICKER_SIZE = { width: 760, height: 560 };
const PICKER_MIN_SIZE = { width: 560, height: 380 };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把「打开远程工作区」窗口的接入请求翻成 `WorkspaceEndpoint`（`docs/core-daemon.md` 第 12 节）。
 *
 * 形状校验与「凭证种类 → 接入方式」的收敛在 host 层（`buildRemoteEndpoint`）；这里只把
 * 原因码翻成本地化文案——i18n 只存在于宿主实现，不进 host 层。
 */
function parseRemoteConnectRequest(
  raw: unknown,
): { ok: true; value: WorkspaceEndpoint } | { ok: false; error: string } {
  const parsed = buildRemoteEndpoint(raw);
  if (parsed.ok) return parsed;
  const messages: Record<RemoteConnectError, string> = {
    request: tt('接入请求格式不对', 'Malformed connect request'),
    host: tt('请填写 SSH 主机地址', 'SSH host is required'),
    port: tt('SSH 端口必须是 1-65535 之间的数字', 'SSH port must be a number between 1 and 65535'),
    user: tt('请填写 SSH 登录用户', 'SSH login user is required'),
    password: tt('请填写 SSH 登录密码', 'SSH password is required'),
  };
  return { ok: false, error: messages[parsed.error] };
}

/**
 * 打开「打开远程工作区」窗口。
 *
 * 流程（`docs/core-daemon.md` 第 12 节）：
 * 1. 填 SSH 表单（主机 / 端口 / 用户 / 口令）；
 * 2. 连接成功后**立刻**列出远端主目录，进入目录选择（可进上级 / 新建 / 删除）；
 * 3. 选定目录后加为工作区（同一个 daemon 连接随后用于打开该工作区）。
 *
 * 窗口按当前这一步的内容定尺寸：第一步是紧凑的 SSH 表单；连接成功后换成选目录的
 * 尺寸（`PICKER_SIZE`），避免「大窗口里一个小表单」。
 */
function openRemoteWorkspaceDialog(): void {
  if (remoteWorkspaceWindow && !remoteWorkspaceWindow.isDestroyed()) {
    remoteWorkspaceWindow.focus();
    return;
  }
  // 延迟 require：bootstrapCore 会引入 core 侧模块，必须在 app ready（initCore）之后加载
  const { listRemoteDirectories, createRemoteDirectory, renameRemoteDirectory, deleteRemoteDirectory } =
    require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined;
  const win = new BrowserWindow({
    ...CONNECT_SIZE,
    useContentSize: true,
    ...(parent ? { parent } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: tt('打开远程工作区', 'Open Remote Workspace'),
    icon: path.join(APP_ROOT, 'assets', 'logo.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'remoteWorkspacePreload.cjs'),
    },
  });
  remoteWorkspaceWindow = win;

  /** 已连接成功的 endpoint；未连接时为 null（后续 list / create / delete / open 都要求它） */
  let connected: WorkspaceEndpoint | null = null;
  const isSender = (sender: Electron.WebContents): boolean =>
    !win.isDestroyed() && sender === win.webContents;
  const close = (): void => {
    if (!win.isDestroyed()) win.close();
  };

  ipcMain.handle('remote-workspace:connect', async (event, raw: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    const request = parseRemoteConnectRequest(raw);
    if (!request.ok) return { ok: false, error: request.error };
    const endpoint = request.value;
    try {
      // SSH 接入时这一步会完成「发现 / 部署 / 启动」，可能要几秒
      const listing = await listRemoteDirectories(endpoint, null);
      connected = endpoint;
      // SSH 接入成功即记入连接历史：以「连上」为准，不是「选完目录」——
      // 用户可能停在目录选择这一步，下次仍希望一键回填表单
      const auth = endpoint.auth;
      if (auth !== null && auth.kind === 'sshPassword') {
        rememberSshConnection({
          host: endpoint.host,
          port: endpoint.port ?? 22,
          user: endpoint.user ?? '',
          password: auth.password,
        });
      }
      // 进目录选择这一步：换尺寸并允许调整大小
      win.setResizable(true);
      win.setMinimumSize(PICKER_MIN_SIZE.width, PICKER_MIN_SIZE.height);
      win.setContentSize(PICKER_SIZE.width, PICKER_SIZE.height);
      win.center();
      // 凭证不下发到页面：标题只需要知道连的是哪台机器
      return {
        ok: true,
        listing,
        endpoint: { host: endpoint.host, port: endpoint.port ?? 0, user: endpoint.user },
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });

  ipcMain.handle('remote-workspace:list', async (event, target: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    if (!connected) return { ok: false, error: 'not connected' };
    if (target !== null && typeof target !== 'string') return { ok: false, error: 'invalid path' };
    try {
      const listing = await listRemoteDirectories(connected, target);
      return { ok: true, listing };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });

  ipcMain.handle('remote-workspace:create', async (event, target: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    if (!connected) return { ok: false, error: 'not connected' };
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: 'invalid path' };
    }
    try {
      return { ok: true, path: await createRemoteDirectory(connected, target) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });

  ipcMain.handle('remote-workspace:rename', async (event, target: unknown, name: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    if (!connected) return { ok: false, error: 'not connected' };
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: 'invalid path' };
    }
    if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'invalid name' };
    try {
      return { ok: true, path: await renameRemoteDirectory(connected, target, name) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });

  ipcMain.handle('remote-workspace:delete', async (event, target: unknown, recursive: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    if (!connected) return { ok: false, error: 'not connected' };
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: 'invalid path' };
    }
    if (typeof recursive !== 'boolean') return { ok: false, error: 'invalid recursive flag' };
    try {
      return { ok: true, path: await deleteRemoteDirectory(connected, target, recursive) };
    } catch (error) {
      // 非空是「还能继续」的失败：把 reason 带回页面，让它升成递归删除的二次确认
      return {
        ok: false,
        error: describeError(error),
        reason: error instanceof DirectoryOperationError ? error.reason : 'other',
      };
    }
  });

  ipcMain.handle('remote-workspace:open', (event, target: unknown) => {
    if (!isSender(event.sender)) return { ok: false, error: 'invalid sender' };
    if (!connected) return { ok: false, error: 'not connected' };
    if (typeof target !== 'string' || target.length === 0) {
      return { ok: false, error: 'invalid path' };
    }
    try {
      addRemoteWorkspace(connected, target);
    } catch (error) {
      // 打开失败必须把原因回给页面：否则窗口停在「忙」状态、按钮全灰，看起来像卡死
      return { ok: false, error: describeError(error) };
    }
    close();
    return { ok: true };
  });

  // SSH 连接历史：条目带着口令下发——选定候选要整表单回填（含口令），只发进这个窗口，
  // 与 connect 的「凭证不下发到页面」（标题不需要口令）不冲突
  ipcMain.handle('remote-workspace:ssh-history', (event) => {
    if (!isSender(event.sender)) return [];
    return readSshHistory();
  });

  ipcMain.handle('remote-workspace:ssh-history-remove', (event, key: unknown) => {
    if (!isSender(event.sender)) return readSshHistory();
    if (typeof key !== 'string') return readSshHistory();
    const next = removeSshEntry(readSshHistory(), key);
    writeWorkspaceState({ ...readWorkspaceState(), recentSshConnections: next });
    return next;
  });

  const onCancel = (event: Electron.IpcMainEvent): void => {
    if (isSender(event.sender)) close();
  };
  ipcMain.on('remote-workspace:cancel', onCancel);
  win.on('closed', () => {
    ipcMain.removeHandler('remote-workspace:connect');
    ipcMain.removeHandler('remote-workspace:list');
    ipcMain.removeHandler('remote-workspace:create');
    ipcMain.removeHandler('remote-workspace:rename');
    ipcMain.removeHandler('remote-workspace:delete');
    ipcMain.removeHandler('remote-workspace:open');
    ipcMain.removeHandler('remote-workspace:ssh-history');
    ipcMain.removeHandler('remote-workspace:ssh-history-remove');
    ipcMain.removeListener('remote-workspace:cancel', onCancel);
    if (remoteWorkspaceWindow === win) remoteWorkspaceWindow = undefined;
  });

  win.once('ready-to-show', () => win.show());
  // 文案语言走宿主语言（与原生菜单同一份事实），页面按 query 选字典
  void win
    .loadFile(path.join(APP_ROOT, 'dist', 'remoteWorkspace', 'index.html'), {
      query: { locale: getHostLocale() },
    })
    .catch((err) => {
      console.error('[remote-workspace] loadFile rejected; run `npm run build:remoteWorkspace`:', err);
    });
}

/**
 * 把「会话 → 工作目录」登记到 core 的会话工作目录表（core 按会话解析工作目录）。
 *
 * 唯一写入通路是 `UiEvent.sessionWorkspaceAssigned`（core 侧 initializeCoreEvents
 * 转调 setSessionWorkspace / clearSessionWorkspace）：Embedded 下同进程同表，
 * Standalone 下只有事件能过帧通道——不再绕过事件直写 core 的表。
 * bootstrap 之前调用时总线尚未注册，事件被丢弃——这正是期望语义：core 还没起来时
 * 登记也没有意义，会话打开后宿主会再登记一次。
 */
function registerCoreSessionWorkspace(sessionId: string, workspace: string): void {
  try {
    requireEventBus().emitToCore({
      type: 'sessionWorkspaceAssigned',
      sessionId,
      workspacePath: workspace ?? null,
    });
  } catch (err) {
    console.error('[main] register session workspace error:', err);
  }
}

/**
 * 用当前对话列表快照刷新宿主的「会话 → 工作目录」索引。
 * 打开对话时按它给聊天视图注入该对话自己的工作目录。
 */
function syncSessionWorkspaceIndex(): void {
  const list = conversations?.getCachedList();
  if (!list) return;
  for (const c of list as ReadonlyArray<{ sessionId?: string; project?: string }>) {
    if (c && typeof c.sessionId === 'string' && typeof c.project === 'string' && c.project) {
      // 统一规范化：视图按这个值注入 --workspace=，关闭工作目录时按同一表示匹配
      sessionWorkspaces.set(c.sessionId, canonicalWorkspacePath(c.project));
    }
  }
}

/**
 * 添加工作目录：按顺序加入打开集合，最后一项成为活动项。
 * 已在集合中的目录不重复加入，直接置为活动项；每个目录都写入最近列表。
 */
function addWorkspaces(paths: readonly string[]): void {
  const refs: WorkspaceRef[] = [];
  for (const raw of paths) {
    if (!isValidWorkspaceDir(raw)) continue;
    refs.push(localWorkspaceRef(raw));
  }
  addWorkspaceRefs(refs);
}

/** 加入一个远程工作区（远程目录选择器确认后调用） */
function addRemoteWorkspace(endpoint: WorkspaceEndpoint, remotePath: string): void {
  addWorkspaceRefs([remoteWorkspaceRef(endpoint, remotePath)]);
}

/** 按顺序加入打开集合，最后一项成为活动项；重复项只激活不新建 */
function addWorkspaceRefs(refs: readonly WorkspaceRef[]): void {
  const added: WorkspaceRef[] = [];
  const opened: WorkspaceRef[] = [];
  for (const ref of refs) {
    // 本地与远程同一口径：只要加入打开集合就进最近列表（远程项连同凭证一起落盘）
    rememberRecentWorkspace(ref);
    const existing = findWorkspace(ref);
    if (!existing) {
      openWorkspaces.push(ref);
      opened.push(ref);
    } else if (reviveWorkspaceIfRecovered(existing)) {
      // 启动期被判定不可用、现已恢复（目录重新出现 / 选择器验证过可达）：
      // 重新加入 opened 补建 Connection，否则激活后是一个没有 Core 的空壳
      opened.push(existing);
    }
    added.push(existing ?? ref);
  }
  if (added.length === 0) return;
  // 新打开的工作区通知 Client 建立 Connection（重复打开只激活已有视图）；
  // 重新打开是全新的一次建连，清掉上一世的就绪标记
  for (const ref of opened) {
    workspaceAvailabilityState.clearReady(refKey(ref));
    emitWorkspaceChange('opened', ref);
  }
  // 最后一项成为活动项；每个目录的会话工作目录在各自会话被 core 解析目录前登记。
  activateWorkspace(added[added.length - 1]);
}

/**
 * 重排打开集合（标题栏标签页拖拽排序）。
 *
 * 只接受「与当前打开集合同一组工作区」的完整排列（按 id 校验），
 * 长度不符 / 含未知 id / 有重复一律忽略整次提交。
 * 活动项与各目录下已打开的对话视图不受顺序影响。
 */
function reorderWorkspaces(ids: readonly string[]): void {
  const current = openWorkspaces.map((ref) => refKey(ref));
  if (ids.length !== current.length) return;
  const unique = new Set(ids);
  if (unique.size !== ids.length) return;
  const byKey = new Map(openWorkspaces.map((ref) => [refKey(ref), ref]));
  const next: WorkspaceRef[] = [];
  for (const id of ids) {
    const ref = byKey.get(id);
    if (!ref) return; // 含未知 id：整次忽略
    next.push(ref);
  }
  if (next.every((ref, index) => ref === openWorkspaces[index])) return; // 顺序未变
  openWorkspaces = next;
  saveOpenWorkspaces(openWorkspaces, workspacePath);
  syncTitlebarWorkspaces();
}

/**
 * 切换活动工作区：更新宿主 / 聊天视图 / 侧栏 / 标题栏，并记住打开集合与活动项。
 *
 * 入参可以是引用本身，也可以是标签页 / 侧栏传回的 id。
 * 聊天视图按对话自己的工作目录保留，切换活动项不销毁任何视图。
 */
function activateWorkspace(target: WorkspaceRef | string): void {
  // 按去重键匹配打开集合中的项，传入不同表示也能定位到同一张标签页
  const ref = typeof target === 'string'
    ? openWorkspaces.find((candidate) => refKey(candidate) === target)
    : findWorkspace(target);
  if (!ref) return;
  const prev = workspacePath;
  const changed = !sameRef(prev, ref);
  workspacePath = ref;
  uiHost?.setWorkspacePath(ref);
  if (changed) {
    saveOpenWorkspaces(openWorkspaces, workspacePath);
    // 列表快照按目录各存一份：切换标签页不丢快照，侧栏直接命中（脏快照由
    // get-conversations 后台补读，见 sidebar:get-conversations）
    // 从「无工作目录」进入：销毁空态视图（--workspace= 为空），避免残留
    if (!prev) chatViews?.closeWorkspace('');
  }
  // 建链中 / 不可用的目录不展示对话视图，聊天区由这里对齐（占位页或对话视图）
  syncChatAreaForActiveWorkspace();
  if (changed) emitWorkspaceChange('activated', ref);
  setupMenu();
  pushTitlebarModeState();
  syncWindowTitle();
  syncTitlebarWorkspaces();
  broadcastWorkspaces();
}

/**
 * 对话属于已打开但不是活动的目录时，先把该目录切为活动项
 * （保持「活动标签页 = 活动对话」一致）。按 core 侧的工作目录路径匹配引用。
 */
function activateWorkspaceForPath(workspace: string | undefined): void {
  if (!workspace) return;
  const ref = openWorkspaces.find((candidate) => workspacePathMatches(candidate, workspace));
  if (ref && !(workspacePath && sameWorkspaceRef(ref, workspacePath))) {
    activateWorkspace(ref);
  }
}

/**
 * 关闭工作目录：移出打开集合，销毁该目录下所有对话视图并中止运行中查询；
 * 关闭的是活动项时把活动权移交相邻项。
 *
 * 该目录下还有非 idle 的对话时先让用户二次确认（关闭会中止它们的运行）：
 * 确认期间集合可能被其它入口改动，确认后重新定位，已不在集合里就什么都不做。
 */
async function closeWorkspace(target: WorkspaceRef | string): Promise<void> {
  // 按去重键匹配打开集合中的项
  const ref = typeof target === 'string'
    ? openWorkspaces.find((candidate) => refKey(candidate) === target)
    : findWorkspace(target);
  if (!ref || !openWorkspaces.includes(ref)) return;
  if (workspaceHasBusySession(ref) && !(await confirmCloseBusy(
    tt(`「${refDisplay(ref)}」下仍有对话在运行`, `Conversations in "${refDisplay(ref)}" are still running`),
    tt('关闭工作区会中止这些对话的运行。确定关闭？', 'Closing the workspace stops them. Close anyway?'),
  ))) return;
  const idx = openWorkspaces.indexOf(ref);
  if (idx < 0) return;
  openWorkspaces.splice(idx, 1);
  // 标签页关闭即丢弃启动期的不可用判定 / 建链状态：之后经「最近打开」重新添加按全新打开处理
  workspaceAvailabilityState.clearAll(refKey(ref));
  chatViews?.closeWorkspace(ref.path);
  // 该目录的列表快照一并丢弃：关闭期间盘上内容可能变化（另一实例 / daemon 侧），
  // 重新打开时按首次打开处理（无快照 → 完整读一次盘）。其它目录的快照不受影响。
  conversations?.invalidateCachedList(ref.path);
  for (const [sid, ws] of [...sessionWorkspaces]) {
    if (workspacePathMatches(ref, ws)) sessionWorkspaces.delete(sid);
  }
  const wasActive = sameRef(workspacePath, ref);
  if (wasActive) {
    // 活动权移交相邻项；相邻项不可用 / 建链中时聊天区由 syncChatAreaForActiveWorkspace
    // 改显占位页（不回退到更远的可用项）
    const next = openWorkspaces[Math.min(idx, openWorkspaces.length - 1)];
    workspacePath = next;
    saveOpenWorkspaces(openWorkspaces, workspacePath);
    uiHost?.setWorkspacePath(workspacePath);
    if (!next && windowMode === 'floating') {
      // 打开集合为空：浮窗没有添加目录的入口，退回完整模式（规格 §10）
      void applyWindowMode('normal');
    }
    syncChatAreaForActiveWorkspace();
  } else {
    saveOpenWorkspaces(openWorkspaces, workspacePath);
  }
  // 通知 Client 销毁该工作区的 Connection（Standalone 下关闭 Core 进程）
  emitWorkspaceChange('closed', ref);
  setupMenu();
  pushTitlebarModeState();
  syncWindowTitle();
  syncTitlebarWorkspaces();
  broadcastWorkspaces();
}

/**
 * 判定一个工作区不可用（本地目录不存在 / 远程建连失败）：标记后销毁它的死
 * Connection 与对话视图。**活动项不变**（不回退到别的标签页）：活动项落在其上时，
 * 聊天区由 `syncChatAreaForActiveWorkspace` 改显占位页。标签页保留在打开集合里
 * （红点），可以点击激活，远程不可连时占位页提供「重新连接」按钮。
 */
function markWorkspaceUnavailable(ref: WorkspaceRef, reason: string, mode: 'build' | 'runtime' = 'build'): void {
  const key = refKey(ref);
  // 状态机先落定（含清掉建链中）：曾就绪过 = 工作区事实上可用（探测与建链竞态的
  // 输家不该否定赢家）；重复标记同样返回 false。两条守卫下副作用都不重复执行。
  // runtime（运行期致命，仅远程 lost）：撤销就绪豁免后落定——daemon / 链路死亡
  // 在 Host 侧无法自动恢复，与建链失败同样标红
  const changed = mode === 'runtime'
    ? workspaceAvailabilityState.markRuntimeFatal(key)
    : workspaceAvailabilityState.markUnavailable(key);
  fileLogger.info(
    'workspace-tab',
    `markUnavailable ${refDisplay(ref)}: changed=${changed}, now=${workspaceAvailabilityState.availabilityOf(key)} (${reason})`,
  );
  if (!changed) return;
  console.warn(`[main] workspace unavailable: ${refDisplay(ref)} (${reason})`);
  workspaceAvailabilityState.clearReady(key);
  // 状态已落定，**先推送再清理**：推送是标签页红点 / 侧栏状态的唯一来源，不能排在
  // 可能抛错的清理步骤后面——实测回归：销毁该目录的预加载对话视图抛错（standalone
  // 会话释放路径）吞掉了整段推送，标签页黄点一直挂到用户点击标签页才刷新
  syncTitlebarWorkspaces();
  broadcastWorkspaces();
  // 该工作区的 Connection 已无法建立：让 Client 销毁（含仍在长超时里挂着的建链尝试），
  // 不留半开的死连接（尚未建立 Connection 的项是空操作）
  emitWorkspaceChange('closed', ref);
  // 该目录下的对话视图一并销毁：会话所属的 Core 已不存在，视图内容不再有效
  // （侧栏「已打开会话」与活动会话随之清空，由 ChatViewManager 推送）
  try {
    chatViews?.closeWorkspace(ref.path);
  } catch (err) {
    // 清理失败不阻断状态收敛（上面已推送）；只留诊断日志
    fileLogger.error('workspace-tab', `closeWorkspace(${refDisplay(ref)}) failed: ${String(err)}`);
  }
  if (sameRef(workspacePath, ref)) {
    syncChatAreaForActiveWorkspace();
  }
}

/**
 * 重连一个不可用的工作区（占位页「重新连接」按钮触发）：红点先变黄色呼吸点
 * （建链中），经 `probeRemoteEndpoint`（3 秒建链超时，远端引导不计入）重新建链——
 * 成功则撤销不可用判定、重新走 opened 建立 Connection 并把聊天区切回对话视图；
 * 失败回到红点。本地项的重试只校验目录是否重新存在。建链中重复触发忽略；标签页被关闭则中止。
 */
async function reconnectWorkspace(id: string): Promise<void> {
  const ref = openWorkspaces.find((candidate) => refKey(candidate) === id);
  if (!ref || workspaceAvailability(ref) !== 'unavailable') return;
  const key = refKey(ref);
  workspaceAvailabilityState.markConnecting(key);
  syncTitlebarWorkspaces();
  if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
  try {
    if (ref.endpoint) {
      const { probeRemoteEndpoint } = require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');
      await probeRemoteEndpoint(ref.endpoint, CONNECT_PROBE_TIMEOUT_MS);
    } else if (!isValidWorkspaceDir(ref.path)) {
      throw new Error(`本地目录仍不存在：${ref.path}`);
    }
    // 等待期间标签页可能已被关闭：不再补建 Connection
    if (!openWorkspaces.some((candidate) => refKey(candidate) === key)) return;
    workspaceAvailabilityState.clearAll(key);
    emitWorkspaceChange('opened', ref);
    activateWorkspace(ref);
  } catch (err) {
    console.warn(`[main] workspace reconnect failed: ${refDisplay(ref)}:`, err);
  } finally {
    // 先落定状态再刷新：成功 → 可用；失败 → 回到红点。
    // 占位页必须与标签页同批刷新，否则会停留在「正在连接」（tab 已是红点）
    workspaceAvailabilityState.clearConnecting(key);
    syncTitlebarWorkspaces();
    if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
  }
}

/** 会话所属工作区是否可打开对话视图（建链中 / 不可用的目录只显占位页，不开视图） */
function isWorkspaceUsableForConversation(workspace: string | undefined): boolean {
  if (!workspace) return true;
  const ref = openWorkspaces.find((candidate) => workspacePathMatches(candidate, workspace));
  return !ref || workspaceAvailability(ref) === 'available';
}

/**
 * 把聊天区对齐当前活动工作区（活动项变化 / 可用性变化时调用）：
 * - 可用 → 正常显示该目录的对话视图；
 * - 建链中 / 不可用 → **不显示对话列表与 webview**，改显占位页
 *   （连接中 / 目录不存在 / 无法连接远程主机 + 「重新连接」按钮）；
 * - 未打开工作区 → 原有空态视图（含「打开本地工作区」入口）。
 */
function syncChatAreaForActiveWorkspace(): void {
  if (!chatViews) return;
  if (!workspacePath) {
    chatViews.showChatPlaceholder(null);
    chatViews.setWorkspacePath('');
    chatViews.disposeAll();
    chatViews.openNewConversation('');
    return;
  }
  const availability = workspaceAvailability(workspacePath);
  if (availability === 'available') {
    chatViews.showChatPlaceholder(null);
    // setActiveWorkspace 负责更新 opts.workspacePath 并清理旧目录的预热视图
    chatViews.setActiveWorkspace(workspacePath.path);
    return;
  }
  // 该目录的对话不可用：清空侧栏对话列表（上一目录的列表不再适用）
  conversations?.clearConversationList();
  chatViews.setWorkspacePath(workspacePath.path);
  chatViews.showChatPlaceholder(
    getChatPlaceholderHtml({
      kind: availability === 'connecting'
        ? 'connecting'
        : workspacePath.endpoint
          ? 'remoteUnreachable'
          : 'dirMissing',
      path: refDisplay(workspacePath),
    }),
  );
}

/**
 * 启动期探测上一次打开的远程工作区（`probeRemoteEndpoint`，3 秒建链超时，远端
 * 引导不计入——冷部署上传产物可能远超 3 秒）。
 *
 * 远程标签页从启动起就处于 connecting（黄色呼吸点），聊天区显示「正在连接」占位页；
 * 探测落定后二选一：成功 → 恢复可选，活动项落在其上时占位页切回对话视图；
 * 失败 → 红点 + 占位页换「无法连接远程主机」（活动项不变）。探测直接走传输层短
 * 超时——正式连接的建链超时（SSH 120 秒）远超用户等待阈值，失败信号必须由探测先
 * 给出。daemon 存活但工作区 channel 建失败等形态由 `onWorkspaceConnectionState`
 * 的 lost 信号兜底（见 initCore 的订阅）。
 */
function probeStartupRemoteWorkspaces(): void {
  // 同一 endpoint（host/port/user + 凭证，凭证不同即不同 daemon）只探测一次
  const groups = new Map<string, { endpoint: WorkspaceEndpoint; display: string; refs: WorkspaceRef[] }>();
  for (const ref of openWorkspaces) {
    const endpoint = ref.endpoint;
    if (!endpoint || !workspaceAvailabilityState.hasConnecting(refKey(ref))) continue;
    const key = JSON.stringify(endpoint);
    const group = groups.get(key);
    if (group) {
      group.refs.push(ref);
    } else {
      groups.set(key, { endpoint, display: refDisplay(ref), refs: [ref] });
    }
  }
  const { probeRemoteEndpoint } = require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');
  for (const group of groups.values()) {
    void probeRemoteEndpoint(group.endpoint, CONNECT_PROBE_TIMEOUT_MS)
      .then(() => {
        for (const ref of group.refs) {
          const key = refKey(ref);
          if (!openWorkspaces.some((candidate) => refKey(candidate) === key)) continue;
          workspaceAvailabilityState.clearConnecting(key);
          // 探测期间 Connection 先死了一步（lost → 已标红）：endpoint 事实上可达，恢复并补建
          if (workspaceAvailabilityState.revokeUnavailable(key)) {
            workspaceAvailabilityState.clearReady(key);
            emitWorkspaceChange('opened', ref);
          }
        }
        // loading → 可用（红点撤销同理）：标题栏重渲染；活动项落在其上时占位页切回对话视图
        syncTitlebarWorkspaces();
        syncChatAreaForActiveWorkspace();
      })
      .catch((err: unknown) => {
        fileLogger.info('workspace-tab', `probe failed (${group.display}): ${String(err)}`);
        console.error(`[main] remote workspace unreachable (${group.display}):`, err);
        for (const ref of group.refs) {
          workspaceAvailabilityState.clearConnecting(refKey(ref));
          // 已标红过（lost 信号先到）时 markWorkspaceUnavailable 内部不再重复刷新：
          // 探测落定是「黄点必须收场」的最后时限，这里与成功分支对称地显式刷一次，
          // 保证标题栏与聊天区一定画出落定后的状态（红点 / 占位页）
          markWorkspaceUnavailable(ref, String(err));
        }
        syncTitlebarWorkspaces();
        syncChatAreaForActiveWorkspace();
      });
  }
}

/** 推送打开集合与活动项到侧栏 */
function broadcastWorkspaces(): void {
  sidebarView?.webContents.send('sidebar:workspaces-changed', sidebarWorkspaceState());
}

/**
 * 侧栏的工作区状态：全量打开集合 + 活动项 + 最近列表
 * （建链中 / 不可用的标签页同样是打开集合的一员，侧栏只以列表空态反映「无对话」）。
 */
function sidebarWorkspaceState(): {
  workspaces: Array<ReturnType<typeof workspaceTabState>>;
  active: string | null;
  recent: Array<ReturnType<typeof workspaceTabState>>;
} {
  return {
    workspaces: openWorkspaces.map((ref) => workspaceTabState(ref)),
    active: workspacePath ? refKey(workspacePath) : null,
    recent: recentWorkspaceTabs(),
  };
}

/**
 * Electron 宿主本地状态文件。
 * 位于 Electron userData 目录（Windows 下即 %APPDATA%\<PRODUCT_NAME>\），
 * 用于记录打开集合、活动工作目录与最近打开的工作目录列表（最多 10 个）；
 * windowSize / floatingWindowSize 分别记录完整模式与浮窗模式的上次窗口位置与大小
 * （两个模式各存一份，切换模式时按各自记录还原位置）；
 * windowMode / floatingPinned 记录上次使用的窗口模式与浮窗置顶状态，启动时优先按它们恢复；
 * theme / shortcut 是只有 Electron 消费的宿主本地偏好，core 不读不写。
 * 文件格式：
 * {
 *   "openWorkspaces": ["C:\\path\\to\\ws", { "scheme": "ssh", "path": "/home/pz", "endpoint": {...} }],
 *   "activeWorkspace": "C:\\path\\to\\ws2",
 *   "recentWorkspaces": ["C:\\path\\to\\ws2", { "scheme": "tcp", "path": "/srv", "endpoint": {...} }],
 *   "recentSshConnections": [{ "host": "192.168.1.5", "port": 22, "user": "root", "password": "…" }],
 *   "windowSize": { "x": 320, "y": 180, "width": 1280, "height": 860 },
 *   "floatingWindowSize": { "x": 1500, "y": 120, "width": 480, "height": 780 },
 *   "windowMode": "floating",
 *   "floatingPinned": true,
 *   "theme": "system",
 *   "shortcut": "Ctrl+Alt+X"
 * }
 *
 * 本地项写字符串（旧版本格式，读取时按本地引用迁移），远程项写 `SerializedWorkspaceRef`。
 * **远程凭证（token / SSH 口令）随 endpoint 一起明文落盘**：重启后要能直接恢复并打开
 * 已连接过的工作区（`docs/client-connection.md` 第 9 节）。
 *
 * 读取口径：字段缺失或非法即按「没有」处理，不做任何跨字段回退
 * （例如 openWorkspaces 缺失就是没有打开任何工作目录）。
 */
const MAX_RECENT_WORKSPACES = 10;

/** 窗口位置与大小（x/y 可缺失：历史版本只存过宽高） */
interface WindowRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface WorkspaceState {
  /**
   * 打开集合：按标签页顺序排列。新版本写 `SerializedWorkspaceRef`（含远程项）；
   * 旧版本写本地路径字符串，读取时按本地引用迁移。
   */
  openWorkspaces?: Array<string | SerializedWorkspaceRef>;
  /** 活动工作区 id（`workspaceRefKey`）；无活动项时为 null */
  activeWorkspaceKey?: string | null;
  /** 旧版本的活动工作目录（本地路径）；读取时按本地引用迁移 */
  activeWorkspace?: string | null;
  /** 最近打开的工作区：与 `openWorkspaces` 同格式（字符串 = 本地路径） */
  recentWorkspaces?: Array<string | SerializedWorkspaceRef>;
  /**
   * SSH 连接历史（`docs/client-connection.md` 第 9 节）：最近连接在前，最多 20 条。
   * **口令明文落盘**——历史的作用就是下次一键回填表单（host / 端口 / 用户 / 口令）。
   */
  recentSshConnections?: SshHistoryEntry[];
  /** 完整模式窗口位置与大小（字段名沿用 windowSize，现在同时存位置） */
  windowSize?: WindowRect;
  /** 悬浮窗模式窗口位置与大小；与完整模式独立存储 */
  floatingWindowSize?: WindowRect;
  /** 上次退出时的窗口模式：启动时优先按它恢复 */
  windowMode?: 'normal' | 'floating';
  /** 浮窗「总在最前」状态：启动时优先按它恢复（默认 true） */
  floatingPinned?: boolean;
  /** 主题模式：跟随系统 / 强制浅色 / 强制深色（宿主本地偏好，core 不读） */
  theme?: ThemeMode;
  /** 唤醒快捷键（Electron accelerator 形式；宿主本地偏好，core 不读） */
  shortcut?: string;
}

function getWorkspaceStateFile(): string {
  return path.join(app.getPath('userData'), 'workspace-state.json');
}

/** 读取工作区状态文件（损坏/不存在时返回空对象） */
function readWorkspaceState(): WorkspaceState {
  try {
    const file = getWorkspaceStateFile();
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || typeof data !== 'object') return {};
    return data as WorkspaceState;
  } catch {
    // 读取失败时忽略，回到未选择工作区状态
    return {};
  }
}

/** 写回完整状态（调用方负责先 read 再合并，避免覆盖其它字段） */
function writeWorkspaceState(state: WorkspaceState): void {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getWorkspaceStateFile(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[main] Failed to write workspace state:', err);
  }
}

// ==================== 宿主本地偏好：theme / shortcut ====================

/**
 * 主题模式：
 * - 'system' 跟随系统（产品默认值）
 * - 'light'  强制浅色
 * - 'dark'   强制深色
 */
type ThemeMode = 'system' | 'light' | 'dark';

/** 判断任意值是否为合法主题模式 */
function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** 读取持久化的主题模式（缺失 / 非法时回退跟随系统） */
function readThemeModeSync(): ThemeMode {
  const value = readWorkspaceState().theme;
  return isThemeMode(value) ? value : 'system';
}

/** 持久化主题模式 */
function writeThemeMode(mode: ThemeMode): void {
  writeWorkspaceState({ ...readWorkspaceState(), theme: mode });
}

/** 读取持久化的唤醒快捷键（缺失 / 非法时回退默认值） */
function readWakeShortcutSync(): string {
  return normalizeAccelerator(readWorkspaceState().shortcut) || DEFAULT_WAKE_SHORTCUT;
}

/** 持久化唤醒快捷键（调用方已规范化） */
function writeWakeShortcut(shortcut: string): void {
  writeWorkspaceState({ ...readWorkspaceState(), shortcut });
}

/**
 * 一次性迁移：把旧版本写在 core settings.json 里的 `theme` / `shortcut` 搬进状态文件。
 *
 * 幂等：状态文件里两个字段都已存在时跳过。settings.json 的旧字段不删除（该文件的
 * 写盘归 core，宿主不再触碰），读取路径只认状态文件。
 */
function migrateLegacyThemeAndShortcut(): void {
  try {
    const state = readWorkspaceState();
    if (state.theme !== undefined && state.shortcut !== undefined) return;

    const legacy = readLegacySettingsFields();
    if (!legacy) return;

    const next: WorkspaceState = { ...state };
    if (next.theme === undefined && isThemeMode(legacy.theme)) next.theme = legacy.theme;
    if (next.shortcut === undefined) {
      const shortcut = normalizeAccelerator(legacy.shortcut);
      if (shortcut) next.shortcut = shortcut;
    }
    if (next.theme === state.theme && next.shortcut === state.shortcut) return;
    writeWorkspaceState(next);
  } catch (err) {
    console.error('[main] Failed to migrate legacy theme/shortcut:', err);
  }
}

/** 读取旧版本位于 settings.json 的 theme / shortcut（失败时返回 null） */
function readLegacySettingsFields(): { theme?: unknown; shortcut?: unknown } | null {
  try {
    // 与 SettingsStore 同一口径读旧配置，避免 app.getPath('home') 与宿主口径分叉
    const file = path.join(resolveConfigDir(), SETTINGS_FILE_NAME);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!data || typeof data !== 'object') return null;
    return data as { theme?: unknown; shortcut?: unknown };
  } catch {
    return null;
  }
}

/**
 * 一次性迁移旧版本的状态文件（只在目标文件不存在时执行）：
 *
 * 1. userData 目录：新版本显式指定为 `appData/<extensionName>`；旧版本打包态落在
 *    `appData/<productName>`（"Tuxedo Cat"），开发态落在 `appData/Electron`。
 * 2. 字段：旧版本只记单个 `lastWorkspace`，新版本记 `openWorkspaces` /
 *    `activeWorkspace`。迁移时把 lastWorkspace 提升为打开集合的唯一一项。
 *
 * 不做跨字段回退（读取路径仍严格要求 openWorkspaces），迁移只发生在这里一次。
 */
function migrateLegacyWorkspaceState(): void {
  try {
    const targetFile = getWorkspaceStateFile();
    if (fs.existsSync(targetFile)) return;

    const candidates = [PRODUCT_NAME, 'Electron']
      .map((name) => path.join(app.getPath('appData'), name, 'workspace-state.json'))
      .filter((file) => file !== targetFile);

    for (const legacyFile of candidates) {
      if (!fs.existsSync(legacyFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf-8')) as
          (WorkspaceState & { lastWorkspace?: unknown }) | null;
        if (!raw || typeof raw !== 'object') continue;

        const { lastWorkspace, ...rest } = raw;
        // 只做形状过滤、不按「目录存在」过滤：迁移后的读取路径（readOpenWorkspaces）
        // 会把目录已不存在的本地项标记为不可用（红点 + 禁选），不在这里静默丢弃
        const legacyOpen = Array.isArray(raw.openWorkspaces)
          ? raw.openWorkspaces.filter(
              (ws): ws is string => typeof ws === 'string' && ws.trim().length > 0,
            )
          : [];
        const legacyLast = isValidWorkspaceDir(lastWorkspace) ? normalizeWorkspacePath(lastWorkspace) : undefined;
        const open = dedupeWorkspacePaths(legacyOpen.length > 0 ? legacyOpen : legacyLast ? [legacyLast] : []);
        const legacyActive =
          typeof raw.activeWorkspace === 'string' && raw.activeWorkspace ? raw.activeWorkspace : undefined;
        const fallbackActive = legacyLast ?? (open.length > 0 ? open[open.length - 1] : undefined);
        const active = legacyActive
          ? open.find((w) => sameWorkspace(w, legacyActive)) ?? fallbackActive
          : fallbackActive;

        writeWorkspaceState({
          ...rest,
          openWorkspaces: open,
          activeWorkspace: active ?? null,
        });
        console.log(`[main] migrated legacy workspace state from ${legacyFile}`);
        return;
      } catch (err) {
        // 单个候选文件损坏不影响尝试下一个候选
        console.error(`[main] Failed to migrate legacy workspace state from ${legacyFile}:`, err);
      }
    }
  } catch (err) {
    console.error('[main] Failed to migrate legacy workspace state:', err);
  }
}

/**
 * 判断路径是否仍为存在的目录。
 * 只 stat 一次并吞掉异常：existsSync + statSync 的组合在「检查后目录被删 / 无权限」
 * 时会抛错，而调用点（启动恢复、IPC 添加目录）都在没有 try/catch 的路径上。
 */
function isValidWorkspaceDir(p: unknown): p is string {
  if (typeof p !== 'string' || p.trim().length === 0) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 序列化一个工作区引用（落盘形态见 `src/host/workspaceState.ts`） */
function serializeWorkspaceRef(ref: WorkspaceRef): SerializedWorkspaceRef {
  return serializeWorkspaceRefShared(ref);
}

/** 反序列化一条落盘项；本地项要求目录仍存在 */
function parseWorkspaceEntry(entry: unknown): WorkspaceRef | null {
  return parseWorkspaceEntryShared(entry, isValidWorkspaceDir);
}

/**
 * 读取打开集合（按引用去重）。本地项**保留**目录已不存在的条目并标记为不可用
 * （标签页显示红点并禁选，见 `workspaceAvailability` 状态机）；远程项原样保留，可达性由
 * 启动探测（`probeStartupRemoteWorkspaces`）异步判定。
 * `openWorkspaces` 缺失 / 非法即视为「没有打开任何工作目录」，不回退到其它字段。
 */
function readOpenWorkspaces(): WorkspaceRef[] {
  const { openWorkspaces } = readWorkspaceState();
  if (!Array.isArray(openWorkspaces)) return [];
  const refs: WorkspaceRef[] = [];
  const seen = new Set<string>();
  for (const entry of openWorkspaces) {
    // 本地项不在这里按「目录存在」过滤（与最近列表的口径不同）：上次打开过的目录
    // 该由用户决定何时关闭标签页，宿主只负责标记不可用，不做静默丢弃
    const ref = parseWorkspaceEntryShared(entry, () => true);
    if (!ref || ref.path.length === 0) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.endpoint === null && !isValidWorkspaceDir(ref.path)) {
      workspaceAvailabilityState.markUnavailable(key);
    }
    refs.push(ref);
  }
  return refs;
}

/** 读取活动工作区（必须属于打开集合；字段缺失 / 不在集合中时取最后一项） */
function readActiveWorkspace(open: readonly WorkspaceRef[]): WorkspaceRef | undefined {
  const { activeWorkspaceKey, activeWorkspace } = readWorkspaceState();
  if (typeof activeWorkspaceKey === 'string' && activeWorkspaceKey) {
    const found = open.find((ref) => refKey(ref) === activeWorkspaceKey);
    if (found) return found;
  }
  // 旧版本只记本地路径
  if (typeof activeWorkspace === 'string' && activeWorkspace) {
    const found = open.find(
      (ref) => ref.endpoint === null && sameWorkspace(ref.path, activeWorkspace),
    );
    if (found) return found;
  }
  return open.length > 0 ? open[open.length - 1] : undefined;
}

/**
 * 保存打开集合与活动项（顺带清掉旧版本遗留的 lastWorkspace 字段）。
 *
 * 远程项与本地项一起落盘：endpoint 连同凭证（token / SSH 口令）写进宿主本地状态文件，
 * 重启后直接恢复并重新连接（见 `docs/client-connection.md` 第 9 节）。
 */
function saveOpenWorkspaces(open: readonly WorkspaceRef[], active: WorkspaceRef | undefined): void {
  const prev = readWorkspaceState() as WorkspaceState & { lastWorkspace?: unknown };
  const { lastWorkspace: _legacy, ...rest } = prev;
  writeWorkspaceState({
    ...rest,
    openWorkspaces: open.map((ref) => serializeWorkspaceRef(ref)),
    // 无活动项时写 null（而不是 undefined：JSON.stringify 会省略该键，与规格 §11 不符）
    activeWorkspaceKey: active ? refKey(active) : null,
    // 旧字段：只在活动项是本地目录时保留，方便旧版本读取
    activeWorkspace: active && active.endpoint === null ? active.path : null,
  });
}

/**
 * 读取最近打开的工作区（本地项过滤掉已不存在的目录，远程项无法检查、原样保留），
 * 按去重键去重，最多 10 个，最近的在最前。
 * 同一目录的不同表示（尾部分隔符 / 大小写 / 符号链接等）只保留最靠前的一条。
 */
function readRecentWorkspaces(): WorkspaceRef[] {
  const { recentWorkspaces } = readWorkspaceState();
  if (!Array.isArray(recentWorkspaces)) return [];
  const refs: WorkspaceRef[] = [];
  const seen = new Set<string>();
  for (const entry of recentWorkspaces) {
    const ref = parseWorkspaceEntry(entry);
    if (!ref) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.slice(0, MAX_RECENT_WORKSPACES);
}

/** 把工作区置顶写入最近列表（按去重键去重、最多 10 个） */
function rememberRecentWorkspace(ref: WorkspaceRef): void {
  const prev = readWorkspaceState();
  const key = refKey(ref);
  const prevRecents = readRecentWorkspaces();
  const recentWorkspaces = [serializeWorkspaceRef(ref), ...prevRecents
    .filter((candidate) => refKey(candidate) !== key)
    .map((candidate) => serializeWorkspaceRef(candidate))]
    .slice(0, MAX_RECENT_WORKSPACES);
  writeWorkspaceState({ ...prev, recentWorkspaces });
}

// ==================== SSH 连接历史（「打开远程工作区」表单回填） ====================

/** 读取 SSH 连接历史（最近连接在前；形状不合法的项整项丢弃，见 `parseSshHistory`） */
function readSshHistory(): SshHistoryEntry[] {
  return parseSshHistory(readWorkspaceState().recentSshConnections);
}

/** SSH 接入成功后写入历史：同一 user@host:port 顶到最前并更新口令 */
function rememberSshConnection(entry: SshHistoryEntry): void {
  writeWorkspaceState({
    ...readWorkspaceState(),
    recentSshConnections: rememberSshEntry(readSshHistory(), entry),
  });
}

/** 各模式的最小窗口尺寸（读取历史尺寸时用于过滤非法值） */
function minWindowSizeFor(mode: WindowMode): { width: number; height: number } {
  return mode === 'floating'
    ? { width: MIN_FLOATING_WIDTH, height: MIN_FLOATING_HEIGHT }
    : { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT };
}

/**
 * 读取上次保存的窗口位置与大小（按模式区分）。
 * 宽高非法/缺失/小于该模式最小尺寸时返回 undefined，由调用方回退到默认值；
 * x/y 缺失（历史数据只存过宽高）时返回的对象里不带 x/y。
 */
function readSavedWindowRect(mode: WindowMode): { x?: number; y?: number; width: number; height: number } | undefined {
  const state = readWorkspaceState();
  const saved = mode === 'floating' ? state.floatingWindowSize : state.windowSize;
  if (!saved || typeof saved !== 'object') return undefined;
  const width = Math.round(Number(saved.width));
  const height = Math.round(Number(saved.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const min = minWindowSizeFor(mode);
  if (width < min.width || height < min.height) return undefined;
  const x = Math.round(Number(saved.x));
  const y = Math.round(Number(saved.y));
  const hasPosition = Number.isFinite(x) && Number.isFinite(y);
  return hasPosition ? { x, y, width, height } : { width, height };
}

/** 保存窗口位置与大小；完整模式与浮窗模式各存一份，互不覆盖 */
function saveWindowRect(mode: WindowMode, rect: { x: number; y: number; width: number; height: number }): void {
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
  const prev = readWorkspaceState();
  const saved: WindowRect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  writeWorkspaceState(
    mode === 'floating' ? { ...prev, floatingWindowSize: saved } : { ...prev, windowSize: saved },
  );
}

/** 判断矩形是否还有足够部分落在某个显示器工作区内（换屏 / 拔显示器后旧坐标可能失效） */
function isRectVisibleOnSomeDisplay(rect: { x: number; y: number; width: number; height: number }): boolean {
  // 至少要露出这么多，否则用户拖不回来
  const minVisibleX = 120;
  const minVisibleY = 40;
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x);
    const overlapY = Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y);
    return overlapX >= minVisibleX && overlapY >= minVisibleY;
  });
}

/** 浮窗模式的默认尺寸：宽 480，高度取主屏工作区高度的 80%（位置沿用当前窗口） */
function defaultFloatingWindowRect(): { width: number; height: number } {
  const { height: workAreaHeight } = screen.getPrimaryDisplay().workAreaSize;
  return { width: FLOATING_WINDOW_WIDTH, height: Math.max(MIN_FLOATING_HEIGHT, Math.round(workAreaHeight * 0.8)) };
}

/**
 * 关闭一个对话：卸运行时内存 + 销毁聊天视图。
 *
 * 侧栏「关闭」与聊天视图顶栏关闭按钮共用这一个入口——两条入口只是触发位置不同，
 * 「非 idle 先二次确认、再走 WebViewUI.closeConversation」这条序列必须一致。
 * 非 idle（查询 / 压缩 / 后台 Bash / 子代理 / 等待用户）时关闭会中止这些运行，
 * 所以先问一次；`new-` 临时 key 未登记运行时事实，视为空闲、不问。
 */
async function closeConversationWithConfirm(sessionId: string): Promise<void> {
  if (sessionIsBusy(sessionId) && !(await confirmCloseBusy(
    tt('该对话正在运行', 'This conversation is still running'),
    tt('关闭后正在进行的运行会被中止。确定关闭？', 'Closing stops the running work. Close anyway?'),
  ))) return;
  webviewUi?.closeConversation(sessionId);
}

/**
 * 删除一个对话（含子会话闭包）：宿主关视图 + core 删盘。
 *
 * 侧栏「删除」与 webview 顶栏「删除」共用这一个入口——两条入口只是触发位置不同，
 * 「关掉该会话的视图、再删盘」这条序列必须一致。
 *
 * 宿主只负责「关视图」：对受影响闭包逐个调 WebViewUI.closeConversation（卸内存 +
 * 销毁视图，5.5 节约定顺序）。闭包由 core 的 collectConversationClosure 算出——
 * 与 deleteConversation 同一条规则，不再在宿主里重写一遍；删盘与列表广播由 core 的
 * conversationDeleted 订阅（deleteConversation → conversationListChanged）承担。
 * 删掉的是当前视图时，关视图后的善后（另开一个新对话视图）由
 * ChatViewManager.switchAwayFromClosedSession 完成。
 */
async function deleteConversationWithViews(sessionId: string): Promise<void> {
  // 先刷新会话工作目录索引：下面按该会话自己的工作目录读列表
  syncSessionWorkspaceIndex();
  // 登记该会话的工作目录：core 的 deleteConversation 按 sessionId 解析工作目录，
  // 未登记时会回退到活动工作目录，导致删错目录（与 rename / smart-name 同口径）。
  // 必须在下面删除索引条目之前取，否则 root 自身的映射已被移除。
  const deleteWs = sessionWorkspaces.get(sessionId);
  if (deleteWs) void registerCoreSessionWorkspace(sessionId, deleteWs);
  const { loadConversationList, collectConversationClosure } = await import('../src/core/history/index.js');
  // 按该会话自己的工作目录读列表：删除的对话可能不在当前活动工作目录
  const affected = collectConversationClosure(
    sessionId,
    await loadConversationList(sessionWorkspaces.get(sessionId)),
  );
  for (const sid of affected) {
    webviewUi?.closeConversation(sid);
    // 宿主索引同步清理：会话已删除，避免陈旧 sessionId → 目录 条目长期残留
    sessionWorkspaces.delete(sid);
  }
  // 删盘（core 消费方：算闭包已由宿主完成，这里只发 root）
  const { requireEventBus } = await import('../src/core/AssistantEventBus.js');
  requireEventBus().emitToCore({ type: 'conversationDeleted', sessionId });
}

/**
 * 处理一条来自 webview（原生聊天视图）的消息。
 * 与 extension.ts AssistantViewProvider 的专用消息处理保持一致，
 * 其余消息统一委托给 WebViewUI（复用同一份 WebviewMessageHandler）。
 */
function handleWebviewMessageFromSource(sender: Electron.WebContents, message: WebviewToHostMessage): void {
  if (!message || typeof message.type !== 'string') return;

  const ui = webviewUi;
  if (!ui) return;
  // IPC 边界：sessionId 是否随消息携带因 type 而异，运行时探测（wire 无类型）
  const rawSessionId = (message as { sessionId?: unknown }).sessionId;
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

  // 用户发出了新对话的第一条消息：该会话开始落盘，不再是「新建但还没发过消息」的对话。
  // 清除该标记后，下次点侧栏「新建」才会创建新的聊天视图，而不是复用这个已有内容的对话。
  if (message.type === 'sendMessage' && sessionId) {
    chatViews?.markSessionUsed(sessionId);
  }

  // 视图的会话身份变化时，把临时 new- 视图转为正式会话条目。
  // 只有这两条消息表达「这个视图现在是哪个会话」：
  // - startNewConversation：webview 新建对话（含预热视图激活）
  // - loadConversation：webview 请求加载某个会话（用户手动切换 / 打开某对话）
  // 对「key 已经等于 sessionId」的调用，registerSession 是提前返回的空操作。
  if (message.type === 'startNewConversation' || message.type === 'loadConversation') {
    if (sessionId) {
      // 该视图自己的工作目录是权威来源（新建对话继承它；加载对话本就属于它）
      const workspace = chatViews?.getWorkspaceForWebContents(sender);
      chatViews?.registerSession(sender, sessionId);
      const resolved = workspace ?? chatViews?.getWorkspaceForKey(sessionId);
      if (resolved) {
        const p = canonicalWorkspacePath(resolved);
        sessionWorkspaces.set(sessionId, p);
        void registerCoreSessionWorkspace(sessionId, p);
      }
    }
  }

  // webview 内点击子代理/回复/From 链接等跳转到指定会话：新起一个 webview 加载该对话
  if (message.type === 'openConversation') {
    if (sessionId) {
      syncSessionWorkspaceIndex();
      const workspace = sessionWorkspaces.get(sessionId);
      // 会话所属目录建链中 / 不可用：不开对话视图（聊天区由占位页占据）
      if (!isWorkspaceUsableForConversation(workspace)) {
        console.warn('[main] ignore open-conversation for non-available workspace:', workspace);
        return;
      }
      if (workspace) void registerCoreSessionWorkspace(sessionId, workspace);
      activateWorkspaceForPath(workspace);
      chatViews?.openConversation(sessionId, workspace);
    }
    return;
  }

  // webview 顶栏「+」（浮窗没有原生侧栏，新建入口搬到顶栏）：新起一个 webview 新建对话。
  // 单视图宿主不会发这条消息——webview 按 openConversationModeOf 分支，原地新建走
  // startNewConversation。工作目录取来源视图自己的工作目录，新对话与它同目录。
  if (message.type === 'openNewConversation') {
    chatViews?.openNewConversation(chatViews?.getWorkspaceForWebContents(sender));
    return;
  }

  // 删除对话：视图生命周期归宿主——多视图宿主删除时要连同该会话的视图（含子会话闭包）
  // 一起关，再删盘；关掉当前视图后由 switchAwayFromClosedSession 补一个新对话视图。
  // 单视图宿主没有可关的视图，删除仍走 WebviewMessageHandler 的 UiEvent 翻译。
  if (message.type === 'deleteConversation') {
    if (sessionId) {
      void deleteConversationWithViews(sessionId).catch((err) => {
        console.error('[main] deleteConversation (webview) error:', err);
      });
    }
    return;
  }

  // 关闭按钮：卸内存 + 销毁视图走 WebViewUI.closeConversation（与侧栏「关闭」同一入口，
  // 含非 idle 时的二次确认）。会话 id 在关视图前反查——视图关掉后就查不到了。
  // loaded 变化由 ChatViewManager 单独推给侧栏，列表变化由 core 的 conversationListChanged 推。
  if (message.type === 'closeWebview') {
    const key = chatViews?.getKeyByWebContents(sender);
    if (key) void closeConversationWithConfirm(key);
    return;
  }

  // 后台预热视图报告「已挂载」：若它已被切到前台，补发激活消息
  // （用户可能在页面加载完成前就点了「新建」）
  if (message.type === 'prewarmViewReady') {
    chatViews?.handlePrewarmViewReady(sender);
    return;
  }

  // webview 内“打开工作区”按钮（未设置工作区时的引导）
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

  // ── 自绘标题栏 IPC ──
  // 这些通道能退出应用、切换工作区、改窗口模式，必须校验来源（只接受标题栏 / 菜单视图）。
  ipcMain.handle('titlebar:get-state', (event) => {
    if (!isTitlebarSender(event.sender)) throw new Error('unauthorized: titlebar:get-state');
    fileLogger.info(
      'workspace-tab',
      `get-state v${workspaceStateVersion}: ${openWorkspaces.map((ref) => `${workspaceDisplayNameOf(ref)}=${workspaceAvailability(ref)}`).join(', ') || '(none)'}`,
    );
    return {
      platform: process.platform,
      productName: PRODUCT_NAME,
      maximized: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized(),
      sections: titlebarMenuSections.map((s) => ({ id: s.id, label: s.label })),
      mode: windowMode,
      pinned: windowMode === 'floating' && floatingPinned,
      canToggleMode: canToggleWindowMode(),
      // 浮窗没有侧栏，品牌位改显示当前工作目录名（浮窗标题栏的唯一上下文）
      workspaceName: workspaceDisplayName() || null,
      // 打开集合（标题栏标签页区渲染）与活动项；version 供渲染层丢弃陈旧回包
      version: workspaceStateVersion,
      workspaces: openWorkspaces.map((ref) => workspaceTabState(ref)),
      activeWorkspace: workspacePath ? refKey(workspacePath) : null,
      // 标签页流水灯：每个工作目录的聚合运行时状态（waiting 优先，其次 running）
      activity: collectWorkspaceActivity(),
      // 标题栏是独立页面，拿不到 core 的 i18n 上下文：文案由主进程按当前语言下发，
      // 避免中文 tooltip 与英文 aria-label 混排（原先写死在页面里）。
      labels: {
        minimize: tt('最小化', 'Minimize'),
        maximize: tt('最大化', 'Maximize'),
        restore: tt('还原', 'Restore'),
        close: tt('关闭', 'Close'),
        alwaysOnTop: tt('总在最前', 'Always on top'),
        unpin: tt('取消总在最前', 'Stop always on top'),
        toggleToFloating: tt('切换到悬浮窗模式', 'Switch to floating window'),
        toggleToFull: tt('切换到完整模式', 'Switch to full mode'),
        modeDisabled: tt('未打开工作区，无法切换', 'Open a workspace first to switch mode'),
        addWorkspace: tt('添加工作区', 'Add workspace'),
        closeWorkspace: tt('关闭工作区', 'Close workspace'),
        // 不可用标签页（红点）的悬停说明：远程看连接，本地看目录
        unavailableLocal: tt('本地目录不存在', 'Local folder not found'),
        unavailableRemote: tt('无法连接远程主机', 'Cannot reach remote host'),
        // 建链中标签页（loading）的悬停说明
        connecting: tt('正在连接', 'Connecting'),
      },
    };
  });

  ipcMain.on('titlebar:toggle-mode', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    void applyWindowMode(windowMode === 'floating' ? 'normal' : 'floating');
  });

  ipcMain.on('titlebar:toggle-pin', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    toggleFloatingPinned();
  });

  // ── 标题栏工作目录标签页 ──
  ipcMain.on('titlebar:activate-workspace', (event, p: unknown) => {
    if (!isTitlebarSender(event.sender)) return;
    if (typeof p === 'string' && p) activateWorkspace(p);
  });

  ipcMain.on('titlebar:close-workspace', (event, p: unknown) => {
    if (!isTitlebarSender(event.sender)) return;
    if (typeof p === 'string' && p) void closeWorkspace(p);
  });

  ipcMain.on('titlebar:add-workspace', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    void openWorkspaceDialog();
  });

  // 加号按钮：弹出「打开本地工作区 / 打开远程工作区」菜单
  ipcMain.on('titlebar:workspace-menu', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    popupWorkspaceMenu();
  });

  ipcMain.on('titlebar:reorder-workspaces', (event, paths: unknown) => {
    if (!isTitlebarSender(event.sender)) return;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return;
    reorderWorkspaces(paths as string[]);
  });

  ipcMain.on('titlebar:minimize', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // 浮窗模式：最小化 = 隐藏到系统托盘（不保留任务栏按钮）；完整模式最小化到任务栏
    if (windowMode === 'floating') {
      mainWindow.hide();
      return;
    }
    mainWindow.minimize();
  });

  ipcMain.on('titlebar:toggle-maximize', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('titlebar:close', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.on('titlebar:open-menu', (event, payload: { id?: string; anchorX?: number }) => {
    if (!isTitlebarSender(event.sender)) return;
    openTitlebarMenu(payload ?? {});
  });

  ipcMain.on('titlebar:close-menu', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    closeTitlebarMenu();
  });

  // ── 自绘下拉菜单窗口 IPC ──
  ipcMain.on('titlebar-menu:select', (event, id: string) => {
    if (!isTitlebarSender(event.sender)) return;
    // 只在菜单确实打开时接受选择：id 最终会在 invokeMenuAction 里按动作表校验
    if (!titlebarMenuOpenId) return;
    if (typeof id !== 'string' || !id) return;
    closeTitlebarMenu();
    invokeMenuAction(id);
  });

  ipcMain.on('titlebar-menu:close', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    closeTitlebarMenu();
  });

  ipcMain.on('titlebar-menu:resize', (event, size: { width?: number; height?: number }) => {
    if (!isTitlebarSender(event.sender)) return;
    positionTitlebarMenu(size ?? {});
  });

  // ── 侧栏 IPC ──
  // 列表流：纯磁盘元数据（单一来源 loadConversationList；loaded / running / waiting 走各自通道）
  ipcMain.handle('sidebar:get-conversations', async () => {
    // e2e 专用：注入列表拉取延迟，驱动侧栏等待态「转圈延时显示」的慢路径
    // （e2e/electron/sessions.spec.ts 的「等待超过 200ms 才显示加载中」用例）。
    // 同 --multi-instance：隐藏开关，不对外公开；未设置时无开销。
    const e2eSlowListMs = Number(process.env.TUXEDO_CAT_E2E_SLOW_LIST_MS);
    if (e2eSlowListMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, e2eSlowListMs));
    }
    // 优先返回该目录的列表快照（ConversationManager.getCachedList，每个目录各一份），
    // 切换标签页不再每次完整读盘 / 走网络往返——列表变化本来就会经
    // conversationListChanged 推送并更新快照。
    const cached = conversations?.getCachedList();
    if (conversations && cached) {
      // 快照可能过期（后台目录的对话视图落盘变化把快照标脏）：先返回快照让侧栏
      // 即时渲染，后台重新读盘，读到后经 sidebar:conversations-updated 补推。
      if (conversations.isCachedListStale()) void conversations.refresh();
      syncSessionWorkspaceIndex();
      return cached;
    }
    // 尚无快照（首次打开该目录）：读一次盘（refresh 顺带推送给侧栏并填充快照）
    if (!conversations) return [];
    try {
      await conversations.refresh();
      syncSessionWorkspaceIndex();
      return conversations.getCachedList() ?? [];
    } catch (err) {
      console.error('[main] sidebar:get-conversations error:', err);
      return [];
    }
  });

  // ── 聊天区占位页 ──
  // 「重新连接」按钮（占位页仅远程不可连时提供）：重试当前活动工作区的建链
  ipcMain.on('chat:reconnect-workspace', (event) => {
    if (!chatViews?.isChatPlaceholderWebContents(event.sender)) return;
    if (workspacePath) void reconnectWorkspace(refKey(workspacePath));
  });

  // 视图流：已打开会话集合（owner 是 ChatViewManager）
  ipcMain.handle('sidebar:get-loaded-sessions', () => {
    return chatViews?.getLoadedSessionIds() ?? [];
  });

  // 运行时状态流：最近一次全量快照（owner 是 core 的 sessionRuntime，宿主缓存的是它
  // 经 Connection 推来的投影）。状态流是「变化时才推」的：侧栏初始化 / 重载时主动拉
  // 一次，补上「推送早于侧栏就绪」造成的空档，否则流水灯 / 等待标记会一直不亮。
  // Standalone（产品形态）下 core 在独立进程，进程内 `src/core/sessionRuntime` 是空的，
  // 必须走这份缓存（第 12.6 节）。
  ipcMain.handle('sidebar:get-session-states', () => {
    return conversations?.getSessionStatesSnapshot() ?? [];
  });

  ipcMain.handle('sidebar:get-active-session', () => {
    return chatViews?.getActiveSessionId() ?? null;
  });

  // 工作目录流：打开集合 + 活动项 + 最近列表（可用子集，与侧栏推送同一形态）
  ipcMain.handle('sidebar:get-workspaces', () => sidebarWorkspaceState());

  ipcMain.on('sidebar:add-workspaces', (_event, paths?: unknown) => {
    if (Array.isArray(paths) && paths.every((p) => typeof p === 'string')) {
      addWorkspaces(paths as string[]);
    } else {
      void openWorkspaceDialog();
    }
  });

  // 侧栏「最近打开」点击：按 id 回查引用后打开。
  // 打开集合里已有就激活（addWorkspaceRefs 只激活不新建），没有则按落盘的凭证重连。
  ipcMain.on('sidebar:open-workspace', (_event, id?: unknown) => {
    if (typeof id !== 'string' || id.length === 0) return;
    const target = openWorkspaces.find((ref) => refKey(ref) === id)
      ?? readRecentWorkspaces().find((ref) => refKey(ref) === id);
    if (!target) return;
    addWorkspaceRefs([target]);
  });

  ipcMain.on('sidebar:activate-workspace', (_event, p: unknown) => {
    if (typeof p === 'string' && p) activateWorkspace(p);
  });

  ipcMain.on('sidebar:close-workspace', (_event, p: unknown) => {
    if (typeof p === 'string' && p) void closeWorkspace(p);
  });

  ipcMain.on('sidebar:open-conversation', (_event, sessionId: string, project?: string) => {
    if (typeof sessionId === 'string' && sessionId) {
      if (typeof project === 'string' && project) {
        // 只接受仍处于打开集合中的目录：陈旧列表项（工作目录已关闭）不得把
        // 会话重新登记到已关闭目录，否则会打开一张没有对应标签页的视图
        const projectPath = canonicalWorkspacePath(project);
        if (!openWorkspaces.some((ref) => workspacePathMatches(ref, projectPath))) {
          console.warn('[main] ignore open-conversation for closed workspace:', projectPath);
          return;
        }
        // 目录建链中 / 不可用：不开对话视图（聊天区由占位页占据）
        if (!isWorkspaceUsableForConversation(projectPath)) {
          console.warn('[main] ignore open-conversation for non-available workspace:', projectPath);
          return;
        }
        sessionWorkspaces.set(sessionId, projectPath);
      }
      const workspace = sessionWorkspaces.get(sessionId);
      if (workspace) void registerCoreSessionWorkspace(sessionId, workspace);
      activateWorkspaceForPath(workspace);
      chatViews?.openConversation(sessionId, workspace);
    }
  });

  ipcMain.on('sidebar:new-conversation', () => {
    // 活动工作区建链中 / 不可用：没有可用的对话视图，占位页期间忽略新建
    if (workspacePath && workspaceAvailability(workspacePath) !== 'available') {
      console.warn('[main] ignore new-conversation for non-available workspace:', refDisplay(workspacePath));
      return;
    }
    chatViews?.openNewConversation(workspacePath?.path ?? '');
  });

  // 关闭指定会话（UI → core 走 WebViewUI.closeConversation：
  // 发 UiEvent.conversationClosed 卸内存 + 宿主销毁视图；列表刷新走 conversationListChanged 流）。
  // 该对话非 idle 时先让用户二次确认，见 closeConversationWithConfirm。
  ipcMain.on('sidebar:close-conversation', (_event, sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId) {
      void closeConversationWithConfirm(sessionId);
    }
  });

  // ── 侧栏对话操作：删除 / 重命名 / 智能命名 ──
  ipcMain.handle('sidebar:delete-conversation', async (_event, sessionId: string) => {
    try {
      await deleteConversationWithViews(sessionId);
      return { ok: true };
    } catch (err) {
      console.error('[main] sidebar:delete-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('sidebar:rename-conversation', async (_event, sessionId: string, title: string) => {
    try {
      // 登记该会话的工作目录：core 写 meta.json 时按会话解析工作目录
      syncSessionWorkspaceIndex();
      const renameWs = sessionWorkspaces.get(sessionId);
      if (renameWs) void registerCoreSessionWorkspace(sessionId, renameWs);
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
      // 先刷新会话工作目录索引并登记到 core：loadConversation 按会话解析工作目录
      syncSessionWorkspaceIndex();
      const smartWs = sessionWorkspaces.get(sessionId);
      if (smartWs) void registerCoreSessionWorkspace(sessionId, smartWs);
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
  const { bootstrapCore, bootstrapSnapshot, shutdownCore, onWorkspaceConnectionState } = require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');

  const host = new ElectronUIHost();
  // 工作区事实来源：Client 按打开集合建立 Connection，并订阅打开 / 关闭 / 激活
  host.setWorkspaceSource({
    // 启动期判定不可用的工作区不建立 Connection（本地目录缺失 / 远程已标记连不上）
    getOpenWorkspaceRefs: () => openWorkspaces.filter(isWorkspaceAvailable),
    getActiveWorkspaceRef: () => workspacePath,
    subscribe: (listener) => {
      workspaceChangeListeners.add(listener);
      return () => workspaceChangeListeners.delete(listener);
    },
  });
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
  conversationsMgr.setStatusListener((states) => {
    updateTrayStatusFromStates(states);
    // 标题栏标签页流水灯（蓝=运行 / 黄=等待）也吃这条状态流，就地刷新不重建标签页
    syncTitlebarActivity();
  });

  // 共享启动接线：locale / 日志 / 总线 / core 侧订阅 / WebViewUI / 历史 / 会话队列 /
  // 等待用户读取器 / 配置目录 / 环境预热 / MCP 残留清理（DEVELOPMENT.md 第 3.5、8.6 节）
  const { ui } = bootstrapCore(host, spinDesign, conversationsMgr, {
    locale: app.getLocale(),
    log: (...args: unknown[]) => {
      const line = args.map(a => String(a)).join(' ');
      console.log('[WebViewUI]', line);
      // 宿主诊断（[ssh] / [client] / [bootstrap] / [core] …）同时落盘：
      // 只打 console 时，远端工作区这类问题在日志文件里完全看不到
      fileLogger.info('host', line);
    },
    logToConsole: true,
    extensionPath: APP_ROOT,
  });

  // 订阅 Connection 生命周期：启动恢复 / 手动重连的建连失败（从未就绪）在此落成
  // 「不可用」——endpoint 探测只覆盖「连不上 daemon」，daemon 存活但工作区 channel
  // 建失败（远端 core 起不来）等失败形态只能从这里得知。远程的运行期 lost（daemon /
  // 链路死亡、Core 重启超限）同样在这里落成不可用：重启策略在 daemon 手里，Host 侧
  // 无法自动恢复，曾就绪过也必须标红（沉默判定最迟 3s 内把 fatal 送到这里）。本地项
  // 保持豁免：Core 由 Host 侧重启策略恢复，恢复后 coreReady 会重新 markReady。
  onWorkspaceConnectionState((ref, state, reason) => {
    const key = refKey(ref);
    // 空引用占位 Connection 不属于任何标签页
    if (!openWorkspaces.some((candidate) => refKey(candidate) === key)) return;
    fileLogger.info('workspace-tab', `connection ${state}: ${refDisplay(ref)} (${reason || 'ready'})`);
    if (state === 'ready') {
      workspaceAvailabilityState.markReady(key);
    } else if (ref.endpoint) {
      // 运行期致命走 runtime 落定（撤销就绪豁免）；从未就绪的建链失败走默认守卫。
      // 落定时顺带清掉建链中：否则这次标红推送的仍是黄态，黄点要等下一次全量刷新才消失
      markWorkspaceUnavailable(ref, reason, 'runtime');
    }
  });

  host.setMainWindow(mainWindow!);
  host.setSidebarView(sidebarView!);
  host.setChatViewManager(chatViews!);
  host.setWorkspacePath(workspacePath);
  webviewUi = ui;
  uiHost = host;
  // 初始同步「已打开会话」集合（此刻通常为空）：让 UserChoiceQueue 的 open 判定
  // 从一开始就走多视图语义，而不是退化成「open == active」的单视图语义
  webviewUi.setOpenSessions(chatViews?.getLoadedSessionIds() ?? []);
  // 视图销毁序列（closeView / LRU trim / disposeAll）在销毁视图前只卸内存：
  // 指向 WebViewUI.releaseConversation（不回调 closeConversationView，避免与视图销毁互相回调成环）
  chatViews!.closeConversation = (sessionId: string) => ui.releaseConversation(sessionId);

  console.log(`[bootstrap] ${JSON.stringify(bootstrapSnapshot())}`);
  // 退出路径（will-quit）复用同一份 core 清理入口
  coreShutdown = shutdownCore;
}
