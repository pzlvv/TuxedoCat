/**
 * Electron preload - 自绘标题栏专用
 * 暴露 titlebarAPI：窗口控制 + 菜单分区读取 + 下拉菜单开关
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('titlebarAPI', {
  /** 初始化状态：平台 / 产品名 / 菜单分区 / 是否最大化 */
  getState: (): Promise<unknown> => ipcRenderer.invoke('titlebar:get-state'),
  minimize: (): void => {
    ipcRenderer.send('titlebar:minimize');
  },
  toggleMaximize: (): void => {
    ipcRenderer.send('titlebar:toggle-maximize');
  },
  close: (): void => {
    ipcRenderer.send('titlebar:close');
  },
  openMenu: (anchor: { id: string; anchorX: number }): void => {
    ipcRenderer.send('titlebar:open-menu', anchor);
  },
  closeMenu: (): void => {
    ipcRenderer.send('titlebar:close-menu');
  },
  /** 完整模式 ↔ 悬浮窗模式 */
  toggleMode: (): void => {
    ipcRenderer.send('titlebar:toggle-mode');
  },
  /** 悬浮窗「总在最前」开关 */
  togglePin: (): void => {
    ipcRenderer.send('titlebar:toggle-pin');
  },
  /** 打开集合（标签页区）：切换活动项 / 关闭某项 / 打开添加菜单 / 拖拽排序 */
  activateWorkspace: (id: string): void => {
    ipcRenderer.send('titlebar:activate-workspace', id);
  },
  closeWorkspace: (id: string): void => {
    ipcRenderer.send('titlebar:close-workspace', id);
  },
  showWorkspaceMenu: (): void => {
    ipcRenderer.send('titlebar:workspace-menu');
  },
  /** 拖拽排序后提交新的打开集合顺序（完整排列，主进程按 id 校验） */
  reorderWorkspaces: (ids: string[]): void => {
    ipcRenderer.send('titlebar:reorder-workspaces', ids);
  },
  onWindowState: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('titlebar:window-state', (_event, state) => callback(state));
  },
  onMenuState: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('titlebar:menu-state', (_event, state) => callback(state));
  },
  onModelChanged: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('titlebar:model-changed', (_event, state) => callback(state));
  },
  onModeState: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('titlebar:mode-state', (_event, state) => callback(state));
  },
  onWorkspacesChanged: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('titlebar:workspaces', (_event, state) => callback(state));
  },
  /** 标签页流水灯：工作目录 -> 聚合运行时状态（waiting / running），状态流变化时推送 */
  onWorkspaceActivity: (callback: (activity: unknown) => void): void => {
    ipcRenderer.on('titlebar:workspace-activity', (_event, activity) => callback(activity));
  },
});
