/**
 * Electron preload - 图片查看器窗口专用
 * 将 main 进程的 imageviewer-init / imageviewer-refresh / viewer-title 消息桥接为
 * 页面可监听的 window message 事件（与 monacoPreload 同一桥接模式）。
 *
 * specs/018：刷新消息只替换 `img.src`，页面自行保留缩放 / 平移；标题消息用于
 * 「文件已删除 / 读取失败 / 自动刷新不可用」标记。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('imageViewerBridge', {
  onInit: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('imageviewer-init', (_event, data) => callback(data));
  },
  onRefresh: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('imageviewer-refresh', (_event, data) => callback(data));
  },
  onTitle: (callback: (data: unknown) => void): void => {
    ipcRenderer.on('viewer-title', (_event, data) => callback(data));
  },
});

// 直接桥接为 window message（与 main.ts 的 addEventListener('message') 兼容）
ipcRenderer.on('imageviewer-init', (_event, data) => {
  window.postMessage({ type: 'init', ...(data as object) }, '*');
});
ipcRenderer.on('imageviewer-refresh', (_event, data) => {
  window.postMessage({ type: 'refresh', ...(data as object) }, '*');
});
ipcRenderer.on('viewer-title', (_event, data) => {
  window.postMessage({ type: 'title', ...(data as object) }, '*');
});
