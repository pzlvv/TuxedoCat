import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const QueryUserMemory: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const query = args?.query;

  // 解析输出结果数量
  let resultText: string | undefined;
  if (status === 'success' && output) {
    const outputStr = typeof output === 'string' ? output : String(output);

    // 尝试提取结果数量（匹配 "Found N result(s)" 或直接按行数计算）
    const countMatch = outputStr.match(/Found\s+(\d+)\s+result/i) || outputStr.match(/^(\d+)\s+result/i);
    if (countMatch) {
      resultText = t('tool.queryMemory.found', { count: countMatch[1], s: parseInt(countMatch[1], 10) !== 1 ? 's' : '' });
    } else {
      const lines = outputStr.split('\n').filter((line: string) => line.trim());
      if (lines.length > 0) {
        resultText = t('tool.queryMemory.results', { count: lines.length, s: lines.length !== 1 ? 's' : '' });
      }
    }
  }

  if (!query) {
    return (
      <ToolHeader icon="Search" name="QueryUserMemory" colors={colors}>
        <span style={{ opacity: 0.5 }}>{t('tool.queryMemory.noQuery')}</span>
      </ToolHeader>
    );
  }

  const displayQuery = typeof query === 'string'
    ? (query.length > 60 ? query.substring(0, 60) + '...' : query)
    : String(query);

  return (
    <ToolHeader icon="Search" name="QueryUserMemory" colors={colors}>
      <span
        style={{
          color: colors.textPrimary,
        }}
        title={String(query)}
      >
        {displayQuery}
      </span>
      {resultText && (
        <span
          style={{
            marginLeft: '8px',
            color: colors.textSystem,
          }}
        >
          {resultText}
        </span>
      )}
    </ToolHeader>
  );
};
