/**
 * 远程终端窗口（docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * 每个工作区一个独立 `BrowserWindow`（FR-002：按 `refKey` 单例，重复触发聚焦既有
 * 窗口）；窗口内多标签的标签 / 通道状态机在 `electron/terminalShells.ts`（本模块只做
 * electron 胶水：窗口生命周期、IPC 注册、SSH 通道适配与租约）。终端数据走独立的
 * `terminal:*` IPC 面，不进对话消息协议、不进总线（FR-009）。
 *
 * 连接复用（FR-006）：shell 通道开在与侧栏文件浏览同一 endpoint 连接池上
 * （`sharedClientFor`），窗口打开期间 `retainRemoteFilesClient` 登记租约、关闭时释放
 * ——工作区与终端窗口的租约全部归零才真正断开 SSH 连接。主机密钥变更沿用主进程
 * 注入的确认流程（`confirmHostKeyChange`），确认后重建信任并重试一次。
 *
 * 生命周期绑定（FR-008）：`closeTerminalWorkspace` 随工作区关闭窗口、
 * `closeAllTerminalWindows` 在应用退出时关全部（先于 SSH 连接池的统一释放）。
 */

import { BrowserWindow, clipboard, ipcMain, nativeTheme } from 'electron';
import * as path from 'path';
import type { ClientChannel } from 'ssh2';
import { recordKnownHostFingerprint, SshHostKeyError } from '../src/host/standalone/sshClient.js';
import { workspaceRefKey, type WorkspaceEndpoint, type WorkspaceRef } from '../src/host/workspaceRef.js';
import { guardViewNavigation } from './viewNavigation.js';
import {
  TerminalSessionGroup,
  parseTabId,
  parseTerminalInput,
  parseTerminalResize,
  parseTerminalSize,
  type TerminalChannel,
  type TerminalSize,
} from './terminalShells.js';
import type { TerminalInitInfo } from './terminal/types.js';
import { releaseRemoteFilesClient, retainRemoteFilesClient, sharedClientFor } from './sidebarFilesRemote.js';

/** 打开终端窗口所需的宿主注入（全部必选；凭证从 ref.endpoint 取） */
export interface TerminalWindowOptions {
  ref: WorkspaceRef;
  /** 应用根目录：`dist/terminal/` 的定位基准 */
  appRoot: string;
  /** 界面语言（`zh` / `en`），经 loadFile query 注入页面 */
  locale: string;
  /** 终端字号 px（`terminalFontSizePx` 的结果，开窗时取值、运行期不热切） */
  fontSizePx: number;
  log: (...args: unknown[]) => void;
  /** 主机密钥变更确认（沿用远程接入的告警流程）；返回 false 视为拒绝 */
  confirmHostKeyChange(err: SshHostKeyError): Promise<boolean>;
}

interface TerminalWindowState {
  win: BrowserWindow;
  group: TerminalSessionGroup;
  endpoint: WorkspaceEndpoint;
}

/** refKey → 窗口状态（每工作区一个窗口，docs/hosts/electron-multi-workspace.md 第 14.2 节） */
const windows = new Map<string, TerminalWindowState>();

/** 终端窗口是常驻 surface：IPC 处理器随首个窗口注册一次，按 sender 路由 */
let ipcRegistered = false;

/**
 * 打开（或聚焦）该工作区的终端窗口。
 *
 * 入口已按 `canOpenRemoteTerminal` 把关；endpoint / 凭证缺失在这里直接抛错
 * （不过度 fallback，架构铁律 4.1）。
 */
