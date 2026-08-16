import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const Glob: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const pattern = args?.pattern;
  const path = args?.path;

  if (!pattern) {
    return (
      <ToolHeader icon="FileSearch" name="Glob" colors={colors}>
        <span style={{ opacity: 0.5 }}>{t('tool.noPattern')}</span>
      </ToolHeader>
    );
  }

  // 构建显示文本
  const parts: string[] = [];

  // 显示模式
  parts.push(`"${pattern}"`);

  // 显示路径（如果不是默认值）
  if (path && path !== '.') {
    const displayPath = path.length > 30 ? '...' + path.slice(-30) : path;
    parts.push(t('tool.in', { path: displayPath }));
  }

  const displayText = parts.join(' ');

  // 解析输出中的文件数
  let resultText: string | undefined;
  if (status === 'success' && output) {
    const outputStr = typeof output === 'string' ? output : String(output);

    // 计算文件数（每行一个文件路径）
    const lines = outputStr.split('\n').filter(line => line.trim());
    const count = lines.length;

    if (count > 0) {
      resultText = t('tool.foundFiles', { count });
    }
  }

  return (
    <ToolHeader icon="FileSearch" name="Glob" colors={colors}>
      <span
        style={{
          color: colors.textPrimary,
        }}
        title={parts.join('\n')}
      >
        {displayText}
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
