import React, { memo } from 'react';
import type { Colors } from './types';
import { t } from './i18n';
import { uiFontSizePx } from './fontSize';
import { useStreamStats, formatCount } from './hooks/useStreamStats';

interface StreamStatsLabelProps {
  /** 流式消息 ID；历史恢复的消息没有该值，组件不渲染任何内容 */
  streamId?: string;
  colors: Colors;
}

/**
 * 流式生成统计文本（count / decode / rate / prefill）。
 *
 * 单独拆成子组件的原因：store 每秒刷新统计，订阅发生在这一层，
 * 因此只有这个 span 会重渲染，ThinkingMessage 的正文（可能很长）不参与。
 */
export const StreamStatsLabel: React.FC<StreamStatsLabelProps> = memo(({ streamId, colors }) => {
  const stats = useStreamStats(streamId);
  if (!stats) return null;

  // 单位缩写：token 用 tok，字符用 chars
  const unit = stats.unit === 'tokens' ? 'tok' : 'chars';
  // decode 时间太短（<0.5s）时速度不准，不显示速率
  const showRate = stats.decodeMs >= 500;
  const decodeText = t(
    showRate ? 'messagesView.streamStats' : 'messagesView.streamStatsNoRate',
    {
      count: formatCount(stats.count),
      unit,
      time: (stats.decodeMs / 1000).toFixed(1),
      rate: stats.rate.toFixed(1),
    },
  );
  // 有首 token 耗时时展示 Prefill，否则只展示 Decode
  const text = stats.ttftMs !== null
    ? t('messagesView.streamStatsPrefill', {
        prefill: (stats.ttftMs / 1000).toFixed(1),
        decode: decodeText,
      })
    : decodeText;

  return (
    <span
      className="ml-2 whitespace-nowrap"
      style={{ color: colors.textSystem, opacity: 0.7, fontSize: uiFontSizePx(12), fontVariantNumeric: 'tabular-nums' }}
    >
      {text}
    </span>
  );
});

StreamStatsLabel.displayName = 'StreamStatsLabel';
