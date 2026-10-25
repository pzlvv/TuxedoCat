/**
 * Electron preload - 侧栏专用
 * 暴露 sidebarAPI：对话列表读写 + 工作目录（打开集合 / 添加 / 切换 / 关闭）+ 变化推送
 * + 文件浏览器（US-42 / US-43：列表 / 复制路径 / 资源管理器定位 / 删除 / 双击打开）
 * + 侧栏宽度拖拽（US-44）
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
  /** 未读完成的会话集合（「任务完成」绿色呼吸；对话成为当前对话后由主进程清除） */
  onSessionCompletion: (callback: (sessionIds: string[]) => void): void => {
    ipcRenderer.on('sidebar:session-completion', (_event, sessionIds) => callback(sessionIds));
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
  // ── 文件浏览器（US-42 / US-43） ──
  // rel 一律是 '/' 分隔的相对路径（约定格式，见 electron/sidebarFiles.ts）；
  // workspaceId 是侧栏工作区项的稳定 id（refKey），主进程按 id 回查打开集合里的
  // 工作区引用（与「最近打开」点击同一约定，不按展示路径回查）
  filesList: (workspaceId: string, dir: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-list', { workspaceId, dir });
  },
  /** 在系统文件资源管理器中定位（只作用于单个条目） */
  filesReveal: (workspaceId: string, relPath: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-reveal', { workspaceId, path: relPath });
  },
  /** 在该目录打开系统命令行（只作用于单个目录；本地工作区专属） */
  filesOpenTerminal: (workspaceId: string, dirRel: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-open-terminal', { workspaceId, dir: dirRel });
  },
  /** 复制路径：relative 为 true 时复制相对路径；多项以换行拼接 */
  filesCopyPaths: (workspaceId: string, relPaths: string[], relative: boolean): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-copy-paths', { workspaceId, paths: relPaths, relative });
  },
  /** 删除（移入回收站）：主进程先弹原生确认框 */
  filesDelete: (workspaceId: string, relPaths: string[]): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-delete', { workspaceId, paths: relPaths });
  },
  /** 双击打开（US-42 验收 6）：主进程按类型分流（内置文本 / 图片窗口或系统应用） */
  filesOpen: (workspaceId: string, relPath: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-open', { workspaceId, path: relPath });
  },
  /** 文档视图取数（specs/030）：git 行数口径或非 git 记录口径，主进程分流 */
  filesDocList: (workspaceId: string): Promise<unknown> => {
    return ipcRenderer.invoke('sidebar:files-doc-list', { workspaceId });
  },
  /** 文档视图开关状态上报：主进程据此挂 / 摘 git 哨兵监听 */
  filesDocWatch: (workspaceId: string, enabled: boolean): void => {
    ipcRenderer.send('sidebar:files-doc-watch', { workspaceId, enabled });
  },
  /** 主进程推送的失效信号（Write 新建 → 树重读、git 哨兵 → 文档重取） */
  onFilesInvalidated: (callback: (payload: unknown) => void): void => {
    ipcRenderer.on('sidebar:files-invalidate', (_event, payload) => callback(payload));
  },
  // ── 侧栏宽度（US-44） ──
  // 拖拽过程高频 send（不落盘），final: true（松手 / 双击恢复）才落盘一次
  setSidebarWidth: (width: number | null, final: boolean): void => {
    ipcRenderer.send('sidebar:set-width', { width, final });
  },
});
