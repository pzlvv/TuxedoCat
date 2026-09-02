/**
 * ElectronUI - Electron 版 UI 实现
 * 实现 AssistantUI 接口，负责 core 层与 webview（Electron renderer）之间的通信桥接。
 *
 * 与 VSCodeUI 共享宿主无关的模块：
 *   - WebviewMessageHandler：webview 消息处理（同一份分发表）
 *   - ToolHandler：工具调用 UI 生命周期
 *   - UserChoiceManager：用户选择/确认队列
 *
 * 宿主差异（webContents / nativeTheme / dialog）收敛在 buildHost() 中。
 */

import type { BrowserWindow, WebContentsView } from 'electron';
import { app, nativeTheme, dialog, BrowserWindow as BrowserWindowCtor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { ChatViewManager } from './ChatViewManager.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');
import type { AssistantUI, MessageData, StreamMessageData, StreamEndData, UIDynamicInfo } from '../src/core/AssistantUI.js';
import type { ToolProgressData } from '../src/core/tools/Tool.js';
import type { WebviewMessage, ValidationRule } from '../src/core/webviewTypes.js';
import type { UIHost } from '../src/host/UIHost.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from '../src/host/mermaidHtml.js';
import { tt, getSystemLocale } from '../src/core/i18n.js';
import { UserChoiceManager } from '../src/VSCodeUI/userChoice.js';
import { ToolHandler } from '../src/VSCodeUI/toolHandler.js';
import { buildEditDiffHunks } from '../src/core/utils/editDiff.js';
import { WebviewMessageHandler } from '../src/VSCodeUI/webviewMessageHandler.js';
import { PRODUCT_NAME } from '../src/config/project.js';

export class ElectronUI implements AssistantUI {
  private static instance: ElectronUI | undefined;
  private mainWindow: BrowserWindow | undefined;
  private sidebarView: WebContentsView | undefined;
  private chatViews: ChatViewManager | undefined;
  /** 当前工作区路径（由 main 进程设置，用户通过菜单选择） */
  private workspacePath: string | undefined;
  /** 按 session 保存的 agent mode */
  private sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'> = new Map();
  /** 侧栏刷新 debounce timer：消息落盘是异步的（appendMessage 在 onMessage 之后执行），
   *  延迟再拉取可保证拿到包含新对话的最新列表 */
  private sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  // 子模块
  private userChoiceManager: UserChoiceManager;
  private toolHandler: ToolHandler;
  private webviewMessageHandler: WebviewMessageHandler;
  /** 已打开的辅助预览窗口（用于 closePreview 统一关闭） */
  private previewWindows: BrowserWindowCtor[] = [];

  private constructor() {
    const outputChannel = {
      appendLine: (line: string) => this.log(line),
    };

    this.userChoiceManager = new UserChoiceManager({
      outputChannel,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      closePreview: () => this.closePreview(),
      getActiveSessionIdInternal: () => this.getActiveSessionIdInternal(),
      onShowDiffInVirtualDocumentCallback: undefined,
      showPasswordInput: async (_prompt, _plainText) => null,
      hasWebview: () => !!this.mainWindow && !this.mainWindow.isDestroyed(),
      // 用户选择框弹出（ask user / 权限确认）：刷新侧栏，流水灯显示黄色
      onChoiceShown: () => this.refreshSidebarThrottled(),
    });

    this.toolHandler = new ToolHandler({
      outputChannel,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      sessionAgentModes: this.sessionAgentModes,
      userChoiceManager: this.userChoiceManager,
    });

    this.webviewMessageHandler = new WebviewMessageHandler({
      host: this.buildHost(),
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      postConversationLoaded: (sessionId, conversation, extra) =>
        this.postConversationLoaded(sessionId, conversation, extra),
      setTitle: (sessionID, title) => this.setTitle(sessionID, title),
      sessionAgentModes: this.sessionAgentModes,
      userChoiceManager: this.userChoiceManager,
      // 用户响应选择后刷新侧栏：黄色流水灯恢复为紫色/消失
      onUserChoiceResponded: () => this.refreshSidebarThrottled(),
    });

    this.userChoiceManager.initUserChoiceQueue();
  }

  static getInstance(): ElectronUI {
    if (!ElectronUI.instance) {
      ElectronUI.instance = new ElectronUI();
    }
    return ElectronUI.instance;
  }

  // ===================== 宿主接线 =====================

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setSidebarView(view: WebContentsView): void {
    this.sidebarView = view;
  }

