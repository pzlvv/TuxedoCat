import React from 'react';
import type { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';
import { uiFontSizePx } from '../fontSize';

export const Skill: React.FC<ToolCallProps> = ({ args, colors, status, output }) => {
  const skillName = args?.skill || '';
  const skillArgs = args?.args || '';

  const displayText = skillName
    ? `/${skillName}${skillArgs ? ` ${skillArgs}` : ''}`
    : '';

  return (
    <ToolHeader icon="Zap" name="Skill" colors={colors}>
      <span style={{ color: colors.harness, marginRight: '6px', fontSize: uiFontSizePx(11), fontWeight: 600 }}>
        {displayText}
      </span>
      {status === 'running' && (
        <span style={{ color: colors.textSecondary, fontSize: uiFontSizePx(11) }}>
          {t('tool.skill.loading')}
        </span>
      )}
      {status === 'success' && (
        <span style={{ color: colors.success || '#4CAF50', fontSize: uiFontSizePx(11) }}>
          {t('tool.skill.loaded')}
        </span>
      )}
      {status === 'fail' && (
        <span style={{ color: colors.error || '#F44336', fontSize: uiFontSizePx(11) }}>
          {output || t('tool.skill.error')}
        </span>
      )}
    </ToolHeader>
  );
};
