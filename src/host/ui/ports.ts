/**
 * WebViewUiPort - WebViewUI 暴露给共享子模块的端口
 *
 * 端口隔离：子模块（ToolHandler / UserChoiceManager / WebviewMessageHandler）
 * 拿不到 WebViewUI 的全量方法，只能通过这个窄接口回推 webview
 * （docs/architecture/contracts.md）。
 * 由 WebViewUI 实现；子模块只依赖这个窄接口。成员全部必选。
 */

import type { SessionRuntimeState } from '../../core/AssistantEventBus.js';

import type { HostToWebviewMessageWithoutSessionId } from '../webviewMessages.js';

/**
 * 投递器：把 (sessionId, 部分消息体) 补全后交给宿主。
 * 由 WebViewUI 内部统一使用，避免多处各写一份合并逻辑。
 * 消息形状是 wire 协议的宿主→webview 方向（sessionId 由投递点补全）。
 */
export type WebviewPoster = (sessionId: string, message: HostToWebviewMessageWithoutSessionId) => void;

/**
 * LLM 配置面板的触发场景。
 *
 * - `startup`：视图加载完成后的补弹——仅当「已配置 active provider 但 apiKey 为空」
 * - `new-conversation`：新建对话的引导——仅当「未配置 active provider 或 apiKey 为空」
 * - `request`：webview 主动请求（用户点设置按钮）——无条件弹
 */
export type LLMConfigPanelTrigger = 'startup' | 'new-conversation' | 'request';

/**
 * conversationLoaded 的附加信息（由 WebviewMessageHandler 提供）。
 *
 * 唯一定义在 `conversationPayload.ts`（wire 消息的组装点），这里只做转出，
 * 避免同一个载荷形状写两份、迟早对不上。
 */
import type { ConversationLoadedExtra } from '../conversationPayload.js';
export type { ConversationLoadedExtra };

/**
 * 排队项内容（`docs/features/user-message-pipeline.md` 第 5 节）。
 *
 * `uuid` 是宿主为该消息生成的 uuid，core 把消息并入 LLM 上下文时补发的
 * `addMessage.messageUuid` 与它配对，webview 据此清除排队项（不按文本匹配）。
 */
export interface QueuedMessageState {
  uuid: string;
  content: string;
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  filePath?: string;
  selectedLines?: { start: number; end: number };
  fileHidden?: boolean;
}

export interface WebViewUiPort {
  /** 补 sessionId 后投递到宿主 webview */
  postToWebview(sessionId: string, message: HostToWebviewMessageWithoutSessionId): void;

  /** 推送 conversationLoaded（含宿主注入的 activityPhase） */
  postConversationLoaded(
    sessionId: string,
    conversation: unknown,
    extra: ConversationLoadedExtra,
  ): void;

  /** 会话标题变化通知（转调 WebViewUI.onTitleChanged） */
  onTitleChanged(sessionId: string, title: string): void;

  /**
   * 该会话的 UI 侧状态已释放（视图关闭 / 会话删除）。
   * `WebViewUI.dropSession` 借此 fan-out 给持有 per-session 状态的子模块：
   * `SessionUiState` 清阶段 / 计数；`UserChoiceManager` 清挂起的选择回调
   * 与 diff 快照；`WebviewMessageHandler` 清 tracked active session。
   */
  dropSession(sessionId: string): void;

  /**
   * 通知 UI 登记 / 清除该会话的排队项（`null` = 清除）。
   *
   * 登记：引擎忙碌、消息尚未进入 LLM 上下文时（`docs/features/user-message-pipeline.md` FR-003）；
   * 清除：内置命令就地执行时由宿主显式清除（`onCommandSend`），
   * 进入上下文的用户消息由 core 补发的 `addMessage`（带 `messageUuid`）清除。
   * 唯一调用者是 WebviewMessageHandler，不是 core。
   */
  onQueuedMessage(sessionId: string, queued: QueuedMessageState | null): void;

  /** 当前活跃 session ID（UI 自己的状态，与宿主无关） */
  getActiveSessionId(): string | undefined;

  /**
   * 该会话是否处于 open 状态（UserChoiceQueue 的投递判定）。
   *
   * - 多视图宿主（Electron）：有聊天视图即为 open（可以多个，只有一个 active/selected）
   * - 单视图宿主（VS Code）：open == active == 当前 webview 里显示的会话
   */
  isSessionOpen(sessionId: string): boolean;

  /**
   * 打开 Spin 设计器（转调 SpinDesign.open）。
   * 子模块不直接持有 SpinDesign，保持「只认 UIHost + WebViewUiPort」的约定。
   */
  openSpinDesign(): Promise<void>;

  /** 重新读取并分发对话列表（转调 ConversationManager.refresh） */
  refreshConversations(): Promise<void>;

  /**
   * 最近一次会话运行时状态快照（转调 ConversationManager.getSessionStatesSnapshot）。
   * Standalone 下进程内 `sessionRuntime` 不被写入，拉取必须走这份缓存。
   */
  getSessionRuntimeStatesSnapshot(): readonly SessionRuntimeState[];

  /**
   * 该会话**自己的**查询是否在跑（转调 SessionUiState.isQueryActive）。
   *
   * `conversationLoaded.hasActiveQuery` 的来源：只认本会话自己的消费循环，不认
   * `sessionRuntime.idle`（后者含后台子代理 / 后台 Bash / 压缩，会把「父会话空闲、
   * 后台子代理在等用户」误判成父会话有活跃查询）。
   */
  isQueryActive(sessionId: string): boolean;

  /**
   * 记录会话活动（打开 / 新建 / 用户发消息时调用），重置空闲关闭计时。
   * 空闲计时的 owner 是 VS Code 的 SingleWebViewConversationManager
   * （core 不参与计时；Electron 不做空闲回收，收到后无操作）。
   */
  noteSessionActivity(sessionId: string): void;

  /**
   * 打开 LLM 配置面板。
   *
   * core 只提供配置事实（`getLLMConfigPanelPayload` / `hasActiveProviderSetting` /
   * `readMcpServersForDefaults`），wire message 的组装与投递在 WebViewUI 完成。
   * `sessionId` 为定向视图；`null` 表示单视图宿主的唯一 webview。
   */
  showLLMConfigPanel(trigger: LLMConfigPanelTrigger, sessionId: string | null): Promise<void>;
}
