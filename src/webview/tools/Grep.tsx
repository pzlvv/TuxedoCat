import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const Grep: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const pattern = args?.pattern;
  const path = args?.path;
  const glob = args?.glob;

  if (!pattern) {
    return (
      <ToolHeader icon="Search" name="Grep" colors={colors}>
        <span style={{ opacity: 0.5 }}>{t('tool.noPattern')}</span>
      </ToolHeader>
    );
  }

  // 构建显示文本
  const parts: string[] = [];

  // 显示搜索模式
  parts.push(`"${pattern}"`);

  // 显示路径
  if (path && path !== '.') {
    const displayPath = path.length > 30 ? '...' + path.slice(-30) : path;
    parts.push(t('tool.in', { path: displayPath }));
  }

  // 显示 glob 过滤器
  if (glob) {
    parts.push(`(${glob})`);
  }

  const displayText = parts.join(' ');

  // 解析输出中的结果摘要
  let resultText: string | undefined;
  if (status === 'success' && output) {
    const outputStr = typeof output === 'string' ? output : String(output);

    // count 模式: "Found 8 total occurrences across 2 files."
    const occurrencesMatch = outputStr.match(/Found (\d+) total occurrences? across (\d+) files?/);
    if (occurrencesMatch) {
      const matches = parseInt(occurrencesMatch[1], 10);
      const files = parseInt(occurrencesMatch[2], 10);
      const matchUnit = matches === 1 ? t('tool.match') : t('tool.matches');
      const fileUnit = files === 1 ? t('tool.file') : t('tool.files');
      resultText = t('tool.foundMatchesInFiles', { matches, matchUnit, files, fileUnit });
    } else {
      // files_with_matches 模式: "Found 3 files\nfile1\nfile2\nfile3"
      const filesMatch = outputStr.match(/Found (\d+) files?/);
      if (filesMatch) {
        const count = parseInt(filesMatch[1], 10);
        resultText = t('tool.foundFiles', { count });
      }
    }
  }

  return (
    <ToolHeader icon="Search" name="Grep" colors={colors}>
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
