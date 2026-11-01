/**
 * PRODUCT_NAME - Electron 主进程入口
 *
 * 职责：
 * 1. 创建主窗口：左侧原生侧栏（对话列表）+ 右侧聊天 WebContentsView（每对话一个标签）
 * 2. 注册 IPC（webview-message）并委托给 WebViewUI（复用同一份 WebviewMessageHandler）
 * 3. 侧栏 IPC：对话列表读写、打开/新建对话、列表变化推送
 * 4. 初始化 core（bootstrapCore：总线 / core 侧订阅 / 宿主环境与工作目录经总线传递）
 * 5. 提供单一图标菜单（打开本地工作区 / 打开远程工作区 / 打开最近的工作区 / 偏好设置 / 开发者工具 / 关于 / 退出）；
 *    标题栏「加号」菜单同样带「打开最近的工作区」
 * 6. 多工作目录：打开集合 + 活动项，标题栏标签页，按对话解析工作目录
 *
 * 与 VS Code 扩展的差异点（extension.ts）：
 * - 工作目录由用户添加（VS Code 从 workspaceFolders 获取）；可同时打开多个，标题栏标签页呈现
 * - 对话列表由原生侧栏展示（VS Code 在 webview 内展示）
 * - 文件打开/虚拟文档/Mermaid/Spin 由 UIHost 提供 Electron 实现
 */

import { fileLogger } from '../src/shared/Logger.js';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, dialog, WebContentsView, shell, webContents, globalShortcut, Tray, nativeImage, screen, clipboard, powerSaveBlocker, type NativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { ChatViewManager, SIDEBAR_DEFAULT_WIDTH, TITLEBAR_HEIGHT, chatViewBackgroundColor } from './ChatViewManager.js';
import {
  getTitlebarMenuHtml,
  TITLEBAR_MENU_WIDTH,
  TITLEBAR_SUBMENU_WIDTH,
  type TitlebarMenuNode,
} from './titlebarMenuHtml.js';
import { ElectronUIHost } from './ElectronUIHost.js';
import { ElectronSpinDesign } from './ElectronSpinDesign.js';
import { showStyledMessageBox } from './styledMessageBox.js';
import { guardViewNavigation } from './viewNavigation.js';
import { ElectronConversationManager } from './ElectronConversationManager.js';
import { WebViewUI } from '../src/host/WebViewUI.js';
import type { Client, CoreChannelCloseMode } from '../src/host/Client.js';
import type { WebviewToHostMessage } from '../src/host/webviewMessages.js';
import { normalizeWorkspacePath, sameWorkspace } from '../src/host/workspacePaths.js';
import { buildRemoteEndpoint, type RemoteConnectError } from '../src/host/remoteConnect.js';
import {
  parseSshHistory,
  rememberSshEntry,
  removeSshEntry,
  sshHistoryKey,
  toSshHistoryCandidate,
  type SshHistoryEntry,
} from '../src/host/sshHistory.js';
import { DirectoryOperationError } from '../src/host/standalone/CoreDaemon.js';
import {
  localWorkspaceRef,
  remoteWorkspaceRef,
  sameRemotePath,
  sameWorkspaceRef,
  workspacePathMatches,
  workspaceRefDisplayPath,
  workspaceRefKey,
  workspaceRefKeyMatches,
  type WorkspaceEndpoint,
  type WorkspaceRef,
} from '../src/host/workspaceRef.js';
import { getChatPlaceholderHtml, type ChatPlaceholderReason } from './chatPlaceholderHtml.js';
import {
  resolveMachineName,
  resolveWorkspaceByIdentity,
} from '../src/host/workspaceIdentity.js';
import { hostname } from 'os';
import { recordKnownHostFingerprint, SshHostKeyError } from '../src/host/standalone/sshClient.js';
import { WorkspaceAvailabilityState } from './workspaceAvailability.js';
import {
  migrateLegacyWorkspaceFields,
  parseWorkspaceEntry as parseWorkspaceEntryShared,
  serializeWorkspaceRef as serializeWorkspaceRefShared,
  type LegacyWorkspaceFields,
  type SerializedWorkspaceRef,
} from '../src/host/workspaceState.js';

import { createTrayStatusIcon, deriveTrayStatusFromStates, type TrayStatus } from './trayStatusIcon.js';
import { diffSessionEndEvents, shouldFireCompletion, type SessionBusyRecord, type SessionLevel } from './trayAttention.js';
import { createAttentionSound, traySoundEnabled } from './trayAttentionSound.js';
import { createTraySoundPlayer } from './traySoundWindow.js';
import { backfillCompletionAttention, diffCompletionAttention, pickReadCompletions, type CompletionAttentionFacts } from './completionAttention.js';
import { SleepBlocker } from './powerSaveBlocker.js';
import {
  selectClosableIdleSessions,
  selectWorkspaceLoadedSessions,
  summarizeOtherWorkspaces,
  type WorkspaceSessionFacts,
} from './workspaceBatchClose.js';
import {
  deleteEachPath,
  listDirectory,
  resolveWithinRoot,
  resolveAllWithinRoot,
  formatRelativePaths,
} from './sidebarFiles.js';
import {
  listRemoteDirectory,
  deleteRemotePaths,
  remoteFileReaderFor,
  retainRemoteFilesClient,
  releaseRemoteFilesClient,
  disposeAllRemoteFilesClients,
  sharedClientFor,
} from './sidebarFilesRemote.js';
import {
  buildDocRows,
  collectGitEntries,
  collectRecordEntries,
  localGitRunner,
  probeGitWorkspace,
  type GitCommandRunner,
} from './sidebarDocView.js';
import { readModifiedDocs, readRemoteModifiedDocs, type RemoteMetaAccess } from '../src/shared/workspaceMeta.js';
import { CONFIG_DIR_NAME } from '../src/config/project.js';
import type { SshClient } from '../src/host/standalone/sshClient.js';
import {
  applyTerminalShortcuts,
  closeAllTerminalWindows,
  closeTerminalWorkspace,
  openTerminalWindow,
} from './terminalWindow.js';
import {
  canOpenRemoteTerminal,
  terminalFontSizePx,
} from './terminalShells.js';
import {
  openLocalWorkspaceFile,
  openRemoteWorkspaceFile,
  REMOTE_BINARY_UNSUPPORTED,
  type FileOpenBridge,
} from './fileOpen.js';
import { sshTargetFor, sshTargetKey } from '../src/host/sshTarget.js';
import { sessionBusyLevel } from '../src/shared/sessionRuntime.js';
import {
  readWorkspaceState,
  writeWorkspaceState,
  getWorkspaceStateFile,
  type WorkspaceState,
  type WindowRect,
} from './workspaceStateStore.js';
import { isRectVisibleOnSomeWorkArea } from './viewerWindowRect.js';
import { PRODUCT_NAME, EXTENSION_NAME, SETTINGS_FILE_NAME, ENV_PREFIX } from '../src/config/project.js';
import { resolveConfigDir } from '../src/config/configDir.js';
import {
  DEFAULT_WAKE_SHORTCUT,
  DEFAULT_NEXT_TAB_SHORTCUT,
  DEFAULT_PREV_TAB_SHORTCUT,
  DEFAULT_OPEN_TERMINAL_SHORTCUT,
  acceleratorFromKeyboardEvent,
  findShortcutConflict,
  formatAcceleratorForDisplay,
  normalizeAccelerator,
  resolveShortcut,
  type RegisteredShortcuts,
  type ShortcutConflictKind,
  type ShortcutRow,
} from './shortcut.js';
import { selectAdjacentId, type TabSwitchDirection } from './tabSwitching.js';
import { tt, onHostLocaleChanged, getHostLocale } from '../src/host/i18n.js';
import { requireEventBus } from '../src/shared/AssistantEventBus.js';
import { getPreferenceDialogHtml, type PreferenceDialogState } from './preferenceDialogHtml.js';
import { clampSoundVolume, readSoundSettings, type SoundSettings } from './soundSettings.js';
import { requestSmartNaming } from '../src/host/coreFacts.js';

/**
 * e2e 专用的侧栏列表延迟注入开关（`<envPrefix>_E2E_SLOW_LIST_MS`）。
 *
 * 主进程与 e2e/electron/sessions.spec.ts 共用这一个名字派生点；envPrefix 取自
 * project.json，源码不出现产品字面量。
 */
const E2E_SLOW_LIST_ENV = `${ENV_PREFIX}_E2E_SLOW_LIST_MS`;

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

// ── 侧栏宽度（可拖拽，US-44） ──
/** 侧栏宽度可调下限（DIP）：再窄对话列表不可用 */
const SIDEBAR_MIN_WIDTH = 200;
/** 侧栏宽度可调上限（DIP）：再宽聊天区失去意义；上限随窗口宽度另有夹取 */
const SIDEBAR_MAX_WIDTH = 640;
/** 聊天区保留的最小宽度：侧栏无论怎么拖都不能把它挤掉 */
const CHAT_MIN_WIDTH = 320;
/**
 * 用户拖拽出的侧栏宽度（DIP）。
 *
 * 只存「用户想要的值」，不做窗口相关夹取——窗口随时会变，窗口相关夹取在
 * `currentSidebarWidth()` 里按当前窗口实时算（窗口拉宽后侧栏自动回到用户拖的值）。
 * 启动时从 workspace-state.json 播种（app ready 后 createMainWindow 前调用
 * `seedSidebarWidth`），持久化见 `sidebarWidthPersist`。
 */
let sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH;

/** 读盘播种侧栏宽度：值非法（手工改坏 / 旧版本残留）按没有记录处理 */
function seedSidebarWidth(): void {
  const saved = readWorkspaceState().sidebarWidth;
  sidebarWidthPx = typeof saved === 'number' && Number.isFinite(saved)
    ? Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, saved)))
    : SIDEBAR_DEFAULT_WIDTH;
}

/**
 * 当前实际生效的侧栏宽度：用户值 + 窗口相关夹取（不挤掉聊天区）。
 *
 * `layout()` 与 `ChatViewManager.chatBounds()` 都从这取值——一份事实一个写入点
 * （docs/architecture/principles.md规则 4），聊天区摆位与侧栏 bounds 永远对得上。
 */
function currentSidebarWidth(): number {
  if (!mainWindow) return sidebarWidthPx;
  const [w] = mainWindow.getContentSize();
  const maxByWindow = Math.max(SIDEBAR_MIN_WIDTH, w - CHAT_MIN_WIDTH);
  return Math.round(Math.min(sidebarWidthPx, maxByWindow));
}

/** 拖拽 / 双击恢复后应用宽度；`persist` 为 true 时同步落盘（拖拽过程不落盘） */
function applySidebarWidth(width: number, persist: boolean): void {
  sidebarWidthPx = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)));
  layout();
  if (persist) {
    writeWorkspaceState({ ...readWorkspaceState(), sidebarWidth: sidebarWidthPx });
  }
}
/** 对话列表的读取与分发（bootstrap 创建；sidebar:get-conversations 读它的列表快照） */
let conversations: ElectronConversationManager | undefined;
/**
 * 打开集合：已打开的工作区引用，按标签页顺序排列（进程内事实）。
 *
 * 本地与远程同构（`docs/core/client-connection.md` 第 4 节）：本地 `endpoint === null`，
 * 远程带 `{ host, port, user, auth }`。标签页 / 侧栏用 `workspaceRefKey` 作稳定 id。
 */
let openWorkspaces: WorkspaceRef[] = [];
/** 活动工作区（打开集合中的一项；集合为空时 undefined） */
let workspacePath: WorkspaceRef | undefined;
/** 会话 → 工作目录 索引：按对话解析工作目录（打开某个对话时用它注入 --workspace=） */
const sessionWorkspaces = new Map<string, string>();
/** 宿主实例（initCore 创建后回填；侧栏哨兵启停等工作区生命周期挂点用，specs/030） */
let electronHost: ElectronUIHost | null = null;
/** 工作区打开 / 关闭 / 激活的订阅者（ElectronUIHost 的 WorkspaceProvider 契约） */
const workspaceChangeListeners = new Set<(change: { type: 'opened' | 'closed' | 'activated'; ref: WorkspaceRef; closeMode: CoreChannelCloseMode }) => void>();

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
 * 工作目录的规范化口径（`docs/core/client-connection.md` 第 4 节）。
 *
 * 本地路径按宿主口径规范化（大小写 / 尾分隔符）；**远程路径是目标机器上的字符串，
 * 原样保留**——对 `/home/pz/proj` 跑本地规范化会得到 `D:\home\pz\proj`，之后按路径
 * 找 Connection、注入 `--workspace=` 全都对不上（表现为远端工作区发消息没有响应）。
 */
function canonicalWorkspacePath(target: string): string {
  const remote = openWorkspaces.find((ref) => ref.endpoint !== null && sameRemotePath(ref.path, target));
  return remote ? remote.path : normalizeWorkspacePath(target);
}

/**
 * 会话所属路径 → 工作区稳定 id（`workspaceRefKey`）：聊天视图的归属判等用 id。
 * 不在打开集合时按路径本身作 id 兜底（会话目录理论必在打开集合里——
 * openConversation 流程先经 isWorkspaceUsableForConversation 校验）。
 */
function workspaceIdForPath(workspace: string | undefined): string {
  if (!workspace) return '';
  const ref = openWorkspaces.find((candidate) => workspacePathMatches(candidate, workspace));
  return ref ? refKey(ref) : workspace;
}

/** 两个可能为空的工作区引用是否指向同一项（都为空视为相同） */
function sameRef(a: WorkspaceRef | undefined, b: WorkspaceRef | undefined): boolean {
  if (!a || !b) return a === b;
  return sameWorkspaceRef(a, b);
}

/**
 * 退出确认链的决策表（specs/031）：按 workspaceRefKey 记录用户对各忙碌远程工作区
 * 的选择（后台运行 / 立即关闭）。窗口 close 确认链填写，will-quit 的 shutdownCore
 * 消费；弹不出对话框的出口（窗口已销毁）不填 = 全部只断链，daemon 默认策略接管。
 */
const pendingQuitDecisions = new Map<string, CoreChannelCloseMode>();

/** 通知工作区变化（Client 据此建立 / 销毁 Connection）。
 *
 * `closeMode` 只对 closed 有意义（specs/031）：`detach` = 后台运行，Connection
 * 只摘路由不发 `closeWorkspace`，Core 留在 daemon 孤儿表继续执行。
 */
