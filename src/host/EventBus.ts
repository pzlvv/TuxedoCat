/**
 * EventBus - AssistantEventBus 的纯内存实现
 *
 * 只做路由，不含任何「事件 → 方法」的映射逻辑，无宿主依赖：
 * - core → UI：emitToUi / request 广播给 onCoreEvents / onCoreRequests 注册的处理器
 * - UI → core：emitToCore 按 type 分发给 onUiEvent 注册的订阅者
 *
 * 边界语义（DEVELOPMENT.md 第 3.7 节）：
 * - emitToUi 时处理器未注册 → 抛错（bootstrap 顺序错误，启动期暴露）
 * - emitToCore 时某 type 无订阅者 → 静默丢弃（合法中间态）
 * - request() 无内置超时：调用点必须自带超时兜底（总线保持纯路由）
 */

import type {
  AssistantEventBus,
  CoreEvent,
  CoreEventHandlers,
  CoreRequest,
  CoreRequestHandlers,
  CoreRequestResultMap,
  UiEvent,
  Unsubscribe,
} from '../core/AssistantEventBus.js';

export function createEventBus(): AssistantEventBus {
  let coreEventHandlers: CoreEventHandlers | null = null;
  let coreRequestHandlers: CoreRequestHandlers | null = null;
  const uiEventHandlers = new Map<string, Set<(event: UiEvent) => void>>();

  const bus: AssistantEventBus = {
    emitToUi(event: CoreEvent): void {
      if (!coreEventHandlers) {
        throw new Error(
          `No core event handlers registered before emitToUi(${event.type}). ` +
          'Call onCoreEvents() (WebViewUI bootstrap) before core emits events.'
        );
      }
      const handler = (coreEventHandlers as Record<string, (e: CoreEvent) => void>)[event.type];
      if (handler) {
        handler(event);
      }
    },

    request<T extends CoreRequest['type']>(
      request: Extract<CoreRequest, { type: T }>,
    ): Promise<CoreRequestResultMap[T]> {
      if (!coreRequestHandlers) {
        return Promise.reject(
          new Error(
            `No core request handlers registered before request(${request.type}). ` +
            'Call onCoreRequests() (WebViewUI bootstrap) before core sends requests.'
          ),
        );
      }
      const handler = (coreRequestHandlers as Record<string, (r: CoreRequest) => Promise<unknown>>)[
        request.type
      ];
      if (!handler) {
        return Promise.reject(
          new Error(`No handler registered for core request ${request.type}.`),
        );
      }
      return handler(request) as Promise<CoreRequestResultMap[T]>;
    },

    onCoreEvents(handlers: CoreEventHandlers): Unsubscribe {
      if (coreEventHandlers) {
        throw new Error('Core event handlers already registered. onCoreEvents() must be called once.');
      }
      coreEventHandlers = handlers;
      return () => {
        if (coreEventHandlers === handlers) {
          coreEventHandlers = null;
        }
      };
    },

    onCoreRequests(handlers: CoreRequestHandlers): void {
      if (coreRequestHandlers) {
        throw new Error('Core request handlers already registered. onCoreRequests() must be called once.');
      }
      coreRequestHandlers = handlers;
    },

    emitToCore(event: UiEvent): void {
      const handlers = uiEventHandlers.get(event.type);
      if (!handlers) return; // 暂无 core 订阅者：静默丢弃（合法中间态）
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          // 单个订阅者失败不阻断其它订阅者
          console.error(`[EventBus] UiEvent handler error (${event.type}):`, err);
        }
      }
    },

    onUiEvent<T extends UiEvent['type']>(
      type: T,
      handler: (event: Extract<UiEvent, { type: T }>) => void,
    ): Unsubscribe {
      let set = uiEventHandlers.get(type);
      if (!set) {
        set = new Set();
        uiEventHandlers.set(type, set);
      }
      const wrapped = handler as (event: UiEvent) => void;
      set.add(wrapped);
      return () => {
        const current = uiEventHandlers.get(type);
        if (!current) return;
        current.delete(wrapped);
        if (current.size === 0) {
          uiEventHandlers.delete(type);
        }
      };
    },
  };

  return bus;
}
