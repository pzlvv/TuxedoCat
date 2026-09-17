/**
 * Electron preload - 唤醒快捷键设置对话框专用
 *
 * 暴露 shortcutAPI：读取当前显示值 + 订阅主进程推来的按键状态 + 保存 / 取消。
 * 页面本身不解析按键（捕获在主进程的 before-input-event 里做）。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shortcutAPI', {
  getState: (): Promise<unknown> => ipcRenderer.invoke('shortcut-dialog:get-state'),
  save: (): void => {
    ipcRenderer.send('shortcut-dialog:save');
  },
  cancel: (): void => {
    ipcRenderer.send('shortcut-dialog:cancel');
  },
  onShortcut: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('shortcut-dialog:state', (_event, state) => callback(state));
  },
});
