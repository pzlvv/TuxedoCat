/**
 * Electron preload - 图片查看器窗口专用
 * 将 main 进程的 imageviewer-init 消息桥接为页面可监听的 window message 事件
 * （与 monacoPreload 同一桥接模式）
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('imageViewerBridge', {
  onInit: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('imageviewer-init', (_event, data) => callback(data));
  },
});

// 直接桥接为 window message（与 main.ts 的 addEventListener('message') 兼容）
ipcRenderer.on('imageviewer-init', (_event, data) => {
  window.postMessage(data, '*');
});
