import React from 'react';
import { t } from '../i18n';
import type { Colors } from '../types';

interface RewindConfirmDialogProps {
  colors: Colors;
  /** 会被删除的消息条数（被点节点之后） */
  removedCount: number;
  /** 会被回滚的文件数（确认框只需给出规模，逐条结果在回执里） */
  fileCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 「从这里继续」的确认框（specs/039 FR-002 / AC-2 / AC-3）。
 *
 * 与 `ApplyDefaultsDialog` 同一形态（固定遮罩 + 居中卡片 + 两个按钮），文案必须写清
 * 三件事：删掉哪一段、回滚哪些文件、不可恢复。默认焦点在「取消」——这是不可逆操作，
 * 误按 Enter 不该删掉对话。
 */
export const RewindConfirmDialog: React.FC<RewindConfirmDialogProps> = ({
  colors,
  removedCount,
  fileCount,
  onCancel,
  onConfirm,
}) => {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999]"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={onCancel}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={t('rewindDialog.title')}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 48px)',
          borderRadius: 8,
          padding: '18px 20px',
          backgroundColor: colors.bgSecondary,
          color: colors.textPrimary,
          border: `1px solid ${colors.border}`,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          {t('rewindDialog.title')}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
          {t('rewindDialog.body', { removed: removedCount, files: fileCount })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              padding: '5px 14px',
              fontSize: 12,
              borderRadius: 4,
              cursor: 'pointer',
              backgroundColor: 'transparent',
              color: colors.textPrimary,
              border: `1px solid ${colors.border}`,
            }}
          >
            {t('rewindDialog.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              padding: '5px 14px',
              fontSize: 12,
              borderRadius: 4,
              cursor: 'pointer',
              backgroundColor: colors.timelineStatusFail,
              color: '#ffffff',
              border: 'none',
            }}
          >
            {t('rewindDialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