function emitWorkspaceChange(
  type: 'opened' | 'closed' | 'activated',
  ref: WorkspaceRef,
  closeMode: CoreChannelCloseMode = 'close',
): void {
  // 工作区关闭连带摘掉文档视图的 git 哨兵（specs/030 FR-003：监听随工作区生命周期）
  if (type === 'closed') void electronHost?.stopDocSentinelFor(ref);
  for (const listener of [...workspaceChangeListeners]) {
    try {
      listener({ type, ref, closeMode });
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

/**
 * 不可用原因（按去重键，占位页说明文字的来源）。
 *
 * 错误对象到不了占位页：落定不可用 / 重连失败时在这里留一份结构化原因，「主机
 * 密钥已变更」这类安全敏感形态才能带上新旧指纹引导确认。可用即失效（重建信任 /
 * 重连成功的路径上删除）。
 */
const unavailableReasons = new Map<string, ChatPlaceholderReason>();

/** 把建连失败翻译成占位页原因：指纹变更加密结构形态，其余展示原始错误 */
function unavailableReasonOf(err: unknown): ChatPlaceholderReason {
  if (err instanceof SshHostKeyError) {
    return {
      kind: 'hostKeyChanged',
      expectedFingerprint: err.expectedFingerprint,
      observedFingerprint: err.observedFingerprint,
    };
  }
  return { kind: 'generic', detail: describeError(err) };
}

/** 原因的单行文本（日志用；指纹变更附上两份指纹便于留档比对） */
function reasonTextOf(reason: ChatPlaceholderReason): string {
  return reason.kind === 'hostKeyChanged'
    ? `${tt('SSH 主机密钥与首次连接的记录不一致', 'SSH host key changed')} `
      + `(recorded=${reason.expectedFingerprint}, observed=${reason.observedFingerprint})`
    : reason.detail;
}

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
let coreShutdown: ((decisions?: ReadonlyMap<string, CoreChannelCloseMode>) => Promise<void>) | undefined;
/** 当前宿主实现（initCore 创建） */
let uiHost: ElectronUIHost | undefined;
/** 共享装配的 Client（initCore 创建）：会话 → Connection 路由表的宿主侧只读入口 */
let coreClient: Client | undefined;
/**
 * 当前生效的主题模式（内存事实）。
 * 启动时从 settings.json 载入，菜单里切换后立即更新——菜单勾选态据此渲染，
 * 不直接读盘：写盘是异步队列，读盘可能读到尚未落盘的旧值。
 */
let currentThemeMode: ThemeMode = 'system';
/** 系统托盘：提供唤醒入口与退出入口（窗口不会因最小化而隐藏到托盘） */
let tray: Tray | undefined;
/** 当前已注册的全局唤醒快捷键（偏好设置窗口打开时临时注销） */
let registeredWakeShortcut: string | undefined;
/** 当前窗口是否由唤醒快捷键/托盘呼出，用于“再按一次回到托盘”的切换判断 */
let wakeToggleActive = false;
/**
 * 打开了偏好设置窗口的 webContents 集合。
 * 打开期间临时注销全局快捷键，避免用户按下的组合键先触发唤醒；
 * 用集合而不是布尔值，兼容同时打开多个的情况。
 */
const preferenceDialogSenders = new Set<number>();
/** 偏好设置窗口（菜单「偏好设置...」；同一时刻只开一个） */
let preferenceDialogWindow: BrowserWindow | undefined;
/** 应用退出中：避免 destroyed 回调里再尝试注册快捷键 */
let appQuitting = false;
/**
 * 白屏恢复用的重绘定时器句柄：
 * - focusRepaintTimer：窗口聚焦防抖后的单次重绘
 * 窗口销毁/应用退出时清理，避免句柄悬挂（纯防御性）。
 */
let focusRepaintTimer: ReturnType<typeof setTimeout> | null = null;
// 侧栏三条流各自单一 owner（docs/architecture/contracts.md 第 4 节）：
// - 列表（纯磁盘元数据）→ ConversationManager.dispatchList → sidebar:conversations-updated
// - 运行时状态（idle / waiting）→ ConversationManager.dispatchStates → sidebar:session-states-updated
// - loaded（视图层）→ ChatViewManager.onLoadedChanged → sidebar:session-loaded-changed

/**
 * 项目根目录（dist-electron 的上一级）
 * 注意：以 `electron.exe dist-electron/main.cjs` 方式启动时，
 * app.getAppPath() 返回 dist-electron，因此不能依赖它定位项目资源。
 */
const APP_ROOT = path.resolve(__dirname, '..');

/** 最近打开的工作区上限（workspace-state.json 的 recentWorkspaces） */
const MAX_RECENT_WORKSPACES = 20;

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

  // 侧栏宽度同样从状态文件播种（拖拽值持久化在 sidebarWidth 字段）：
  // 必须在 createMainWindow 之前——首帧 layout() 就按它摆侧栏与聊天区
  seedSidebarWidth();

  // ── 工作目录 ──
  // 不默认使用当前工作目录：恢复上次打开的打开集合与活动项；
  // 命令行 --workspace= 作为额外的一项加入打开集合并置为活动项。
  // 保存的活动项不可用（本地目录不存在）或建链中（远程探测未落定）时**保持为活动项**：
  // 聊天区由 `syncChatAreaForActiveWorkspace` 改显占位页，不回退到别的标签页
  // （远程可达性由 initCore 之后的探测异步判定，10 秒超时）。
  openWorkspaces = readOpenWorkspaces();
  // 远程工作区从启动起进入建链中（黄色呼吸点）：可达性由 initCore 之后的探测落定；
  // 侧栏文件浏览器的 SSH 连接按打开集合登记共享（关闭时按计数释放）
  for (const ref of openWorkspaces) {
    if (ref.endpoint) {
      workspaceAvailabilityState.markConnecting(refKey(ref));
      retainRemoteFilesClient(ref.endpoint);
    }
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
  // 注册全局唤醒快捷键（settings.json 中的 shortcut，默认 Ctrl+Alt+X）；
  // 注册失败（组合键被占用）不弹窗，落日志留痕（见 registerWakeShortcutValue）
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

  // 本应用任意窗口（主窗口 / 偏好设置窗口等）获得焦点即取消闪烁提醒。
  // 只监听 mainWindow 的 focus 会漏掉子窗口聚焦的情况——子窗口聚焦时主窗口
  // 失去焦点，但用户正在使用本应用，不应继续闪烁。
  app.on('browser-window-focus', () => {
    cancelAttention();
    // 用户已到场：启动恢复的托盘抑制立即解除（specs/031 FR-006）
    startupTraySuppressionDeadline = 0;
  });

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
    // 提醒音的播放窗口（若还活着）：显式销毁，不靠窗口销毁兜底
    attentionSound.dispose();
    // 释放电源阻断：进程退出前不再占着系统的电源请求
    sleepBlocker.dispose();
    // 远程终端窗口随退出关闭：同步销毁 shell 通道并释放租约（docs/hosts/electron-multi-workspace.md 第 14.7 节），
    // 必须先于下面的 SSH 连接池统一释放
    closeAllTerminalWindows();
    // 侧栏文件浏览器的 SSH 连接（远程工作区的 SFTP 会话）一并释放
    disposeAllRemoteFilesClients();
    // core 侧的进程级资源（MCP 子进程 / Standalone Core 进程）统一由共享骨架释放；
    // Standalone 下关闭 Core 进程需要一点时间，此处不阻塞退出——Core 也会在
    // 标准输入关闭（EOF）时自行退出。决策表承载退出确认链的选择（specs/031）：
    // detach 的工作区只断链，Core 孤儿化存活。
    void coreShutdown?.(pendingQuitDecisions);
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
  // 退出确认：关一张标签要确认、退出却直接杀掉全部运行中会话是粒度倒挂——任一
  // 工作区还有非 idle 对话时先经确认。远程工作区逐个弹三选（后台运行 / 立即关闭 /
  // 取消，specs/031 FR-002），本地工作区维持现有总确认；任一「取消」中止整个退出。
  // 确认后置标志放行，关闭流程不再重复问。关闭路径的关键不变量：preventDefault 后
  // 每一条出口（再次 close / will-quit）都必须能走到真正的退出。
  let windowCloseConfirmed = false;
  win.on('close', (event) => {
    if (sizeSaveTimer) {
      clearTimeout(sizeSaveTimer);
      sizeSaveTimer = undefined;
    }
    persistWindowRect();
    if (windowCloseConfirmed) return;
    const busyRemote = openWorkspaces.filter(
      (candidate) => candidate.endpoint !== null && workspaceHasBusySession(candidate),
    );
    const busyLocal = openWorkspaces.find(
      (candidate) => candidate.endpoint === null && workspaceHasBusySession(candidate),
    );
    if (busyRemote.length === 0 && !busyLocal) return;
    event.preventDefault();
    void (async () => {
      const decisions = await confirmQuitWorkspaces(busyRemote);
      if (!decisions) return; // 任一「取消」：整个退出中止（spec AC-12）
      if (busyLocal) {
        // 本地忙碌工作区维持现有总确认，排在远程逐区确认之后（spec FR-002）
        const confirmed = await confirmCloseBusy(
          tt('仍有对话在运行', 'Conversations are still running'),
          tt(`「${refDisplay(busyLocal)}」下仍有对话在运行，退出会中止它们。确定退出？`,
             `Conversations in "${refDisplay(busyLocal)}" are still running. Quit anyway?`),
        );
        if (!confirmed) return;
      }
      pendingQuitDecisions.clear();
      for (const [key, mode] of decisions) pendingQuitDecisions.set(key, mode);
      if (win && !win.isDestroyed()) {
        windowCloseConfirmed = true;
        win.close();
      }
    })();
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

  // 外部链接防御（与聊天视图同一份实现）：侧栏内点击链接不在 Electron 中打开，
  // 交给系统浏览器（见 electron/viewNavigation.ts）
  guardViewNavigation(sidebarView.webContents, 'sidebar');
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
  // 标题栏虽然只加载本地文件与 data: URL，但页面一旦被拖放或脚本导航到外部页面，
  // preload 会在新页面重跑、把 titlebarAPI 交给外部页面（含窗口控制动作）
  guardViewNavigation(titlebarView.webContents, 'titlebar');
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
    // （`docs/architecture/core-ui-separation.md` 第 4.8 / 4.9 节），不问 core。
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
    workspaceId: workspacePath ? refKey(workspacePath) : '',
    locale: app.getLocale(),
    systemLocale: getSystemLocaleForStartup(),
    uiLanguage,
    uiFontSize,
    highlightLanguages,
    // 语言 / 字号每次建视图时从 SettingsStore 实时读取：设置保存后新开的视图
    // 首帧就是新档位（运行中视图由 defaults 推送即时生效，这里是新视图的来源）
    readUiPreferences: () => {
      try {
        const { getSettingsStore } = require('../src/host/SettingsStore.js') as typeof import('../src/host/SettingsStore.js');
        const store = getSettingsStore();
        return { uiLanguage: store.readUiLanguage(), uiFontSize: store.readUiFontSize() };
      } catch {
        return undefined;
      }
    },
    // 聊天视图整体下移，给顶部自绘标题栏让位
    topInset: TITLEBAR_HEIGHT,
    // 侧栏宽度实时读取口：用户拖拽手柄改宽度后聊天区摆位立即跟随（见 currentSidebarWidth）
    sidebarWidth: currentSidebarWidth,
    // 对话列表渲染方随窗口模式推导：悬浮窗隐藏原生侧栏，列表改由 webview 顶栏渲染
    // （视图模式不变，Electron 恒为多视图）
    conversationListOwner: windowMode === 'floating' ? 'webview' : 'host',
    onActiveSessionChanged: (sessionId) => {
      sidebarView?.webContents.send('sidebar:active-session-changed', sessionId);
      // 该对话成为当前对话 = 阅读了它的未读完成：清掉并同步（侧栏 / webview 灯条随之熄灭）
      if (sessionId && unreadCompletionSessions.delete(sessionId)) syncCompletionAttention();
      if (sessionId) {
        completionsReadInRun.add(sessionId);
        backfillArmedSessions.delete(sessionId);
      }
      // 同步 UI 侧的「当前活跃会话」：切到已打开的视图不会再走 loadConversation /
      // startNewConversation，不同步的话按会话解析的数据（project skills / MCP 启用
      // 列表）会停在旧视图，取到别的标签页的工作目录。
      webviewUi?.setActiveSessionId(sessionId ?? undefined);
    },
    onLoadedChanged: (sessionIds) => {
      // 视图层「已打开会话」集合单独推送（不并入对话列表流），见 docs/architecture/contracts.md 第 4 节
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
        if (findWorkspace(ref)) chatViews?.preloadWorkspace(refKey(ref), ref.path);
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
      chatViews?.openConversation(sid, workspaceIdForPath(workspace), workspace);
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
  // 回窗聚焦只做「已读」清理（聚焦即已读，正看着的对话不亮灯）；
  // 未读完成本身在武装时刻就已推送（失焦即推），这里补推是幂等快照
  mainWindow.on('focus', () => {
    reconcileCompletionAttention();
    syncCompletionAttention();
  });

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
    // 提醒音的播放窗口一并销毁：它也是 BrowserWindow，留着会让 window-all-closed
    // 不再触发（应用不退出）、activate 里「没有窗口才重建主窗口」的判定失效
    attentionSound.dispose();
  });
}

/** 主窗口 / 标题栏兜底背景色：与自绘 UI 的深/浅底色保持一致，避免加载期闪白或闪黑 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#16161b' : '#f4f4f5';
}

/**
 * 应用主题模式（偏好设置窗口里主题单选的动作）。
 *
 * - `nativeTheme.themeSource`：驱动系统级配色、原生对话框，以及各渲染进程的
 *   prefers-color-scheme（自绘标题栏 / 侧栏 / Monaco 预览 / 偏好设置窗口据此切换深浅）；
 * - 显式 `onThemeChanged(null)`：聊天 webview 不监听 prefers-color-scheme，
 *   主题值靠 setTheme 消息下发；重复选择同一项时不会触发 nativeTheme 的
 *   updated 事件，因此这里主动广播一次，保证值一致；
 * - 持久化落在宿主本地偏好（core 不参与）。
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

/** 各会话上一次的忙闲记录（`diffSessionEndEvents` 的差分基准，随每次全量推送推进） */
let traySessionLevels = new Map<string, SessionBusyRecord>();

/**
 * 「任务完成」绿色呼吸（`completionAttention.ts` + `syncCompletionAttention`）：
 * 会话 running → idle 且用户当时看不到（窗口失焦 / 标签页未激活 / 非当前对话）时
 * 对对话项记「未读完成」（标签页只在完成时该标签页未激活才记——激活中的标签页
 * 视为已读）；武装即推（失焦也推，见 `updateCompletionAttentionFromStates`）——
 * 可见但未聚焦的窗口（分屏 / 副屏）当场亮灯，不回窗不补亮；窗口最小化 / 隐藏时
 * 推送无可见效果，恢复后灯条以常亮呈现。灯条呼吸一次后**保持常亮**，直到用户阅读：
 * 激活该标签页清掉标签页项，把该对话切为当前对话清掉对话项；回窗聚焦那一刻正看着
 * 的对话（聚焦 + 激活标签页 + 当前对话）直接视为已读，由 `reconcileCompletionAttention`
 * 清掉——聚焦即已读，切到别的对话不补亮。未读集合归主进程独有——焦点 / 激活 /
 * 当前对话是宿主本地事实，webview / 侧栏 / 标题栏只吃全量集合快照（幂等，重复推送
 * 不重复呼吸）。
 */
let completionAttentionLevels = new Map<string, SessionLevel>();
/** 未读完成的标签页（工作区稳定 id）：激活该标签页即视为阅读 */
const unreadCompletionTabs = new Set<string>();
/** 未读完成的对话（sessionId）：成为当前对话、或回窗聚焦时正看着即视为阅读 */
const unreadCompletionSessions = new Set<string>();
/**
 * 本次运行已阅读的会话：补武装（`backfillCompletionAttention`）的护栏。打开对话
 * 即清掉 core 侧的 `unreadCompletions` 计数，但清零落盘与下一次列表刷新之间存在
 * 在途窗口——护栏挡住窗口期的重复武装，重启后 core 已清零，护栏不需要持久化。
 */
const completionsReadInRun = new Set<string>();
/**
 * 经离场补武装进入未读集合的会话：标签页灯的补挂范围。在线差分武装的会话沿用
 * 「完成时未激活才武装标签页」规则，不进这个集合——离场完成的完成时刻用户完全
 * 缺席，激活中的标签页也算未读（specs/defects/orphan-completion-unread-light）。
 */
const backfillArmedSessions = new Set<string>();

/**
 * 系统睡眠 / 休眠阻断：任一会话非 idle 时阻断（`prevent-app-suspension`，允许屏幕熄灭），
 * 全部空闲后释放。与托盘状态点吃同一条会话状态流（`setStatusListener`），
 * 见 `electron/powerSaveBlocker.ts` 与 docs/hosts/host-bootstrap.md 第 1 节。
 */
const sleepBlocker = new SleepBlocker(powerSaveBlocker);

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

/**
 * 托盘提醒音（`electron/trayAttentionSound.ts` + `electron/traySoundWindow.ts`）：
 * 提醒触发时（与托盘闪烁同一处判定）播一次 `electron/assets/meow.aac`，让最小化到托盘的用户
 * 也能凭声音知道任务结束（`docs/hosts/host-matrix.md` 第 6 节的托盘提醒段落）。
 *
 * 播放载体懒建：首次提醒才创建隐藏窗口（播完自毁），不常驻——常驻窗口会改坏
 * `window-all-closed` 与 `activate` 里的窗口计数判定。播放失败只落日志：调用点在
 * `setStatusListener` 的回调里，抛错会连带打断同一快照上的托盘状态点与睡眠阻断。
 *
 * `traySoundEnabled()` 为假（e2e 启动器置了 `DISABLE_TRAY_SOUND`）时不建载体：整应用
 * 用例在开发机上跑，出声会和真实运行的应用撞在一起。用户偏好里的「播放提示音」关掉时
 * 同样不建载体（`readSoundSettingsSync()`），音量则每次播放前现取——偏好设置里拖滑条
 * 不需要重建已缓存的播放窗口。
 */
const attentionSound = createAttentionSound({
  acquirePlayer: () =>
    appQuitting || !traySoundEnabled() || !readSoundSettingsSync().enabled
      ? null
      : createTraySoundPlayer({
          audioPath: path.join(APP_ROOT, 'electron', 'assets', 'meow.aac'),
          getVolume: () => readSoundSettingsSync().volume,
        }),
  warn: (message) => fileLogger.warn('tray-sound', message),
});

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
 * `status` 决定圆点颜色（空闲绿点 / 运行红点 / 等待黄点）。
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
 * 不能只看 `mainWindow.isFocused()`：偏好设置窗口是带 parent 的独立
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
 * 任务结束提醒：任一会话从运行中结束（完成 → idle、或转等待用户确认 → waiting）
 * 且窗口处于后台（最小化/隐藏/可见但非顶层）时的提醒。颜色跟随当前**聚合**状态：
 * 其它对话还在跑时红点闪、全部空闲绿点闪、有会话等用户黄点闪。
 * 只闪烁托盘图标，不闪烁窗口 / 任务栏图标——窗口闪烁过于打扰，提醒入口统一收敛到托盘。
 */
function startAttention(status: TrayStatus): void {
  if (!isWindowInBackground()) return;
  attentionActive = true;
  // 除闪烁外再出一声：与闪烁同一判定、同一时机（窗口在前台不提醒也就不出声；
  // 闪烁的亮 / 灭相位切换不经过这里，不会重复出声）
  attentionSound.play();
  if (tray && !startTrayBlink(status)) restoreTrayIcon();
}

/** 用户打开/还原/聚焦界面后取消提醒（停止托盘闪烁并恢复静态托盘图标） */
function cancelAttention(): void {
  if (!attentionActive) return;
  attentionActive = false;
  restoreTrayIcon();
}

/**
 * 主窗口是否持有焦点。「任务完成」绿色呼吸的武装 / 回窗已读清理判据（武装即推，
 * 焦点不再是推送门控），与托盘的 `isWindowInBackground` 分开：这里只看主窗口
 * （偏好设置窗口聚焦时主窗口失焦，但那个窗口盖在主窗口上，聊天区是否可见无法
 * 一概而论——回窗已读清理等主窗口真正拿到 focus 事件，语义与「窗口获取到焦点后」
 * 一致）。
 */
function isMainWindowFocused(): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
}

/** 会话归属工作区的稳定 id（复用标签页流水灯 `collectWorkspaceActivity` 的同一套归属查找） */
function resolveSessionWorkspaceKey(sessionId: string): string | null {
  const target = resolveSessionWorkspaceRef(sessionId);
  return target ? refKey(target) : null;
}

/**
 * 「任务完成」绿色呼吸的画面事实求值（completionAttention.ts 的 `factsOf` 注入）。
 * 武装（`updateCompletionAttentionFromStates`）与回窗已读清理
 * （`reconcileCompletionAttention`）共用这一份，两个判定恒为反义。
 */
function completionFactsOf(sessionId: string): CompletionAttentionFacts {
  const workspaceKey = resolveSessionWorkspaceKey(sessionId);
  const activeKey = workspacePath ? refKey(workspacePath) : null;
  return {
    workspaceKey,
    tabActive: workspaceKey !== null && workspaceKey === activeKey,
    sessionCurrent: (chatViews?.getActiveSessionId() ?? null) === sessionId,
    windowFocused: isMainWindowFocused(),
  };
}

/**
 * 「任务完成」绿色呼吸的武装入口：吃与会话状态流同一份全量推送（`setStatusListener`），
 * 差分出 running → idle 且用户当时看不到的完成，记入未读集合后立即尝试推送。
 */
function updateCompletionAttentionFromStates(
  states: ReadonlyArray<import('../src/shared/AssistantEventBus.js').SessionRuntimeState>,
): void {
  const arm = diffCompletionAttention(completionAttentionLevels, states, completionFactsOf);
  completionAttentionLevels = arm.next;
  // 快照里消失的会话（关闭工作区 / 删除对话）不再提醒
  let removed = false;
  for (const sessionId of arm.gone) {
    if (unreadCompletionSessions.delete(sessionId)) removed = true;
    backfillArmedSessions.delete(sessionId);
  }
  for (const key of arm.tabs) unreadCompletionTabs.add(key);
  for (const sessionId of arm.sessions) unreadCompletionSessions.add(sessionId);
  syncCompletionAttention();
  // 清除也要同步出去：让渲染层把已消失会话的灯条熄掉（与推送同一幂等快照）
  if (removed) syncCompletionAttention();
}

/**
 * 回窗已读清理：从未读对话集合移除此刻完全可见（聚焦 + 激活标签页 + 当前对话，
 * `pickReadCompletions`）的条目。清除原本只挂「成为当前对话」「激活标签页」两个
 * 迁移事件；完成发生在窗口失焦期间、而该对话**本来就是**当前对话时迁移永远不来
 * ——聚焦是它唯一的已读时机。focus 处理器先调这里再 `syncCompletionAttention`：
 * 正看着的对话不亮灯，切到别的对话后也不会补亮。
 */
function reconcileCompletionAttention(): void {
  if (unreadCompletionSessions.size === 0) return;
  let removed = false;
  for (const sessionId of pickReadCompletions([...unreadCompletionSessions], completionFactsOf)) {
    if (unreadCompletionSessions.delete(sessionId)) removed = true;
    completionsReadInRun.add(sessionId);
    backfillArmedSessions.delete(sessionId);
  }
  if (removed) syncCompletionAttention();
}

/**
 * 把未读完成的全量集合推给三个渲染层（幂等快照，不是增量事件）：
 * - 标题栏：标签页集合（浮窗没有标签页，照推无害——标签页区隐藏）；
 * - 侧栏 / webview：会话集合。渲染层按 sessionId 匹配自己的列表，列表里没有的
 *   id 自然不亮；集合里已有的 id 保留原到达时刻（不重复呼吸），新 id 以到达时刻
 *   起算呼吸一个周期后转常亮。
 *
 * 推送时机 = 武装即推（失焦也推：可见但未聚焦的窗口当场亮灯；最小化 / 隐藏窗口
 * 推送无可见效果，恢复后以常亮呈现）+ 回窗聚焦（focus 处理器先经
 * `reconcileCompletionAttention` 清掉已读再推）+ 切换标签页 / 切换窗口模式后的
 * 新可见表面补齐（集合未变，已亮的不重播呼吸）。
 */
function syncCompletionAttention(): void {
  fileLogger.info('completion-sync', `tabs=[${[...unreadCompletionTabs].join(',')}] sessions=${unreadCompletionSessions.size}`);
  const sessions = [...unreadCompletionSessions];
  sendToTitlebar('titlebar:workspace-completion', [...unreadCompletionTabs]);
  sidebarView?.webContents.send('sidebar:session-completion', sessions);
  uiHost?.broadcastToWebviews({ type: 'sessionCompletionAttention', sessionIds: sessions });
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
 * 完成提醒的确认窗口（毫秒）：空闲挂起项自动提交 / 排队压缩续跑都发生在 idle 推送
 * **之后**（挂起项是 webview 本地事实，宿主无从预知，docs/features/user-message-pipeline.md
 * FR-003），差分看到 running → idle 时队列里可能还有活。窗口结束时会话仍空闲 / 等用户
 * 才提醒；期间又跑起来则取消，真正的完成由续跑任务自己的 running → idle 再触发
 * （docs/hosts/host-matrix.md 托盘段落）。本地提交链路（webview → 宿主 → core）
 * 一个往返即可让会话回到 running，1s 足以覆盖，也把真完成的提醒最多推迟这一窗口。
 */
const COMPLETION_ATTENTION_GRACE_MS = 1000;

/** 每会话的完成提醒定时器（确认窗口；确认通过 / 取消 / 会话消失时移除） */
const pendingCompletionTimers = new Map<string, NodeJS.Timeout>();

/**
 * 托盘状态点：running / waiting 由 core 的 sessionRuntimeChanged 全量推送，
 * 经 ElectronConversationManager.setStatusListener 到达这里；不再从对话列表推导。
 *
 * 有会话在等待用户确认/提问 → 黄点；有会话运行中 → 红点；全部空闲 → 绿点。
 * 状态未变化时不重建图标（createFromBitmap / resize 有一定开销）。
 *
 * 另外负责「任务结束提醒」：任一会话从运行中结束（完成 → idle、转等待 → waiting）
 * 且窗口处于后台时就闪烁，**不看聚合状态是否变化**——两个对话在跑时其中一个完成，
 * 聚合仍是 running，同样要提醒（红点闪）。事件由 `diffSessionEndEvents` 对相邻两次
 * 全量推送差分得出；闪烁颜色取当前聚合状态。完成提醒进确认窗口
 * （`COMPLETION_ATTENTION_GRACE_MS`）：空闲挂起项提交 / 队列续跑造成的
 * idle → running 闪现不算完成，不提醒；转等待立即提醒不设窗口。
 */
/**
 * 启动恢复期间的托盘提醒抑制（specs/031 FR-006）：启动恢复打开的远程工作区经
 * 认领重放补发孤儿期间的快照序列，其中的 running → idle 差分会命中托盘提醒的
 * 「窗口不在前台」条件，造成开屏误闪提示音。抑制带硬上限，首个窗口聚焦即解除；
 * 对话列表绿灯（completionAttention）不受影响——那是用户主动要看的未读事实。
 */
let startupTraySuppressionDeadline = Date.now() + 30_000;

function trayAttentionSuppressed(): boolean {
  return Date.now() < startupTraySuppressionDeadline;
}

function updateTrayStatusFromStates(
  states: ReadonlyArray<import('../src/shared/AssistantEventBus.js').SessionRuntimeState>,
): void {
  const status = deriveTrayStatusFromStates(states);
  const ends = diffSessionEndEvents(traySessionLevels, states);
  traySessionLevels = ends.next;

  // 确认窗口内又跑起来的会话不是完成：取消其提醒定时器（含从快照消失的会话）
  for (const [sessionId, timer] of [...pendingCompletionTimers]) {
    const level = ends.next.get(sessionId)?.level;
    if (level === 'running' || level === undefined) {
      clearTimeout(timer);
      pendingCompletionTimers.delete(sessionId);
    }
  }
  // 完成进确认窗口：窗口结束时仍空闲 / 等用户才提醒（空闲挂起项提交、排队压缩等
  // 队列续跑造成的 idle → running 闪现不算完成）；trayStatus 为 null = 托盘未建，
  // 闪烁无从谈起，跳过
  for (const sessionId of ends.completedSessions) {
    // 启动恢复窗口内的「完成」是认领重放的补发（specs/031），不武装托盘提醒：
    // 差分表照常推进，绿灯由 completionAttention 负责
    if (trayAttentionSuppressed()) continue;
    const timer = setTimeout(() => {
      pendingCompletionTimers.delete(sessionId);
      if (trayStatus && shouldFireCompletion(traySessionLevels.get(sessionId)?.level)) {
        startAttention(trayStatus);
      }
    }, COMPLETION_ATTENTION_GRACE_MS);
    pendingCompletionTimers.set(sessionId, timer);
  }

  if (status !== trayStatus) {
    trayStatus = status;

    if (status === 'running' && attentionActive) {
      attentionActive = false;
    }

    if (attentionActive) {
      if (!startTrayBlink(status)) restoreTrayIcon();
    } else {
      restoreTrayIcon();
    }
  }

  if (ends.anyNowWaiting && !trayAttentionSuppressed()) {
    startAttention(status);
  }
}

/**
 * 重新注册全局唤醒快捷键：先注销旧值，再读取宿主本地偏好并注册新值。
 * 注册失败（快捷键被系统或其它程序占用）不弹窗（托盘 / 菜单入口仍然可用），
 * 但必须落日志留痕——静默失效的症状是「按快捷键没反应」，没有日志无从排查。
 */
function registerWakeShortcut(): void {
  registerWakeShortcutValue(readWakeShortcutSync());
}

/** 按指定值注册全局唤醒快捷键（先注销旧值）；失败落日志，不中断主流程 */
function registerWakeShortcutValue(shortcut: string): void {
  if (appQuitting) return;
  // 偏好设置窗口打开期间不注册全局快捷键，避免用户按下的组合键被占用/触发
  if (preferenceDialogSenders.size > 0) return;
  if (registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
  }
  try {
    if (globalShortcut.register(shortcut, () => toggleMainWindowFromTray())) {
      registeredWakeShortcut = shortcut;
      console.log(`[main] Global wake shortcut registered: ${shortcut}`);
      return;
    }
    // 组合键被占用（另一个实例 / 其它程序）：应用仍可用，失效原因必须可见
    const message = `wake shortcut not registered (already taken): ${shortcut}`;
    console.warn(`[main] ${message}`);
    fileLogger.warn('shortcut', message);
  } catch (err) {
    const message = `wake shortcut register threw: ${shortcut}: ${String(err)}`;
    console.warn(`[main] ${message}`);
    fileLogger.warn('shortcut', message);
  }
}

/** 偏好设置窗口打开：临时注销全局唤醒快捷键，避免用户按下的组合键直接触发唤醒 */
function suspendWakeShortcut(sender: Electron.WebContents): void {
  const senderId = sender.id;
  if (preferenceDialogSenders.has(senderId)) return;
  preferenceDialogSenders.add(senderId);
  // 窗口被销毁（关闭 / 应用退出）时兜底释放，避免快捷键一直处于注销状态
  sender.once('destroyed', () => {
    if (preferenceDialogSenders.delete(senderId) && preferenceDialogSenders.size === 0) {
      resumeWakeShortcutInternal();
    }
  });
  if (preferenceDialogSenders.size === 1 && registeredWakeShortcut) {
    globalShortcut.unregister(registeredWakeShortcut);
    registeredWakeShortcut = undefined;
    console.log('[main] Global wake shortcut suspended while the shortcut dialog is open');
  }
}

/** 偏好设置窗口关闭后恢复全局快捷键注册（按最新宿主本地偏好） */
function resumeWakeShortcutInternal(): void {
  if (appQuitting) return;
  registerWakeShortcut();
}

/**
 * 打开偏好设置窗口（菜单「偏好设置...」）。
 *
 * 承载三块宿主本地偏好：
 * - 主题：点选立即生效（applyThemeMode）；窗口配色走 `prefers-color-scheme`，
 *   切换后窗口自己跟着变，不需要关掉重开
 * - 提示音：开关与音量落盘；打开提示音 / 拖完音量滑条时预览播放一次
 *   （与任务结束提醒共用同一个播放载体，见 attentionSound）
 * - 快捷键：唤醒 / 下一标签 / 上一标签三行逐行录制（specs/021），点行内字段后录制，
 *   按键捕获在主进程的 before-input-event 里做（复用 electron/shortcut.ts）；标签行
 *   录制先过冲突判定，保存后 setupMenu() 即时换绑。打开期间注销全局快捷键
 *   （suspendWakeShortcut）
 *
 * 与自绘消息框（`electron/styledMessageBox.ts`）同构：主进程把 HTML 作为 data URL
 * 载入 BrowserWindow，页面通过 preload 的 preferenceAPI 通信。
 */
function openPreferenceDialog(): void {
  if (preferenceDialogWindow && !preferenceDialogWindow.isDestroyed()) {
    preferenceDialogWindow.focus();
    return;
  }

  /** 正在录制改键的行（specs/021：唤醒 / 下一标签 / 上一标签逐行录制；null = 未在录制） */
  let capturing: ShortcutRow | null = null;
  let shortcutError: string | undefined;

  // 主窗口可见时才挂为子窗口：窗口最小化到托盘时挂隐藏的父窗口会让对话框也显示不出来
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined;
  // useContentSize 按内容区定尺寸：四行快捷键 + 音量条全展开 + 校验错误行的内容高度
  // 约 530（CSS px，与 DPI 无关），560 留出余量——内容装得下，页面不出现滚动条
  const win = new BrowserWindow({
    width: 460,
    height: 560,
    useContentSize: true,
    ...(parent ? { parent } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: tt('偏好设置', 'Preferences'),
    icon: path.join(APP_ROOT, 'assets', 'logo.png'),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preferencePreload.cjs'),
    },
  });
  preferenceDialogWindow = win;
  guardViewNavigation(win.webContents, 'preference-dialog');

  const currentState = (): PreferenceDialogState => {
    const sound = readSoundSettingsSync();
    return {
      theme: currentThemeMode,
      wakeShortcutDisplay: formatAcceleratorForDisplay(readWakeShortcutSync()),
      nextTabShortcutDisplay: formatAcceleratorForDisplay(readShortcutValueSync('nextTab')),
      prevTabShortcutDisplay: formatAcceleratorForDisplay(readShortcutValueSync('prevTab')),
      openTerminalShortcutDisplay: formatAcceleratorForDisplay(readShortcutValueSync('openTerminal')),
      capturing,
      ...(shortcutError ? { shortcutError } : {}),
      soundEnabled: sound.enabled,
      soundVolume: sound.volume,
    };
  };
  const pushState = (): void => {
    if (!win.isDestroyed()) win.webContents.send('preference-dialog:state', currentState());
  };
  const closeDialog = (): void => {
    if (!win.isDestroyed()) win.close();
  };

  const onSetTheme = (_event: Electron.IpcMainEvent, mode: unknown): void => {
    if (!isThemeMode(mode)) return;
    applyThemeMode(mode);
    pushState();
  };
  const onSetSoundEnabled = (_event: Electron.IpcMainEvent, enabled: unknown): void => {
    const on = enabled === true;
    try {
      writeSoundEnabled(on);
    } catch (err) {
      console.error('[main] persist sound enabled failed:', err);
    }
    // 打开提示音时试听一次：用户当场听到开关与音量生效
    if (on) attentionSound.preview();
    pushState();
  };
  const onSetSoundVolume = (_event: Electron.IpcMainEvent, volume: unknown): void => {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    const clamped = clampSoundVolume(volume);
    try {
      writeSoundVolume(clamped);
    } catch (err) {
      console.error('[main] persist sound volume failed:', err);
    }
    // 拖完滑条预览播放一次：与提醒同一个载体、同一份音量
    attentionSound.preview();
    pushState();
  };
  const onCaptureShortcut = (_event: Electron.IpcMainEvent, row: unknown): void => {
    // 行标识由页面随点击带上；不在可录制行之列的请求直接忽略（不过度 fallback）
    if (row !== 'wake' && row !== 'nextTab' && row !== 'prevTab' && row !== 'openTerminal') return;
    capturing = row;
    shortcutError = undefined;
    pushState();
  };
  const onClose = (): void => closeDialog();

  ipcMain.handle('preference-dialog:get-state', () => currentState());
  ipcMain.on('preference-dialog:set-theme', onSetTheme);
  ipcMain.on('preference-dialog:set-sound-enabled', onSetSoundEnabled);
  ipcMain.on('preference-dialog:set-sound-volume', onSetSoundVolume);
  ipcMain.on('preference-dialog:capture-shortcut', onCaptureShortcut);
  ipcMain.on('preference-dialog:close', onClose);

  // 打开期间注销全局快捷键：否则用户按下的组合键会先触发唤醒
  suspendWakeShortcut(win.webContents);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') {
      event.preventDefault();
      if (capturing) {
        capturing = null;
        shortcutError = undefined;
        pushState();
      } else {
        closeDialog();
      }
      return;
    }
    if (!capturing) return;
    event.preventDefault();
    const accelerator = acceleratorFromKeyboardEvent({
      code: input.code,
      key: input.key,
      ctrlKey: input.control,
      altKey: input.alt,
      metaKey: input.meta,
      shiftKey: input.shift,
    });
    if (!accelerator) return; // 只按了修饰键，继续等待
    // 标签快捷键先过冲突判定（specs/021 FR-003）：与任一既有绑定相同即拒绝，
    // 行内报错、原值保持、录制态保留（用户可直接再按别的组合）
    if (capturing !== 'wake') {
      const row = capturing;
      const registered: RegisteredShortcuts = {
        wake: readWakeShortcutSync(),
        nextTab: readShortcutValueSync('nextTab'),
        prevTab: readShortcutValueSync('prevTab'),
        openTerminal: readShortcutValueSync('openTerminal'),
        menuAccelerators: collectFixedMenuAccelerators(),
      };
      const conflict = findShortcutConflict(row, accelerator, registered);
      if (conflict) {
        shortcutError = conflictMessage(conflict);
        pushState();
        return;
      }
      try {
        writeShortcutValue(row, accelerator);
      } catch (err) {
        console.error('[main] save shortcut failed:', err);
        shortcutError = tt('保存失败', 'Failed to save');
        pushState();
        return;
      }
      capturing = null;
      shortcutError = undefined;
      pushState();
      return;
    }
    try {
      writeWakeShortcut(accelerator);
    } catch (err) {
      console.error('[main] save wake shortcut failed:', err);
      shortcutError = tt('保存失败', 'Failed to save');
      pushState();
      return;
    }
    capturing = null;
    shortcutError = undefined;
    pushState();
  });

  win.on('closed', () => {
    ipcMain.removeHandler('preference-dialog:get-state');
    ipcMain.removeListener('preference-dialog:set-theme', onSetTheme);
    ipcMain.removeListener('preference-dialog:set-sound-enabled', onSetSoundEnabled);
    ipcMain.removeListener('preference-dialog:set-sound-volume', onSetSoundVolume);
    ipcMain.removeListener('preference-dialog:capture-shortcut', onCaptureShortcut);
    ipcMain.removeListener('preference-dialog:close', onClose);
    if (preferenceDialogWindow === win) preferenceDialogWindow = undefined;
  });

  win.once('ready-to-show', () => win.show());

  const html = getPreferenceDialogHtml({
    // 与菜单 / 托盘 / Spin 设计器同源：消费启动期收敛的宿主 locale（uiLanguage 显式
    // zh / en 覆盖系统语言），不直接看 app.getLocale()——否则英文系统的用户即使选了
    // 中文，这个窗口仍是英文（specs/defects/preference-dialog-ignores-ui-language.md）
    locale: getHostLocale(),
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
 * 在创建原生 UI 之前收敛宿主语言（`docs/hosts/host-bootstrap.md` 第 2 节）。
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
    // 宽度走 currentSidebarWidth()（用户拖拽值 + 窗口相关夹取），
    // 与 chatBounds() 的 left 取值同源，聊天区与侧栏永远贴合
    sidebarView?.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: currentSidebarWidth(), height: contentHeight });
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

/** 该 IPC 是否来自应用自有的侧栏视图：文件浏览通道能删工作区文件，必须校验来源 */
function isSidebarSender(sender: Electron.WebContents): boolean {
  const sidebar = sidebarView?.webContents;
  return !!sidebar && !sidebar.isDestroyed() && sender === sidebar;
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
    // 模式切换改变了可见表面（浮窗没有侧栏与标签页，完整模式相反）：
    // 补推一次未读完成，让新可见表面的灯条挂上（集合未变，已亮的不重播呼吸）
    syncCompletionAttention();
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

/**
 * 指定工作区的显示名（标题栏标签页 / 浮窗品牌位用）。
 *
 * 远程把目录名放在前、主机名放在后（`目录名@主机名`，如 `TEST@192.168.1.1`）：
 * 标签页收窄时从左往右截断，目录名是最能区分工作区的一段，必须留在可见侧；
 * 同名目录靠尾部主机名区分（`docs/hosts/electron-multi-workspace.md` 第 5 节）。
 */
function workspaceDisplayNameOf(ref: WorkspaceRef | undefined): string {
  if (!ref) return '';
  const trimmed = ref.path.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed) || ref.path;
  return ref.endpoint ? `${base}@${ref.endpoint.host}` : base;
}

/** 把窗口标题同步到当前模式 / 工作区 */
function syncWindowTitle(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(windowTitleForCurrentState());
}

/** 标签页流水灯的聚合状态：waiting（黄，优先）> running（蓝） */
type WorkspaceActivityLevel = 'waiting' | 'running';

/**
 * 会话归属的打开项（工作区引用）：宿主索引命中后按打开集合匹配；未命中时按
 * Client 的会话路由表兜底。路由表兜底的场景：跨工作区子代理会话由目标工作区
 * Core 在后台创建（specs/025 FR-001），不经过「打开对话 / 读列表」路径——宿主
 * 索引（`syncSessionWorkspaceIndex`）只刷新活动工作区的列表快照，要等该工作区
 * 被激活重读列表才补上；而派发时刻（`requestCrossWorkspaceAgent` →
 * `assignSession`）路由表就已登记归属（specs/023 FR-002），按它解析归属，
 * 标签页流水灯 / 关闭确认不必等用户切到目标标签页才亮。
 */
function resolveSessionWorkspaceRef(sessionId: string): WorkspaceRef | undefined {
  const indexed = sessionWorkspaces.get(sessionId);
  if (indexed) {
    return openWorkspaces.find((candidate) => workspacePathMatches(candidate, indexed));
  }
  const routed = coreClient?.workspaceRefForSession(sessionId);
  if (!routed) return undefined;
  return openWorkspaces.find((candidate) => sameWorkspaceRef(candidate, routed));
}

/**
 * 汇总每个打开的工作目录的运行时状态，供标题栏标签页流水灯使用：
 * 该目录下任一会话在等待用户操作（ask user / 权限确认）→ `waiting`（黄，优先）；
 * 否则任一会话非 idle（查询 / 压缩 / 后台 Bash / 子代理）→ `running`（蓝）。
 *
 * 两份输入都取宿主自己的投影，不依赖进程内 core 状态（``docs/architecture/principles.md` 第 6 节
 * 「core 描述事实，UI 决定表现」）：
 * - 状态：`ConversationManager` 缓存的全量快照——core 的 `sessionRuntimeChanged`
 *   经 Connection 推到宿主后存在这里。Standalone（产品形态）下 core 在独立进程，
 *   会话运行时事实在 Core 进程内，主进程里没有可读的登记表；
 * - 归属：宿主的「会话 → 工作目录」索引（打开 / 加载对话时登记，见
 *   `syncSessionWorkspaceIndex`），即 core 那张表在本进程的投影；索引未命中时
 *   按 Client 路由表兜底（`resolveSessionWorkspaceRef`）。
 */
function collectWorkspaceActivity(): Record<string, WorkspaceActivityLevel> {
  const result: Record<string, WorkspaceActivityLevel> = {};
  for (const state of conversations?.getSessionStatesSnapshot() ?? []) {
    // 忙闲判定收敛在 core 的 sessionBusyLevel（与托盘 / 关闭确认同一份派生）：
    // waiting（等用户）> running > idle
    const level = sessionBusyLevel(state);
    if (level === 'idle') continue;
    const target = resolveSessionWorkspaceRef(state.sessionId);
    if (!target) continue;
    const key = refKey(target);
    if (level === 'waiting') result[key] = 'waiting';
    else if (result[key] !== 'waiting') result[key] = 'running';
  }
  return result;
}

/** 把标签页流水灯状态推给标题栏（状态流每次变化时调用，就地更新不重建标签页） */
function syncTitlebarActivity(): void {
  sendToTitlebar('titlebar:workspace-activity', collectWorkspaceActivity());
}

/**
 * 该工作目录下是否有非 idle 的对话（waiting 也算忙：等用户输入的会话关掉会丢问题）。
 * 与标签页流水灯 / 托盘消费同一个派生（core 的 `sessionBusyLevel`）。
 */
function workspaceHasBusySession(ref: WorkspaceRef): boolean {
  return collectWorkspaceActivity()[refKey(ref)] !== undefined;
}

/**
 * 该对话当前是否非 idle（含 waiting）：读宿主缓存的会话运行时快照（与
 * `collectWorkspaceActivity` 同一份事实、同一个派生 `sessionBusyLevel`），
 * 未登记任何事实（含新建中的 `new-` 临时 key）＝ 空闲。
 */
function sessionIsBusy(sessionId: string): boolean {
  const states = conversations?.getSessionStatesSnapshot() ?? [];
  const state = states.find((candidate) => candidate.sessionId === sessionId);
  return state !== undefined && sessionBusyLevel(state) !== 'idle';
}

/**
 * 关闭前的二次确认（自绘模态对话框，electron/styledMessageBox.ts）：返回 true 表示
 * 用户确认关闭。窗口不可用时没有可确认的对象，按「继续关闭」处理（与无确认路径同行为）。
 */
async function confirmCloseBusy(message: string, detail: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  const response = await showStyledMessageBox(mainWindow, {
    type: 'warning',
    buttons: [tt('仍然关闭', 'Close Anyway'), tt('取消', 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
}

/**
 * 忙碌远程工作区的三选对话框（specs/031 FR-001）：后台运行 / 立即关闭 / 取消，
 * 默认焦点落在取消（防误关）。窗口不可用时按「取消」处理——退出确认链的关键
 * 不变量是每条出口都能走到真正的退出，但「静默替用户选后台运行」不可接受，
 * 让 daemon 默认策略接管的出口只属于弹不出任何对话框的崩溃路径。
 */
async function confirmRemoteCloseChoice(ref: WorkspaceRef): Promise<'detach' | 'close' | 'cancel'> {
  if (!mainWindow || mainWindow.isDestroyed()) return 'cancel';
  // 文案区分等待与运行：waiting 的会话后台运行后请求仍在等待，回来即可应答
  const activity = collectWorkspaceActivity()[refKey(ref)];
  const detail = activity === 'waiting'
    ? tt('远端有对话在等待你的输入。后台运行保留任务与等待中的请求，重开工作区即可应答；立即关闭会中止它们。',
         'A conversation is waiting for your input. Keep it running in the background and answer later, or stop it now.')
    : tt('远端有对话仍在运行。后台运行让任务继续执行，重开工作区即可恢复；立即关闭会中止它们。',
         'Conversations are still running remotely. Keep them running in the background, or stop them now.');
  const response = await showStyledMessageBox(mainWindow, {
    type: 'warning',
    message: tt(`「${refDisplay(ref)}」下仍有对话在运行`,
                `Conversations in "${refDisplay(ref)}" are still running`),
    detail,
    buttons: [
      tt('后台运行', 'Run in Background'),
      tt('立即关闭', 'Close Now'),
      tt('取消', 'Cancel'),
    ],
    defaultId: 2,
    cancelId: 2,
  });
  return response === 0 ? 'detach' : response === 1 ? 'close' : 'cancel';
}

/**
 * 退出确认链的远程段（specs/031 FR-002）：按标签页顺序逐个工作区弹三选，决策落表；
 * 任一「取消」中止整个退出（返回 null）。忙碌判据与关一张标签同一份事实
 * （collectWorkspaceActivity 的宿主快照投影）。
 */
async function confirmQuitWorkspaces(
  refs: readonly WorkspaceRef[],
): Promise<ReadonlyMap<string, CoreChannelCloseMode> | null> {
  const decisions = new Map<string, CoreChannelCloseMode>();
  for (const ref of refs) {
    const choice = await confirmRemoteCloseChoice(ref);
    if (choice === 'cancel') return null;
    decisions.set(refKey(ref), choice);
  }
  return decisions;
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
 * 打开/关闭开发者工具（Ctrl+Shift+I）：独立窗口打开（detach——主窗口是自绘
 * WebContentsView 布局，停靠式面板会挤压 / 遮挡视图，且在部分打包形态下不可见）。
 * 优先调试当前聚焦的 webContents（聊天视图/侧栏），聚焦不可用时回退到活动聊天
 * 视图，最后回退到主窗口。
 */
function toggleDevTools(): void {
  const target = webContents.getFocusedWebContents()
    ?? chatViews?.getActiveWebContents()
    ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null);
  if (!target || target.isDestroyed()) return;
  if (target.isDevToolsOpened()) target.closeDevTools();
  else target.openDevTools({ mode: 'detach' });
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

/** 显示「关于」对话框（原生菜单与自绘菜单共用）：自绘窗口，与应用深浅主题一致 */
function showAboutDialog(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void showStyledMessageBox(mainWindow, {
    type: 'info',
    buttons: [tt('确定', 'OK')],
    defaultId: 0,
    cancelId: 0,
    message: PRODUCT_NAME,
    detail: tt(`版本 ${app.getVersion()}`, `Version ${app.getVersion()}`),
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
    label: tt('打开最近的工作区', 'Open Recent Workspace'),
    submenu: buildRecentWorkspacesMenu(),
  };
  // 标签页切换快捷键（specs/021）：accelerator 取宿主本地偏好的当前值（默认
  // Ctrl+Tab / Ctrl+Shift+Tab），改键保存后 writeShortcutValue 重建动作表即时换绑；
  // 菜单条目与组合键同源（原生菜单、自绘菜单、before-input-event 兜底三处共用）
  const nextTabItem: MenuItemDef = {
    id: 'main.nextWorkspaceTab',
    label: tt('下一标签', 'Next Workspace Tab'),
    accelerator: readShortcutValueSync('nextTab'),
    run: () => { switchToAdjacentWorkspace('next'); },
  };
  const prevTabItem: MenuItemDef = {
    id: 'main.prevWorkspaceTab',
    label: tt('上一标签', 'Previous Workspace Tab'),
    accelerator: readShortcutValueSync('prevTab'),
    run: () => { switchToAdjacentWorkspace('prev'); },
  };
  // 打开命令行 / 终端（specs/021 同款宿主本地快捷键，默认 Ctrl+Alt+T，仅应用内生效）：
  // 作用于活动工作区，按端点分叉（本地系统命令行 / 远程 SSH 终端窗口，与标签页右键
  // 同一套入口语义与置灰规则）；accelerator 取宿主本地偏好的当前值，改键保存后
  // writeShortcutValue 重建动作表即时换绑。菜单条目与组合键同源（原生菜单、自绘菜单、
  // before-input-event 兜底三处共用）
  const openTerminalItem: MenuItemDef = {
    id: 'main.openTerminal',
    label: openTerminalMenuLabel(),
    accelerator: readShortcutValueSync('openTerminal'),
    enabled: canOpenTerminalForActiveWorkspace(),
    run: () => { openTerminalForActiveWorkspace(); },
  };
  // 偏好设置：Electron 专属能力（主题 / 唤醒快捷键 / 提示音都是宿主本地偏好，
  // webview 里改不了），统一收进一个自绘设置窗口（见 openPreferenceDialog）
  const preferenceItem: MenuItemDef = {
    id: 'main.preference',
    label: tt('偏好设置...', 'Preferences...'),
    run: () => openPreferenceDialog(),
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
        nextTabItem,
        prevTabItem,
        openTerminalItem,
        { type: 'separator' },
        preferenceItem,
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
      nextTabItem,
      prevTabItem,
      openTerminalItem,
      { type: 'separator' },
      preferenceItem,
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
 * 构建「打开最近的工作区」子菜单项。
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
 * 菜单既有 accelerator（快捷键录制冲突判定的输入，specs/021）。
 * 可录制行的现行值不在此列——它们的冲突由 RegisteredShortcuts 的 nextTab / prevTab /
 * openTerminal 字段表达，避免同一绑定被数两次。
 */
function collectFixedMenuAccelerators(): string[] {
  const index = new Map<string, string>();
  for (const section of buildMenuSections()) {
    collectMenuAccelerators(section.items, index);
  }
  const accelerators: string[] = [];
  for (const [accelerator, id] of index) {
    if (id === 'main.nextWorkspaceTab' || id === 'main.prevWorkspaceTab' || id === 'main.openTerminal') continue;
    accelerators.push(accelerator);
  }
  return accelerators;
}

/** 录制冲突的行内提示文案（specs/021；文案映射留在主进程，冲突判定纯函数不持 i18n） */
function conflictMessage(kind: ShortcutConflictKind): string {
  switch (kind) {
    case 'wake':
      return tt('与唤醒快捷键相同', 'Same as the wake shortcut');
    case 'nextTab':
      return tt('与「下一标签」快捷键相同', 'Same as Next Workspace Tab');
    case 'prevTab':
      return tt('与「上一标签」快捷键相同', 'Same as Previous Workspace Tab');
    case 'openTerminal':
      return tt('与「打开终端」快捷键相同', 'Same as the Open Terminal shortcut');
    case 'menu':
      return tt('与菜单既有快捷键相同', 'Same as an existing menu shortcut');
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
  guardViewNavigation(view.webContents, 'titlebar-menu');
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
  // 上限放到整个内容区宽度：飞出面板按「锚点到窗口右缘」动态取宽，不再能用
  // 固定的「主面板 + 二级面板」封顶（页面上报的是真实并集尺寸，封顶只为防异常值）
  const maxWidth = content.width;
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
    // 飞出面板宽度上限「主面板右边 → 窗口右缘」：面板按内容自适应（条目短就收缩），
    // 「最近的工作区」这类长路径条目最多铺满到这个上限、完整显示不截断
    const flyoutMaxWidth = Math.max(TITLEBAR_SUBMENU_WIDTH, availableRight - TITLEBAR_MENU_WIDTH);
    const html = getTitlebarMenuHtml({
      items: section.items,
      isDark: nativeTheme.shouldUseDarkColors,
      maxHeight,
      availableRight,
      flyoutMaxWidth,
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

/**
 * 在本地目录拉起系统终端（侧栏右键「在此处打开命令行」与标签页右键「打开命令行」
 * 共用这一个入口）。窗口须独立于应用生命周期：detached + stdio ignore 后立刻 unref，
 * 主进程不持有句柄。
 * Windows 上不能直接 `cmd /k`（stdio ignore 时 stdin 是 NUL，cmd 读到 EOF 立即退出，
 * 实测即退）——经 `start` 拉起的新控制台窗口里 stdin 是 CONIN$，交互会话驻留。
 */
const spawnTerminalAt = (dir: string): void => {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    // cwd 直接给目录（start 不带 /D，路径含空格也无需转义）；首参空串是窗口标题占位
    spawn(comspec, ['/c', 'start', '', 'cmd.exe', '/k'], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Linux：Debian 系有 x-terminal-emulator 别名，其余退回 gnome-terminal
  const terminal = fs.existsSync('/usr/bin/x-terminal-emulator') ? '/usr/bin/x-terminal-emulator' : 'gnome-terminal';
  spawn(terminal, ['--working-directory', dir], { detached: true, stdio: 'ignore' }).unref();
};

/**
 * 收集某工作区下可关的批量关闭事实：候选＝该工作区**已打开**的会话视图
 * （`ChatViewManager.getLoadedSessionIds`，含子代理对话），逐个取判定时刻的忙闲
 * （sessionBusyLevel，waiting 也算忙）。弹出菜单（置灰判定）与点击执行各收集一次
 * ——菜单开着期间会话状态可能变化，执行以点击时刻的事实为准。
 *
 * 候选不用「会话 → 工作目录」索引（磁盘对话列表）：列表里没打开过的会话没有视图 /
 * 运行时资源可卸，关它只会发一条按 sessionId 路由不到的 `conversationClosed`
 * （多 Connection 下 Client 查不到归属直接抛错，异常还会中断整批关闭）。
 */
function collectWorkspaceSessionFacts(ref: WorkspaceRef): WorkspaceSessionFacts[] {
  const views = chatViews;
  if (!views) return [];
  const loaded = views.getLoadedSessionIds().map((sessionId) => ({
    sessionId,
    workspaceId: views.getWorkspaceForKey(sessionId),
  }));
  return selectWorkspaceLoadedSessions(loaded, refKey(ref)).map((sessionId) => ({
    sessionId,
    busy: sessionIsBusy(sessionId),
  }));
}

/**
 * 标签页右键菜单（原生 OS 菜单，与加号的 popupWorkspaceMenu 同形态；原生菜单无法被
 * Playwright 驱动，交互按 US-48 豁免人工验证）：关闭 / 关闭所有空闲会话（范围＝右键
 * 工作区里已打开的对话视图，含子代理对话，当前选中的对话空闲也包含在内）/ 关闭其它
 * 所有工作区（任一他区忙碌先弹一次汇总确认）/ 打开命令行（仅本地，目录已不存在置灰）
 * 或打开终端（远程工作区，见 docs/hosts/electron-multi-workspace.md 第 14 节），
 * 条目尾随显示「打开终端」快捷键的当前值。置灰是终态，不在点击后再报错。
 */
function popupTabContextMenu(ref: WorkspaceRef): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: tt('关闭', 'Close'),
      click: () => { void closeWorkspace(refKey(ref)); },
    },
    {
      label: tt('关闭所有空闲会话', 'Close All Idle Sessions'),
      // 置灰判定用弹出时刻的快照；点击时重新收集（菜单开着期间状态可能变化）
      enabled: selectClosableIdleSessions(collectWorkspaceSessionFacts(ref)).length > 0,
      click: async () => {
        // 逐会话走既有关闭入口：关闭时刻重查忙闲，判定后转忙的会话落入既有逐会话
        // 忙碌确认（确认则关、取消则跳过该会话继续其余），不静默跳过
        for (const sid of selectClosableIdleSessions(collectWorkspaceSessionFacts(ref))) {
          await closeConversationWithConfirm(sid);
        }
      },
    },
    {
      label: tt('关闭其它所有工作区', 'Close Other Workspaces'),
      enabled: openWorkspaces.length > 1,
      click: async () => {
        const plan = summarizeOtherWorkspaces(
          openWorkspaces
            .filter((candidate) => candidate !== ref && refKey(candidate) !== refKey(ref))
            .map((candidate) => ({ id: refKey(candidate), hasBusySession: workspaceHasBusySession(candidate) })),
        );
        if (plan.ids.length === 0) return;
        if (plan.needsConfirm && !(await confirmCloseBusy(
          tt('其它工作区中仍有对话在运行', 'Conversations in other workspaces are still running'),
          tt('关闭工作区会中止这些对话的运行。确定关闭全部其它工作区？', 'Closing these workspaces stops them. Close all other workspaces?'),
        ))) return;
        for (const otherId of plan.ids) {
          const target = openWorkspaces.find((candidate) => refKey(candidate) === otherId);
          if (target) teardownWorkspace(target);
        }
      },
    },
    { type: 'separator' },
    // 终端入口按端点分叉（docs/hosts/electron-multi-workspace.md 第 14.1 节）：本地是
    // 系统命令行，远程是该工作区的 SSH 终端窗口；两者互斥，一张标签只出现其一。
    // 条目尾随显示 openTerminal 行的当前快捷键（specs/021），与主菜单「打开终端」条目
    // 同源取宿主本地偏好值；组合键本身作用于活动工作区，本条目作用于右键的那张标签
    ref.endpoint === null
      ? {
          label: tt('打开命令行', 'Open Terminal'),
          // 目录已不存在无从打开
          enabled: fs.existsSync(ref.path),
          accelerator: readShortcutValueSync('openTerminal'),
          click: () => { spawnTerminalAt(ref.path); },
        }
      : {
          label: tt('打开终端', 'Open Terminal'),
          enabled: canOpenRemoteTerminal(ref),
          accelerator: readShortcutValueSync('openTerminal'),
          click: () => { openRemoteTerminalFor(ref); },
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
 * 把「打开远程工作区」窗口的接入请求翻成 `WorkspaceEndpoint`（`docs/core/core-remote.md` 第 2 节）。
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
 * 流程（`docs/core/core-remote.md` 第 2 节）：
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
    // 这一步的键盘中心是页面里的路径框：Alt 不该呼出菜单栏，菜单栏也直接不建
    autoHideMenuBar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'remoteWorkspacePreload.cjs'),
    },
  });
  // 菜单栏只挂在 Windows / Linux 的窗口上（macOS 是应用级菜单，不受影响）
  if (process.platform !== 'darwin') win.setMenu(null);
  remoteWorkspaceWindow = win;
  // 页面注入 remoteWorkspacePreload（含远端目录读写）：同其他应用自有页面一样拒绝导航
  guardViewNavigation(win.webContents, 'remote-workspace');

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

  // SSH 连接历史：候选只带 host / 端口 / 用户（展示与筛选不需要口令）；
  // 口令按选定项经 `remote-workspace:ssh-history-entry` 单独取——不随整表常驻页面
  ipcMain.handle('remote-workspace:ssh-history', (event) => {
    if (!isSender(event.sender)) return [];
    return readSshHistory().map(toSshHistoryCandidate);
  });

  ipcMain.handle('remote-workspace:ssh-history-entry', (event, key: unknown) => {
    if (!isSender(event.sender)) return null;
    if (typeof key !== 'string') return null;
    return readSshHistory().find((entry) => sshHistoryKey(entry) === key) ?? null;
  });

  ipcMain.handle('remote-workspace:ssh-history-remove', (event, key: unknown) => {
    if (!isSender(event.sender)) return readSshHistory().map(toSshHistoryCandidate);
    if (typeof key !== 'string') return readSshHistory().map(toSshHistoryCandidate);
    const next = removeSshEntry(readSshHistory(), key);
    writeWorkspaceState({ ...readWorkspaceState(), recentSshConnections: next });
    return next.map(toSshHistoryCandidate);
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
    ipcMain.removeHandler('remote-workspace:ssh-history-entry');
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
 * 转调 setSessionWorkspace / clearSessionWorkspace）：
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
 * 用对话列表快照刷新宿主的「会话 → 工作目录」索引。
 * 打开对话时按它给聊天视图注入该对话自己的工作目录。
 *
 * 缺省读活动目录的缓存快照；传入列表则从**那份列表**学习（specs/defects/
 * inactive-tab-completion-light-missing）——非活动目录的定向装载（refreshWorkspace）
 * 到达时活动目录的缓存里没有这些会话，只有条目自带的 `project` 能提供归属，
 * 标签页灯的归属解析（resolveSessionWorkspaceRef）才有据可查。
 */
function syncSessionWorkspaceIndex(from?: readonly unknown[]): void {
  const list = from ?? conversations?.getCachedList();
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
  // 侧栏文件浏览器的 SSH 连接共享随工作区一起登记（关闭时按计数释放）
  for (const ref of opened) {
    if (ref.endpoint) retainRemoteFilesClient(ref.endpoint);
  }
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

/** 菜单条目文案随活动工作区端点分叉：本地「打开命令行」、远程「打开终端」（与标签页右键同口径） */
function openTerminalMenuLabel(): string {
  if (workspacePath && workspacePath.endpoint === null) return tt('打开命令行', 'Open Terminal');
  return tt('打开终端', 'Open Terminal');
}

/** 活动工作区的终端入口可用性（与标签页右键同口径：本地目录须存在、远程须有可用凭证） */
function canOpenTerminalForActiveWorkspace(): boolean {
  const ref = workspacePath;
  if (!ref) return false;
  if (ref.endpoint === null) return fs.existsSync(ref.path);
  return canOpenRemoteTerminal(ref);
}

/**
 * 快捷键打开活动工作区的命令行 / 终端（默认 Ctrl+Alt+T，仅应用内生效）：
 * 本地拉起系统命令行（`spawnTerminalAt`）、远程打开该工作区的 SSH 终端窗口，
 * 与标签页右键两条入口共用同一套语义。无活动工作区 / 入口不可用时静默不动
 * （菜单条目置灰兜底，快捷键路径再判一次防置灰判定与按键之间的时序）。
 */
function openTerminalForActiveWorkspace(): void {
  if (!canOpenTerminalForActiveWorkspace()) return;
  const ref = workspacePath;
  if (!ref) return;
  if (ref.endpoint === null) spawnTerminalAt(ref.path);
  else openRemoteTerminalFor(ref);
}

/**
 * 切到相邻标签页（快捷键「下一标签 / 上一标签」，specs/021）：按当前打开集合顺序
 * 取相邻项后走同一份激活链（activateWorkspace），侧栏 / 聊天区 / 标题栏联动与持久化
 * 全部沿用既有语义。集合不足 2 项 / 无活动项时没有相邻项可去，静默不动（设计允许的
 * 瞬时状态，不报错）；目标项在执行前被并发关闭时 activateWorkspace 按 id 重新定位、
 * 定位不到同样落空。
 */
function switchToAdjacentWorkspace(direction: TabSwitchDirection): void {
  // 浮窗模式不切换（docs/hosts/electron-multi-workspace.md 第 5 节）：浮窗只呈现活动
  // 工作目录的对话、不呈现标签页区，组合键 / 菜单条目在该模式下不动作
  if (windowMode === 'floating') return;
  const target = selectAdjacentId(
    openWorkspaces.map((ref) => refKey(ref)),
    workspacePath ? refKey(workspacePath) : null,
    direction,
  );
  if (target !== null) activateWorkspace(target);
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
    // 激活标签页 = 阅读了它的未读完成：清掉标签页项并同步（对话项要等各自被打开才清）
    if (unreadCompletionTabs.delete(refKey(ref))) syncCompletionAttention();
    // 补武装来源随标签页级已读一并失效（specs/defects/inactive-tab-completion-light-missing）：
    // 来源记录只服务「归属晚到的重试补挂」；用户已激活该标签页后，后续列表到达
    // （新建对话 / 改名等都会触发重读）不得把标签页绿灯重新挂回——重试补挂不翻
    // 已读的旧账。对话行未读集合不动（行灯等各自被打开才清）。
    //
    // 归属判定与武装解析同一套查找（`resolveSessionWorkspaceRef`，含 Client 路由表
    // 兜底）：只扫宿主索引会把「武装能解析、作废却拿不到」的会话漏掉——远程工作区
    // 建链就绪后的列表装载是异步的，用户在列表到达前激活标签页时索引尚未登记
    //（specs/defects/completion-tab-light-relights-after-read）。
    for (const sessionId of [...backfillArmedSessions]) {
      const owner = resolveSessionWorkspaceRef(sessionId);
      if (owner && sameRef(owner, ref)) backfillArmedSessions.delete(sessionId);
    }
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
  if (workspaceHasBusySession(ref)) {
    if (ref.endpoint !== null) {
      // 忙碌远程工作区：三选（specs/031 FR-001）。后台运行 = detach——标签页与
      // 打开集合照常移除（最近列表保留），Core 留在远端孤儿表继续执行
      const choice = await confirmRemoteCloseChoice(ref);
      if (choice === 'cancel') return;
      teardownWorkspace(ref, choice);
      return;
    }
    if (!(await confirmCloseBusy(
      tt(`「${refDisplay(ref)}」下仍有对话在运行`, `Conversations in "${refDisplay(ref)}" are still running`),
      tt('关闭工作区会中止这些对话的运行。确定关闭？', 'Closing the workspace stops them. Close anyway?'),
    ))) return;
  }
  teardownWorkspace(ref);
}

/**
 * 关闭工作区的清理链（无确认，确认由调用方负责）：标签页 × / 中键 / 右键「关闭」经
 * `closeWorkspace` 的忙碌确认后进来；右键「关闭其它所有工作区」在**一次汇总确认**后
 * 逐个进来——若走 `closeWorkspace` 会放大成每区一次确认，违背汇总语义。
 */
function teardownWorkspace(ref: WorkspaceRef, closeMode: CoreChannelCloseMode = 'close'): void {
  const idx = openWorkspaces.indexOf(ref);
  if (idx < 0) return;
  openWorkspaces.splice(idx, 1);
  // 标签页关闭即丢弃启动期的不可用判定 / 建链状态：之后经「最近打开」重新添加按全新打开处理
  workspaceAvailabilityState.clearAll(refKey(ref));
  unavailableReasons.delete(refKey(ref));
  // 文件浏览器的 SSH 连接随工作区释放一次共享：同一 endpoint 还有其它工作区
  // 在用时连接保留（引用计数归零才真正断开），重开按新连接处理
  releaseRemoteFilesClient(ref.endpoint);
  // 远程终端窗口随工作区关闭（docs/hosts/electron-multi-workspace.md 第 14.7 节）：shell 通道随窗口收尾，
  // 终端自己的连接租约在窗口 closed 时释放
  closeTerminalWorkspace(refKey(ref));
  // 视图归属按稳定 id（refKey）：同路径不同主机的远程工作区互不误伤。
  // detach（后台运行，specs/031）只销视图：会话与在跑任务留在孤儿的 Core 里继续，
  // 不发 conversationClosed（那会中止整棵会话树）
  chatViews?.closeWorkspace(refKey(ref), { releaseSessions: closeMode !== 'detach' });
  // 该目录的列表快照一并丢弃：关闭期间盘上内容可能变化（另一实例 / daemon 侧），
  // 重新打开时按首次打开处理（无快照 → 完整读一次盘）。其它目录的快照不受影响。
  conversations?.invalidateCachedList(refKey(ref));
  // 关闭的工作区不再提醒：未读完成的标签页项与该目录会话的对话项一并丢弃
  let completionCleared = unreadCompletionTabs.delete(refKey(ref));
  for (const [sid, ws] of [...sessionWorkspaces]) {
    if (workspacePathMatches(ref, ws)) {
      sessionWorkspaces.delete(sid);
      if (unreadCompletionSessions.delete(sid)) completionCleared = true;
      backfillArmedSessions.delete(sid);
    }
  }
  if (completionCleared) syncCompletionAttention();
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
  // 通知 Client 销毁该工作区的 Connection（Standalone 下关闭 Core 进程；
  // detach 为后台运行，specs/031）
  emitWorkspaceChange('closed', ref, closeMode);
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
function markWorkspaceUnavailable(ref: WorkspaceRef, reason: ChatPlaceholderReason, mode: 'build' | 'runtime' = 'build'): void {
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
    `markUnavailable ${refDisplay(ref)}: changed=${changed}, now=${workspaceAvailabilityState.availabilityOf(key)} (${reasonTextOf(reason)})`,
  );
  if (!changed) return;
  unavailableReasons.set(key, reason);
  console.warn(`[main] workspace unavailable: ${refDisplay(ref)} (${reason})`);
  workspaceAvailabilityState.clearReady(key);
  // 状态已落定，**先推送再清理**：推送是标签页红点 / 侧栏状态的唯一来源，不能排在
  // 可能抛错的清理步骤后面——实测回归：销毁该目录的预加载对话视图抛错（standalone
  // 会话释放路径）吞掉了整段推送，标签页黄点一直挂到用户点击标签页才刷新
  syncTitlebarWorkspaces();
  broadcastWorkspaces();
  // 该目录下的对话视图**先于** Connection 销毁：此时会话归属映射还在，视图释放的
  // conversationClosed 正常路由；反过来先摘 Connection，释放时路由必抛
  // 「No Connection owns session」，把整批清理炸断留孤儿视图（此后 LRU 淘汰重新
  // 抛错会杀死主进程，见 specs/defects/workspace-unavailable-teardown-strands-orphan-views）
  try {
    chatViews?.closeWorkspace(refKey(ref));
  } catch (err) {
    // 清理失败不阻断状态收敛（上面已推送）；只留诊断日志
    fileLogger.error('workspace-tab', `closeWorkspace(${refDisplay(ref)}) failed: ${String(err)}`);
  }
  // 该工作区的 Connection 已无法建立：让 Client 销毁（含仍在长超时里挂着的建链尝试），
  // 不留半开的死连接（尚未建立 Connection 的项是空操作）
  emitWorkspaceChange('closed', ref, 'close');
  if (sameRef(workspacePath, ref)) {
    syncChatAreaForActiveWorkspace();
  }
}

/**
 * 重连一个不可用的工作区（占位页「重新连接」按钮触发）：红点先变黄色呼吸点
 * （建链中），经 `openRemoteWorkspaceAfterProbe`（3 秒建链超时，远端引导不计入）
 * 重新建链——建链中保持到 Connection 就绪（coreReady）才收场：绿点与聊天区由
 * `onWorkspaceConnectionState` 的 ready 信号恢复，不在 opened 时刻就撤掉占位页
 * （daemon 通道异步建立，Connection 注册滞后于 opened；窗口期内恢复可输入会让
 * 输入在 Client 路由层被静默丢弃，见
 * specs/defects/ssh-reconnect-send-dropped-before-connection-ready）。失败回到
 * 红点，原因落盘并留给占位页。主机密钥变更是例外流程：弹比对告警，用户确认即
 * 重建信任并立刻重试一次。本地项的重试只校验目录是否重新存在。
 * 建链中重复触发忽略；标签页被关闭则中止。
 */
async function reconnectWorkspace(id: string): Promise<void> {
  const ref = openWorkspaces.find((candidate) => refKey(candidate) === id);
  if (!ref || workspaceAvailability(ref) !== 'unavailable') return;
  const key = refKey(ref);
  workspaceAvailabilityState.markConnecting(key);
  syncTitlebarWorkspaces();
  if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
  try {
    try {
      await openRemoteWorkspaceAfterProbe(ref);
    } catch (err) {
      // 主机密钥变更：静默失败对用户等于死路——弹告警展示新旧指纹，
      // 确认后重建信任再试一次（拒绝则维持不可用）
      if (!(err instanceof SshHostKeyError)) throw err;
      if (!(await confirmHostKeyChange(err))) throw err;
      recordKnownHostFingerprint(err.host, err.port, err.observedFingerprint);
      fileLogger.info(
        'workspace-tab',
        `host key for ${err.host}:${err.port} re-trusted after confirmation; retrying reconnect`,
      );
      await openRemoteWorkspaceAfterProbe(ref);
    }
  } catch (err) {
    const reason = unavailableReasonOf(err);
    unavailableReasons.set(key, reason);
    // 失败原因必须落盘：只进 console 时，日志文件里重连为什么失败无据可查
    fileLogger.info('workspace-tab', `reconnect failed (${refDisplay(ref)}): ${reasonTextOf(reason)}`);
    console.warn(`[main] workspace reconnect failed: ${refDisplay(ref)}:`, err);
    // 失败收场：回到红点。成功路径的建链中不在 finally 里无条件清掉——
    // 保持到 Connection 就绪，由 onWorkspaceConnectionState 的 ready 收尾
    workspaceAvailabilityState.clearConnecting(key);
  } finally {
    // 失败 → 红点；成功 → 建链中黄点保持（ready 收尾）。两条路都刷新一次：
    // 占位页与标签页同批画出落定后的状态
    syncTitlebarWorkspaces();
    if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
  }
}

/**
 * 重连的核心段：短超时探测远程 endpoint（本地项校验目录存在），通过后撤销不可用
 * 判定、补建 Connection 并激活。重连与「指纹确认后的重试」共用；失败抛错由调用方
 * 决定是否重试。
 */
async function openRemoteWorkspaceAfterProbe(ref: WorkspaceRef): Promise<void> {
  if (ref.endpoint) {
    const { probeRemoteEndpoint } = require('../src/host/bootstrapCore.js') as typeof import('../src/host/bootstrapCore.js');
    await probeRemoteEndpoint(ref.endpoint, CONNECT_PROBE_TIMEOUT_MS);
  } else if (!isValidWorkspaceDir(ref.path)) {
    throw new Error(`本地目录仍不存在：${ref.path}`);
  }
  // 等待期间标签页可能已被关闭：不再补建 Connection
  if (!openWorkspaces.some((candidate) => refKey(candidate) === refKey(ref))) return;
  // 只撤销不可用判定；建链中保持到 Connection 就绪（coreReady）——聊天区与绿点都由
  // ready 信号收尾，不在 opened 时刻恢复可输入（窗口期内的输入会被 Client 路由层
  // 静默丢弃，见 specs/defects/ssh-reconnect-send-dropped-before-connection-ready）
  workspaceAvailabilityState.revokeUnavailable(refKey(ref));
  unavailableReasons.delete(refKey(ref));
  emitWorkspaceChange('opened', ref);
  activateWorkspace(ref);
  // 复用仍存活的已就绪 Connection（opened 未新建而是激活）时 ready 信号不会再来：
  // 就地收尾建链中，不让黄点挂死
  recoverConnectingIfReady(ref);
}

/**
 * Connection 已就绪而建链中标记还在时就地收尾：登记 ready、清掉建链中并刷新
 * 标签页与聊天区。opened 走「激活已有 Connection」分支时 coreReady 不会重发，
 * 没有这一步黄点会挂死（新建 Connection 的常规路径由 ready 事件收尾，不走这里）。
 */
function recoverConnectingIfReady(ref: WorkspaceRef): void {
  const key = refKey(ref);
  if (!workspaceAvailabilityState.hasConnecting(key)) return;
  const connection = coreClient?.connectionForWorkspace(ref);
  if (!connection || !connection.isReady()) return;
  workspaceAvailabilityState.markReady(key);
  workspaceAvailabilityState.clearConnecting(key);
  syncTitlebarWorkspaces();
  if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
}

/**
 * 打开指定工作区的远程终端窗口（docs/hosts/electron-multi-workspace.md 第 14.1 / 14.2 节）。
 *
 * 入口是标签页右键「打开终端」，作用于右键的那张标签（不必是活动项）。条目可用性由
 * `canOpenRemoteTerminal` 在菜单弹出时判定；点击里再判一次防御时序（弹出与点击之间
 * 凭证可能已变化）。
 */
function openRemoteTerminalFor(ref: WorkspaceRef): void {
  if (!canOpenRemoteTerminal(ref)) return;
  openTerminalWindow({
    ref,
    appRoot: APP_ROOT,
    locale: getHostLocale(),
    fontSizePx: terminalFontSizePx(readTerminalFontPreference()),
    // 终端窗口的标签切换组合与工作区标签页同源（specs/021）；开窗取现值，
    // 改键保存后经 writeShortcutValue 的 applyTerminalShortcuts 同步
    readTabShortcuts: () => ({
      nextTab: readShortcutValueSync('nextTab'),
      prevTab: readShortcutValueSync('prevTab'),
    }),
    log: (...args: unknown[]): void => {
      fileLogger.info('terminal', args.map((a) => String(a)).join(' '));
    },
    confirmHostKeyChange,
  });
}

/** 界面字号档位的实时读取（与聊天视图的 readUiPreferences 同一来源；未就绪回缺省档） */
function readTerminalFontPreference(): 'medium' | 'large' | 'xlarge' | undefined {
  try {
    const { getSettingsStore } = require('../src/host/SettingsStore.js') as typeof import('../src/host/SettingsStore.js');
    return getSettingsStore().readUiFontSize();
  } catch {
    return undefined;
  }
}

/**
 * 主机密钥变更告警（TOFU 的确认例外）：展示记录与观测两份指纹，用户确认后重建
 * 信任。拒绝 / 主窗口不可用时按不确认处理，工作区维持不可用（占位页保留指纹
 * 比对信息）。
 */
async function confirmHostKeyChange(err: SshHostKeyError): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const target = `${err.host}:${err.port}`;
  const response = await showStyledMessageBox(mainWindow, {
    type: 'warning',
    buttons: [tt('信任并重连', 'Trust && Reconnect'), tt('取消', 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    message: tt('SSH 主机密钥已变更', 'SSH host key has changed'),
    detail: tt(
      `${target} 的主机密钥与首次连接时记录的指纹不一致。\n\n`
      + `记录的指纹：${err.expectedFingerprint}\n`
      + `观测的指纹：${err.observedFingerprint}`,
      `${target}'s host key differs from the fingerprint recorded on first connect.\n\n`
      + `Recorded: ${err.expectedFingerprint}\n`
      + `Observed: ${err.observedFingerprint}`,
    ),
  });
  return response === 0;
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
    chatViews.setWorkspacePath('', '');
    chatViews.disposeAll();
    chatViews.openNewConversation('');
    return;
  }
  const availability = workspaceAvailability(workspacePath);
  if (availability === 'available') {
    chatViews.showChatPlaceholder(null);
    // setActiveWorkspace 负责更新 opts.workspacePath 并清理旧目录的预热视图
    chatViews.setActiveWorkspace(workspacePath.path, refKey(workspacePath));
    return;
  }
  // 该目录的对话不可用：清空侧栏对话列表（上一目录的列表不再适用）
  conversations?.clearConversationList();
  chatViews.setWorkspacePath(workspacePath.path, refKey(workspacePath));
  chatViews.showChatPlaceholder(
    getChatPlaceholderHtml({
      kind: availability === 'connecting'
        ? 'connecting'
        : workspacePath.endpoint
          ? 'remoteUnreachable'
          : 'dirMissing',
      path: refDisplay(workspacePath),
      // 不可用原因：指纹变更带新旧指纹引导确认，其余展示原始错误；无记录为 null
      reason: availability === 'unavailable'
        ? (unavailableReasons.get(refKey(workspacePath)) ?? null)
        : null,
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
  // 同一连接目标（端口归一 + 凭证指纹，`sshTargetKey` 唯一派生）只探测一次
  const groups = new Map<string, { endpoint: WorkspaceEndpoint; display: string; refs: WorkspaceRef[] }>();
  for (const ref of openWorkspaces) {
    const endpoint = ref.endpoint;
    if (!endpoint || !workspaceAvailabilityState.hasConnecting(refKey(ref))) continue;
    const key = sshTargetKey(sshTargetFor(endpoint));
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
          unavailableReasons.delete(key);
          // 探测期间 Connection 先死了一步（lost → 已标红）：endpoint 事实上可达，恢复并补建。
          // 建链中保持到 Connection 就绪（coreReady）——绿点与聊天区由 ready 信号收尾，
          // 不在 opened 时刻恢复可输入（窗口期内的输入会被 Client 路由层静默丢弃）
          if (workspaceAvailabilityState.revokeUnavailable(key)) {
            workspaceAvailabilityState.clearReady(key);
            emitWorkspaceChange('opened', ref);
          }
          // opened 激活的是仍就绪的存量 Connection 时 ready 不会重发，就地收尾
          recoverConnectingIfReady(ref);
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
          markWorkspaceUnavailable(ref, unavailableReasonOf(err));
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

// ==================== 宿主本地偏好：theme / shortcut / sound ====================

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
  return resolveShortcut(readWorkspaceState().shortcut, DEFAULT_WAKE_SHORTCUT);
}

/** 持久化唤醒快捷键（调用方已规范化） */
function writeWakeShortcut(shortcut: string): void {
  writeWorkspaceState({ ...readWorkspaceState(), shortcut });
}

/** 可录制快捷键的行标识 → 状态文件字段与默认值（specs/021；openTerminal 为终端入口行） */
const SHORTCUT_ROWS = {
  nextTab: { field: 'nextTabShortcut', fallback: DEFAULT_NEXT_TAB_SHORTCUT },
  prevTab: { field: 'prevTabShortcut', fallback: DEFAULT_PREV_TAB_SHORTCUT },
  openTerminal: { field: 'openTerminalShortcut', fallback: DEFAULT_OPEN_TERMINAL_SHORTCUT },
} as const;

/** 读取可录制快捷键（缺失 / 非法时回退默认值；与唤醒快捷键同口径，不写回） */
function readShortcutValueSync(row: keyof typeof SHORTCUT_ROWS): string {
  const { field, fallback } = SHORTCUT_ROWS[row];
  return resolveShortcut(readWorkspaceState()[field], fallback);
}

/** 持久化可录制快捷键（调用方已规范化），重建菜单动作表让组合即时换绑；
 * 终端窗口的标签快切吃同一份偏好，经 applyTerminalShortcuts 同步到已开的窗口 */
function writeShortcutValue(row: keyof typeof SHORTCUT_ROWS, accelerator: string): void {
  const { field } = SHORTCUT_ROWS[row];
  writeWorkspaceState({ ...readWorkspaceState(), [field]: accelerator });
  setupMenu();
  applyTerminalShortcuts(readShortcutValueSync('nextTab'), readShortcutValueSync('prevTab'));
}

/**
 * 读取提示音偏好：是否播放 + 音量（0–1 线性增益）。
 *
 * 字段缺失 / 非法按默认（开启、满音量，与提示音引入时的行为一致）——规范化
 * 收敛在纯函数 `readSoundSettings` 里（`electron/soundSettings.ts`）。
 */
function readSoundSettingsSync(): SoundSettings {
  return readSoundSettings(readWorkspaceState());
}

/** 持久化「是否播放提示音」 */
function writeSoundEnabled(enabled: boolean): void {
  writeWorkspaceState({ ...readWorkspaceState(), soundEnabled: enabled });
}

/** 持久化提示音音量（调用方已收敛到 [0, 1]） */
function writeSoundVolume(volume: number): void {
  writeWorkspaceState({ ...readWorkspaceState(), soundVolume: volume });
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
 *    `appData/<productName>`（`<product-name>`），开发态落在 `appData/Electron`。
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
        const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf-8')) as unknown;
        const migrated = migrateLegacyWorkspaceFields(raw);
        if (!migrated) continue;

        // 旧字段 `lastWorkspace` 不再写回新文件（迁移只发生一次，读取路径只认新字段）
        const { lastWorkspace: _legacyLast, ...rest } = raw as WorkspaceState & LegacyWorkspaceFields;
        writeWorkspaceState({
          ...rest,
          openWorkspaces: migrated.openWorkspaces,
          activeWorkspace: migrated.activeWorkspace,
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
    // 兼容归一之前写下的远程键（末尾多一个 `/`，见 workspaceRefKeyMatches）
    const found = open.find((ref) => workspaceRefKeyMatches(ref, activeWorkspaceKey));
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
 * 重启后直接恢复并重新连接（见 `docs/core/client-connection.md` 第 9 节）。
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
 * 按去重键去重，最多 20 个，最近的在最前。
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

/** 把工作区置顶写入最近列表（按去重键去重、最多 20 个） */
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
  // 判据收在 viewerWindowRect（与查看器 / 设计器窗口共用同一份实现）
  return isRectVisibleOnSomeWorkArea(rect, screen.getAllDisplays().map(({ workArea }) => workArea));
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
 *
 * 没有打开的视图（`ChatViewManager.isViewAlive` 为假）时直接空操作：没有可卸的运行时
 * 资源，而 `conversationClosed` 按会话路由到归属 Connection——本进程没打开过的会话在
 * Client 侧没有归属，多 Connection 下查不到归属直接抛错（批量关闭里一次抛错会中断
 * 后续会话，见 docs/hosts/webview-ui.md 第 1 节）。
 */
async function closeConversationWithConfirm(sessionId: string): Promise<void> {
  if (!chatViews?.isViewAlive(sessionId)) return;
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
 * 宿主只负责「关视图」：对受影响闭包里**已打开**的视图逐个调 WebViewUI.closeConversation
 * （卸内存 + 销毁视图，5.5 节约定顺序）——没打开的会话没有视图可关，也不该发
 * conversationClosed（按会话路由不到归属，多 Connection 下抛错会中断删除）。
 * 闭包由 core 的 collectConversationClosure 算出——与 deleteConversation 同一条规则，
 * 不再在宿主里重写一遍；删盘与列表广播由 core 的 conversationDeleted 订阅
 * （deleteConversation → conversationListChanged）承担。
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
  const { loadConversationList, collectConversationClosure } = await import('../src/shared/history/index.js');
  // 按该会话自己的工作目录读列表：删除的对话可能不在当前活动工作目录
  const affected = collectConversationClosure(
    sessionId,
    await loadConversationList(sessionWorkspaces.get(sessionId)),
  );
  for (const sid of affected) {
    // 只有打开着的视图需要关：闭包里的子会话可能从未在本进程打开过，没有可卸资源，
    // 关它会发一条按会话路由不到的 conversationClosed（多 Connection 下 Client 查不到
    // 归属直接抛错，异常会中断删除、conversationDeleted 发不出去）。core 侧
    // deleteConversation 递归处理整个闭包（文件 / 缓存 / 引擎 / MCP / 运行时状态），
    // 跳过没有视图的会话不会漏卸。
    if (chatViews?.isViewAlive(sid)) webviewUi?.closeConversation(sid);
    // 宿主索引同步清理：会话已删除，避免陈旧 sessionId → 目录 条目长期残留
    sessionWorkspaces.delete(sid);
  }
  // 删盘（core 消费方：算闭包已由宿主完成，这里只发 root）
  const { requireEventBus } = await import('../src/shared/AssistantEventBus.js');
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

  // 视图的会话身份变化时，把临时 new- 视图转为正式会话条目。
  // 表达「这个视图现在是哪个会话」的消息：
  // - startNewConversation：webview 新建对话（含预热视图激活）
  // - loadConversation：webview 请求加载某个会话（用户手动切换 / 打开某对话）
  // - sendMessage 且来源视图还是临时 new- 键：首条消息可能抢在挂载后 500ms 的
  //   startNewConversation 上报之前发出（发送路径自己生成 session id，
  //   useAppHandlers.ts）——视图身份在这一刻同样确立。不晋升的话该会话永远进不了
  //   「已打开会话」集合，UserChoiceQueue 判 open=false，manual 模式的权限确认
  //   停在 pending 不投递（不弹框、回合挂死）。
  // 对「key 已经等于 sessionId」的调用，registerSession 是提前返回的空操作。
  const sourceViewKey = chatViews?.getKeyByWebContents(sender) ?? null;
  const establishesViewSession = message.type === 'startNewConversation'
    || message.type === 'loadConversation'
    || (message.type === 'sendMessage' && !!sessionId && sourceViewKey?.startsWith('new-') === true);
  if (establishesViewSession) {
    if (sessionId) {
      // 该视图自己的工作区是权威来源（新建对话继承它；加载对话本就属于它）；
      // 视图归属按稳定 id 登记，这里取路径用于 sessionWorkspaces（会话 → 目录索引）
      const workspace = chatViews?.getWorkspacePathForWebContents(sender);
      chatViews?.registerSession(sender, sessionId);
      const resolved = workspace ?? chatViews?.getWorkspacePathForKey(sessionId);
      if (resolved) {
        const p = canonicalWorkspacePath(resolved);
        sessionWorkspaces.set(sessionId, p);
        void registerCoreSessionWorkspace(sessionId, p);
      }
    }
  }

  // 用户发出了新对话的第一条消息：该会话开始落盘，不再是「新建但还没发过消息」的对话。
  // 清除该标记后，下次点侧栏「新建」才会创建新的聊天视图，而不是复用这个已有内容的对话。
  // 必须放在上面的晋升之后：registerSession 会把临时键的「未发送」标记迁移到正式 id，
  // 先标记会漏删、视图被误判为仍可复用的新对话。
  if (message.type === 'sendMessage' && sessionId) {
    chatViews?.markSessionUsed(sessionId);
  }

  // webview 内点击子代理/回复/From 链接等跳转到指定会话：新起一个 webview 加载该对话
  if (message.type === 'openConversation') {
    if (sessionId) {
      let workspace: string | undefined;
      if (message.targetWorkspaceId) {
        // 跨工作区跳转（specs/023 FR-005）：按代理身份解析打开集合，未打开 / 歧义都忽略
        const machineName = resolveMachineName(process.platform, process.env, hostname());
        const resolved = resolveWorkspaceByIdentity(
          openWorkspaces,
          message.targetWorkspaceId,
          machineName,
        );
        if (resolved.kind !== 'match') {
          console.warn(
            '[main] ignore cross-workspace jump:',
            message.targetWorkspaceId,
            resolved.kind,
          );
          return;
        }
        workspace = resolved.ref.path;
        sessionWorkspaces.set(sessionId, workspace);
      } else {
        syncSessionWorkspaceIndex();
        workspace = sessionWorkspaces.get(sessionId);
      }
      // 会话所属目录建链中 / 不可用：不开对话视图（聊天区由占位页占据）
      if (!isWorkspaceUsableForConversation(workspace)) {
        console.warn('[main] ignore open-conversation for non-available workspace:', workspace);
        return;
      }
      if (workspace) void registerCoreSessionWorkspace(sessionId, workspace);
      activateWorkspaceForPath(workspace);
      chatViews?.openConversation(sessionId, workspaceIdForPath(workspace), workspace);
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
      // 未读完成的标签页集合：推送早于标题栏订阅（页面加载期）的窗口由这份
      // 初始快照补上，离场完成的标签页灯不因加载时序丢失
      completion: [...unreadCompletionTabs],
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

  // 标签页右键：弹出该工作区的上下文菜单（关闭 / 批量关闭 / 打开命令行）
  ipcMain.on('titlebar:tab-context-menu', (event, p: unknown) => {
    if (!isTitlebarSender(event.sender)) return;
    if (typeof p !== 'string' || !p) return;
    const ref = openWorkspaces.find((candidate) => refKey(candidate) === p);
    if (ref) popupTabContextMenu(ref);
  });

  ipcMain.on('titlebar:add-workspace', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    void openWorkspaceDialog();
  });

  // 加号按钮：弹出「打开本地工作区 / 打开远程工作区 / 打开最近的工作区」菜单
  ipcMain.on('titlebar:workspace-menu', (event) => {
    if (!isTitlebarSender(event.sender)) return;
    // 先收起可能还开着的自绘下拉菜单：两个菜单同时开着会让焦点 / Esc 语义混乱
    closeTitlebarMenu();
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
    // 变量名与 e2e 用例共用同一常量（envPrefix 派生，源码不持有产品字面量）。
    const e2eSlowListMs = Number(process.env[E2E_SLOW_LIST_ENV]);
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
  // 会话运行时事实在 Core 进程内（经 sessionRuntimeChanged 全量推送），主进程只缓存快照，
  // 必须走这份缓存（``docs/architecture/principles.md` 第 6 节）。
  ipcMain.handle('sidebar:get-session-states', () => {
    return conversations?.getSessionStatesSnapshot() ?? [];
  });

  // 未读完成集合流与状态流同构：「变化时才推」，侧栏初始化 / 重载时主动拉一次，
  // 补上「补武装推送早于侧栏订阅（页面加载期）」造成的空档，否则离场完成的绿灯
  // 一直不亮（specs/defects/orphan-completion-unread-light）
  ipcMain.handle('sidebar:get-session-completion', () => [...unreadCompletionSessions]);

  ipcMain.handle('sidebar:get-active-session', () => {
    return chatViews?.getActiveSessionId() ?? null;
  });

  // 工作目录流：打开集合 + 活动项 + 最近列表（可用子集，与侧栏推送同一形态）
  ipcMain.handle('sidebar:get-workspaces', () => sidebarWorkspaceState());

  // ── 侧栏宽度拖拽（US-44） ──
  // 拖拽过程高频触发走 send（fire-and-forget，不等回包不落盘）；pointerup 带
  // final: true 时同步落盘一次（workspace-state.json 的 sidebarWidth 字段）。
  // width 传 null = 双击手柄恢复默认宽度。只接受侧栏视图来源：宽度是窗口级布局
  // 事实，别让任意页面都能改。
  ipcMain.on('sidebar:set-width', (event, payload: unknown) => {
    // send 通道的来源守卫按 titlebar:* 的同一口径静默 return（throw 会成为主进程未捕获异常）
    if (!isSidebarSender(event.sender)) return;
    const p = (payload ?? {}) as { width?: unknown; final?: unknown };
    if (p.width === null) {
      applySidebarWidth(SIDEBAR_DEFAULT_WIDTH, true);
      return;
    }
    if (typeof p.width !== 'number' || !Number.isFinite(p.width)) return;
    applySidebarWidth(p.width, p.final === true);
  });

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

  ipcMain.on('sidebar:open-conversation', (
    _event,
    sessionId: string,
    project?: string,
  ) => {
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
      chatViews?.openConversation(sessionId, workspaceIdForPath(workspace), workspace);
    }
  });

  ipcMain.on('sidebar:new-conversation', () => {
    // 活动工作区建链中 / 不可用：没有可用的对话视图，占位页期间忽略新建
    if (workspacePath && workspaceAvailability(workspacePath) !== 'available') {
      console.warn('[main] ignore new-conversation for non-available workspace:', refDisplay(workspacePath));
      return;
    }
    chatViews?.openNewConversation(workspacePath ? refKey(workspacePath) : '');
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
      const { requireEventBus } = await import('../src/shared/AssistantEventBus.js');
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
      // 先刷新会话工作目录索引并登记到 core：命名按会话解析工作目录（数据 / 配置都在 core）
      syncSessionWorkspaceIndex();
      const smartWs = sessionWorkspaces.get(sessionId);
      if (smartWs) void registerCoreSessionWorkspace(sessionId, smartWs);
      // 智能命名编排属 core：走受控事实入口（coreFacts），经
      // UiRequest.smartNamingRequested 交给 Core 进程（数据 / 配置都在 Core 侧）。
      // 标题写盘走 UiEvent.conversationRenamed，广播由 core 发
      const title = await requestSmartNaming(sessionId);
      const { requireEventBus } = await import('../src/shared/AssistantEventBus.js');
      requireEventBus().emitToCore({ type: 'conversationRenamed', sessionId, title });
      // 标题回推与列表刷新由 core 广播（titleChanged / conversationListChanged）
      return { ok: true, title };
    } catch (err) {
      console.error('[main] sidebar:smart-name-conversation error:', err);
      return { ok: false, error: String(err) };
    }
  });

  // ── 侧栏文件浏览器（US-42 / US-43） ──
  // workspaceId 由渲染层回传、不可信：它是侧栏工作区项的稳定 id（refKey），按 id 回查
  // 「打开集合中的工作区」——不能按路径回查：远程项的展示路径（ssh://user@host/…）
  // 与 ref.path（远端真实路径）不同，且同一路径可以在多台机器上出现，只有 id 唯一
  // （与侧栏「最近打开」点击的回查方式同一约定）。条目相对路径再经 sidebarFiles 的
  // 越界校验（本地 win32 / 远程 posix），双保险缺一不可。
  const resolveFilesRef = (workspaceId: unknown): WorkspaceRef | null => {
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;
    return openWorkspaces.find((ref) => refKey(ref) === workspaceId) ?? null;
  };
  /** 公共入参校验：workspaceId 合法 + paths 是非空字符串数组；不合法时回错误而非抛错（渲染层按 ok:false 显示） */
  const parseFilesPayload = (
    payload: unknown,
  ): { ref: WorkspaceRef; rels: string[] } | { error: string } => {
    const p = (payload ?? {}) as { workspaceId?: unknown; paths?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { error: 'workspace-unavailable' };
    if (!Array.isArray(p.paths) || p.paths.length === 0 || !p.paths.every((x) => typeof x === 'string' && x.length > 0)) {
      return { error: 'invalid-arguments' };
    }
    return { ref, rels: p.paths as string[] };
  };
  // 文件操作日志落盘（console 在打包态不可见）：远程 SFTP 的连接建立 / 失败原因
  // 只有在这里才能事后排查（SshClient 的 [ssh] 行也走这个出口）
  const fileOpLog = (...args: unknown[]): void => {
    fileLogger.info('sidebar-files', args.map((a) => String(a)).join(' '));
  };

  ipcMain.handle('sidebar:files-list', async (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-list');
    const p = (payload ?? {}) as { workspaceId?: unknown; dir?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { ok: false, error: 'workspace-unavailable' };
    if (typeof p.dir !== 'string') return { ok: false, error: 'invalid-arguments' };
    if (ref.endpoint) {
      // 远程（SSH）：SFTP 列目录，路径按远端 POSIX 语义校验
      try {
        return { ok: true, entries: await listRemoteDirectory(ref.endpoint, ref.path, p.dir, fileOpLog) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fileLogger.warn('sidebar-files', `list failed (${refDisplay(ref)}/${p.dir}): ${message}`);
        return { ok: false, error: message };
      }
    }
    const abs = resolveWithinRoot(ref.path, p.dir, { allowRoot: true });
    if (!abs) return { ok: false, error: 'outside-root' };
    try {
      return { ok: true, entries: await listDirectory(abs) };
    } catch (err) {
      // 目录读不到（被外部删除 / 无权限）原样回给渲染层显示，不猜空列表
      const message = err instanceof Error ? err.message : String(err);
      fileLogger.warn('sidebar-files', `list failed (${refDisplay(ref)}/${p.dir}): ${message}`);
      return { ok: false, error: message };
    }
  });

  // 文档视图（specs/030 FR-003 / FR-004）：git 口径（本地直跑 / 远程 SSH exec——git
  // 输出永远产生在文件所在的那台机器上）与非 git 记录口径（workspace.meta.json，
  // 本地 fs / 远程 SFTP，只读）分流取数
  const remoteGitRunner = (client: SshClient, root: string): GitCommandRunner => {
    const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
    const posixJoin = (a: string, b: string): string => `${a.replace(/\/+$/, '')}/${b}`;
    return {
      run: async (args) => {
        // 参数逐个单引号转义：不经 shell 展开（*.md pathspec 必须原样到达 git）
        const out = await client.exec(`git -C ${shQuote(root)} ${args.map(shQuote).join(' ')}`);
        if (out.code === null) throw new Error('远端 git 命令超时或未给出退出码');
        return { code: out.code, stdout: out.stdout, stderr: out.stderr };
      },
      readFile: async (rel) => {
        try {
          return (await client.readFileBuffer(posixJoin(root, rel))).toString('utf8');
        } catch {
          return null;
        }
      },
      exists: async (rel) => {
        try {
          return (await client.stat(posixJoin(root, rel))).exists;
        } catch {
          return false;
        }
      },
    };
  };

  const remoteMetaAccess = (client: SshClient): RemoteMetaAccess => ({
    homeDir: () => client.homeDir(),
    readFile: async (remotePath) => {
      try {
        return (await client.readFileBuffer(remotePath)).toString('utf8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no such file/i.test(message)) return null;
        throw err;
      }
    },
    stat: async (remotePath) => {
      try {
        return (await client.stat(remotePath)).exists;
      } catch {
        return false;
      }
    },
  });

  ipcMain.handle('sidebar:files-doc-list', async (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-doc-list');
    const p = (payload ?? {}) as { workspaceId?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { ok: false, error: 'workspace-unavailable' };
    try {
      if (ref.endpoint) {
        const client = await sharedClientFor(ref.endpoint, fileOpLog);
        const runner = remoteGitRunner(client, ref.path);
        const probe = await probeGitWorkspace(runner);
        if (probe === 'yes') {
          const result = await collectGitEntries(runner);
          return result.ok
            ? { ok: true, mode: result.mode, rows: buildDocRows(result.entries) }
            : result;
        }
        if (probe === 'no') {
          const paths = await readRemoteModifiedDocs(remoteMetaAccess(client), CONFIG_DIR_NAME, ref.path);
          const entries = await collectRecordEntries(paths, runner.exists);
          return { ok: true, mode: 'record', rows: buildDocRows(entries) };
        }
        return { ok: false, error: probe.error };
      }
      const runner = localGitRunner(ref.path);
      const probe = await probeGitWorkspace(runner);
      if (probe === 'yes') {
        const result = await collectGitEntries(runner);
        return result.ok
          ? { ok: true, mode: result.mode, rows: buildDocRows(result.entries) }
          : result;
      }
      if (probe === 'no') {
        const paths = await readModifiedDocs(ref.path);
        const entries = await collectRecordEntries(paths, runner.exists);
        return { ok: true, mode: 'record', rows: buildDocRows(entries) };
      }
      return { ok: false, error: probe.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fileLogger.warn('sidebar-files', `doc-list failed (${refDisplay(ref)}): ${message}`);
      return { ok: false, error: message };
    }
  });

  // 文档视图开关上报（specs/030 FR-003）：主进程据此挂 / 摘 git 哨兵监听；
  // host 在 initCore 创建，侧栏 handler 注册先于它——经模块级回填引用解耦时序
  ipcMain.on('sidebar:files-doc-watch', (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) return;
    const p = (payload ?? {}) as { workspaceId?: unknown; enabled?: unknown };
    if (typeof p.workspaceId !== 'string' || typeof p.enabled !== 'boolean') return;
    void electronHost?.setDocSentinel(p.workspaceId, p.enabled);
  });

  ipcMain.handle('sidebar:files-reveal', (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-reveal');
    // 单项语义用单项契约：preload 发 `{ workspaceId, path }`（此前借复数 paths 数组
    // 再 slice(0,1) 静默丢多余项）
    const p = (payload ?? {}) as { workspaceId?: unknown; path?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { ok: false, error: 'workspace-unavailable' };
    if (typeof p.path !== 'string' || p.path.length === 0) return { ok: false, error: 'invalid-arguments' };
    // 「在文件资源管理器中打开」只对本地路径有意义：远程项在渲染层就不显示该菜单项
    if (ref.endpoint) return { ok: false, error: 'remote-unsupported' };
    const abs = resolveWithinRoot(ref.path, p.path);
    if (!abs) return { ok: false, error: 'outside-root' };
    shell.showItemInFolder(abs);
    return { ok: true };
  });

  ipcMain.handle('sidebar:files-open-terminal', (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-open-terminal');
    const p = (payload ?? {}) as { workspaceId?: unknown; dir?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { ok: false, error: 'workspace-unavailable' };
    if (typeof p.dir !== 'string') return { ok: false, error: 'invalid-arguments' };
    // 与 reveal 同理：远程项在渲染层就不显示该菜单项，主进程再拒一次（双保险）
    if (ref.endpoint) return { ok: false, error: 'remote-unsupported' };
    // 根目录（空 rel）合法：工作区根就是「此处」
    const abs = resolveWithinRoot(ref.path, p.dir, { allowRoot: true });
    if (!abs) return { ok: false, error: 'outside-root' };
    try {
      spawnTerminalAt(abs);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fileLogger.warn('sidebar-files', `open terminal failed (${refDisplay(ref)}/${p.dir}): ${message}`);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('sidebar:files-copy-paths', (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-copy-paths');
    const p = (payload ?? {}) as { relative?: unknown };
    const parsed = parseFilesPayload(payload);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const { ref, rels } = parsed;
    if (ref.endpoint) {
      // 远程：绝对路径是远端 POSIX 串（逐项越界校验），相对路径保持 '/' 分隔——
      // 复制出来的路径要能在远端 shell 里直接用，不经本地 path 翻译
      const abs = resolveAllWithinRoot(ref.path, rels, { posix: true });
      if (!abs) return { ok: false, error: 'outside-root' };
      clipboard.writeText((p.relative === true ? rels : abs).join('\n'));
      return { ok: true };
    }
    const abs = resolveAllWithinRoot(ref.path, rels);
    if (!abs) return { ok: false, error: 'outside-root' };
    // 本地：相对路径按平台分隔符输出，与「复制完整路径」同一口径
    const text = (p.relative === true ? formatRelativePaths(ref.path, rels) : abs).join('\n');
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('sidebar:files-delete', async (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-delete');
    const parsed = parseFilesPayload(payload);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const { ref, rels } = parsed;
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no-window' };
    // 自绘确认框（与应用深浅主题一致），本地 / 远程分别措辞：本地移入回收站（可恢复），
    // 远程永久删除（目录连同内容，远端没有回收站）。默认与取消都落在「取消」
    // （与 confirmCloseBusy 同一口径，e2e 直接驱动自绘窗口的按钮）。
    const isRemote = ref.endpoint !== null;
    const shown = rels.slice(0, 5).join('\n');
    const detailList = `${shown}${rels.length > 5 ? `\n${tt(`…（共 ${rels.length} 项）`, `… (${rels.length} items in total)`)}` : ''}`;
    const response = await showStyledMessageBox(mainWindow, {
      type: 'warning',
      buttons: isRemote
        ? [tt('永久删除', 'Delete Permanently'), tt('取消', 'Cancel')]
        : [tt('移入回收站', 'Move to Trash'), tt('取消', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: tt(`要删除选中的 ${rels.length} 项吗？`, `Delete ${rels.length} selected item(s)?`),
      detail: (isRemote
        ? tt('所选项目将被永久删除（目录连同内容），无法撤销：', 'The selected items will be deleted permanently (directories with their contents). This cannot be undone:')
        : tt('所选项目将移入系统回收站：', 'The selected items will be moved to the Recycle Bin:'))
        + `\n${detailList}`,
    });
    if (response !== 0) return { ok: false, error: 'cancelled' };
    if (ref.endpoint) {
      try {
        await deleteRemotePaths(ref.endpoint, ref.path, rels, fileOpLog);
      } catch (err) {
        // 部分失败如实回报（渲染层无论成败都刷新树，残留项会自然显现）
        const message = err instanceof Error ? err.message : String(err);
        fileLogger.warn('sidebar-files', `remote delete failed (${refDisplay(ref)}): ${message}`);
        return { ok: false, error: message };
      }
      return { ok: true };
    }
    const abs = resolveAllWithinRoot(ref.path, rels);
    if (!abs) return { ok: false, error: 'outside-root' };
    // 逐项失败收集收敛在 deleteEachPath（与远程 SFTP 删除同一份口径）；
    // 部分失败如实回报（渲染层无论成败都刷新树，残留项会自然显现）
    try {
      await deleteEachPath(rels, (rel) => {
        const target = resolveWithinRoot(ref.path, rel);
        if (!target) return Promise.reject(new Error('path escapes the workspace root'));
        return shell.trashItem(target);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fileLogger.warn('sidebar-files', `delete failed (${refDisplay(ref)}): ${message}`);
      return { ok: false, error: message };
    }
    return { ok: true };
  });

  // ── 双击打开文件（US-42 验收 6） ──
  // 分流在 electron/fileOpen.ts：Markdown → 内置 Markdown 预览窗口（渲染后的只读
  // HTML）、文本 → 内置 Monaco 窗口（与「Edit 预览」同一效果）、
  // 图片 → 内置图片查看器（滚轮缩放）、其它二进制 → 系统默认应用。
  // 远程工作区：Markdown / 文本 / 图片走 SFTP 读出进内置窗口；二进制不支持打开。
  const fileOpenBridge: FileOpenBridge = {
    openMarkdownViewer: (init) => {
      if (!uiHost) throw new Error('ui host unavailable');
      return uiHost.openMarkdownPreviewWindow(init);
    },
    openImageViewer: (init) => {
      if (!uiHost) throw new Error('ui host unavailable');
      return uiHost.openImagePreviewWindow(init);
    },
    openTextViewer: (init) => {
      if (!uiHost) throw new Error('ui host unavailable');
      // filePath 传文件名：Monaco 只用它做语法推断，不读盘（内容已在 content 里）
      return uiHost.openMonacoWindow({ mode: 'view', ...init });
    },
    openLocalFile: (filePath) => {
      if (!uiHost) throw new Error('ui host unavailable');
      // 侧栏双击的是本地工作区文件，没有来源对话视图：不参与远程机器归属解析
      return uiHost.openFile(filePath, null, null);
    },
    openWithSystemApp: async (filePath) => {
      // shell.openPath 失败时回错误串（成功回 ''），原样抛给调用方显示
      const failure = await shell.openPath(filePath);
      if (failure) throw new Error(failure);
    },
  };

  ipcMain.handle('sidebar:files-open', async (event, payload: unknown) => {
    if (!isSidebarSender(event.sender)) throw new Error('unauthorized: sidebar:files-open');
    const p = (payload ?? {}) as { workspaceId?: unknown; path?: unknown };
    const ref = resolveFilesRef(p.workspaceId);
    if (!ref) return { ok: false, error: 'workspace-unavailable' };
    if (typeof p.path !== 'string' || p.path.length === 0) return { ok: false, error: 'invalid-arguments' };
    if (!uiHost) return { ok: false, error: 'no-host' };
    try {
      if (ref.endpoint) {
        await openRemoteWorkspaceFile(
          fileOpenBridge,
          remoteFileReaderFor(ref.endpoint, fileOpLog),
          ref.endpoint,
          ref.path,
          p.path,
        );
      } else {
        await openLocalWorkspaceFile(fileOpenBridge, ref.path, p.path);
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 远程二进制「不支持打开」是预期行为：不弹框，渲染层静默忽略
      if (message === REMOTE_BINARY_UNSUPPORTED) {
        fileOpLog(`remote binary open skipped (${refDisplay(ref)}/${p.path})`);
        return { ok: false, error: message };
      }
      // 打不开（读盘失败 / 系统应用拒绝 / 越界）如实回报：日志落盘 + 自绘提示框
      fileLogger.warn('sidebar-files', `open failed (${refDisplay(ref)}/${p.path}): ${message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        void showStyledMessageBox(mainWindow, {
          type: 'warning',
          buttons: [tt('确定', 'OK')],
          defaultId: 0,
          cancelId: 0,
          message: tt(`无法打开「${p.path}」`, `Cannot open "${p.path}"`),
          detail: message,
        });
      }
      return { ok: false, error: message };
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
  electronHost = host;
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
  // 会话 → 工作目录索引的宿主侧查询口（specs/030 FR-001：toolResult 相对路径解析）
  host.setSessionWorkspaceLookup((sessionId) => sessionWorkspaces.get(sessionId) ?? null);
  const spinDesign = new ElectronSpinDesign(host);
  const conversationsMgr = new ElectronConversationManager(
    host,
    (channel: string, payload: unknown) => {
      if (sidebarView && !sidebarView.webContents.isDestroyed()) {
        sidebarView.webContents.send(channel, payload);
      }
    },
    // 列表快照按工作区稳定 id 分份（同路径不同主机的远程工作区互不命中）；
    // 路径反查打开集合拿引用，查不到（瞬时未登记）退回路径本身——不会误判成活动项
    (path) => {
      if (!path) return '';
      const ref = openWorkspaces.find((candidate) => workspacePathMatches(candidate, path));
      return ref ? refKey(ref) : path;
    },
    // 灯管线：任何目录的列表到达都走这里（specs/defects/inactive-tab-completion-light-missing）。
    // 工作区对话列表到达即刷新「会话 → 工作目录」索引：远程工作区建链慢，列表常晚于
    // 工作区激活到达（首次 sidebar:get-conversations 只拿到空快照）。删除 / 重命名 /
    // 智能命名 / 从侧栏打开对话都按会话 id 反查该索引解析工作目录，不在这里补记，这些
    // 操作对晚到的会话会解析不到归属（批量关闭空闲会话不走该索引，它按已打开的会话
    // 视图枚举）。归属从**到达的那份列表**学习（条目自带 project）——非活动目录的
    // 定向装载（refreshWorkspace）也在这里获得归属，标签页灯才挂得上。
    (list) => {
      syncSessionWorkspaceIndex(list);
      // 标签页蓝 / 黄灯的重聚合（specs/defects/restart-tab-lights-incomplete）：
      // 重启认领场景里运行时快照早于列表到达（daemon 在 openWorkspace 应答里就
      // 重放），聚合时归属索引为空、非 idle 会话解析不出归属被丢弃——列表到达
      // 即索引补齐，这里重推一次聚合把窗口期的丢失填平（静默在跑的任务没有
      // 后继快照可依赖）
      syncTitlebarActivity();
      // 离场完成的补武装（specs/defects/orphan-completion-unread-light）：本次运行
      // 已阅读的会话不再补（清零落盘的在途窗口护栏）
      const armed = backfillCompletionAttention(
        [...unreadCompletionSessions],
        list,
        [...completionsReadInRun],
      );
      let changed = armed.length > 0;
      const freshlyArmed = new Set(armed);
      for (const sessionId of armed) {
        unreadCompletionSessions.add(sessionId);
        backfillArmedSessions.add(sessionId);
      }
      // 标签页灯的补挂：离场完成的**首次**武装不适用在线的「完成时未激活才武装」规则
      // （完成时刻用户完全缺席，激活中的标签页也算未读），归属可解析即武装；归属索引
      // 晚到的会话（非活动目录的列表后到）在索引补齐后的下一次列表到达补挂。
      //
      // 但**补挂重试**（本次列表没有新武装的、此前已在来源集合里的会话）与首次武装
      // 口径不同：用户已经激活过该标签页就不再补亮——激活是标签页级已读，重试不翻
      // 旧账。否则已读会话经在途旧计数重新武装后，绿灯会落到已激活标签页上而没有
      // 熄灯入口（specs/defects/completion-tab-light-relights-after-read）。判据与
      // 在线差分同一份（`facts.tabActive`），命中即把来源作废，后续列表到达不再重试。
      for (const sessionId of [...backfillArmedSessions]) {
        if (!unreadCompletionSessions.has(sessionId)) continue;
        const facts = completionFactsOf(sessionId);
        fileLogger.info('completion-backfill', `[probe] sid=${sessionId} wsKey=${facts.workspaceKey} tabActive=${facts.tabActive} fresh=${freshlyArmed.has(sessionId)} tabs=[${[...unreadCompletionTabs].join(',')}]`);
        if (facts.tabActive && !freshlyArmed.has(sessionId)) {
          backfillArmedSessions.delete(sessionId);
          continue;
        }
        if (facts.workspaceKey && !unreadCompletionTabs.has(facts.workspaceKey)) {
          unreadCompletionTabs.add(facts.workspaceKey);
          changed = true;
        }
      }
      if (changed) syncCompletionAttention();
    },
  );
  conversations = conversationsMgr;
  // 托盘只吃状态流（阶段 3.6）：running / waiting 来自 core 的 sessionRuntimeChanged
  conversationsMgr.setStatusListener((states) => {
    updateTrayStatusFromStates(states);
    // 「任务完成」绿色呼吸：同一份状态流里差分出「用户没看到的完成」（见 completionAttention.ts）
    updateCompletionAttentionFromStates(states);
    // 标题栏标签页流水灯（蓝=运行 / 黄=等待）也吃这条状态流，就地刷新不重建标签页
    syncTitlebarActivity();
    // 非 idle 会话存在时阻断系统睡眠 / 休眠（与托盘同一份状态流）
    sleepBlocker.update(states);
  });

  // 订阅 Connection 生命周期：启动恢复 / 手动重连的建连失败（从未就绪）在此落成
  // 「不可用」——endpoint 探测只覆盖「连不上 daemon」，daemon 存活但工作区 channel
  // 建失败（远端 core 起不来）等失败形态只能从这里得知。远程的运行期 lost（daemon /
  // 链路死亡、Core 重启超限）同样在这里落成不可用：重启策略在 daemon 手里，Host 侧
  // 无法自动恢复，曾就绪过也必须标红（沉默判定最迟 10s 内把 fatal 送到这里）。本地项
  // 保持豁免：Core 由 Host 侧重启策略恢复，恢复后 coreReady 会重新 markReady。
  // 注册必须在 bootstrapCore（Client 在其中建立 Connection）之前：监听不缓存事件，
  // 本地工作区建链快，注册晚了会错过 ready（非活动目录的列表装载就挂在 ready 上）。
  onWorkspaceConnectionState((ref, state, reason) => {
    const key = refKey(ref);
    // 空引用占位 Connection 不属于任何标签页
    if (!openWorkspaces.some((candidate) => refKey(candidate) === key)) return;
    fileLogger.info('workspace-tab', `connection ${state}: ${refDisplay(ref)} (${reason || 'ready'})`);
    if (state === 'ready') {
      // Connection 就绪才收掉建链中：绿点与聊天区此刻恢复。opened 时刻不恢复——
      // daemon 通道异步建立，Connection 注册滞后于 opened，窗口期内恢复可输入
      // 会让输入在 Client 路由层被静默丢弃（No Connection owns session）。
      // 恢复只属于「建链中」的路径（重连 / 启动恢复）：普通 ready（如本地 Core
      // 重启）不带 connecting，不做聊天区切换——否则会把用户拽到最近使用的对话
      const wasConnecting = workspaceAvailabilityState.hasConnecting(key);
      workspaceAvailabilityState.markReady(key);
      if (wasConnecting) {
        workspaceAvailabilityState.clearConnecting(key);
        syncTitlebarWorkspaces();
        if (sameRef(workspacePath, ref)) syncChatAreaForActiveWorkspace();
      }
      // Core 重启 / Connection 重建后重新注册查看器文件监听（specs/018 FR-003）。
      uiHost?.onWorkspaceConnectionReady(ref);
      // 非活动目录的列表定向装载（specs/defects/inactive-tab-completion-light-missing）：
      // 离场完成的补武装唯一挂在列表到达出口，而列表此前只装载活动目录——重启恢复后
      // 非当前标签页的列表无人装载，标签页绿灯永不亮。建链就绪即装载该目录的列表
      // （启动恢复 / 重开 / 重连同一出口）；活动目录的装载仍由侧栏拉取驱动，
      // 不在这里重复读盘。
      if (!sameRef(workspacePath, ref)) void conversationsMgr.refreshWorkspace(ref.path);
    } else if (ref.endpoint) {
      // 运行期致命走 runtime 落定（撤销就绪豁免）；从未就绪的建链失败走默认守卫。
      // 落定时顺带清掉建链中：否则这次标红推送的仍是黄态，黄点要等下一次全量刷新才消失
      markWorkspaceUnavailable(ref, { kind: 'generic', detail: reason }, 'runtime');
    }
  });

  // 共享启动接线：locale / 日志 / 总线 / core 侧订阅 / WebViewUI / 历史 / 会话队列 /
  // 等待用户读取器 / 配置目录 / 环境预热 / MCP 残留清理（docs/architecture/events.md 第 5 节；宿主专属接线见 `docs/hosts/host-bootstrap.md` 第 1 节）
  const { ui, client } = bootstrapCore(host, spinDesign, conversationsMgr, {
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
    // Electron 多工作区宿主：支持跨工作区代理（specs/023 FR-009）
    // 与跨工作区文件传输（specs/028 FR-005）
    crossWorkspaceAgent: true,
    crossWorkspaceTransfer: true,
  });

  host.setMainWindow(mainWindow!);
  host.setSidebarView(sidebarView!);
  host.setChatViewManager(chatViews!);
  host.setWorkspacePath(workspacePath);
  webviewUi = ui;
  uiHost = host;
  coreClient = client;
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
