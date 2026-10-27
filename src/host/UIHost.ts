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
 * 契约按 UI surface 划分（``docs/architecture/layering.md 第 2 节规则 7）：
 * - UIHost 服务**对话 webview**
 * - SpinDesign 服务 Spin 设计器（独立面板/窗口，见 `docs/architecture/contracts.md` 第 2 节）
 * - ConversationManager 服务对话列表与会话状态（见 `docs/architecture/contracts.md` 第 4 节）
 *
 * `WorkspaceProvider` 是工作区（进程级环境事实）的独立契约，`UIHost` 继承它：
 * core 经订阅获得当前工作区与变化，启动期不主动读取。
 */

import type { CoreEvent } from '../shared/AssistantEventBus.js';
import type { HostToWebviewMessage } from './webviewMessages.js';
import type { WorkspaceRef } from './workspaceRef.js';

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

/**
 * 对话视图句柄：标识宿主里的一个具体对话视图。
 *
 * 宿主实现用它包裹自己的视图对象（Electron 包裹 `WebContents`），调用方只透传、不解读。
 * 句柄是名义类型——必须是本类的实例，任意对象无法冒充（编译期拦截）。
 * 产出方式见 `sendToWebviewView` 的说明。
 */
export class WebviewViewHandle {
  constructor(
    /** 宿主内部视图对象；仅宿主实现读取，契约与调用方不解读 */
    readonly view: unknown,
  ) {}
}

/** 工作区变化：打开 / 关闭 / 激活（`docs/core/client-connection.md` 第 5 节） */
export type WorkspaceChange =
  | { type: 'opened'; ref: WorkspaceRef }
  | { type: 'closed'; ref: WorkspaceRef }
  | { type: 'activated'; ref: WorkspaceRef };

/**
 * WorkspaceProvider - 工作区契约（宿主实现）。
 *
 * 工作区是**宿主侧的进程级环境事实**，不属于任何 UI surface：单独成契约，
 * 供只需要工作区的消费方（Spin 设计器、对话列表、Client 装配）依赖。
 *
 * 这是**宿主内部**的事实来源：core 不感知「当前工作目录是谁」——会话的工作目录
 * 是会话自己的属性，由宿主在会话首次被 core 解析目录之前登记（见
 * `setSessionWorkspace`）。本契约不产生任何总线事件；Client 订阅变化后按
 * 工作区打开 / 关闭 Connection（`docs/core/client-connection.md`）。
 */
export interface WorkspaceProvider {
  /** 当前工作区路径；未打开工作区返回 undefined（绝不退回 process.cwd()） */
  getWorkspacePath(): string | undefined;
  /** 当前工作区引用（本地 / 远程同构）；未打开工作区返回 undefined */
  getWorkspaceRef(): WorkspaceRef | undefined;
  /** 当前打开的工作区集合（按打开顺序）；未打开返回空数组 */
  getOpenWorkspaceRefs(): readonly WorkspaceRef[];
  /**
   * 视图所属工作区引用（多视图宿主按视图解析；单视图宿主返回当前工作区）。
   *
   * 用于按来源视图过滤 `@` 工作区候选（specs/023 FR-007）：补全列表要排除**该视图**
   * 所属的工作区，而不是活动标签页。`null` 表示没有来源视图（宿主主动推送）。
   */
  getWorkspaceRefForView(view: WebviewViewHandle | null): WorkspaceRef | undefined;
  /** 订阅工作区打开 / 关闭 / 激活；返回取消订阅 */
  onWorkspaceChanged(listener: (change: WorkspaceChange) => void): () => void;
}

export interface UIHost extends WorkspaceProvider {
  // ===================== 传输 =====================

  /**
   * 推送消息到 webview。
   * 消息体由调用方组装（含 sessionId 等字段）；多视图宿主据此按 sessionId 路由。
   */
  sendToWebview(message: HostToWebviewMessage): void;

  /**
   * 广播消息到所有对话视图。
   *
   * 多视图宿主（Electron）发给每个已打开的聊天视图；单视图宿主（VS Code）等价于
   * `sendToWebview`。用于与具体会话无关的全局变更（如系统主题）。
   */
  broadcastToWebviews(message: HostToWebviewMessage): void;

  /**
   * 直发某个对话视图（预热视图初始化、按来源回包）。
   *
   * `view` 由宿主实现产出：多视图宿主把来源视图对象包成句柄交给调用方透传
   * （Electron 为 `WebviewViewHandle` 包裹 `WebContents`，见 `docs/hosts/host-bootstrap.md` 第 1 节）；单视图宿主
   * （VS Code）等价于 `sendToWebview`，句柄不参与路由。
   */
  sendToWebviewView(view: WebviewViewHandle, message: HostToWebviewMessage): void;

