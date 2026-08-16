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

export interface UIHost {
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

  /** 当前是否为深色主题 */
  isDarkTheme(): boolean;

  /** UI 语言（如 'zh' / 'en'） */
  getLocale(): string;

  /** 日志输出 */
  log(...args: unknown[]): void;

  /** 密码输入回退（无 webview 时使用宿主原生输入） */
  showPasswordInput?(prompt: string, plainText?: boolean): Promise<string | null>;
}
