/**
 * 远程终端窗口与主进程之间的数据类型（docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * preload（`electron/terminalPreload.ts`）与页面（`electron/terminal/`）共用；
 * 标签 / 尺寸的形状沿用状态机（`electron/terminalShells.ts`）的定义，不另立一套。
 * 数据面独立于对话 webview 的消息协议、不进 `AssistantEventBus`（docs/hosts/electron-multi-workspace.md 第 14.8 节）。
 */

import type { TerminalSize, TerminalTab } from '../terminalShells.js';

export type { TerminalSize, TerminalTab };

/** `terminal:init` 的应答（页面加载完成后主动拉一次） */
export interface TerminalInitInfo {
  /** 当前是否深色主题（xterm 配色与页面 chrome 都用它） */
  isDark: boolean;
  /** 连接目标展示串（`ssh://user@host`，断开态文案用；不含凭证） */
  target: string;
  /** 主进程当前标签表（页面重载时恢复投影；首开为空表，随后由 `terminal:tabs` 驱动） */
  tabs: readonly TerminalTab[];
}

/** resize / reconnect 的载荷：{ tabId, cols, rows } */
export interface TerminalResizePayload {
  tabId: number;
  cols: number;
  rows: number;
}

/** `window.terminalAPI`（`electron/terminalPreload.ts` 暴露） */
export interface TerminalAPI {
  init(): Promise<TerminalInitInfo>;
  newTab(size: TerminalSize): Promise<void>;
  input(payload: { tabId: number; data: string }): Promise<void>;
  resize(payload: TerminalResizePayload): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  reconnect(payload: TerminalResizePayload): Promise<void>;
  closeWindow(): void;
  /** 剪贴板写（复制选区；走主进程 clipboard 模块，不依赖渲染端剪贴板权限） */
  copyText(text: string): void;
  /** 剪贴板读（粘贴；空串表示无可粘贴内容） */
  pasteText(): Promise<string>;
  onTabs(listener: (tabs: readonly TerminalTab[]) => void): void;
  onOutput(listener: (tabId: number, data: Uint8Array) => void): void;
  onTheme(listener: (isDark: boolean) => void): void;
}
