import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';
import { uiFontSizePx } from '../fontSize';

export const Agent: React.FC<ToolCallProps> = ({ args, colors, output, onNavigate }) => {
  const prompt = args?.prompt || '';
  const role = args?.agentRole;

  // 从 output 中提取 subAgentId
  let subAgentId: string | undefined;
  if (output && typeof output === 'string') {
    const match = output.match(/\*\*Sub-agent ID\*\*: `([^`]+)`/);
    if (match) {
      subAgentId = match[1];
    }
  }

  const handleClick = () => {
    if (subAgentId && onNavigate) {
      onNavigate(subAgentId);
    }
  };

  const displayText = prompt
    ? `"${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`
    : '';

  return (
    <ToolHeader icon="Bot" name="Agent" colors={colors}>
      {role && (
        <span style={{ color: colors.toolName, marginRight: '6px', fontSize: uiFontSizePx(11), opacity: 0.8 }}>
          [{role}]
        </span>
      )}
      {subAgentId && (
        <span
          onClick={handleClick}
          style={{
            marginRight: '6px',
            color: colors.harness,
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
            fontSize: uiFontSizePx(11),
            whiteSpace: 'nowrap',
          }}
          title={t('tool.agent.navigateTitle')}
        >
          #{subAgentId.slice(-8)}...
        </span>
      )}
      <span style={{ color: colors.textPrimary }}>
        {displayText}
      </span>
    </ToolHeader>
  );
};
