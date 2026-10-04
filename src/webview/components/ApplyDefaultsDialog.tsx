import React from 'react';
import type { ApplyDefaultsPrompt, Colors } from '../types';
import { t } from '../i18n';

interface ApplyDefaultsDialogProps {
  prompt: ApplyDefaultsPrompt;
  colors: Colors;
  /** 用户选择「暂不应用」：只保留新对话默认值，不动当前对话 */
  onDismiss: () => void;
  /** 用户选择「应用到当前对话」：把 pending 里的字段写进当前对话 */
  onApply: () => void;
}

/**
 * 「默认配置已修改，是否应用到当前对话」确认对话框。
 *
 * 设置面板保存后，若某默认值相对保存前有变化、又与当前对话的值不一致，就弹这个框：
 * 确认才改当前对话，避免保存默认配置时静默覆盖用户在当前对话里的选择。
 * 逐条列出变更项（变更前 → 变更后），让用户知道会改什么。
 */
export const ApplyDefaultsDialog: React.FC<ApplyDefaultsDialogProps> = ({
  prompt,
  colors,
  onDismiss,
  onApply,
}) => {
  return (
    <div
      className="fixed inset-0 z-[9999]"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: colors.bgSecondary,
          border: `1px solid ${colors.border}`,
          borderRadius: '8px',
          padding: '16px',
          width: 'calc(100% - 32px)',
          maxWidth: '380px',
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div className="ui-fs-13 font-semibold mb-2" style={{ color: colors.textPrimary }}>
          {t('applyDefaults.title')}
        </div>
        <div className="ui-fs-12 mb-3 leading-snug" style={{ color: colors.textSystem }}>
          {t('applyDefaults.message')}
        </div>
        <div className="flex flex-col gap-1 mb-4">
          {prompt.changes.map((change) => (
            <div key={change.label} className="ui-fs-12 leading-snug" style={{ color: colors.textSystem }}>
              <span style={{ color: colors.textPrimary }}>{change.label}</span>
              {': '}
              <span>{change.from}</span>
              <span style={{ color: colors.textSecondary }}>{' → '}</span>
              <span style={{ color: colors.harness }}>{change.to}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded ui-fs-12 transition-colors"
            style={{
              backgroundColor: 'transparent',
              color: colors.textSystem,
              border: `1px solid ${colors.border}`,
            }}
          >
            {t('applyDefaults.dismiss')}
          </button>
          <button
            onClick={onApply}
            className="px-3 py-1.5 rounded ui-fs-12 text-white transition-colors hover:brightness-110"
            style={{ backgroundColor: colors.harness }}
          >
            {t('applyDefaults.apply')}
          </button>
        </div>
      </div>
    </div>
  );
};
