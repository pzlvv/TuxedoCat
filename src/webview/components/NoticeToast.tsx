import React from 'react';
import { Colors } from '../types';
import { t } from '../i18n';

/**
 * 一条瞬时状态提示（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
 *
 * core 只给「键 + 参数」，翻译在这里做；不进消息流、不落盘。
 */
export interface NoticeItem {
  id: number;
  key: string;
  params: Record<string, string | number>;
  level: 'info' | 'warn' | 'error';
}

const LEVEL_COLORS: Record<NoticeItem['level'], string> = {
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
};

interface NoticeToastProps {
  notices: NoticeItem[];
  colors: Colors;
  onDismiss: (id: number) => void;
}

/** 瞬时提示浮层：多条提示纵向堆叠，点击关闭或到点自动消失 */
export const NoticeToast: React.FC<NoticeToastProps> = ({ notices, colors, onDismiss }) => {
  if (notices.length === 0) return null;
  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 items-center"
      style={{ zIndex: 9999 }}
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          role="status"
          className="flex items-start gap-2 rounded-lg px-3 py-2"
          style={{
            backgroundColor: colors.bgSecondary,
            border: `1px solid ${colors.border}`,
            borderLeft: `3px solid ${LEVEL_COLORS[notice.level]}`,
            maxWidth: '420px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <span
            className="text-[12px]"
            style={{ color: colors.textPrimary, overflowWrap: 'break-word', wordBreak: 'break-word' }}
          >
            {t(notice.key, notice.params)}
          </span>
          <button
            onClick={() => onDismiss(notice.id)}
            className="text-[14px] leading-none transition-colors hover:opacity-70"
            style={{ color: colors.textSystem }}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
