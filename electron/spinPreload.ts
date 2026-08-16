/**
 * Electron preload - Spin 设计窗口专用
 *
 * spinDesignHtml.ts 是 VS Code webview 页面，内部调用 acquireVsCodeApi() 与宿主通信。
 * 此 preload 注入兼容 shim，使其在 Electron 辅助窗口中可直接复用：
 *   - window.acquireVsCodeApi() -> { postMessage, getState, setState }
 *   - main -> 页面消息：ipcRenderer.on('spin-design-message') 转发为 window message 事件
 */

import { contextBridge, ipcRenderer } from 'electron';

let savedState: unknown = null;

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (message: unknown): void => {
    ipcRenderer.send('spin-design-message', message);
  },
  getState: (): unknown => savedState,
  setState: (state: unknown): void => {
    savedState = state;
  },
}));

// main -> 页面消息桥接（spinSaveResult 等）
ipcRenderer.on('spin-design-message', (_event, message) => {
  window.postMessage(message, '*');
});
