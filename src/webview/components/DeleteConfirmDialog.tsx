import React from 'react';
import { Colors } from '../types';
import { t } from '../i18n';

interface DeleteConfirmDialogProps {
  deleteConfirm: { sessionId: string; title: string };
  colors: Colors;
  onCancel: () => void;
  onConfirm: (sessionId: string) => void;
}

export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  deleteConfirm,
  colors,
  onCancel,
  onConfirm,
}) => {
  return (
    <div
      className="fixed top-16 right-4"
      style={{ zIndex: 9999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          backgroundColor: colors.bgSecondary,
          border: `1px solid ${colors.border}`,
          borderRadius: '6px',
          padding: '12px',
          minWidth: '240px',
          maxWidth: '280px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}
      >
        <div className="mb-2" style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          <p className="text-[12px]" style={{ color: colors.textPrimary }}>
            {t('deleteConfirm.confirm', { title: deleteConfirm.title })}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-2 py-1 rounded text-[12px] transition-colors"
            style={{
              backgroundColor: colors.bgTertiary,
              color: colors.textPrimary,
            }}
          >
            {t('deleteConfirm.cancel')}
          </button>
          <button
            onClick={() => onConfirm(deleteConfirm.sessionId)}
            className="px-2 py-1 rounded text-[12px] text-white transition-colors hover:brightness-110"
            style={{
              backgroundColor: '#ef4444',
            }}
          >
            {t('deleteConfirm.delete')}
          </button>
        </div>
      </div>
    </div>
  );
};