  /**
   * 把当前主题下发给对话 webview。
   *
   * 值由宿主实现用 `isDarkTheme()` 计算——`isDarkTheme()` 是主题的唯一判定源
   * （Mermaid 预览与 Spin 设计器 HTML 也读它）。
   *
   * - `view` 为 `null`：广播到所有对话视图（单视图宿主即唯一 webview）
   * - `view` 指定句柄：只发该视图（视图加载初始化、`requestTheme` 回包）
   *
   * 调用点：视图加载完成、系统主题变化、webview 的 `requestTheme`。
   */
  onThemeChanged(view: WebviewViewHandle | null): void;

  // ===================== 环境 =====================

  /** 日志输出（VS Code: OutputChannel；Electron: console） */
  log(...args: unknown[]): void;

  // 当前工作区路径（getWorkspacePath）由 WorkspaceProvider 提供，UIHost 继承该契约。

  /** 当前是否为深色主题 */
  isDarkTheme(): boolean;

  /** UI 语言（如 'zh' / 'en'） */
  getLocale(): string;

  // ===================== 面板 / 窗口 =====================

  /**
   * 打开文件并定位到行；不需要定位时传 `null`。
   *
   * `view` 是链接的来源对话视图（`WebviewMessageHandler` 传 `ctx.sender`）：远程会话
   * 可能引用工作区外的文件，宿主按视图所属工作区把路径解析到那台机器
   * （specs/defects/remote-open-file-outside-workspace.md）；无来源视图（宿主主动调用 /
   * 单视图宿主）传 `null`，宿主只按打开集合解析、维持本地语义。
   */
  openFile(filePath: string, target: LineSelection | null, view: WebviewViewHandle | null): Promise<void>;

  /** 显示虚拟文档（内容预览） */
  showVirtualDocument(content: string, title: string): Promise<void>;

  /**
   * 在宿主里显示一次改动（before / after 两段内容）。
   *
   * 调用点：`ToolHandler.requestToolPermission`——Edit / Write 的权限请求带上 diff 内容时，
   * 在权限确认框弹出**之前**调用，让用户先看到改动（webview 侧同一份改动由工具卡片渲染）。
   *
   * - VS Code：`DocumentManager.showDiff` 打开 before/after 两个虚拟文档组成的 diff 标签
   * - Electron：空实现——diff 只在 webview 的工具卡片里渲染，桌面端不再开 Monaco 窗口
   *   （见 docs/hosts/host-matrix.md 第 6 节 UIHost 对照表）
   *
   * 同一个 diff 重复打开时由宿主自行去重；打开新的 diff 前由宿主自行关闭上一个预览。
   */
  showDiff(options: ShowDiffOptions): Promise<void>;

  /** 打开 Mermaid 预览 */
  openMermaidPreview(code: string): Promise<void>;

  /**
   * Core 上报远程工作区文件变化（specs/018 FR-002）。
   *
   * 事件由 `WebViewUI` 的 `workspaceFileChanged` handler 转交；宿主据此刷新对应
   * 查看器窗口。VS Code 的编辑器自身随文件更新，实现为 no-op；Electron 按
   * `watchId` 路由到当前查看器。
   */
  onWorkspaceFileChanged(event: Extract<CoreEvent, { type: 'workspaceFileChanged' }>): void;

  /**
   * Core 上报工具执行结果（specs/030 FR-001）。
   *
   * 事件由 `WebViewUI` 的 `toolResult` handler 在投递 webview 渲染之外旁路转交；
   * Electron 据此解析 Write 新建文件并刷新侧栏文件树，VS Code 无侧栏文件浏览器，
   * 实现为 no-op。渲染链路（ToolHandler / wire 消息）不受该成员影响。
   */
  onToolResult(event: Extract<CoreEvent, { type: 'toolResult' }>): void;

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
   * 销毁该会话的 UI 视图。只销毁视图——不删磁盘数据，也不释放运行时内存。
   *
   * - Electron（多视图）：销毁对应聊天视图（ChatViewManager.closeView）
   * - VS Code（单视图）：空实现。只有一个 webview，没有「关闭会话」这个 UI 动作
   *   （webview 侧由 canCloseConversation(hostInfo) 判定为 false，不渲染关闭按钮）
   *
   * 「关视图」与「卸内存」是两件事，归属也不同：
   * - 销毁视图：宿主（本方法）
   * - 释放运行时内存：core（UiEvent.conversationClosed → releaseSessionResources）
   */
  closeConversationView(sessionId: string): Promise<void>;

  // ===================== 配置文件 =====================

  /**
   * 串行化「读-改-写」settings.json（~/<CONFIG_DIR_NAME>/settings.json）。
   *
   * 配置文件是宿主资源：**写**由宿主承担，core 只读（``docs/architecture/layering.md 第 2 节规则 9）。
   * `mutator` 同步修改 cfg；返回非 undefined 时作为新的完整配置写回。
   * 两个宿主共用 `src/host/settingsFile.ts` 的实现（串行队列 + 写后清 core 读缓存）。
   */
  updateSettingsJson(mutator: (cfg: Record<string, any>) => void | Record<string, any>): Promise<void>;
}
