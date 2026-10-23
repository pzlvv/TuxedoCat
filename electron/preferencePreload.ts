/**
 * Electron preload - 偏好设置窗口专用（菜单「偏好设置...」）。
 *
 * 暴露 preferenceAPI：读取当前状态 + 订阅主进程推来的状态 + 三块偏好的写入动作。
 * 快捷键解析与主题 / 音量的落盘都在主进程做，页面只发意图、只渲染状态。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('preferenceAPI', {
  getState: (): Promise<unknown> => ipcRenderer.invoke('preference-dialog:get-state'),
  setTheme: (mode: string): void => {
    ipcRenderer.send('preference-dialog:set-theme', mode);
  },
  setSoundEnabled: (enabled: boolean): void => {
    ipcRenderer.send('preference-dialog:set-sound-enabled', enabled);
  },
  setSoundVolume: (volume: number): void => {
    ipcRenderer.send('preference-dialog:set-sound-volume', volume);
  },
  captureShortcut: (row: string): void => {
    ipcRenderer.send('preference-dialog:capture-shortcut', row);
  },
  close: (): void => {
    ipcRenderer.send('preference-dialog:close');
  },
  onState: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('preference-dialog:state', (_event, state) => callback(state));
  },
});
