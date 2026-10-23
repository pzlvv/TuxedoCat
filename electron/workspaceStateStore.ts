/**
 * Electron 宿主本地状态文件（workspace-state.json）的唯一读写点。
 *
 * 位于 Electron userData 目录（Windows 下即 %APPDATA%/<产品名>/），记录打开集合、
 * 活动工作目录、最近列表、SSH 连接历史、窗口位置 / 模式 / 主题 / 快捷键——
 * 全部是只有 Electron 消费的宿主本地偏好，core 不读不写。
 *
 * 写安全：临时文件 + `rename` 原子换名（同目录 rename 是原子操作），写盘中途崩溃 /
 * 掉电不会留下半截 JSON——旧实现直接 `writeFileSync`，损坏后整个文件读不出、
 * 打开集合 / 最近列表 / 窗口状态一次性静默清零。内容与上次相同不落盘
 * （窗口拖动会高频触发写盘）。单实例写入（`--multi-instance` 各自独立 userData），
 * 不需要跨进程锁（与 `settings.json` 的共写纪律区分，见 `src/core/utils/fileLock.ts`）。
 *
 * 文件格式（本地项写字符串 = 旧版本格式，读取时按本地引用迁移；远程项写
 * `SerializedWorkspaceRef`）：
 * {
 *   "openWorkspaces": ["C:\\path\\to\\ws", { "scheme": "ssh", "path": "/home/pz", "endpoint": {...} }],
 *   "activeWorkspaceKey": "ssh//user@host/home/pz",
 *   "recentWorkspaces": ["C:\\path\\to\\ws2", { "scheme": "ssh", "path": "/srv", "endpoint": {...} }],
 *   "recentSshConnections": [{ "host": "192.168.1.5", "port": 22, "user": "root", "password": "…" }],
 *   "windowSize": { "x": 320, "y": 180, "width": 1280, "height": 860 },
 *   "floatingWindowSize": { "x": 1500, "y": 120, "width": 480, "height": 780 },
 *   "windowMode": "floating",
 *   "floatingPinned": true,
 *   "theme": "system",
 *   "shortcut": "Ctrl+Alt+X",
 *   "nextTabShortcut": "Ctrl+Tab",
 *   "prevTabShortcut": "Ctrl+Shift+Tab",
 *   "openTerminalShortcut": "Ctrl+Alt+T",
 *   "soundEnabled": true,
 *   "soundVolume": 0.8,
 *   "sidebarWidth": 340
 * }
 *
 * **远程凭证（SSH 口令）随 endpoint 一起明文落盘**：重启后要能直接恢复并打开
 * 已连接过的工作区（`docs/core/client-connection.md` 第 9 节）；落盘是唯一副本，
 * 不向渲染进程整表下发（候选列表只要 host / 端口 / 用户，口令按选定项单独取）。
 *
 * 读取口径：字段缺失或非法即按「没有」处理，不做任何跨字段回退
 * （例如 openWorkspaces 缺失就是没有打开任何工作目录）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { SshHistoryEntry } from '../src/host/sshHistory.js';
import type { SerializedWorkspaceRef } from '../src/host/workspaceState.js';

/** 窗口位置与大小（x/y 可缺失：历史版本只存过宽高） */
export interface WindowRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface WorkspaceState {
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
   * SSH 连接历史（`docs/core/client-connection.md` 第 9 节）：最近连接在前，最多 20 条。
   * **口令明文落盘**——历史的作用就是下次回填表单；只落盘、不整表下发渲染进程。
   */
  recentSshConnections?: SshHistoryEntry[];
  /** 完整模式窗口位置与大小（字段名沿用 windowSize，现在同时存位置） */
  windowSize?: WindowRect;
  /** 悬浮窗模式窗口位置与大小；与完整模式独立存储 */
  floatingWindowSize?: WindowRect;
  /** 查看器窗口名额（Monaco / 图片 / Markdown 共用）的上次位置与大小 */
  viewerWindowRect?: WindowRect;
  /** Spin 设计器窗口的上次位置与大小；与查看器名额独立存储 */
  spinDesignWindowRect?: WindowRect;
  /** 上次退出时的窗口模式：启动时优先按它恢复 */
  windowMode?: 'normal' | 'floating';
  /** 浮窗「总在最前」状态：启动时优先按它恢复（默认 true） */
  floatingPinned?: boolean;
  /** 主题模式：跟随系统 / 强制浅色 / 强制深色（宿主本地偏好，core 不读） */
  theme?: 'system' | 'light' | 'dark';
  /** 唤醒快捷键（Electron accelerator 形式；宿主本地偏好，core 不读） */
  shortcut?: string;
  /**
   * 「下一标签」快捷键（Electron accelerator 形式；宿主本地偏好，core 不读）。
   * 缺失 / 非法时按默认值处理（`DEFAULT_NEXT_TAB_SHORTCUT`），读取路径不写回（specs/021）。
   */
  nextTabShortcut?: string;
  /**
   * 「上一标签」快捷键（Electron accelerator 形式；宿主本地偏好，core 不读）。
   * 缺失 / 非法时按默认值处理（`DEFAULT_PREV_TAB_SHORTCUT`），读取路径不写回（specs/021）。
   */
  prevTabShortcut?: string;
  /**
   * 「打开终端」快捷键（Electron accelerator 形式；宿主本地偏好，core 不读）。
   * 缺失 / 非法时按默认值处理（`DEFAULT_OPEN_TERMINAL_SHORTCUT`），读取路径不写回；
   * 仅应用内生效（菜单动作表 + before-input-event 兜底），不做全局注册。
   */
  openTerminalShortcut?: string;
  /**
   * 任务结束提醒是否播放提示音（宿主本地偏好，core 不读）。
   * 缺失按关闭处理：提示音默认不播，用户显式开启才落 true（specs/016 FR-006）。
   */
  soundEnabled?: boolean;
  /**
   * 提示音音量（0–1 的线性增益；宿主本地偏好，core 不读）。
   * 缺失 / 非法时按默认音量（0.5）处理。
   */
  soundVolume?: number;
  /** 侧栏宽度（DIP，拖拽手柄调整）；缺失 / 非法时用默认宽度（`SIDEBAR_DEFAULT_WIDTH`） */
  sidebarWidth?: number;
}

export function getWorkspaceStateFile(): string {
  return path.join(app.getPath('userData'), 'workspace-state.json');
}

/** 读取工作区状态文件（损坏 / 不存在时返回空对象，不留半截内容） */
export function readWorkspaceState(): WorkspaceState {
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

/** 上次写入的序列化内容：内容未变不落盘（窗口拖动等高频调用不再打盘） */
let lastWritten: string | null = null;

/** 写回完整状态（调用方负责先 read 再合并，避免覆盖其它字段）；原子落盘、内容未变跳过 */
export function writeWorkspaceState(state: WorkspaceState): void {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(state, null, 2);
    if (serialized === lastWritten) return;
    const file = getWorkspaceStateFile();
    // 同目录 rename 原子换名：写盘中途崩溃不留半截 JSON（见模块头注）
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialized, 'utf-8');
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      // rename 失败时清掉临时文件，避免残留
      fs.unlinkSync(tmp);
      throw err;
    }
    lastWritten = serialized;
  } catch (err) {
    console.error('[main] Failed to write workspace state:', err);
  }
}

/** 测试用：清掉「内容未变不落盘」的记忆（改写落盘文件后需要强制重写时） */
export function resetWorkspaceStateWriteCacheForTest(): void {
  lastWritten = null;
}