  setChatViewManager(m: ChatViewManager): void {
    this.chatViews = m;
    // 注入"会话是否正在等待用户输入"判定（ask user / 权限确认）→ 侧栏黄色流水灯
    m.setWaitingForUserProvider((sessionId) => this.userChoiceManager.hasPendingChoice(sessionId));
  }

  setWorkspacePath(p: string | undefined): void {
    this.workspacePath = p;
    // 工作区变化后通知当前 webview 刷新当前文件上下文
    if (p) {
      this.chatViews?.sendToActive({
        type: 'workspaceChanged',
        workspacePath: p,
      });
    }
  }

  getWorkspacePath(): string | undefined {
    return this.workspacePath;
  }

  /** 推送消息到渲染进程：优先按 sessionId 路由到对应聊天视图，否则发给当前活动视图 */
  private sendToRenderer(message: Record<string, unknown>): void {
    const sessionId = message.sessionId as string | undefined;
    if (sessionId && this.chatViews?.sendTo(sessionId, message)) {
      return;
    }
    this.chatViews?.sendToActive(message);
  }

  /** 推送消息到侧栏（原生对话列表） */
  private sendToSidebar(channel: string, payload: unknown): void {
    if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      this.sidebarView.webContents.send(channel, payload);
    }
  }

  /** 节流刷新侧栏列表（trailing debounce 500ms）：消息落盘完成后能拉到最新列表 */
  private refreshSidebarThrottled(): void {
    if (this.sidebarRefreshTimer) clearTimeout(this.sidebarRefreshTimer);
    this.sidebarRefreshTimer = setTimeout(() => {
      this.sidebarRefreshTimer = null;
      (async () => {
        try {
          const list = (await this.chatViews?.getSidebarConversations()) ?? [];
          this.sendToSidebar('sidebar:conversations-updated', list);
        } catch (err) {
          this.log(`Failed to refresh sidebar: ${err}`);
        }
      })();
    }, 500);
  }

  /** 获取当前活跃 session ID（从内存缓存读取） */
  private getActiveSessionIdInternal(): string | undefined {
    try {
      const configModule = require('../src/core/history/Config.js') as typeof import('../src/core/history/Config.js');
      return configModule.getActiveSessionId();
    } catch {
      return undefined;
    }
  }

  private log(...args: unknown[]): void {
    const line = args.map(a => String(a)).join(' ');
    console.log(`[ElectronUI] ${line}`);
  }

  /** 关闭所有辅助预览窗口（替代 VS Code 的 closePreview） */
  private closePreview(): void {
    for (const win of this.previewWindows) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.previewWindows = [];
  }

  /** 注册辅助窗口并跟踪，便于统一关闭 */
  private trackPreviewWindow(win: BrowserWindowCtor): void {
    this.previewWindows.push(win);
    win.on('closed', () => {
      this.previewWindows = this.previewWindows.filter((w) => w !== win);
    });
  }

  // ===================== 宿主能力（UIHost） =====================

  private buildHost(): UIHost {
    return {
      sendToWebview: (message) => this.sendToRenderer(message),

      openFile: async (filePath, selectedLines) => {
        // Monaco 编辑器窗口打开文件并定位到行
        await this.openMonacoWindow({
          mode: 'view',
          filePath,
          selectedLines,
          title: path.basename(filePath),
        });
      },

      showVirtualDocument: async (content, title) => {
        await this.openMonacoWindow({
          mode: 'content',
          content,
          title,
        });
      },

      showDiff: async (options) => {
        await this.openMonacoWindow({
          mode: 'diff',
          filePath: options.filePath,
          beforeContent: options.beforeContent || '',
          afterContent: options.afterContent || '',
          title: options.title || 'Diff',
        });
      },

      openMermaidPreview: async (code) => {
        this.openMermaidWindow(code);
      },

      openSpinDesign: async () => {
        await this.openSpinDesignWindow();
      },

      openExternalUrl: async (url) => {
        try {
          const { shell } = await import('electron');
          await shell.openExternal(url);
        } catch (err) {
          this.log(`[ElectronUI] Failed to open external URL: ${err}`);
        }
      },

      saveTextFile: async (content, options) => {
        const baseDir = this.getWorkspacePath() ?? app.getPath('home');
        const dialogOptions = {
          title: options?.title,
          defaultPath: path.join(baseDir, options?.defaultFileName ?? 'untitled.txt'),
          filters: options?.filters,
        };
        const win = BrowserWindowCtor.getFocusedWindow();
        const result = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);
        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true };
        }
        try {
          await fs.promises.writeFile(result.filePath, content, 'utf-8');
          return { success: true, filePath: result.filePath };
        } catch (err) {
          this.log(`[ElectronUI] saveTextFile failed: ${err}`);
          return { success: false, error: String(err) };
        }
      },

      isDarkTheme: () => nativeTheme.shouldUseDarkColors,
      getLocale: () => app.getLocale().startsWith('zh') ? 'zh' : 'en',
      log: (...args) => this.log(...args),
    };
  }

  /**
   * 打开 Monaco 编辑器窗口并发送初始化数据
   * view 模式由主进程读取文件内容；diff/content 模式直接传入内容
   */
  private async openMonacoWindow(init: {
    mode: 'view' | 'diff' | 'content';
    filePath?: string;
    selectedLines?: { start: number; end: number };
    content?: string;
    title?: string;
    beforeContent?: string;
    afterContent?: string;
  }): Promise<void> {
    const win = new BrowserWindowCtor({
      width: 1080,
      height: 720,
      title: init.title || PRODUCT_NAME,
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'monacoPreload.cjs'),
      },
    });
    this.trackPreviewWindow(win);

    const indexPath = path.join(APP_ROOT, 'dist', 'monaco', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`[ElectronUI] Monaco page not found: ${indexPath}. Run npm run build:monaco`);
      return;
    }
    await win.loadFile(indexPath);

    // 读取文件内容（view 模式）
    const data: Record<string, unknown> = { ...init };
    if (init.mode === 'view' && init.filePath) {
      try {
        data.content = await fs.promises.readFile(init.filePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          data.content = '';
        } else {
          data.content = `// 无法读取文件: ${err.message}`;
        }
      }
    }

    // 桌面版没有 VS Code 的 activeTextEditor 概念，"当前选中的文件"即最近在
    // Monaco 视图中打开的真实文件（view 模式）。通知聊天 webview，
    // 使发送消息时能带上当前文件信息（与 VS Code 的 sendCurrentFileInfo 对应）。
    if (init.mode === 'view' && init.filePath) {
      this.sendToRenderer({
        type: 'setCurrentFile',
        filePath: init.filePath,
        selectedLines: init.selectedLines,
      });
      this.log(`[ElectronUI] Current file set: ${init.filePath}`);
    }

    win.webContents.send('monaco-init', data);
  }

  /** Mermaid 预览窗口 */
  private openMermaidWindow(code: string): void {
    const win = new BrowserWindowCtor({
      width: 1000,
      height: 700,
      title: 'Mermaid Preview',
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: '#1a1a1f',
      webPreferences: { sandbox: true },
    });
    this.trackPreviewWindow(win);
    const isDark = nativeTheme.shouldUseDarkColors;
    // 优先使用 dist/webview/assets/mermaid.min.js（与 VS Code 版本一致）
    const appPath = APP_ROOT;
    const mermaidCandidates = [
      path.join(appPath, 'dist', 'webview', 'assets', 'mermaid.min.js'),
      path.join(appPath, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    ];
    const mermaidSrc = mermaidCandidates.find((p) => fs.existsSync(p));
    try {
      if (mermaidSrc) {
        win.loadFile(mermaidSrc).catch(() => undefined);
        win.webContents.once('did-finish-load', () => {
          win.webContents.executeJavaScript(`window.__mermaidLoaded = true;`).catch(() => undefined);
        });
        // 先加载本地 mermaid.min.js 再注入预览页会导致时序复杂，直接加载预览页并从 file:// 引用
        win.loadURL(
          'data:text/html;charset=utf-8,' +
          encodeURIComponent(getMermaidPreviewHtml(code, `file:///${mermaidSrc.replace(/\\/g, '/')}`, isDark))
        );
      } else {
        win.loadURL(
          'data:text/html;charset=utf-8,' +
          encodeURIComponent(getMermaidPreviewHtml(code, '', isDark))
        );
      }
    } catch (err) {
      win.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(getMermaidErrorHtml(code, String(err)))
      );
    }
  }

  /** Spin 设计窗口（注入 acquireVsCodeApi shim 使 spinDesignHtml 可复用） */
  private async openSpinDesignWindow(): Promise<void> {
    // 读取已存在的 spin.json
    let existingData: any = null;
    const projectDir = this.getProjectConversationDir(this.getWorkspacePath());
    if (projectDir) {
      const spinJsonPath = path.join(projectDir, 'spin.json');
      try {
        if (fs.existsSync(spinJsonPath)) {
          existingData = JSON.parse(fs.readFileSync(spinJsonPath, 'utf-8'));
        }
      } catch {
        // 忽略
      }
    }

    const { getSpinDesignHtml } = await import('../src/VSCodeUI/spinDesignHtml.js');
    const isDark = nativeTheme.shouldUseDarkColors;
    const html = getSpinDesignHtml(existingData, isDark, app.getLocale().startsWith('zh') ? 'zh' : 'en', getSystemLocale());

    const win = new BrowserWindowCtor({
      width: 1100,
      height: 720,
      title: tt('Spin 设计', 'Spin Design'),
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: '#1a1a1f',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'spinPreload.cjs'),
      },
    });
    this.trackPreviewWindow(win);

    // 保存 spin.json
    const saveSpin = (data: any): void => {
      if (!projectDir) {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
        return;
      }
      const workspacePath = this.getWorkspacePath();
      if (!workspacePath) {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
        return;
      }
      const fullData = { ...data, meta: data.meta || {} };
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }
      // 串行写入 spin.json，避免与 SpinLoop 的 updateNodeMeta 并发
      // "读-改-写"导致清除结果被回写（保存不生效）
      import('../src/core/spin/Engine.js').then(({ writeSpinJsonQueued }) =>
        writeSpinJsonQueued(workspacePath, fullData)
      ).then(() => {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: true });
      }).catch((err) => {
        win.webContents.send('spin-design-message', { type: 'spinSaveResult', success: false, error: String(err) });
      });
    };

    // 监听 spin 窗口发来的保存消息
    const { ipcMain } = await import('electron');
    const listener = (_e: any, msg: any) => {
      if (msg?.type === 'saveSpinDesign' && msg.data) {
        saveSpin(msg.data);
      } else if (msg?.type === 'exportSpinDesign' && msg.data) {
        import('../src/host/spinDesignExport.js').then(({ exportSpinDesignJson }) =>
          exportSpinDesignJson(this.buildHost(), msg.data, tt('导出 Spin 设计', 'Export Spin Design'))
        ).then((result) => {
          if (!win.isDestroyed()) {
            win.webContents.send('spin-design-message', { type: 'spinExportResult', ...result });
          }
        }).catch((err) => {
          this.log(`[ElectronUI] spin.json export failed: ${err}`);
          if (!win.isDestroyed()) {
            win.webContents.send('spin-design-message', { type: 'spinExportResult', success: false, error: String(err) });
          }
        });
      }
    };
    ipcMain.on('spin-design-message', listener);
    win.on('closed', () => {
      ipcMain.removeListener('spin-design-message', listener);
    });

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  private getProjectConversationDir(workspacePath?: string): string | undefined {
    if (!workspacePath) return undefined;
    try {
      const { getProjectConversationDir } = require('../src/core/history/Config.js');
      return getProjectConversationDir(workspacePath);
    } catch {
      return undefined;
    }
  }

  // ===================== AssistantUI 接口实现 =====================

  onSetAgentMode(parentSessionId: string, childSessionId: string): void {
    const parentMode = this.sessionAgentModes.get(parentSessionId);
    this.sessionAgentModes.set(childSessionId, parentMode === 'auto' ? 'auto' : 'risk');
  }

  async onPreToolCall(
    sessionID: string,
    toolUseId: string,
    toolName: string,
    args: Record<string, any>,
    tool: unknown,
  ): Promise<import('../src/core/tools/Tool.js').PermissionResult> {
    return this.toolHandler.onPreToolCall(sessionID, toolUseId, toolName, args, tool);
  }

  onToolCall(sessionID: string, toolUseId: string, toolName: string): void {
    this.toolHandler.onToolCall(sessionID, toolUseId, toolName);
  }

  onToolResult(sessionID: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void {
    this.toolHandler.onToolResult(sessionID, toolUseId, toolName, output, status);
  }

  updateToolArgs(sessionID: string, toolUseId: string, args: Record<string, unknown>): void {
    this.postToWebview(sessionID, {
      type: 'updateToolArgs',
      toolCallId: toolUseId,
      toolArgs: args,
    } as any);
  }

  onToolProgress(sessionID: string, toolUseId: string, progress: ToolProgressData): void {
    const p = progress as ToolProgressData & {
      output?: string;
      fullOutput?: string;
      elapsedTimeSeconds?: number;
      totalLines?: number;
      totalBytes?: number;
      taskId?: string;
    };
    const STREAM_CAP_CHARS = 100_000;
    let streamed = p.fullOutput || p.output || '';
    if (streamed.length > STREAM_CAP_CHARS) {
      streamed = streamed.slice(-STREAM_CAP_CHARS);
    }
    this.postToWebview(sessionID, {
      type: 'toolProgress',
      toolCallId: toolUseId,
      output: streamed,
      isStreaming: true,
      elapsedTimeSeconds: p.elapsedTimeSeconds,
      totalLines: p.totalLines,
      totalBytes: p.totalBytes,
      taskId: p.taskId,
    } as any);
  }

  onMessage(sessionID: string, data: MessageData): void {
    this.postToWebview(sessionID, { type: 'addMessage', ...data });
    // 用户消息已显示；持久化在 appendMessage 中异步完成，配合 onQueryEnd 的兜底
    // 通过 trailing debounce 延迟拉取，确保新对话能出现在侧栏列表
    if (data.role === 'user') {
      this.refreshSidebarThrottled();
    }
  }

  onStreamMessage(sessionID: string, data: StreamMessageData): void {
    if (data.role === 'assistant' && data.accumulated && !data.accumulated.trim()) {
      return;
    }
    this.postToWebview(sessionID, {
      type: 'streamMessage',
      role: data.role,
      delta: data.delta,
      accumulated: data.accumulated,
      streamId: data.streamId,
    });
  }

  onStreamEnd(sessionID: string, data: StreamEndData): void {
    this.postToWebview(sessionID, {
      type: 'streamEnd',
      role: data.role,
      accumulated: data.accumulated,
      usage: data.usage,
      streamId: data.streamId,
    });
  }

  setThinkingAnimation(sessionID: string, show: boolean): void {
    this.postToWebview(sessionID, { type: 'showThinkingAnimation', show });
  }

  /**
   * 为指定会话的聊天视图设置 abort 按钮状态（只发给该会话自己的视图，避免跨会话覆盖）
   */
  private setEnableAbortForSession(sessionId: string, enable: boolean): void {
    this.chatViews?.sendTo(sessionId, {
      type: 'setEnableAbort',
      sessionId,
      enable,
    } as WebviewMessage);
  }

  /**
   * 判断 abort scope 内是否有活跃查询。
   * abort scope = 会话自身 + 其递归子代理；父会话 abort 会连带中断子代理，
   * 因此子代理后台运行时父会话的 abort 按钮也应保持可用。
   */
  private hasActiveQueryInScope(sessionId: string): boolean {
    if ((this.queryActiveCounts.get(sessionId) ?? 0) > 0) {
      return true;
    }
    try {
      const { subAgentRegistry } = require('../src/core/tools/agent/SubAgentRegistry.js') as typeof import('../src/core/tools/agent/SubAgentRegistry.js');
      for (const childId of subAgentRegistry.listForCreator(sessionId)) {
        if (this.hasActiveQueryInScope(childId)) {
          return true;
        }
      }
    } catch {
      // 子代理注册表不可用时只按当前会话自身判断
    }
    return false;
  }

  /**
   * 同步所有已打开聊天视图的 abort 状态。
   * 多会话并发时，某个会话结束只应关闭它自己（及其子代理）的 abort，
   * 不能把其他仍在流式输出的会话 abort 置灰。
   */
  private syncAbortState(): void {
    if (!this.chatViews) return;
    for (const sessionId of this.chatViews.getLoadedSessionIds()) {
      this.setEnableAbortForSession(sessionId, this.hasActiveQueryInScope(sessionId));
    }
  }

  onAbort(_sessionID: string): void {
    this.sendToRenderer({ type: 'abort' });
  }

  setTitle(sessionID: string, title: string): void {
    this.postToWebview(sessionID, { type: 'setTitle', title });
  }

  onSessionCreated(sessionID: string): void {
    this.postToWebview(sessionID, { type: 'initSessionState' });
  }

  async refreshConversationList(): Promise<void> {
    try {
      // 原生侧栏列表：磁盘历史（仅已发送消息的对话）+ loaded 标记
      const sidebarList = (await this.chatViews?.getSidebarConversations()) ?? [];
      this.sendToSidebar('sidebar:conversations-updated', sidebarList);
      // webview 内部列表（子对话树等）
      const { loadConversationList } = await import('../src/core/history/index.js');
      const conversations = await loadConversationList();
      this.sendToRenderer({ type: 'conversationsData', conversations });
      this.log(`Conversation list refreshed (${conversations.length} conversations)`);
    } catch (err) {
      this.log(`Failed to refresh conversation list: ${err}`);
    }
  }

  onAIBegin(sessionID: string): void {
    this.setThinkingAnimation(sessionID, true);
    this.postToWebview(sessionID, { type: 'aiBegin' });
  }

  onAIEnd(sessionID: string): void {
    this.setThinkingAnimation(sessionID, false);
    this.postToWebview(sessionID, { type: 'aiEnd' });
    this.fetchAndSendBalance(sessionID);
  }

  /** 每个 session 当前处于"查询进行中"的计数（同一 session 可能被多个调用方同时标记 begin，用于去重，保证一次查询只发一次 queryEnd） */
  private queryActiveCounts: Map<string, number> = new Map();

  onQueryBegin(sessionID: string): void {
    const count = (this.queryActiveCounts.get(sessionID) ?? 0) + 1;
    this.queryActiveCounts.set(sessionID, count);
    if (count > 1) {
      // 同一 session 已处于查询中（嵌套 begin），忽略，避免 UI 状态抖动
      this.log(`Ignoring nested queryBegin for session: ${sessionID} (count=${count})`);
      return;
    }
    this.syncAbortState();
    this.setThinkingAnimation(sessionID, true);
    this.postToWebview(sessionID, { type: 'queryBegin' });
    // 会话进入运行状态：刷新侧栏（非 idle 对话显示流水灯）
    this.refreshSidebarThrottled();
  }

  onQueryEnd(sessionID: string): void {
    const count = this.queryActiveCounts.get(sessionID) ?? 0;
    if (count <= 0) {
      // 没有对应的 queryBegin（重复 onQueryEnd），忽略，保证一次查询只发一次 queryEnd
      this.log(`Ignoring redundant queryEnd for session: ${sessionID}`);
      return;
    }
    const next = count - 1;
    if (next > 0) {
      // 该 session 还有其他进行中的查询（嵌套 begin 未结束），暂不发送 queryEnd
      this.queryActiveCounts.set(sessionID, next);
      this.log(`Query still active for session: ${sessionID} (remaining=${next}), deferring queryEnd`);
      return;
    }
    this.queryActiveCounts.delete(sessionID);
    this.syncAbortState();
    this.postToWebview(sessionID, { type: 'queryEnd' });
    // 查询结束：用户消息已持久化（appendMessage 已完成），刷新侧栏使新对话出现在列表中
    this.refreshSidebarThrottled();
  }

  private fetchAndSendBalance(sessionID: string): void {
    import('../src/core/utils/balance.js').then(({ fetchBalance }) => {
      fetchBalance(sessionID).then(balanceInfo => {
        if (balanceInfo) {
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: balanceInfo.totalBalance,
            currency: balanceInfo.currency,
            isUnlimited: balanceInfo.isUnlimited,
            fetchedAt: balanceInfo.fetchedAt,
          } as any);
        }
      }).catch((err: unknown) => {
        this.log(`Failed to fetch balance: ${err}`);
      });
    }).catch((err: unknown) => {
      this.log(`Failed to import balance module: ${err}`);
    });
  }

  clearMessages(sessionID: string): void {
    this.postToWebview(sessionID, { type: 'clearMessages' });
  }

  onQueuedMessage(sessionID: string, content: string | null, images?: Array<{ dataUrl: string; mediaType?: string }>): void {
    if (content) {
      this.postToWebview(sessionID, { type: 'queuedMessage', sessionId: sessionID, content, images });
    } else {
      this.postToWebview(sessionID, { type: 'clearQueuedMessage', sessionId: sessionID });
    }
  }

  async onCommandSend(commandName: string, args: string, sessionId: string): Promise<boolean> {
    this.log(`onCommandSend: ${commandName} args=${args}`);

    if (commandName === 'clear') {
      this.postToWebview(sessionId, { type: 'clearMessages', sessionId });
      (async () => {
        try {
          const { replaceConversationMessages, updateConversationContext } = await import('../src/core/history/index.js');
          await replaceConversationMessages(sessionId, []);
          await updateConversationContext(sessionId, { totalContextTokens: 0 });
          const { getSessionEngine } = await import('../src/core/QueryEngine.js');
          const engine = getSessionEngine(sessionId);
          if (engine) {
            const msgs = engine.getMessages();
            msgs.length = 0;
            engine.lastPersistedMessageUuid = null;
          }
        } catch (err) {
          this.log(`Error clearing conversation: ${err}`);
        }
      })();
      return true;
    }

    if (commandName === 'spin') {
      const trimmed = args.trim();
      if (trimmed === 'design') {
        this.webviewMessageHandler.handleOpenSpinDesign().catch((err: any) => {
          this.log(`Error opening spin design: ${err}`);
        });
        return true;
      }
      const ws = this.getWorkspacePath();
      if (ws) {
        const projectDir = this.getProjectConversationDir(ws);
        if (projectDir) {
          const spinJsonPath = path.join(projectDir, 'spin.json');
          if (!fs.existsSync(spinJsonPath)) {
            this.webviewMessageHandler.handleOpenSpinDesign().catch((err: any) => {
              this.log(`Error opening spin design: ${err}`);
            });
            return true;
          }
        }
      }
    }

    return false;
  }

  onCompressProgress(sessionID: string, status: 'start' | 'complete' | 'error', postCompactTokenCount?: number): void {
    this.postToWebview(sessionID, { type: 'compressProgress', status, postCompactTokenCount });
  }

  async onExpandCompact(sessionID: string): Promise<void> {
    this.log(`Expanding compact for session: ${sessionID}`);
    try {
      const { loadCompactArchive } = await import('../src/core/history/Conversation.js');
      const originalMessages = await loadCompactArchive(sessionID);
      if (!originalMessages || originalMessages.length === 0) {
        return;
      }
      const { loadConversation } = await import('../src/core/history/index.js');
      const conversation = await loadConversation(sessionID);
      const compressedSummaries = conversation.messages.filter((m: any) =>
        m.type === 'user' && (m as any).isCompactSummary === true
      );
      const retainedMessages = conversation.messages.filter((m: any) =>
        (m.type === 'user' || m.type === 'assistant')
        && !(m as any).isCompactSummary
        && !((m as any).subtype === 'compact_boundary')
      );
      const summaryCount = originalMessages.filter((m: any) => (m as any).isCompactSummary === true).length;
      const messagesToDisplay = summaryCount === 0 && compressedSummaries.length > 0
        ? [...originalMessages, ...compressedSummaries, ...retainedMessages]
        : [...originalMessages, ...retainedMessages];

      this.postToWebview(sessionID, { type: 'clearMessages' });

      const toolResultMap = new Map<string, { content: string; exitCode: number }>();
      for (const msg of messagesToDisplay) {
        if (msg.type === 'user' && Array.isArray((msg as any).message?.content)) {
          const toolResults = ((msg as any).message.content as any[]).filter((block: any) => block.type === 'tool_result');
          for (const result of toolResults) {
            const r = result as { tool_use_id?: string; is_canceled?: boolean; content?: string; exit_code?: number };
            if (r.tool_use_id && r.is_canceled !== true) {
              toolResultMap.set(r.tool_use_id, { content: r.content || '', exitCode: r.exit_code ?? 0 });
            }
          }
        }
      }

      for (const msg of messagesToDisplay) {
        const m = msg as any;
        if (m.isMeta || m.silent) continue;
        if (m.type === 'system') {
          if (m.subtype === 'compact_boundary') continue;
          this.postToWebview(sessionID, { type: 'addMessage', role: 'system', content: m.content });
        } else if (m.type === 'user') {
          const content = typeof m.message?.content === 'string' ? m.message.content : undefined;
          if (content !== undefined) {
            this.postToWebview(sessionID, {
              type: 'addMessage',
              role: 'user',
              content,
              filePath: m.filePath,
              fileSelectedLines: m.fileSelectedLines,
              isCompactSummary: m.isCompactSummary === true,
              isFromAgent: m.fromSubAgent === true,
              meta: m._meta,
            });
          }
        } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            const b = block as any;
            if (b.type === 'thinking') {
              this.postToWebview(sessionID, { type: 'addMessage', role: 'thinking', content: b.thinking || '' });
            } else if (b.type === 'text') {
              this.postToWebview(sessionID, { type: 'addMessage', role: 'assistant', content: b.text || '' });
            } else if (b.type === 'tool_use') {
              const toolUseId = b.id || '';
              const result = toolResultMap.get(toolUseId);
              const toolArgs: Record<string, unknown> = b.input ? { ...b.input } : {};
              const blockMeta = b._meta as Record<string, unknown> | undefined;
              if (b.name === 'Edit' && typeof blockMeta?.beforeContent === 'string' && typeof blockMeta?.afterContent === 'string') {
                // Edit 只发送 diff 相关行
                toolArgs.diffHunks = buildEditDiffHunks({
                  beforeContent: blockMeta.beforeContent,
                  afterContent: blockMeta.afterContent,
                  startLine: blockMeta.startLine as number | undefined,
                  endLine: blockMeta.endLine as number | undefined,
                  replaceAll: Boolean(b.input?.replace_all),
                });
              } else if (blockMeta?.beforeContent !== undefined || blockMeta?.afterContent !== undefined) {
                // Write 等工具保留原有 before/after 字段
                toolArgs.beforeContent = blockMeta.beforeContent;
                toolArgs.afterContent = blockMeta.afterContent;
              }
              this.postToWebview(sessionID, {
                type: 'addMessage',
                role: 'toolcall',
                content: result?.content || '',
                param: `⚙️ ${b.name || 'tool'}`,
                toolName: b.name,
                toolArgs,
                toolCallId: toolUseId,
                status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
              });
            }
          }
        }
      }

      this.postToWebview(sessionID, { type: 'expandCompactDone' });
    } catch (err) {
      this.log(`Failed to expand compact for ${sessionID}: ${err}`);
    }
  }

  async getUIDynamicInfo(_sessionID: string): Promise<UIDynamicInfo> {
    // 不使用当前工作目录作为默认：未选择工作区时返回空字符串（引擎也无法在无工作区下运行）
    return { cwd: this.getWorkspacePath() || '' };
  }

  async requestPassword(sessionID: string, prompt: string, validationRule?: ValidationRule, plainText?: boolean): Promise<string | null> {
    return this.userChoiceManager.requestPassword(sessionID, prompt, validationRule, plainText);
  }

  async requestUserChoice(sessionID: string, options: {
    toolName: string;
    message: string;
    choices?: Array<{ label: string; description?: string }>;
    showPreview?: boolean;
    previewContent?: string;
    previewTitle?: string;
    showDiff?: boolean;
    beforeContent?: string;
    afterContent?: string;
    diffTitle?: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }): Promise<{ index: number; reply?: string }> {
    return this.userChoiceManager.requestUserChoice(sessionID, options);
  }

  /** 处理来自 webview 的消息 */
  async handleWebviewMessage(message: any): Promise<void> {
    await this.webviewMessageHandler.handleWebviewMessage(message);
  }

  /** 推送消息到 webview（统一添加 sessionId） */
  private postToWebview(sessionId: string, message: Record<string, unknown>): void {
    this.sendToRenderer({ ...message, sessionId });
  }

  /** 发送对话加载消息到 webview */
  private postConversationLoaded(
    sessionId: string,
    conversation: any,
    extra: {
      pendingToolUseIds: string[];
      savedContext?: any;
      parentSessionId?: string;
      agentMode: string;
      hasActiveQuery: boolean;
      hasCompactArchive?: boolean;
      model?: string;
    },
  ): void {
    const trimmed = JSON.parse(JSON.stringify(conversation));
    const toolMetaMap: Record<string, any> = {};

    if (trimmed.messages) {
      console.log(`[ElectronUI] postConversationLoaded: raw messages=${trimmed.messages.length}`);
      trimmed.messages = trimmed.messages.filter(
        (msg: any) => !msg.isMeta && !msg.silent
      );
      console.log(`[ElectronUI] postConversationLoaded: after filter=${trimmed.messages.length}`);
      for (const msg of trimmed.messages) {
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block._meta) {
              block._metaTrimmed = true;
              block._toolUseId = block.id;
              const rawMeta = block._meta as Record<string, unknown>;
              const { beforeContent, afterContent, ...smallFields } = rawMeta;
              block._meta = smallFields;

              if (block.name === 'Edit' && typeof beforeContent === 'string' && typeof afterContent === 'string') {
                // Edit 只发送 diff 相关行，避免把整个文件内容发给 webview
                toolMetaMap[block.id!] = {
                  diffHunks: buildEditDiffHunks({
                    beforeContent,
                    afterContent,
                    startLine: rawMeta.startLine as number | undefined,
                    endLine: rawMeta.endLine as number | undefined,
                    replaceAll: Boolean((block.input as any)?.replace_all),
                  }),
                };
              } else {
                // Write 等工具仍保留原有 beforeContent/afterContent 字段
                toolMetaMap[block.id!] = { beforeContent, afterContent };
              }
            }
          }
        }
      }
    }

    this.sendToRenderer({
      type: 'conversationLoaded',
      conversation: trimmed,
      pendingToolUseIds: extra.pendingToolUseIds,
      savedContext: extra.savedContext,
      parentSessionId: extra.parentSessionId,
      agentMode: extra.agentMode,
      hasActiveQuery: extra.hasActiveQuery,
      sessionId,
      hasCompactArchive: extra.hasCompactArchive === true,
      toolMetaMap: Object.keys(toolMetaMap).length > 0 ? toolMetaMap : undefined,
      model: extra.model || trimmed.metadata?.model ||
        (trimmed.metadata?.context?.model) ||
        undefined,
    } as WebviewMessage);

    // 同步 abort 状态：打开/切换到含活跃子代理的会话后，abort 按钮应立即可用
    this.syncAbortState();
  }
}
