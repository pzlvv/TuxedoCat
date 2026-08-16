import React from 'react';
import type { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const Skill: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const skillName = args?.skill || '';
  const skillArgs = args?.args || '';

  const displayText = skillName
    ? `/${skillName}${skillArgs ? ` ${skillArgs}` : ''}`
    : '';

  return (
    <ToolHeader icon="Zap" name="Skill" colors={colors}>
      <span style={{ color: colors.harness, marginRight: '6px', fontSize: '11px', fontWeight: 600 }}>
        {displayText}
      </span>
      {status === 'running' && (
        <span style={{ color: colors.textSecondary, fontSize: '11px' }}>
          {t('tool.skill.loading')}
        </span>
      )}
      {status === 'success' && (
        <span style={{ color: colors.success || '#4CAF50', fontSize: '11px' }}>
          {t('tool.skill.loaded')}
        </span>
      )}
      {status === 'fail' && (
        <span style={{ color: colors.error || '#F44336', fontSize: '11px' }}>
          {output || t('tool.skill.error')}
        </span>
      )}
    </ToolHeader>
  );
};
