/**
 * 流式生成统计 hook（组件侧只负责订阅，真正的计算在 streamStatsStore 里）。
 *
 * - 统计按 streamId 索引，组件卸载（切换对话）后全局定时器仍继续刷新；
 * - 历史恢复的消息没有 streamId，返回 null，不显示统计。
 *
 * 用 useSyncExternalStore 订阅 store：store 每秒 refresh 时只通知订阅者，
 * 由 React 读取稳定的快照引用决定是否重渲染，不再需要 useState + 本地定时器兜底。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { getStreamStats, subscribeStreamStats, type StreamStats } from '../streamStatsStore';

export type { StreamStats, StreamStatsUnit } from '../streamStatsStore';

/**
 * 把计数格式化为紧凑形式：超过 1000 显示为 1.2K。
 * 统计值不会超过 1M，因此不处理 M。
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) {
    return `${Math.round(n / 100) / 10}K`;
  }
  return String(Math.round(n));
}

/**
 * 订阅某条流式消息的统计，store 每秒刷新一次会触发重渲染。
 * @param streamId 流式消息 ID；历史消息没有该值，直接返回 null
 */
export function useStreamStats(streamId: string | undefined | null): StreamStats | null {
  // subscribe / getSnapshot 随 streamId 变化重建：streamId 变了要换订阅源。
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!streamId) return () => {};
      return subscribeStreamStats(streamId, onStoreChange);
    },
    [streamId],
  );

  // getStreamStats 返回 store 缓存的 stats 对象，未变化时引用稳定，
  // useSyncExternalStore 据此跳过重渲染。
  const getSnapshot = useCallback(() => getStreamStats(streamId), [streamId]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
