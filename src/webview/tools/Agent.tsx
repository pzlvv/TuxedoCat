import React from 'react';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';
import { uiFontSizePx } from '../fontSize';

export const Agent: React.FC<ToolCallProps> = ({ args, colors, output, onNavigate }) => {
  const prompt = args?.prompt || '';
  const role = args?.agentRole;
  // 跨工作区子代理（specs/023）：工具入参里的 target 就是跳转的目标工作区身份
  const target = typeof args?.target === 'string' && args.target ? args.target : null;

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
      // 同工作区跳转传 null（宿主按当前视图解析）；跨工作区传目标身份对应的稳定 id
      onNavigate(subAgentId, target);
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
      {target && (
        <span
          style={{
            marginRight: '6px',
            color: colors.textSystem,
            fontSize: uiFontSizePx(11),
            whiteSpace: 'nowrap',
          }}
          title={target}
        >
          → {target}
        </span>
      )}
      <span style={{ color: colors.textPrimary }}>
        {displayText}
      </span>
    </ToolHeader>
  );
};
