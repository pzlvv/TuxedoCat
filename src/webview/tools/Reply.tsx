import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import InlineCode from '../components/InlineCode';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { t } from '../i18n';

export const ReplyTool: React.FC<ToolCallProps> = ({ args, colors, status, onNavigate }) => {
  // 目标会话标识：优先使用 args.targetSessionId，没有则使用 args.hostname 识别远程
  const targetSessionId = args?.targetSessionId || '';
  const hostname = args?.hostname || '';
  const workspace = args?.workspace || '';

  // 构建显示文本: <host>:<workspacePath>:<sessionId>
  // sessionId 只显示前 8 位
  let displayText: string;
  let canNavigate = false;

  if (hostname && workspace) {
    // 远程节点回复：显示 hostname:workspace:sessionId
    const shortWs = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.substring(0, 20) || '';
    const shortSid = targetSessionId ? targetSessionId.substring(0, 8) : '...';
    displayText = `${hostname}:${shortWs}:${shortSid}`;
    // 远程节点不支持跳转
    canNavigate = false;
  } else if (targetSessionId) {
    // 本地会话：显示 sessionId 缩写，支持点击跳转
    displayText = targetSessionId.substring(0, 8);
    canNavigate = true;
  } else {
    displayText = '...';
    canNavigate = false;
  }

  const handleClick = () => {
    if (canNavigate && targetSessionId && onNavigate) {
      onNavigate(targetSessionId);
    }
  };

  const message = args?.message || '';

  return (
    <div className="w-full">
      <ToolHeader icon="Reply" name="Reply" colors={colors}>
        <span
          onClick={handleClick}
          style={{
            color: canNavigate ? colors.harness : colors.textSystem,
            cursor: canNavigate ? 'pointer' : 'default',
            textDecoration: canNavigate ? 'underline' : 'none',
            textDecorationStyle: 'dotted',
            fontSize: '11px',
            whiteSpace: 'nowrap',
          }}
          title={canNavigate ? t('tool.reply.navigateTitle') : undefined}
        >
          {displayText}
        </span>
      </ToolHeader>
      {/* 只有成功时才渲染 markdown 内容，失败时不显示无用文本 */}
      {status === 'success' && message && (
        <div
          className="max-w-full text-left markdown-body text-[13px] leading-snug"
          style={{
            color: colors.textPrimary,
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
            border: `1px solid ${colors.textSystem}`,
            borderRadius: '6px',
            padding: '8px',
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              code: ({ children, className }: any) => {
                const isInline = !className;
                return isInline ? (
                  <InlineCode colors={colors}>{children}</InlineCode>
                ) : (
                  <code className={className}>{children}</code>
                );
              },
            }}
          >
            {message}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
};
