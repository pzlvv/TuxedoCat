/**
 * UIHost - 宿主能力接口
 *
 * 供共享的 WebviewMessageHandler / ToolHandler / UserChoiceManager 使用，
 * 由具体宿主（VSCodeUI / ElectronUI）实现。
 *
 * 设计目标：core 层不感知宿主，UI 消息处理层（src/VSCodeUI/*）也不直接
 * 依赖 vscode/electron API，宿主差异全部收敛到本接口的实现中。
 */

/** 极简日志通道（兼容 vscode.OutputChannel 的形状） */
export interface LogChannel {
  appendLine(line: string): void;
}

/** diff 预览参数 */
export interface ShowDiffOptions {
  filePath?: string;
  newContent?: string;
  title?: string;
  beforeContent?: string;
  afterContent?: string;
}

/** 另存为对话框选项 */
export interface SaveFileOptions {
  /** 默认文件名（宿主会拼接到默认目录） */
  defaultFileName?: string;
  /** 对话框标题 */
  title?: string;
  /** 文件过滤器 */
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** 另存为结果 */
export interface SaveFileResult {
  success: boolean;
  /** 用户取消时置为 true */
  canceled?: boolean;
  /** 保存成功的完整路径 */
  filePath?: string;
  /** 失败原因 */
  error?: string;
}

export interface UIHost {
  /** 宿主类型（用于区分单 webview / 多 webview 的会话生命周期语义） */
  readonly kind?: 'vscode' | 'electron';

  /** 推送消息到 webview（消息体由调用方组装，含 sessionId 等字段） */
  sendToWebview(message: Record<string, unknown>): void;

  /** 打开文件并定位到行（宿主编辑器能力） */
  openFile(filePath: string, selectedLines?: { start: number; end: number }): Promise<void>;

  /** 显示虚拟文档（内容预览） */
  showVirtualDocument(content: string, title: string): Promise<void>;

  /** 显示 diff 预览 */
  showDiff(options: ShowDiffOptions): Promise<void>;

  /** 打开 Mermaid 预览 */
  openMermaidPreview(code: string): Promise<void>;

  /** 打开 Spin 设计器 */
  openSpinDesign(): Promise<void>;

  /** 用系统默认浏览器打开外部链接（VS Code: vscode.env.openExternal；Electron: shell.openExternal） */
  openExternalUrl(url: string): Promise<void>;

  /**
   * 弹出“另存为”对话框并写入文本文件
   * 用于 Spin Design 导出 spin.json 等场景，宿主差异（VS Code showSaveDialog / Electron dialog）在此收敛
   */
  saveTextFile(content: string, options?: SaveFileOptions): Promise<SaveFileResult>;

  /** 当前是否为深色主题 */
  isDarkTheme(): boolean;

  /** UI 语言（如 'zh' / 'en'） */
  getLocale(): string;

  /** 日志输出 */
  log(...args: unknown[]): void;

  /**
   * 关闭会话（仅销毁视图/释放资源，不删除磁盘数据）：先中止正在运行的查询，再释放 MCP 引用。
   * - Electron：用户可点聊天视图的关闭按钮直接触发，且会销毁对应聊天视图。
   * - VS Code：用户无法直接触发，仅在删除对话时由删除流程调用。
   */
  closeConversation?(sessionId: string): void | Promise<void>;

  /** 刷新宿主侧 abort 按钮状态（后台任务/子代理被中止后调用） */
  refreshAbortState?(): void;
}
