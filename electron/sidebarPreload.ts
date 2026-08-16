/**
 * Electron preload - 侧栏专用
 * 暴露 sidebarAPI：对话列表读写 + 打开对话 + 列表变化推送
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sidebarAPI', {
  getConversations: (): Promise<unknown> => ipcRenderer.invoke('sidebar:get-conversations'),
  getActiveSession: (): Promise<string | null> => ipcRenderer.invoke('sidebar:get-active-session'),
  getWorkspace: (): Promise<string | null> => ipcRenderer.invoke('sidebar:get-workspace'),
  openWorkspace: (): void => {
    ipcRenderer.send('sidebar:open-workspace');
  },
  openConversation: (sessionId: string): void => {
    ipcRenderer.send('sidebar:open-conversation', sessionId);
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
  onConversationsUpdated: (callback: (list: unknown) => void): void => {
    ipcRenderer.on('sidebar:conversations-updated', (_event, list) => callback(list));
  },
  onActiveSessionChanged: (callback: (sessionId: string | null) => void): void => {
    ipcRenderer.on('sidebar:active-session-changed', (_event, sessionId) => callback(sessionId));
  },
  onWorkspaceChanged: (callback: (workspace: string | null) => void): void => {
    ipcRenderer.on('sidebar:workspace-changed', (_event, workspace) => callback(workspace));
  },
});
