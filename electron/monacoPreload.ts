/**
 * Electron preload - Monaco 编辑器窗口专用
 * 将 main 进程的 monaco-init 消息桥接为页面可监听的 window message 事件
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('monacoBridge', {
  onInit: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('monaco-init', (_event, data) => callback(data));
  },
});

// 直接桥接为 window message（与 main.ts 的 addEventListener('message') 兼容）
ipcRenderer.on('monaco-init', (_event, data) => {
  window.postMessage(data, '*');
});
