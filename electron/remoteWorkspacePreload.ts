/**
 * Electron preload - 「打开远程工作区」窗口专用（`docs/core-daemon.md` 第 12 节）。
 *
 * 暴露 remoteWorkspaceAPI：连远端 Core、列 / 新建 / 删除远端目录、打开选中的远端目录。
 * 页面（`electron/remoteWorkspace/`）只负责显示与收集输入，格式校验与文件系统操作都在主进程。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { RemoteWorkspaceAPI } from './remoteWorkspace/types.js';

const api: RemoteWorkspaceAPI = {
  connect: (request) => ipcRenderer.invoke('remote-workspace:connect', request),
  list: (path) => ipcRenderer.invoke('remote-workspace:list', path),
  create: (path) => ipcRenderer.invoke('remote-workspace:create', path),
  rename: (path, name) => ipcRenderer.invoke('remote-workspace:rename', path, name),
  remove: (path, recursive) => ipcRenderer.invoke('remote-workspace:delete', path, recursive),
  // 必须用 invoke：主进程这个频道注册的是 `ipcMain.handle`（`send` 只会走 `ipcMain.on`，
  // 用错就永远没人接，页面还会停在「忙」状态、按钮全灰）
  open: (path) => ipcRenderer.invoke('remote-workspace:open', path),
  cancel: () => {
    ipcRenderer.send('remote-workspace:cancel');
  },
};

contextBridge.exposeInMainWorld('remoteWorkspaceAPI', api);
