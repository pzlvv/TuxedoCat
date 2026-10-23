/**
 * Electron preload - 聊天区占位页专用
 *
 * 活动工作区建链中 / 不可用时，聊天区不显示对话列表与 webview，改显占位页。
 * 「无法连接远程主机」的占位页提供「重新连接」按钮，经此通道通知主进程重试建链
 * （主进程按当前活动工作区定位目标，无需回传 id）。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chatPlaceholderAPI', {
  reconnectWorkspace: (): void => {
    ipcRenderer.send('chat:reconnect-workspace');
  },
  /** 跨工作区占位页：跳到发起方对话（specs/022 FR-005） */
  jumpToOrigin: (): void => {
    ipcRenderer.send('chat:jump-to-origin');
  },
});
