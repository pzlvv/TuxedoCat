/**
 * Electron preload - 远程终端窗口专用（docs/hosts/electron-multi-workspace.md 第 14 节）。
 *
 * 暴露 terminalAPI：建 / 关标签、键入、resize、重连与三条下行事件（tabs / output /
 * theme）。页面（`electron/terminal/`）只负责渲染（xterm）与收集输入，通道与标签
 * 状态都在主进程；数据面独立于对话 webview 的消息协议（docs/hosts/electron-multi-workspace.md 第 14.8 节）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { TerminalAPI, TerminalResizePayload } from './terminal/types.js';
import type { TerminalSize, TerminalTab } from './terminalShells.js';

const api: TerminalAPI = {
  init: () => ipcRenderer.invoke('terminal:init'),
  newTab: (size: TerminalSize) => ipcRenderer.invoke('terminal:new-tab', size),
  input: (payload: { tabId: number; data: string }) => ipcRenderer.invoke('terminal:input', payload),
  resize: (payload: TerminalResizePayload) => ipcRenderer.invoke('terminal:resize', payload),
  closeTab: (tabId: number) => ipcRenderer.invoke('terminal:close-tab', tabId),
  reconnect: (payload: TerminalResizePayload) => ipcRenderer.invoke('terminal:reconnect', payload),
  // 必须用 send：关窗口是单向动作，主进程注册的是 `ipcMain.on`
  closeWindow: () => {
    ipcRenderer.send('terminal:close-window');
  },
  copyText: (text: string) => {
    ipcRenderer.send('terminal:copy', text);
  },
  pasteText: () => ipcRenderer.invoke('terminal:paste'),
  onTabs: (listener: (tabs: readonly TerminalTab[]) => void) => {
    ipcRenderer.on('terminal:tabs', (_event, tabs: readonly TerminalTab[]) => listener(tabs));
  },
  onOutput: (listener: (tabId: number, data: Uint8Array) => void) => {
    ipcRenderer.on('terminal:output', (_event, payload: { tabId: number; data: Uint8Array }) => {
      listener(payload.tabId, payload.data);
    });
  },
  onTheme: (listener: (isDark: boolean) => void) => {
    ipcRenderer.on('terminal:theme', (_event, payload: { isDark: boolean }) => listener(payload.isDark));
  },
};

contextBridge.exposeInMainWorld('terminalAPI', api);