export function openTerminalWindow(options: TerminalWindowOptions): void {
  const { ref } = options;
  const endpoint = ref.endpoint;
  if (!endpoint || endpoint.auth === null || endpoint.auth.kind !== 'sshPassword') {
    throw new Error(`terminal requires a remote workspace with sshPassword auth: ${refDisplayForLog(ref)}`);
  }
  const key = workspaceRefKey(ref);
  const existing = windows.get(key);
  if (existing) {
    if (!existing.win.isDestroyed()) existing.win.focus();
    return;
  }

  const target = `ssh://${endpoint.user}@${endpoint.host}`;
  const win = new BrowserWindow({
    width: 980,
    height: 660,
    minWidth: 520,
    minHeight: 320,
    useContentSize: true,
    show: false,
    title: `${target}${ref.path}`,
    icon: path.join(options.appRoot, 'assets', 'logo.png'),
    // 终端窗口的键盘中心是 xterm：不建菜单栏（Windows / Linux），Alt 不呼出菜单
    autoHideMenuBar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161b' : '#fafafa',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'terminalPreload.cjs'),
    },
  });
  if (process.platform !== 'darwin') win.setMenu(null);
  // 终端页面不开放导航（对齐其它应用自有页面的守卫口径；外部链接交系统浏览器）
  guardViewNavigation(win.webContents, 'terminal');
  win.once('ready-to-show', () => win.show());

  const group = new TerminalSessionGroup({
    openChannel: (size) => openShellWithHostKeyRetry(endpoint, ref.path, size, options),
    onTabsChanged: (tabs) => send(win, 'terminal:tabs', tabs),
    onOutput: (tabId, data) => send(win, 'terminal:output', { tabId, data }),
    log: options.log,
  });

  const state: TerminalWindowState = { win, group, endpoint };
  windows.set(key, state);
  // 终端窗口本身占用一条连接租约：窗口在，连接就在（与工作区租约独立计数）
  retainRemoteFilesClient(endpoint);
  options.log(`[terminal] window opened for ${target}${ref.path}`);

  win.on('closed', () => {
    // closeAllTerminalWindows 已清理过（dispose + 释放租约）就不再重复
    if (windows.get(key) !== state) return;
    windows.delete(key);
    group.dispose();
    releaseRemoteFilesClient(endpoint);
    options.log(`[terminal] window closed for ${target}${ref.path}`);
  });

  registerIpcOnce(options);
  void win
    .loadFile(path.join(options.appRoot, 'dist', 'terminal', 'index.html'), {
      query: { locale: options.locale, fontSize: String(options.fontSizePx) },
    })
    .catch((err: Error) => {
      // 页面没构建时给出可操作的错误（对齐 titlebar / remoteWorkspace 的口径）
      options.log(`[terminal] loadFile failed: ${err.message} (run \`npm run build:terminal\`)`);
      win.setTitle(`${target}${ref.path}（页面未构建：npm run build:terminal）`);
      win.show();
    });
}

/** 关闭该工作区的终端窗口（工作区关闭时调用；窗口不在时 no-op） */
export function closeTerminalWorkspace(key: string): void {
  const state = windows.get(key);
  if (!state) return;
  if (!state.win.isDestroyed()) state.win.close();
}

/** 关闭全部终端窗口并同步销毁通道（应用退出时；先于 SSH 连接池统一释放） */
export function closeAllTerminalWindows(): void {
  for (const state of windows.values()) {
    // will-quit 不能等窗口事件：通道在这里同步销毁，窗口直接 destroy
    state.group.dispose();
    releaseRemoteFilesClient(state.endpoint);
    if (!state.win.isDestroyed()) state.win.destroy();
  }
  windows.clear();
}

// ---------- 内部 ----------

/**
 * 建 shell 通道：复用 endpoint 连接池 + 主机密钥变更重试一次（docs/hosts/electron-multi-workspace.md 第 14.5 节）。
 * 重试仅在用户确认后发生（确认流程由宿主注入）；拒绝则失败原样上报。
 */
async function openShellWithHostKeyRetry(
  endpoint: WorkspaceEndpoint,
  cwd: string,
  size: TerminalSize,
  options: TerminalWindowOptions,
): Promise<TerminalChannel> {
  const open = async (): Promise<ClientChannel> => {
    const client = await sharedClientFor(endpoint, options.log);
    // 起始工作目录 = 工作区路径（specs/022 FR-003；cd 在远端外层 sh 执行，不进历史）
    return client.openShell({ ...size, cwd });
  };
  try {
    return adaptChannel(await open());
  } catch (err) {
    if (!(err instanceof SshHostKeyError)) throw err;
    if (!(await options.confirmHostKeyChange(err))) throw err;
    recordKnownHostFingerprint(err.host, err.port, err.observedFingerprint);
    options.log(`[terminal] host key for ${err.host}:${err.port} re-trusted after confirmation; retrying shell`);
    return adaptChannel(await open());
  }
}

