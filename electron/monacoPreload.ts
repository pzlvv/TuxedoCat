/**
 * Electron preload - dist/monaco 两个页面的共用桥（Monaco 查看窗口 + Markdown 预览
 * 窗口的 markdown.html，同一 vite 工程多入口）。
 *
 * 把 main 进程的 monaco-init / monaco-refresh / markdown-init / markdown-refresh /
 * viewer-title 桥接为页面可监听的 window message 事件（specs/018：刷新只替换内容，
 * 页面保留滚动 / 光标）；反向桥接 Markdown 预览页标题栏的窗口控制（经
 * `markdown-window-control` 回主进程，发送方校验在主进程）。
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

// 直接桥接为 window message（与两个页面的 addEventListener('message') 兼容）。
// monaco-* 与 markdown-* 走各自的 IPC 通道、载荷不同构，但窗口 message 都用 init /
// refresh 类型名——两个页面各监听自己的通道，互不串扰。
ipcRenderer.on('monaco-init', (_event, data) => {
  window.postMessage({ type: 'init', ...(data as object) }, '*');
});
ipcRenderer.on('monaco-refresh', (_event, data) => {
  window.postMessage({ type: 'refresh', ...(data as object) }, '*');
});
ipcRenderer.on('markdown-init', (_event, data) => {
  window.postMessage({ type: 'init', ...(data as object) }, '*');
});
ipcRenderer.on('markdown-refresh', (_event, data) => {
  window.postMessage({ type: 'refresh', ...(data as object) }, '*');
});
ipcRenderer.on('viewer-title', (_event, data) => {
  window.postMessage({ type: 'title', ...(data as object) }, '*');
});

// Markdown 预览页标题栏的窗口控制（minimize / toggle-maximize / close）→ 主进程；
// 主进程按 webContents 校验发送方（registerMarkdownWindowControls）
window.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown; action?: unknown } | null;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'window-control' || typeof data.action !== 'string') return;
  ipcRenderer.send('markdown-window-control', { action: data.action });
});
