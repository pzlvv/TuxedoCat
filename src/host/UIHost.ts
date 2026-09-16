/**
 * UIHost - 宿主能力接口（VSCode 扩展 / Electron 主进程）
 *
 * 供共享的 WebviewMessageHandler / ToolHandler / UserChoiceManager 使用。
 * 设计约束（架构原则）：
 * - 契约完整：不提供可选成员，宿主必须显式实现全部能力，
 *   避免调用方用 `host.foo?.()` 静默降级、把宿主差异伪装成“没这功能”。
 * - 能力命名表达语义，而不是暴露宿主类型：共享代码不出现 `if (host.kind === ...)`。
 * - 入参显式：可选语义用 `null` 表达，而不是省略参数。
 */

import type { WebviewMessage } from '../core/webviewTypes.js';

/** 极简日志通道（兼容 vscode.OutputChannel 的形状） */
export interface LogChannel {
  appendLine(line: string): void;
}

/** 文件定位目标（选中行区间，1-based） */
export interface LineSelection {
  start: number;
  end: number;
}

/** diff 预览参数 */
export interface ShowDiffOptions {
  filePath: string;
  title: string;
  beforeContent: string;
  afterContent: string;
  /** 变更后的完整内容（afterContent 缺失时的兜底来源） */
  newContent: string;
}

/** 另存为对话框选项 */
export interface SaveFileOptions {
  /** 默认文件名（宿主会拼接到默认目录） */
  defaultFileName: string;
  /** 对话框标题 */
  title: string;
  /** 文件过滤器 */
  filters: Array<{ name: string; extensions: string[] }>;
}

/** 另存为结果（判别联合：成功/取消/失败三种情况互斥且字段完整） */
export type SaveFileResult =
  | { success: true; filePath: string }
  | { success: false; canceled: true }
  | { success: false; canceled: false; error: string };

export interface UIHost {
  /**
   * 推送消息到 webview。
   * 消息体由调用方组装（含 sessionId 等字段）；多视图宿主据此按 sessionId 路由。
   */
  sendToWebview(message: WebviewMessage): void;

  /**
   * 某个会话被「打开 / 进入」时由共享 handler 通知宿主。
   *
   * 用途：MCP 引用等「会话打开」副作用的归属方由宿主决定——
   * 单 webview 宿主在此建立引用；多视图宿主由视图管理器在打开/关闭视图时精确维护，
   * 这里保持空实现。共享 handler 不再感知宿主类型。
   */
  onSessionOpened(sessionId: string | undefined): void;

  /** 打开文件并定位到行；不需要定位时传 null */
  openFile(filePath: string, target: LineSelection | null): Promise<void>;

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
  saveTextFile(content: string, options: SaveFileOptions): Promise<SaveFileResult>;

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
  closeConversation(sessionId: string): void | Promise<void>;

  /** 刷新宿主侧 abort 按钮状态（后台任务/子代理被中止后调用） */
  refreshAbortState(): void;
}
