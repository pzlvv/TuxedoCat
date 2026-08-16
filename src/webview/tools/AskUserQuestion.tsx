import React from 'react';
import type { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const AskUserQuestion: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const question = args?.question || '';

  return (
    <ToolHeader icon="HelpCircle" name="Ask User" colors={colors}>
      <span style={{ color: colors.textPrimary, marginRight: '6px', fontSize: '11px', fontWeight: 600 }}>
        {question}
      </span>
      {status === 'success' && output && (
        <span style={{ color: colors.textSystem, fontSize: '11px' }}>
          {t('tool.askUser.response', { output })}
        </span>
      )}
      {status === 'running' && (
        <span style={{ color: colors.textSecondary, fontSize: '11px' }}>
          {t('tool.askUser.waitingResponse')}
        </span>
      )}
      {(status === 'fail') && (
        <span style={{ color: colors.timelineStatusFail || '#ef4444', fontSize: '11px', fontWeight: 600 }}>
          {output || t('tool.askUser.failed')}
        </span>
      )}
    </ToolHeader>
  );
};
