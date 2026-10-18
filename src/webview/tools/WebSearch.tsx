import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

/**
 * WebSearch / WebFetch 工具卡片
 * 联网搜索（WebSearch 工具 / 历史 Responses 搜索项）与网页抓取（WebFetch 工具）：
 * - search 形态：显示搜索关键词（args.query 或旧格式的 args.queries）
 * - open_page 形态：显示抓取 / 打开的网页 URL
 *
 * 搜索进行中（status === 'running'）时不额外显示 loading，
 * 复用 timeline 上 toolcall 运行时的旋转小点即可；完成后显示"完成"。
 */
export const WebSearch: React.FC<ToolCallProps> = ({ toolName, args, colors, status, output }) => {
  const action = args?.action || (typeof args?.url === 'string' && args.url ? 'open_page' : 'search');
  const queries: string[] = Array.isArray(args?.queries)
    ? args.queries
    : typeof args?.query === 'string' && args.query
      ? [args.query]
      : [];
  const url: string = args?.url || '';
  const isFailed = status === 'fail';
  const failText = output || t('webSearch.failed');

  // 剥离服务商附加的内部追踪参数（#ws_call_id=xxx），仅影响展示
  const cleanUrl = url.replace(/[#&?]ws_call_id=[^#&?]*/g, '').replace(/[?#]$/, '');

  // open_page：显示打开的网页 URL
  if (action === 'open_page') {
    const displayUrl = cleanUrl.length > 60 ? cleanUrl.substring(0, 60) + '…' : cleanUrl;
    return (
      <ToolHeader icon="ExternalLink" name={toolName} colors={colors}>
        <span
          style={{ color: isFailed ? colors.timelineStatusFail : colors.textPrimary }}
          title={cleanUrl}
        >
          {isFailed ? failText : cleanUrl ? displayUrl : t('webSearch.openingPage')}
        </span>
        {status === 'success' && (
          <span style={{ marginLeft: '8px', color: colors.textSystem }}>
            {t('webSearch.pageLoaded')}
          </span>
        )}
      </ToolHeader>
    );
  }

  // search：显示搜索关键词
  const displayQueries = queries
    .filter((q) => !q.startsWith('ws_call_id='))
    .slice(0, 2)
    .map((q) => (q.length > 30 ? q.substring(0, 30) + '…' : q));
  const queryText = displayQueries.length
    ? `"${displayQueries.join('" / "')}"`
    : '';
  const isDone = status === 'success';

  return (
    <ToolHeader icon="Search" name={toolName} colors={colors}>
      <span
        style={{ color: isFailed ? colors.timelineStatusFail : colors.textPrimary }}
        title={queries.join('\n')}
      >
        {isFailed
          ? failText
          : queryText
            ? t('webSearch.searching', { query: queryText })
            : // 已完成但没有关键词（服务商未返回 queries 的瞬时搜索项）：
              // 直接显示"完成"，避免"正在联网搜索… + 完成"的矛盾展示
              isDone
              ? t('webSearch.searchDone')
              : t('webSearch.searchingDefault')}
      </span>
      {isDone && queryText && (
        <span style={{ marginLeft: '8px', color: colors.textSystem }}>
          {t('webSearch.searchDone')}
        </span>
      )}
    </ToolHeader>
  );
};