/** ssh2 `ClientChannel` → 状态机的 `TerminalChannel` 窄接口 */
function adaptChannel(channel: ClientChannel): TerminalChannel {
  return {
    write: (data) => channel.write(data),
    onceDrain: (listener) => channel.once('drain', listener),
    onData: (listener) => {
      channel.on('data', (chunk: Buffer | string) => {
        listener(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      });
    },
    onError: (listener) => {
      channel.on('error', (err: Error) => listener(err.message));
    },
    onRemoteExit: (listener) => {
      channel.on('exit', () => listener());
    },
    onClose: (listener) => {
      channel.on('close', () => listener());
    },
    resize: (rows, cols) => channel.setWindow(rows, cols, 0, 0),
    destroy: () => {
      // 先尽力发 SIGHUP（远端 Windows sshd 不支持信号则失败被忽略），再发 EOF；
      // shell 进程由 sshd 随通道 / 连接回收（docs/hosts/electron-multi-workspace.md 第 14.7 节）
      try {
        channel.signal('SIGHUP');
      } catch {
        // 信号不支持是预期内的收尾路径：EOF 已足够让交互 shell 退出
      }
      channel.end();
    },
  };
}

/** 终端窗口的 IPC 面：随首个窗口注册一次，按 sender 路由到所属窗口的状态 */
function registerIpcOnce(options: TerminalWindowOptions): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  /** 首个窗口负责注册；后面只增窗口。卸载点只有进程退出（终端是常驻 surface） */
  nativeTheme.on('updated', () => {
    for (const state of windows.values()) {
      send(state.win, 'terminal:theme', { isDark: nativeTheme.shouldUseDarkColors });
    }
  });

  const requireState = (sender: Electron.WebContents): TerminalWindowState => {
    for (const state of windows.values()) {
      if (!state.win.isDestroyed() && state.win.webContents === sender) return state;
    }
    throw new Error('unauthorized: terminal sender');
  };

  ipcMain.handle('terminal:init', (event): TerminalInitInfo => {
    const state = requireState(event.sender);
    const endpoint = state.endpoint;
    return {
      isDark: nativeTheme.shouldUseDarkColors,
      target: `ssh://${endpoint.user}@${endpoint.host}`,
      tabs: state.group.listTabs(),
    };
  });
  ipcMain.handle('terminal:new-tab', (event, raw: unknown) => {
    void requireState(event.sender).group.newTab(parseTerminalSize(raw));
    return undefined;
  });
  ipcMain.handle('terminal:input', (event, raw: unknown) => {
    const payload = parseTerminalInput(raw);
    requireState(event.sender).group.input(payload.tabId, payload.data);
    return undefined;
  });
  ipcMain.handle('terminal:resize', (event, raw: unknown) => {
    const payload = parseTerminalResize(raw);
    requireState(event.sender).group.resize(payload.tabId, payload.size);
    return undefined;
  });
  ipcMain.handle('terminal:close-tab', (event, raw: unknown) => {
    requireState(event.sender).group.closeTab(parseTabId(raw));
    return undefined;
  });
  ipcMain.handle('terminal:reconnect', (event, raw: unknown) => {
    const payload = parseTerminalResize(raw);
    void requireState(event.sender).group.reconnect(payload.tabId, payload.size);
    return undefined;
  });
  ipcMain.on('terminal:close-window', (event) => {
    const state = requireState(event.sender);
    if (!state.win.isDestroyed()) state.win.close();
  });
  // 剪贴板走主进程 clipboard 模块（docs/hosts/electron-multi-workspace.md 第 14.4 节）：渲染端的
  // navigator.clipboard.readText 受权限策略约束，这里的路径是确定的
  ipcMain.on('terminal:copy', (event, text: unknown) => {
    requireState(event.sender);
    if (typeof text === 'string' && text.length > 0) clipboard.writeText(text);
  });
  ipcMain.handle('terminal:paste', (event) => {
    requireState(event.sender);
    return clipboard.readText();
  });
}

function send(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function refDisplayForLog(ref: WorkspaceRef): string {
  const endpoint = ref.endpoint;
  const authority = endpoint ? `${endpoint.user}@${endpoint.host}` : 'local';
  return `ssh://${authority}${ref.path}`;
}
