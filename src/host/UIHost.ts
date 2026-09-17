/**
 * UIHost - 宿主能力接口（对话 webview 的宿主）
 *
 * 供共享的 WebviewMessageHandler / ToolHandler / UserChoiceManager / WebViewUI 使用。
 * 设计约束（架构原则）：
 * - 契约完整：不提供可选成员，宿主必须显式实现全部能力，
 *   避免调用方用 `host.foo?.()` 静默降级、把宿主差异伪装成"没这功能"。
 * - 能力命名表达语义，而不是暴露宿主类型：共享代码不出现 `if (host.kind === ...)`。
 * - 入参显式：可选语义用 `null` 表达，而不是省略参数。
 * - 返回值统一 Promise<void>，不用 void | Promise<void> 联合。
 *
 * 契约按 UI surface 划分（第 2 节规则 7）：
 * - UIHost 服务**对话 webview**
 * - SpinDesign 服务 Spin 设计器（独立面板/窗口，见第 5.2 节）
 * - ConversationManager 服务对话列表与会话状态（见第 5.4 节）
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

/**
 * diff 预览参数。
 *
 * 两种调用来源：
 * - 工具 diff（webview 点文件链接）：filePath / newContent 有值
 * - 用户选择 diff（权限确认）：filePath / newContent 为 null，只有 before/after/title
 */
export interface ShowDiffOptions {
  /** 目标文件路径；无文件来源时传 null */
  filePath: string | null;
  /** 变更后的完整内容；无文件来源时传 null */
  newContent: string | null;
  title: string;
  beforeContent: string;
  afterContent: string;
}

/** 另存为对话框选项 */
export interface SaveFileOptions {
  /** 默认文件名（宿主拼接到默认目录） */
  defaultFileName: string;
  /** 对话框标题 */
  title: string;
  /** 文件过滤器 */
  filters: Array<{ name: string; extensions: string[] }>;
}

/** 另存为结果（判别联合：成功/取消/失败互斥且字段完整） */
export type SaveFileResult =
  | { success: true; filePath: string }
  | { success: false; canceled: true }
  | { success: false; canceled: false; error: string };

export interface UIHost {
  // ===================== 传输 =====================

  /**
   * 推送消息到 webview。
   * 消息体由调用方组装（含 sessionId 等字段）；多视图宿主据此按 sessionId 路由。
   */
  sendToWebview(message: WebviewMessage): void;

  // ===================== 环境 =====================

  /** 日志输出（VS Code: OutputChannel；Electron: console） */
  log(...args: unknown[]): void;

  /** 当前工作区路径；未打开工作区返回 undefined（绝不退回 process.cwd()） */
  getWorkspacePath(): string | undefined;

  /** 当前是否为深色主题 */
  isDarkTheme(): boolean;

  /** UI 语言（如 'zh' / 'en'） */
  getLocale(): string;

  // ===================== 面板 / 窗口 =====================

  /** 打开文件并定位到行；不需要定位时传 null */
  openFile(filePath: string, target: LineSelection | null): Promise<void>;

  /** 显示虚拟文档（内容预览） */
  showVirtualDocument(content: string, title: string): Promise<void>;

  /**
   * 显示 diff 预览。
   * 同一个 diff 重复打开时由宿主自行去重；打开新的 diff 前由宿主自行关闭上一个预览。
   * - VS Code：DocumentManager.showDiff 打开 diff 标签
   * - Electron：空实现（见第 11.1 节第 9 项）——预览能力已经在 webview 里
   *   （PreviewOverlay 支持 text / image / diff / mermaid），不再重复开 Monaco 窗口
   */
  showDiff(options: ShowDiffOptions): Promise<void>;

  /** 打开 Mermaid 预览 */
  openMermaidPreview(code: string): Promise<void>;

  /**
   * 关闭当前预览（diff / 虚拟文档 / 预览窗口）。
   * 预览句柄由宿主自己持有，共享模块不再保存任何宿主句柄。
   */
  closePreview(): void;

  /** 用系统默认浏览器打开外部链接 */
  openExternalUrl(url: string): Promise<void>;

  /**
   * 弹出「另存为」对话框并写入文本文件。
   * 当前唯一调用方是 Spin 设计器的导出（SpinDesign 通过注入的宿主调用），
   * 但它是通用文件能力，不属于 Spin 领域，因此留在 UIHost。
   */
  saveTextFile(content: string, options: SaveFileOptions): Promise<SaveFileResult>;

  // ===================== 会话 / 列表 / 状态 =====================

  /**
   * 同步 abort 按钮状态。
   *
   * `isActive` 由 WebViewUI 提供（判定「会话自身 + 后台任务 + 递归子代理」是否有活跃查询），
   * 宿主只负责决定「要对哪些会话下发」：
   * - VS Code：只处理当前活动会话；无活动会话时下发 disable
   * - Electron：遍历 ChatViewManager.getLoadedSessionIds() 逐会话下发
   */
  syncAbortState(isActive: (sessionId: string) => boolean): void;

  /**
   * 销毁该会话的 UI 视图。只销毁视图——不删磁盘数据，也不释放运行时内存。
   *
   * - Electron：销毁对应聊天视图（ChatViewManager.closeView）
   * - VS Code：空实现。只有一个 webview，没有「关闭会话」这个 UI 动作
   *   （HostInfo.closeConversation === false，webview 也不渲染关闭按钮）
   *
   * 「关视图」与「卸内存」是两件事，归属也不同：
   * - 销毁视图：宿主（本方法）
   * - 释放运行时内存：core（UiEvent.conversationClosed → releaseSessionResources）
   */
  closeConversationView(sessionId: string): Promise<void>;
}
