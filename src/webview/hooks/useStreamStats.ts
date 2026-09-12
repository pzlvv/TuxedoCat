/**
 * 流式生成统计 hook（组件侧只负责订阅，真正的计算在 streamStatsStore 里）。
 *
 * - 统计按 streamId 索引，组件卸载（切换对话）后全局定时器仍继续刷新；
 * - 历史恢复的消息没有 streamId，返回 null，不显示统计。
 */
import { useEffect, useState } from 'react';
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
  const [stats, setStats] = useState<StreamStats | null>(() => getStreamStats(streamId));

  useEffect(() => {
    // 挂载 / streamId 变化时先同步一次当前值
    setStats(getStreamStats(streamId));
    if (!streamId) return;
    return subscribeStreamStats(streamId, () => {
      setStats(getStreamStats(streamId));
    });
  }, [streamId]);

  // 本地兜底：流式期间每秒主动拉一次。
  // store 的全局 ticker 负责计算；这里只保证组件每秒重渲染一次，
  // 避免订阅通知被 React 合并/跳过时 decode 数字不刷新。
  const streaming = stats?.isStreaming === true;
  useEffect(() => {
    if (!streamId || !streaming) return;
    const id = window.setInterval(() => setStats(getStreamStats(streamId)), 1000);
    return () => window.clearInterval(id);
  }, [streamId, streaming]);

  return stats;
}
