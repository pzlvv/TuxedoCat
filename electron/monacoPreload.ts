/**
 * Electron preload - Monaco 编辑器窗口专用
 * 将 main 进程的 monaco-init / monaco-refresh / viewer-title 消息桥接为页面可监听的
 * window message 事件（specs/018：刷新只替换 model 内容，页面保留滚动 / 光标）。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('monacoBridge', {
  onInit: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('monaco-init', (_event, data) => callback(data));
  },
  onRefresh: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('monaco-refresh', (_event, data) => callback(data));
  },
  onTitle: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('viewer-title', (_event, data) => callback(data));
  },
});

// 直接桥接为 window message（与 main.ts 的 addEventListener('message') 兼容）
ipcRenderer.on('monaco-init', (_event, data) => {
  window.postMessage({ type: 'init', ...(data as object) }, '*');
});
ipcRenderer.on('monaco-refresh', (_event, data) => {
  window.postMessage({ type: 'refresh', ...(data as object) }, '*');
});
ipcRenderer.on('viewer-title', (_event, data) => {
  window.postMessage({ type: 'title', ...(data as object) }, '*');
});
