/**
 * Electron preload - 「打开远程 Workspace」对话框专用。
 *
 * 暴露 remoteWorkspaceAPI：连接远端 Core、列远端目录、打开选中的远端目录。
 * 页面（`remoteWorkspaceDialogHtml.ts`）只负责显示与收集输入。
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('remoteWorkspaceAPI', {
  /** 连接远端 daemon 并返回根目录列表（连接后立刻进入目录选择） */
  connect: (endpoint: { host: string; port: number; token: string }): Promise<unknown> =>
    ipcRenderer.invoke('remote-workspace:connect', endpoint),
  /** 列某个远端目录的子目录 */
  list: (path: string): Promise<unknown> => ipcRenderer.invoke('remote-workspace:list', path),
  /** 选定远端目录：主进程把它加为工作区并关闭对话框 */
  open: (path: string): Promise<unknown> => ipcRenderer.invoke('remote-workspace:open', path),
  cancel: (): void => {
    ipcRenderer.send('remote-workspace:cancel');
  },
});
