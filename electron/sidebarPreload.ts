/**
 * Electron preload - 侧栏专用
 * 暴露 sidebarAPI：对话列表读写 + 工作目录（打开集合 / 添加 / 切换 / 关闭）+ 变化推送
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sidebarAPI', {
  getConversations: (): Promise<unknown> => ipcRenderer.invoke('sidebar:get-conversations'),
  getActiveSession: (): Promise<string | null> => ipcRenderer.invoke('sidebar:get-active-session'),
  /** 打开集合 + 活动项 + 最近工作目录 */
  getWorkspaces: (): Promise<unknown> => ipcRenderer.invoke('sidebar:get-workspaces'),
  /** 添加工作目录；不传 paths 时弹出系统目录选择框 */
  addWorkspaces: (paths?: string[]): void => {
    ipcRenderer.send('sidebar:add-workspaces', paths);
  },
  /** 打开（或激活）一个工作区；`id` 来自 getWorkspaces / onWorkspacesChanged 下发的项 */
  openWorkspace: (id: string): void => {
    ipcRenderer.send('sidebar:open-workspace', id);
  },
  activateWorkspace: (path: string): void => {
    ipcRenderer.send('sidebar:activate-workspace', path);
  },
  closeWorkspace: (path: string): void => {
    ipcRenderer.send('sidebar:close-workspace', path);
  },
  openConversation: (sessionId: string, project?: string): void => {
    ipcRenderer.send('sidebar:open-conversation', sessionId, project);
  },
  newConversation: (): void => {
    ipcRenderer.send('sidebar:new-conversation');
  },
  deleteConversation: (sessionId: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:delete-conversation', sessionId);
  },
  closeConversation: (sessionId: string): void => {
    ipcRenderer.send('sidebar:close-conversation', sessionId);
  },
  renameConversation: (sessionId: string, title: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:rename-conversation', sessionId, title);
  },
  smartNameConversation: (sessionId: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:smart-name-conversation', sessionId);
  },
  getLoadedSessions: (): Promise<unknown> => ipcRenderer.invoke('sidebar:get-loaded-sessions'),
  /** 会话运行时状态（idle / waiting）的当前全量快照（初始化 / 重载时播种用） */
  getSessionStates: (): Promise<unknown> => ipcRenderer.invoke('sidebar:get-session-states'),
  onConversationsUpdated: (callback: (list: unknown) => void): void => {
    ipcRenderer.on('sidebar:conversations-updated', (_event, list) => callback(list));
  },
  onSessionStatesUpdated: (callback: (states: unknown) => void): void => {
    ipcRenderer.on('sidebar:session-states-updated', (_event, states) => callback(states));
  },
  onSessionLoadedChanged: (callback: (sessionIds: unknown) => void): void => {
    ipcRenderer.on('sidebar:session-loaded-changed', (_event, sessionIds) => callback(sessionIds));
  },
  onActiveSessionChanged: (callback: (sessionId: string | null) => void): void => {
    ipcRenderer.on('sidebar:active-session-changed', (_event, sessionId) => callback(sessionId));
  },
  onWorkspacesChanged: (callback: (state: unknown) => void): void => {
    ipcRenderer.on('sidebar:workspaces-changed', (_event, state) => callback(state));
  },
});
