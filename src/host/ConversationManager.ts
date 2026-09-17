/**
 * ConversationManager - 对话相关数据的宿主契约（第三个 UI surface）
 *
 * 分发两条互相独立的流（DEVELOPMENT.md 第 5.4 节）：
 *
 * |          | 流 1：对话列表                    | 流 2：会话运行时状态             |
 * | -------- | -------------------------------- | ------------------------------- |
 * | 内容     | 磁盘元数据（title/createdAt/...） | running / waiting               |
 * | 数据源   | 磁盘（core 的 loadConversationList） | core 的 sessionRuntime        |
 * | 变化频率 | 低（落盘/改名/删除/新建）         | 高（每次查询开始结束、等用户）    |
 * | 触发     | CoreEvent.conversationListChanged | CoreEvent.sessionRuntimeChanged |
 * | 消费者   | webview 子对话树、Electron 原生侧栏 | Electron 侧栏流水灯、系统托盘    |
 *
 * 为什么必须分开：以前两者是「一条流」——宿主把 running/waitingForUser
 * 「贴」到磁盘列表上再一起推出去，导致列表接口失真、每次状态变化都要重读盘。
 * 拆开之后各自只在自己变化时推，托盘直接吃状态流。
 *
 * 用抽象类而不是接口：load() 两端一致、只有 dispatch*() 不同，
 * 模板方法把共享部分固定在基类。
 */

import type { ConversationMetadata } from '../core/history/Conversation.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import type { UIHost } from './UIHost.js';

export abstract class ConversationManager {
  constructor(protected readonly host: UIHost) {}

  // ===================== 流 1：对话列表 =====================

  /** 重新读取对话列表并分发给该宿主所有需要它的界面 */
  async refresh(): Promise<void> {
    await this.dispatchList(await this.load());
  }

  /** 读磁盘对话列表（source of truth，两端一致） */
  protected async load(): Promise<ConversationMetadata[]> {
    const { loadConversationList } = await import('../core/history/index.js');
    return loadConversationList();
  }

  /** 把纯磁盘列表分发给该宿主的界面 */
  protected abstract dispatchList(list: readonly ConversationMetadata[]): Promise<void>;

  // ===================== 流 2：会话运行时状态 =====================

  /**
   * 把最新的会话状态分发给该宿主的界面。
   * states 由 core 的全量推送（CoreEvent.sessionRuntimeChanged）提供，不做增量合并。
   */
  updateSessionStates(states: readonly SessionRuntimeState[]): void {
    this.dispatchStates(states);
  }

  /** 把会话状态分发给该宿主的界面 */
  protected abstract dispatchStates(states: readonly SessionRuntimeState[]): void;

  /**
   * 注册会话状态回调，可选。
   * Electron 用它驱动系统托盘状态点与「任务结束」闪烁提醒；VS Code 不注册。
   */
  setStatusListener(fn: (states: readonly SessionRuntimeState[]) => void): void {
    this.statusListener = fn;
  }

  /** 已注册的状态回调（Electron 托盘）；未注册时为 null */
  protected statusListener: ((states: readonly SessionRuntimeState[]) => void) | null = null;

  /**
   * 设置「推侧栏」的出口（Electron 专用：侧栏就绪后由宿主替换 no-op 占位）。
   * VS Code 没有原生侧栏，不调用。
   */
  setSidebarOutlet(fn: (channel: string, payload: unknown) => void): void {
    this.sidebarOutlet = fn;
  }

  /** 侧栏出口（Electron 用；未设置时 no-op） */
  protected sidebarOutlet: ((channel: string, payload: unknown) => void) | null = null;
}
