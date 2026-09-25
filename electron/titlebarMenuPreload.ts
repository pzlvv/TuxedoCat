/**
 * Electron preload - 自绘标题栏下拉菜单窗口专用
 * 暴露 titlebarMenuAPI：选择菜单项 / 关闭菜单 / 上报菜单尺寸（供主进程定位窗口）
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('titlebarMenuAPI', {
  /** 选中某个菜单项（主进程据此执行动作并关闭菜单） */
  select: (id: string): void => {
    ipcRenderer.send('titlebar-menu:select', id);
  },
  /** 关闭菜单（Esc / 失焦前的主动关闭） */
  close: (): void => {
    ipcRenderer.send('titlebar-menu:close');
  },
  /** 上报渲染后的实际尺寸与左偏移（二级面板向左展开时为负），主进程据此设置视图大小与位置 */
  resize: (size: { width: number; height: number; offsetX?: number }): void => {
    ipcRenderer.send('titlebar-menu:resize', size);
  },
  /** 宿主关闭/重开菜单时通知页面收起二级面板（页面会被复用，不重新加载） */
  onReset: (callback: () => void): void => {
    ipcRenderer.on('titlebar-menu:reset', () => callback());
  },
});
