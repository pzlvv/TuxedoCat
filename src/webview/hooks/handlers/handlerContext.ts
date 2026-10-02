/**
 * webview 消息 handler 的共享上下文。
 *
 * useMessageHandler 的 switch 把判别收窄后的 wire 消息转发给四个域
 * （stream / tool / conversation / config）的 handler；hook 体内创建的
 * ref 与闭包经本接口注入，域 handler 不感知 React 生命周期。
 * `sessionId` / `fromCurrentSession` / `hostSessionId` 是 handleMessage
 * 入口处算好的当前会话判定（各 handler 共用同一份）。
 */
import type { MutableRefObject } from 'react';
import type { Message, QueuedMessagePayload } from '../../types';
import type { UseMessageHandlerProps } from '../useMessageHandler';

export interface HandlerContext {
  /** 首次渲染的 props（setState / ref 类字段稳定；值类型字段经 propsRef 读最新） */
  props: UseMessageHandlerProps;
  propsRef: MutableRefObject<UseMessageHandlerProps>;
  contextLengthRef: MutableRefObject<number>;
  messagesRef: MutableRefObject<Message[]>;
  /** 每个 session 本轮 query 的起始时间（TTFT 统计） */
  queryStartBySessionRef: MutableRefObject<Map<string, number>>;
  /** 每个 session 最近一次模型产出活动时间（Thinking for Xs 的起点） */
  lastActivityBySessionRef: MutableRefObject<Map<string, number>>;
  /** 已打开会话的消息缓存（仅内存，切走再切回不丢 streamId 关联） */
  sessionMessagesCacheRef: MutableRefObject<Map<string, Message[]>>;
  /** 渲染前预滚到底部（先滚动、后渲染，见 useMessageHandler 内注释） */
  scrollToBottomBeforeRender(): void;
  /** 排队消息回填到输入框（目标会话非当前时写该会话的状态快照） */
  restoreQueuedMessageToInput(targetSessionId: string, queued: QueuedMessagePayload): void;
  /** 当前会话 ID（currentSessionIdRef.current） */
  sessionId: string | undefined;
  /** 消息是否作用于当前展示的会话 */
  fromCurrentSession: boolean;
  /** 消息自带的会话 ID（wire 上的 sessionId 字段） */
  hostSessionId: string | undefined;
}
