import React, { useRef, useEffect, useLayoutEffect, useMemo, memo, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { File, ChevronRight, Copy, Check, Wrench, Info } from 'lucide-react';
import { Timeline, ConfigProvider } from 'antd';
import { ThinkingAnimation } from './ThinkingAnimation';
import { ConversationLoading } from './ConversationLoading';
import InlineCode from './components/InlineCode';
import { AnsiText, hasAnsi } from './ansi';
import { PersistedOutputBox, isPersistedOutput } from './tools/persistedOutput';
import * as ToolComponents from './tools';
import type { Message, Colors } from './types';
import { postMessage, getLogoUri, LOGO_CLASS_NAME, navigateToConversation } from './webviewEnv';
import { profileLog } from './debug';
import { t } from './i18n';

/**
 * Pre-computed stable tool component map — created once outside the component
 * to avoid re-creating the object on every render.
 */
const TOOL_COMPONENT_MAP: Record<string, React.ComponentType<any>> = {
  'Bash': ToolComponents.Bash,
  'RemoteBash': ToolComponents.RemoteBash,
  'Read': ToolComponents.ReadFile,
  'ReadFile': ToolComponents.ReadFile,
  'Write': ToolComponents.WriteFile,
  'WriteFile': ToolComponents.WriteFile,
  'Edit': ToolComponents.EditFile,
  'EditFile': ToolComponents.EditFile,
  'Glob': ToolComponents.Glob,
  'Grep': ToolComponents.Grep,
  'WebSearch': ToolComponents.WebSearch,
  'TodoWrite': ToolComponents.TodoWrite,
  'Agent': ToolComponents.Agent,
  'Reply': ToolComponents.ReplyTool,
  'Skill': ToolComponents.Skill,
  'AskUserQuestion': ToolComponents.AskUserQuestion,
  'QueryUserMemory': ToolComponents.QueryUserMemory,
};

/**
 * Shallow equality for toolArgs/meta 等浅层对象字段。
 * 嵌套大对象（beforeContent/afterContent 等）不做深比较，避免 O(n) 遍历大字符串。
 */
function shallowEqualRecord(a: Record<string, any> | undefined, b: Record<string, any> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 智能转义数字区间中的波浪号（1~100、0xFFFF~0xFF、50%~80% 等）。
 * 只要波浪号前后任意一侧是数字（含十进制、十六进制、百分数）就转义，
 * 避免被 Markdown/GFM 误解析为删除线。只处理普通文本段，
 * 跳过 fenced code block 和 inline code，避免代码里出现多余的 \。
 */
function escapeNumericTildeInMarkdown(text: string): string {
  if (!text.includes('~')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => {
      // 奇数段是代码（split 捕获组），保持原样
      if (index % 2 === 1) return part;
      return part.replace(
        /((?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?|[0-9A-Fa-f]{2,})%?)~|~((?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d+)?|[0-9A-Fa-f]{2,})%?)/g,
        (match, left, right) => `${left ?? ''}\\~${right ?? ''}`
      );
    })
    .join('');
}

/**
 * Custom comparator for MessageItem — only re-render when visible message
 * content fields actually change. Compares shallow fields plus toolArgs/meta
 * 的浅层内容；toolArgs 变化时工具组件必须能收到新 args（例如 updateToolArgs
 * 补全 WebSearch 参数、EditFile 清空 before/afterContent）。
 * Also compares colors and isDark to detect theme changes.
 */
function areEqual(prevProps: any, nextProps: any): boolean {
  const prev = prevProps.message;
  const next = nextProps.message;
  if (prev === next && prevProps.colors === nextProps.colors && prevProps.isDark === nextProps.isDark) return true;
  if (prevProps.colors !== nextProps.colors) return false;
  if (prevProps.isDark !== nextProps.isDark) return false;
  if (prev.role !== next.role) return false;
  if (prev.content !== next.content) return false;
  if (prev.status !== next.status) return false;
  if (prev.toolCallId !== next.toolCallId) return false;
  if (prev.isCompactSummary !== next.isCompactSummary) return false;
  if (prev.hasBorder !== next.hasBorder) return false;
  if (prev.isFromAgent !== next.isFromAgent) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.param !== next.param) return false;
  if (prev.filePath !== next.filePath) return false;
  if (prev.toolName !== next.toolName) return false;
  if (!shallowEqualRecord(prev.toolArgs, next.toolArgs)) return false;
  if (!shallowEqualRecord(prev.meta, next.meta)) return false;
  return true;
}

/**
 * Custom comparator for SegmentTimeline — compare messages array by content
 * key fields instead of reference identity, to prevent unnecessary re-renders
 * when the array reference changes but content is identical.
 */
function areSegmentTimelineEqual(prevProps: any, nextProps: any): boolean {
  if (prevProps.segmentIndex !== nextProps.segmentIndex) return false;
  if (prevProps.isLastSegment !== nextProps.isLastSegment) return false;
  if (prevProps.showThinkingAnimation !== nextProps.showThinkingAnimation) return false;
  if (prevProps.animationMode !== nextProps.animationMode) return false;
  if (prevProps.colors !== nextProps.colors) return false;
  if (prevProps.isDark !== nextProps.isDark) return false;
  const prevMsgs = prevProps.nonUserMsgs;
  const nextMsgs = nextProps.nonUserMsgs;
  if (prevMsgs === nextMsgs) return true;
  if (prevMsgs.length !== nextMsgs.length) return false;
  for (let i = 0; i < prevMsgs.length; i++) {
    const a = prevMsgs[i];
    const b = nextMsgs[i];
    if (a === b) continue;
    if (a.content !== b.content) return false;
    if (a.status !== b.status) return false;
    if (a.role !== b.role) return false;
    if (a.toolCallId !== b.toolCallId) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  ToolCall message sub-component                                     */
/* ------------------------------------------------------------------ */
const ToolCallMessage = memo(function ToolCallMessage({
  message,
  colors,
  isDark,
  onNavigate,
  onExpandToggle,
  onBeforePreviewRender,
}: {
  message: Message;
  colors: Colors;
  isDark: boolean;
  onNavigate?: (sessionId: string) => void;
  onExpandToggle?: (isOpen: boolean) => void;
  onBeforePreviewRender?: () => void;
}) {
  const toolName = message.toolName || 'Unknown';
  const status = message.status || 'running';
  const toolArgs = message.toolArgs || {};

  const ToolComponent = TOOL_COMPONENT_MAP[toolName];

  if (ToolComponent) {
    return (
      <ToolComponent
        toolName={toolName}
        args={toolArgs}
        status={status}
        output={message.content}
        isDark={isDark}
        colors={colors}
        toolCallId={message.toolCallId}
        isStreaming={message.isStreaming}
        onNavigate={onNavigate}
        onExpandToggle={onExpandToggle}
        onBeforePreviewRender={onBeforePreviewRender}
      />
    );
  }

  return (
    <div
      className="inline-flex items-center"
      style={{
        color: colors.textSystem,
        fontSize: '12.5px',
        minHeight: '32px',
        marginTop: '-3.5px',
      }}
    >
      {/* 未知工具兜底：仍显示默认图标，保证所有工具卡片都有图标 */}
      <Wrench size={12} style={{ color: colors.textSystem, flexShrink: 0 }} />
      <span
        style={{
          fontWeight: 700,
          fontSize: '12.5px',
          color: colors.toolName,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          marginLeft: '8px',
        }}
      >
        {toolName}
      </span>
    </div>
  );
}, areEqual);

/* ------------------------------------------------------------------ */
/*  User message sub-component                                         */
/* ------------------------------------------------------------------ */
const UserMessage = memo(function UserMessage({
  message,
  colors,
  isDark,
  onExpandToggle,
}: {
  message: Message;
  colors: Colors;
  isDark: boolean;
  onExpandToggle?: (isOpen: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // 从 meta 读取元信息
  const meta = message.meta;
  const metaParam = meta?.param as string | undefined;
  const metaFilePath = meta?.filePath as string | undefined;
  const metaFileSelectedLines = meta?.fileSelectedLines as { start: number; end: number } | undefined;

  // 判断消息类型
  const isAgentMessage = message.isFromAgent && !!metaParam;
  const isFileMessage = !!metaFilePath;
  // agent 消息细分：通过 meta.type 区分
  const metaType = meta?.type as string | undefined;
  const isToMessage = isAgentMessage && metaType === 'to';
  const isFromMessage = isAgentMessage && metaType === 'from';

  // 子代理回复（From 类型）可点击跳转到对应会话
  const agentSessionId = isFromMessage ? (metaParam!.startsWith('#') ? metaParam!.substring(1) : metaParam!.split(':').pop()!.trim()) : null;
  const agentUserMatch = isFromMessage && !metaParam!.startsWith('#') ? metaParam!.match(/\(([^)]+)\)/) : null;
  const agentUserName = agentUserMatch ? agentUserMatch[1] : null;
  const handleAgentClick = useCallback(() => {
    if (agentSessionId) {
      // VS Code：当前 webview 重新加载对话；Electron App：新起 webview 加载对话
      navigateToConversation(agentSessionId);
    }
  }, [agentSessionId]);

  // 文件消息处理
  const handleFileClick = useCallback(() => {
    if (metaFilePath) {
      postMessage({
        type: 'openFile',
        filePath: metaFilePath,
        selectedLines: metaFileSelectedLines,
      });
    }
  }, [metaFilePath, metaFileSelectedLines]);

  // 生成文件显示文本
  const fileDisplayText = useMemo(() => {
    if (!metaFilePath) return null;
    const fileName = metaFilePath.split(/[/\\]/).pop();
    if (metaFileSelectedLines) {
      const { start, end } = metaFileSelectedLines;
      return start !== end ? `${fileName}:${start}~${end}` : `${fileName}:${start}`;
    }
    return fileName || null;
  }, [metaFilePath, metaFileSelectedLines]);

  // 显示的参数字符串
  // - 子代理回复（From）：去掉 "From: " 前缀（metaParam 本身没有这个前缀）
  // - @ 消息（To）：metaParam 以 "To: " 开头，保持原样
  // - 文件消息：文件名
  const displayParam = isAgentMessage ? metaParam : fileDisplayText;

  // User message markdown components
  const userMarkdownComponents = useMemo(() => ({
    p: ({ children }: any) => <p className="mb-1 last:mb-0" style={{ color: colors.textPrimary }}>{children}</p>,
    code: ({ children, className }: any) => {
      const isInline = !className;
      return isInline ? (
        <InlineCode colors={colors}>{children}</InlineCode>
      ) : (
        <div className="my-2 rounded-md overflow-hidden" style={{ border: `1px solid ${colors.border}`, backgroundColor: colors.bgSecondary }}>
          <pre className="p-3 overflow-x-auto text-[12.5px] leading-relaxed" style={{ margin: 0, backgroundColor: 'transparent' }}>
            <code>{typeof children === 'string' && hasAnsi(children) ? <AnsiText text={children} /> : children}</code>
          </pre>
        </div>
      );
    },
  }), [colors]);

  // Check if content exceeds max lines after render.
  // 使用 useLayoutEffect 在浏览器绘制前完成测量并折叠，避免长消息先显示完整高度、
  // 再在 effect 中折叠的“发送后再折叠”闪烁。
  useLayoutEffect(() => {
    if (contentRef.current) {
      const lineHeight = parseFloat(getComputedStyle(contentRef.current).lineHeight || '20');
      const height = contentRef.current.scrollHeight;
      setIsTruncated(height > lineHeight * 15);
    }
  }, [message.content, message.isFromAgent]);

  // memo 化 ReactMarkdown：content 未变化时跳过重复解析（例如流式结束帧、
  // isStreaming/status 等字段变化触发的重渲染），只有内容或主题色变化时才重新解析。
  const userMarkdownElement = useMemo(() => {
    if (!message.isFromAgent) return null;
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={userMarkdownComponents}
      >
        {escapeNumericTildeInMarkdown(message.content)}
      </ReactMarkdown>
    );
  }, [message.content, message.isFromAgent, userMarkdownComponents]);

  const handleToggleExpand = useCallback(() => {
    const next = !expanded;
    onExpandToggle?.(next);
    setExpanded(next);
  }, [expanded, onExpandToggle]);

  if (message.isCompactSummary) {
    const compactContent = message.content || '';
    return (
      <div
        className="w-full px-3 py-2 text-left rounded-lg"
        style={{
          backgroundColor: colors.bgSecondary,
          border: `1px dashed ${colors.border}`,
        }}
      >
        <div
          className="flex items-center gap-1 text-[12px] mb-1.5 pb-1 border-b"
          style={{ borderColor: colors.border, color: colors.textSystem, fontWeight: 600, fontStyle: 'italic' }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h4.586a1.5 1.5 0 0 1 1.06.44l3.414 3.414A1.5 1.5 0 0 1 13 5.914V13.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 13.5V2.5Z" />
          </svg>
          <span>{t('messagesView.compactSummary')}</span>
        </div>
        <p
          className="whitespace-pre-wrap text-[13px] leading-relaxed"
          style={{ color: colors.textSecondary, overflowWrap: 'break-word', wordBreak: 'break-word' }}
        >
          {compactContent}
        </p>
      </div>
    );
  }

  const userBg = isDark ? 'transparent' : '#fafafa';
  return (
    <div
      className="w-full px-2 py-1.5 text-left rounded-lg"
      style={{
        backgroundColor: userBg,
        color: colors.textPrimary,
        border: `1px solid ${colors.border}`,
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
      }}
    >
      {displayParam && (
        <>
          {isFromMessage ? (
            <div
              className="flex items-center gap-1 text-[11px] mb-0.5 pb-0.5 border-b cursor-pointer"
              style={{ borderColor: colors.border, fontWeight: 500 }}
              onClick={handleAgentClick}
              title={t('messagesView.openConversation', { id: agentSessionId ?? '' })}
            >
              <span style={{ color: colors.textSystem }}>From: </span>
              <span style={{ color: colors.harness, textDecoration: 'underline', textDecorationStyle: 'dotted' }}>
                {metaParam!.startsWith('#')
                  ? `#${agentSessionId?.slice(-8)}...`
                  : (() => {
                    // 格式: host:workspace (username):agentId, 展示为 host:workspace (username)
                    const withoutAgentId = metaParam!.split(':').slice(0, 2).join(':');
                    return agentUserName ? `${withoutAgentId} (${agentUserName})` : metaParam!;
                  })()}
              </span>
            </div>
          ) : isToMessage ? (
            <div
              className="flex items-center gap-1 text-[11px] mb-0.5 pb-0.5 border-b"
              style={{ borderColor: colors.border, color: colors.textSystem, fontWeight: 500 }}
            >
              <span>{metaParam}</span>
            </div>
          ) : isFileMessage ? (
            <div
              className="flex items-center gap-1 text-[12px] mb-0.5 pb-0.5 border-b cursor-pointer hover:underline"
              style={{ borderColor: colors.border, color: colors.textSystem, fontWeight: 500 }}
              onClick={handleFileClick}
            >
              <File size={10} />
              <span>{fileDisplayText}</span>
            </div>
          ) : displayParam ? (
            <div
              className="flex items-center gap-1 text-[11px] mb-0.5 pb-0.5 border-b"
              style={{ borderColor: colors.border, color: colors.textSystem, fontWeight: 500 }}
            >
              <span>{displayParam}</span>
            </div>
          ) : null}
        </>
      )}
      <div
        ref={contentRef}
        onClick={(!expanded && isTruncated) ? handleToggleExpand : undefined}
        style={{
          overflow: 'hidden',
          maxHeight: (!expanded && isTruncated) ? 180 : 'none',
          cursor: (!expanded && isTruncated) ? 'pointer' : undefined,
        }}
        title={(!expanded && isTruncated) ? t('messagesView.clickShowFullContent') : undefined}
      >
        {message.isFromAgent ? (
          <div className="markdown-body text-[13px] leading-snug" style={{ lineHeight: '1.4' }}>
            {userMarkdownElement}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{message.content}</p>
        )}
      </div>
      {/* 折叠遮罩 — 仅当未展开且被截断时显示 */}
      {isTruncated && !expanded && (
        <div
          style={{
            position: 'relative',
            marginTop: '-50px',
            height: 50,
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${isDark ? '#1e1e1e' : '#ffffff'})`,
            marginBottom: 4,
          }}
        />
      )}
      {isTruncated && !expanded && (
        <div
          className="flex items-center gap-1 mt-1 text-[11px] cursor-pointer hover:underline"
          onClick={handleToggleExpand}
          style={{ color: colors.textSystem, opacity: 0.7 }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3a.5.5 0 0 1 .5.5v4h4a.5.5 0 0 1 0 1h-4v4a.5.5 0 0 1-1 0v-4h-4a.5.5 0 0 1 0-1h4v-4A.5.5 0 0 1 8 3z" />
          </svg>
          <span>{t('messagesView.showFullContent')}</span>
        </div>
      )}
      {isTruncated && expanded && (
        <div
          className="flex items-center gap-1 mt-1 text-[11px] cursor-pointer hover:underline"
          onClick={handleToggleExpand}
          style={{ color: colors.textSystem, opacity: 0.7 }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 8a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8z" />
          </svg>
          <span>{t('messagesView.collapse')}</span>
        </div>
      )}
    </div>
  );
}, areEqual);

/* ------------------------------------------------------------------ */
/*  Thinking message sub-component                                     */
/* ------------------------------------------------------------------ */
const ThinkingMessage = memo(function ThinkingMessage({
  message,
  colors,
  onThinkingToggle,
}: {
  message: Message;
  colors: Colors;
  /** 用户手动展开/折叠 thinking 时调用，用于通知外层停止/恢复自动滚动 */
  onThinkingToggle?: (isOpen: boolean) => void;
}) {
  // 流式过程中默认收起；用户手动展开后保持展开。
  // 始终用 userExpanded 控制 open，避免流式结束时 React 移除 open 属性导致自动折叠。
  const [userExpanded, setUserExpanded] = useState(false);

  const isOpen = userExpanded;

  return (
    <details
      className="text-[13px] group"
      style={{ color: colors.textSystem }}
      open={isOpen}
      onToggle={(e) => {
        // 用户手动展开时记录
        if ((e.target as HTMLDetailsElement).open) {
          setUserExpanded(true);
        } else {
          setUserExpanded(false);
        }
      }}
    >
      <summary
        className="cursor-pointer list-none flex items-center"
        style={{ minHeight: '32px', marginTop: '-3.5px' }}
        onClick={(e) => {
          // 在默认 toggle 行为前告诉外层：展开时暂停自动滚动，收起时由外层根据底部状态恢复
          const details = e.currentTarget.closest('details');
          const nextOpen = details ? !details.open : !message.isStreaming;
          onThinkingToggle?.(nextOpen);
        }}
      >
        <span>thinking</span>
        <ChevronRight size={13} className="ml-1 transition-transform group-open:rotate-90" style={{ color: colors.textSystem, flexShrink: 0 }} />
      </summary>
      <div
        className="pl-5 whitespace-pre-wrap mt-1"
        style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}
      >
        {message.content}
      </div>
    </details>
  );
}, areEqual);

/* ------------------------------------------------------------------ */
/*  System message sub-component                                       */
/* ------------------------------------------------------------------ */
const SystemMessage = memo(function SystemMessage({
  message,
  colors,
}: {
  message: Message;
  colors: Colors;
}) {
  return (
    <div
      className="max-w-full text-left flex items-center"
      style={{ minHeight: '32px', overflowWrap: 'break-word', wordBreak: 'break-word' }}
    >
      <Info size={12} style={{ color: colors.textSystem, flexShrink: 0 }} />
      <p className="text-[13px] italic font-semibold ml-2" style={{ color: colors.textSystem, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        {message.content}
      </p>
    </div>
  );
}, areEqual);

/* ------------------------------------------------------------------ */
/*  CodeBlock — fenced code block with a copy button                  */
/* ------------------------------------------------------------------ */
const CodeBlock = memo(function CodeBlock({
  children,
  className,
  colors,
}: {
  children: React.ReactNode;
  className?: string;
  colors: Colors;
}) {
  const [copied, setCopied] = useState(false);
  const isMermaid = className === 'language-mermaid';

  const codeText = useMemo(() => {
    if (typeof children === 'string') return children;
    if (React.isValidElement(children)) {
      const nested = children.props?.children;
      return typeof nested === 'string' ? nested : '';
    }
    return '';
  }, [children]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [codeText]);

  const handlePreview = useCallback(() => {
    postMessage({
      type: 'openMermaidPreview' as any,
      code: codeText,
    });
  }, [codeText]);

  return (
    <div className="relative group my-2 rounded-lg overflow-hidden" style={{ backgroundColor: colors.bgSecondary }}>
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isMermaid && (
          <button
            onClick={handlePreview}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
            style={{
              backgroundColor: colors.bgSecondary,
              border: `1px solid ${colors.border}`,
              color: colors.textSystem,
            }}
            title={t('messagesView.previewChart')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3C4.5 3 1.5 8 1.5 8C1.5 8 4.5 13 8 13C11.5 13 14.5 8 14.5 8C14.5 8 11.5 3 8 3Z" />
              <circle cx="8" cy="8" r="2.5" />
            </svg>
            <span>{t('messagesView.preview')}</span>
          </button>
        )}
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
          style={{
            backgroundColor: colors.bgSecondary,
            border: `1px solid ${colors.border}`,
            color: copied ? colors.harness : colors.textSystem,
          }}
          title={t('messagesView.copyCode')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? t('messagesView.copied') : t('messagesView.copy')}</span>
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-tight" style={{ margin: 0, backgroundColor: 'transparent' }}>
        <code className={className} style={{ backgroundColor: 'transparent' }}>
          {hasAnsi(codeText) ? <AnsiText text={codeText} /> : children}
        </code>
      </pre>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  MermaidBlock — 降级为代码块显示（带预览按钮）                      */
/* ------------------------------------------------------------------ */
const MermaidBlock = memo(function MermaidBlock({
  children,
  colors,
}: {
  children: React.ReactNode;
  colors: Colors;
}) {
  return <CodeBlock className="language-mermaid" colors={colors}>{children}</CodeBlock>;
});

/* ------------------------------------------------------------------ */
/*  Assistant / default message sub-component                          */
/* ------------------------------------------------------------------ */
const AssistantMessage = memo(function AssistantMessage({
  message,
  colors,
}: {
  message: Message;
  colors: Colors;
}) {
  const markdownComponents = useMemo(() => ({
    p: ({ children }: any) => <p className="mb-1 last:mb-0" style={{ color: colors.textPrimary }}>{children}</p>,
    code: ({ children, className }: any) => {
      const isInline = !className;
      if (!isInline && className === 'language-mermaid') {
        return <MermaidBlock colors={colors}>{children}</MermaidBlock>;
      }
      return isInline ? (
        <InlineCode colors={colors}>{children}</InlineCode>
      ) : (
        <CodeBlock className={className} colors={colors}>{children}</CodeBlock>
      );
    },
    pre: ({ children }: any) => children,
    ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5" style={{ color: colors.textPrimary }}>{children}</ul>,
    ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5" style={{ color: colors.textPrimary }}>{children}</ol>,
    li: ({ children }: any) => <li style={{ color: colors.textPrimary }}>{children}</li>,
    h1: ({ children }: any) => <h1 className="text-base font-bold mb-1" style={{ color: colors.textPrimary }}>{children}</h1>,
    h2: ({ children }: any) => <h2 className="text-sm font-bold mb-1" style={{ color: colors.textPrimary }}>{children}</h2>,
    h3: ({ children }: any) => <h3 className="text-xs font-bold mb-1" style={{ color: colors.textPrimary }}>{children}</h3>,
    blockquote: ({ children }: any) => <blockquote className="border-l-2 pl-3 italic mb-1" style={{ borderColor: colors.border, color: colors.textPrimary }}>{children}</blockquote>,
    table: ({ children }: any) => <table className="w-full border-collapse mb-1" style={{ backgroundColor: 'transparent', borderColor: colors.border }}>{children}</table>,
    thead: ({ children }: any) => <thead style={{ backgroundColor: 'transparent' }}>{children}</thead>,
    tbody: ({ children }: any) => <tbody>{children}</tbody>,
    tr: ({ children }: any) => <tr style={{ backgroundColor: 'transparent' }}>{children}</tr>,
    th: ({ children }: any) => <th className="text-left p-1 font-medium text-xs" style={{ backgroundColor: 'transparent', borderColor: colors.border, color: colors.textPrimary, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{children}</th>,
    td: ({ children }: any) => <td className="p-1 text-xs" style={{ backgroundColor: 'transparent', borderColor: colors.border, color: colors.textPrimary, overflowWrap: 'break-word', wordBreak: 'break-word' }}>{children}</td>,
    a: ({ children, href }: any) => <a href={href} className="underline" style={{ color: colors.textSystem }}>{children}</a>,
    strong: ({ children }: any) => <strong className="font-bold" style={{ color: colors.textPrimary }}>{children}</strong>,
    em: ({ children }: any) => <em className="italic" style={{ color: colors.textPrimary }}>{children}</em>,
  }), [colors]);

  const borderStyle = message.hasBorder
    ? {
      border: '2px solid #a78bfa',
      borderRadius: '8px',
      padding: '8px',
    }
    : {};

  // memo 化 ReactMarkdown：content 未变化时跳过重复解析（如流式结束帧、
  // isStreaming 等字段变化触发的重渲染），仅内容或主题色变化时重新解析。
  const markdownElement = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeRaw, rehypeKatex]}
      components={markdownComponents}
    >
      {escapeNumericTildeInMarkdown(message.content)}
    </ReactMarkdown>
  ), [message.content, markdownComponents]);

  // 超大输出被持久化到磁盘时（如 Web Search 后模型输出超长、Bash 输出超限），
  // 直接渲染文件路径 + 预览，不再走 markdown，避免显示原始 <persisted-output> 标签。
  if (message.content && isPersistedOutput(message.content)) {
    return (
      <div
        className="max-w-full text-left"
        style={{
          color: colors.textPrimary,
          paddingTop: '3px',
          ...borderStyle,
        }}
      >
        <PersistedOutputBox content={message.content} colors={colors} />
      </div>
    );
  }

  return (
    <div
      className="max-w-full text-left"
      style={{
        color: colors.textPrimary,
        paddingTop: '3px',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        ...borderStyle,
      }}
    >
      <div className="markdown-body text-[13px] leading-snug">
        {markdownElement}
      </div>
    </div>
  );
}, areEqual);

/* ------------------------------------------------------------------ */
/*  MessageItem — dispatches to the correct sub-component              */
/* ------------------------------------------------------------------ */
const MessageItem = memo(function MessageItem({
  message,
  colors,
  isDark,
  onNavigate,
  onThinkingToggle,
  onExpandToggle,
  onBeforePreviewRender,
}: {
  message: Message;
  colors: Colors;
  isDark: boolean;
  onNavigate?: (sessionId: string) => void;
  onThinkingToggle?: (isOpen: boolean) => void;
  onExpandToggle?: (isOpen: boolean) => void;
  onBeforePreviewRender?: () => void;
}) {
  if (message.role === 'toolcall') {
    return <ToolCallMessage message={message} colors={colors} isDark={isDark} onNavigate={onNavigate} onExpandToggle={onExpandToggle} onBeforePreviewRender={onBeforePreviewRender} />;
  }
  if (message.role === 'user') {
    return <UserMessage message={message} colors={colors} isDark={isDark} onExpandToggle={onExpandToggle} />;
  }
  if (message.role === 'thinking') {
    return <ThinkingMessage message={message} colors={colors} onThinkingToggle={onThinkingToggle} />;
  }
  if (message.role === 'system') {
    return <SystemMessage message={message} colors={colors} />;
  }
  // assistant or other
  return <AssistantMessage message={message} colors={colors} />;
}, areEqual);

/**
 * Combined auto-scroll strategy:
 *
 * 1. CSS overflow-anchor: auto on the container keeps the scroller pinned
 *    at the bottom by default — the browser handles anchoring natively.
 *
 * 2. Wheel 事件一旦出现（向上滚动，或当前已不在底部）就立刻标记
 *    userScrolledAway，不等 scroll 事件越过阈值；JS scroll listener 仍用
 *    **distance threshold** 作为辅助，检测其他输入（触摸/键盘/滚动条）造成的
 *    scroll-away。2 px fudge 帮助避免布局抖动或 momentum 滚动舍入造成的误判。
 *
 * 3. ResizeObserver on container children provides a **fallback** for cases
 *    where CSS overflow-anchor alone is insufficient (e.g. multi-frame
 *    layout shifts, todo lists, thinking + tool use rendering together).
 *
 * 4. useMessageHandler 会在 Bash/Write/Edit 等 preview 渲染前先把容器预滚到底部
 *    （scrollToBottomBeforeRender），保证“先滚动、后渲染”的视觉顺序。
 */
const SCROLL_AWAY_THRESHOLD = 50; // px — distance from bottom to consider "away"

function useAutoScroll(
  containerRef: React.RefObject<HTMLDivElement | null>,
  isStreaming: boolean,
  hasRunningTools: boolean,
  forceScrollKey?: number,
  externalUserScrolledAwayRef?: React.MutableRefObject<boolean>,
) {
  const isAtBottomRef = useRef(true);
  /**
   * Tracks whether the user has intentionally scrolled away from the bottom.
   * Once set to true, auto-scroll is suppressed during streaming
   * until the user scrolls back near the bottom (< threshold) or sends a new message.
   */
  const internalUserScrolledAwayRef = useRef(false);
  const userScrolledAwayRef = externalUserScrolledAwayRef ?? internalUserScrolledAwayRef;

  /** Force-scroll to bottom. Called by ResizeObserver and useLayoutEffect. */
  /** Ref to prevent duplicate rAF scroll-sync when called multiple times per frame */
  const scrollSyncRafRef = useRef<number | null>(null);
  /**
   * 标记当前是否有一个由 scrollToBottom 发起的 rAF 二次同步尚未执行。
   * 在这段极短窗口内，浏览器可能因为 overflow-anchor / 布局调整而产生滚动事件，
   * 这些事件不能被误判为用户主动滚走，否则首次自动滚底会被自身抑制。
   */
  const programmaticScrollPendingRef = useRef(false);
  /**
   * 最近一次用户滚动输入（wheel/touch/keyboard/pointer）的时间。
   * 用于在 force-scroll 轮询期间区分“用户真的滚走了”和“浏览器布局/overflow-anchor
   * 造成的伪滚动离开”，避免首次打开对话时自动滚底被误判抑制。
   */
  const lastUserScrollInputRef = useRef(0);

  const scrollToBottom = useCallback((force = false) => {
    const container = containerRef.current;
    if (!container) {
      profileLog(`[AutoScroll] scrollToBottom force=${force} SKIP container=null`);
      return;
    }
    const beforeTop = container.scrollTop;
    const beforeHeight = container.scrollHeight;
    const beforeClient = container.clientHeight;
    profileLog(`[AutoScroll] scrollToBottom force=${force} userScrolledAway=${userScrolledAwayRef.current} before=${beforeTop}/${beforeHeight}/${beforeClient}`);
    container.scrollTop = container.scrollHeight;
    profileLog(`[AutoScroll] scrollToBottom force=${force} after=${container.scrollTop}/${container.scrollHeight}/${container.clientHeight} distance=${(container.scrollHeight - container.scrollTop - container.clientHeight).toFixed(1)}`);
    // 只有强制滚动（加载历史/新用户消息/forceScrollKey）才需要屏蔽 rAF 等待期间
    // 由 overflow-anchor/布局调整产生的“伪滚动离开”。普通流式跟随滚动如果也屏蔽，
    // 会让用户在高频渲染时难以主动向上滚动。
    if (force) {
      programmaticScrollPendingRef.current = true;
    }
    // 使用 requestAnimationFrame 再同步一次 scrollTop，抵御 overflow-anchor
    // 对 scrollTop 的干扰。overflow-anchor 在布局阶段可能会覆盖 JS 设置的
    // scrollTop（概率性出现），导致 diff 展开后滚动不到底。
    if (scrollSyncRafRef.current === null) {
      scrollSyncRafRef.current = requestAnimationFrame(() => {
        scrollSyncRafRef.current = null;
        programmaticScrollPendingRef.current = false;
        const c = containerRef.current;
        // 二次同步前必须再次确认用户没有主动滚走，避免 rAF 回调把用户
        // 已经向上滚动的位置强行拉回底部。
        const willSync = !!c && !userScrolledAwayRef.current && c.scrollTop !== c.scrollHeight;
        profileLog(`[AutoScroll] scrollToBottom rAF-sync willSync=${willSync} userScrolledAway=${userScrolledAwayRef.current} before=${c ? `${c.scrollTop}/${c.scrollHeight}/${c.clientHeight}` : 'null'}`);
        if (willSync) {
          c!.scrollTop = c!.scrollHeight;
          profileLog(`[AutoScroll] scrollToBottom rAF-sync after=${c!.scrollTop}/${c!.scrollHeight}/${c!.clientHeight} distance=${(c!.scrollHeight - c!.scrollTop - c!.clientHeight).toFixed(1)}`);
        }
      });
    }
  }, [containerRef, userScrolledAwayRef]);

  // 组件卸载时取消尚未执行的 rAF 二次同步，避免在 StrictMode 或会话切换时
  // 残留的 programmaticScrollPending 状态影响下一次挂载。
  useEffect(() => {
    return () => {
      if (scrollSyncRafRef.current !== null) {
        cancelAnimationFrame(scrollSyncRafRef.current);
        scrollSyncRafRef.current = null;
      }
      programmaticScrollPendingRef.current = false;
    };
  }, []);

  // 记录用户滚动输入时间，供 force-scroll 轮询判断是否真的需要停止跟随。
  // 滚轮事件除了记录时间外，还会立刻标记 userScrolledAway，不等 scroll 事件
  // 越过阈值，避免新节点/流式更新与用户刚开始上滚时互相拉扯。
  useEffect(() => {
    const markUserScrollInput = () => {
      lastUserScrollInputRef.current = performance.now();
    };
    const handleWheel = (event: WheelEvent) => {
      markUserScrollInput();
      const container = containerRef.current;
      if (!container) return;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      // 用户向上滚动（且容器确实可以向上滚动），或当前已经不在底部时，
      // 滚轮输入一律立即停止自动滚动。仍在底部且继续向下滚动时不打断自动跟随。
      const canScrollUp = container.scrollTop > 0;
      if ((event.deltaY < 0 && canScrollUp) || distanceFromBottom > 2) {
        userScrolledAwayRef.current = true;
        profileLog(`[AutoScroll] wheel STOP userScrolledAway=true deltaY=${event.deltaY} distance=${distanceFromBottom.toFixed(1)}`);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.startsWith('Arrow') ||
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === ' '
      ) {
        markUserScrollInput();
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: true });
    window.addEventListener('touchstart', markUserScrollInput, { passive: true });
    window.addEventListener('keydown', handleKeyDown, { passive: true });
    window.addEventListener('pointerdown', markUserScrollInput, { passive: true });
    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('touchstart', markUserScrollInput);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', markUserScrollInput);
    };
  }, [containerRef, userScrolledAwayRef]);

  // ── Scroll listener: distance-threshold based ──────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let lastScrollTop = container.scrollTop;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      isAtBottomRef.current = distanceFromBottom <= 2;

      if (distanceFromBottom <= 2) {
        // At the very bottom — resume auto-scroll
        userScrolledAwayRef.current = false;
      } else if (!programmaticScrollPendingRef.current && distanceFromBottom > SCROLL_AWAY_THRESHOLD && scrollTop < lastScrollTop - 2) {
        // 只有附近存在真实用户滚动输入时，才把“向上滚动”判定为用户主动滚走。
        // overflow-anchor / 布局调整在设置 scrollTop 后也可能产生 scrollTop 回退
        // （概率性出现），这种伪滚动没有对应的 wheel/touch/keyboard/pointerdown
        // 输入，不能把 userScrolledAwayRef 置为 true，否则后续非强制滚动
        // （流式增量、toolMetaData 异步 diff 展开等）会被自身抑制。
        const userRecentlyScrolled = performance.now() - lastUserScrollInputRef.current < 1000;
        if (userRecentlyScrolled) {
          userScrolledAwayRef.current = true;
          profileLog(`[AutoScroll] scroll MARK userScrolledAway=true distance=${distanceFromBottom.toFixed(1)} scrollTop=${scrollTop} lastInputAge=${(performance.now() - lastUserScrollInputRef.current).toFixed(0)}ms`);
        }
      }
      lastScrollTop = scrollTop;
      // Between 2 and threshold: keep previous state (hysteresis prevents flickering)
      profileLog(`[AutoScroll] scroll event scrollTop=${scrollTop}/${scrollHeight} ch=${clientHeight} distance=${distanceFromBottom.toFixed(1)} atBottom=${isAtBottomRef.current} pending=${programmaticScrollPendingRef.current} userScrolledAway=${userScrolledAwayRef.current}`);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // initialize

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  // ── ResizeObserver: fallback for multi-frame content rendering ─────
  // Observes the container itself — when any child content expands/contracts,
  // the container's content box resizes, reliably triggering this observer.
  //
  // Previously only direct children (segment divs) were observed, which could
  // miss resize events when deeply nested content expands asynchronously
  // (e.g. EditFile's diff block appearing via meta loading after toolMetaData
  //  response), because the resize propagation might not reach segment divs
  //  in time when the Timeline wrapper layer handles layout independently.
  //
  // Uses requestAnimationFrame debouncing: rapid resize events (e.g. multi-frame
  // streaming updates, async content loading) are consolidated into a single
  // scroll per animation frame.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let initialSettled = false;
    const initialTimer = setTimeout(() => { initialSettled = true; }, 100);

    const ro = new ResizeObserver(() => {
      profileLog(`[AutoScroll] ResizeObserver fired initialSettled=${initialSettled} userScrolledAway=${userScrolledAwayRef.current} rafPending=${rafId !== null}`);
      if (!initialSettled) return;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      // 内容收缩/展开后若已经处于底部，则恢复自动滚动（与滚动事件逻辑保持一致）。
      if (userScrolledAwayRef.current) {
        if (distanceFromBottom <= 2) {
          userScrolledAwayRef.current = false;
        } else {
          return;
        }
      }
      // Debounce: only schedule one rAF callback per frame
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!userScrolledAwayRef.current) {
          scrollToBottom();
        }
      });
    });

    // Observe the container itself (not just direct children) to reliably
    // capture all descendant size changes (e.g. EditFile diff block appearing)
    ro.observe(container);

    return () => {
      clearTimeout(initialTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [containerRef, scrollToBottom]);

  // ── scrollHeight polling: active during streaming OR running tools, handles
  // cases where content grows without changing the container or child box size
  // (e.g. Bash tool output appending results after the initial command block).
  // During idle periods, ResizeObserver is sufficient.
  useEffect(() => {
    if (!isStreaming && !hasRunningTools) return;
    const container = containerRef.current;
    if (!container) return;

    let prevScrollHeight = container.scrollHeight;
    let rafId: number | null = null;
    let stopped = false;

    profileLog(`[AutoScroll] streaming/running poll START isStreaming=${isStreaming} hasRunningTools=${hasRunningTools} scrollHeight=${prevScrollHeight}`);

    const check = () => {
      if (stopped || !container) return;
      const sh = container.scrollHeight;
      // 展开 thinking 时可能还没有产生可滚动区域，此时用户仍处于“底部”，
      // 不能因为 thinking 展开就把 userScrolledAway 一直锁死。每次轮询都检查
      // 实际距离，到底部就恢复自动滚动，避免首次内容撑满视口后仍然无法跟随。
      const distanceFromBottom = sh - container.scrollTop - container.clientHeight;
      if (distanceFromBottom <= 2) {
        userScrolledAwayRef.current = false;
      }
      if (sh !== prevScrollHeight && !userScrolledAwayRef.current) {
        profileLog(`[AutoScroll] poll scrollHeight ${prevScrollHeight}->${sh}`);
        prevScrollHeight = sh;
        // 使用 scrollToBottom 统一滚动路径：除了设置 scrollTop，还会在
        // 下一帧二次同步，抵御 overflow-anchor 对 scrollTop 的覆盖。
        scrollToBottom();
      }
      rafId = requestAnimationFrame(check);
    };

    rafId = requestAnimationFrame(check);

    return () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [isStreaming, hasRunningTools, containerRef, scrollToBottom]);

  // ── settle polling: 在 force-scroll（如加载历史对话）后短暂轮询 scrollHeight ──
  // 加载历史对话时大量内容是异步渲染的（EditFile 的 diff 块需等待 toolMetaData
  // 响应、Shiki 代码高亮、图片等），它们会在初始 scrollToBottom 之后才使
  // scrollHeight 增长。滚动容器是固定高度（flex-1 overflow-y-auto），子内容增长
  // 不会改变容器自身 content box，因此 ResizeObserver 观察容器不会触发（实测）。
  // 这里在 forceScrollKey 变化后主动轮询，直到高度稳定或超时，确保最终滚到底部。
  useEffect(() => {
    if (forceScrollKey === undefined) return;
    const container = containerRef.current;
    if (!container) return;

    let prevScrollHeight = container.scrollHeight;
    let rafId: number | null = null;
    let lastChangeTime = performance.now();
    const startTime = lastChangeTime;
    const MAX_DURATION = 2000; // ms，最长轮询窗口
    const SETTLE_MS = 250; // ms，连续无变化即视为稳定

    profileLog(`[AutoScroll] settle poll START forceScrollKey=${forceScrollKey} scrollHeight=${prevScrollHeight}`);

    const check = () => {
      rafId = null;
      if (!container) return;
      const sh = container.scrollHeight;
      const now = performance.now();
      if (sh !== prevScrollHeight) {
        profileLog(`[AutoScroll] settle poll scrollHeight ${prevScrollHeight}->${sh} userScrolledAway=${userScrolledAwayRef.current} inputAge=${(now - lastUserScrollInputRef.current).toFixed(0)}ms`);
        prevScrollHeight = sh;
        lastChangeTime = now;
        // 用户在轮询期间主动滚动后停止跟随；但 userScrolledAway 也可能是浏览器
        // 布局/overflow-anchor 造成的伪状态，此时附近没有用户滚动输入，应继续强制滚底。
        const userRecentlyScrolled = now - lastUserScrollInputRef.current < 1000;
        if (!userScrolledAwayRef.current || !userRecentlyScrolled) {
          scrollToBottom(true);
        }
      }
      if (now - lastChangeTime > SETTLE_MS || now - startTime > MAX_DURATION) {
        profileLog(`[AutoScroll] settle poll END forceScrollKey=${forceScrollKey} stableMs=${(now - lastChangeTime).toFixed(0)}ms elapsed=${(now - startTime).toFixed(0)}ms`);
        return;
      }
      rafId = requestAnimationFrame(check);
    };

    rafId = requestAnimationFrame(check);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [forceScrollKey, containerRef, userScrolledAwayRef, scrollToBottom]);

  return { isAtBottomRef, userScrolledAwayRef, scrollToBottom };
}

interface MessagesViewProps {
  messages: Array<Message>;
  /** 外部滚动容器 ref（用于在消息渲染前预滚动等场景） */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /** 外部共享的用户滚离状态；由 App 传给 useMessageHandler，使渲染前预滚动也遵守该状态 */
  userScrolledAwayRef?: React.MutableRefObject<boolean>;
  /** App 模式（Electron）下正在加载对话：空状态显示 loading 动画替代静态 Logo */
  isLoadingConversation?: boolean;
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  isDark: boolean;
  colors: Colors;
  forceScrollKey?: number;
  /** 流式渲染版本号：每次 streaming content 变化时递增，用于重建 segments 但维持 key 稳定 */
  streamingVersion?: number;
  /** 是否存在压缩归档（显示"展开"按钮） */
  hasCompactArchive?: boolean;
  /** 压缩是否已展开 */
  isCompactExpanded?: boolean;
  /** 展开压缩回调 */
  onExpandCompact?: () => void;
  onNavigate?: (sessionId: string) => void;
}

/**
 * Segment timeline component — rendered inside a Timeline from Ant Design.
 * Uses memo with deep comparison to avoid re-render when messages array
 * reference changes but content is the same.
 */
const SegmentTimeline = memo(function SegmentTimeline({
  segmentIndex,
  isLastSegment,
  nonUserMsgs,
  showThinkingAnimation,
  animationMode,
  colors,
  isDark,
  onNavigate,
  onThinkingToggle,
  onExpandToggle,
  onBeforePreviewRender,
}: {
  segmentIndex: number;
  isLastSegment: boolean;
  nonUserMsgs: Message[];
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  colors: Colors;
  isDark: boolean;
  onNavigate?: (sessionId: string) => void;
  onThinkingToggle?: (isOpen: boolean) => void;
  onExpandToggle?: (isOpen: boolean) => void;
  onBeforePreviewRender?: () => void;
}) {
  const theme = useMemo(() => ({
    token: {
      colorBorder: colors.timelineLine,
      colorText: colors.textPrimary,
      colorSplit: colors.timelineLine,
    },
    components: {
      Timeline: {
        tailWidth: 2,
        dotSize: 10,
      },
      Steps: {
        dotCurrentSize: 10,
      },
    },
  }), [colors.timelineLine, colors.textPrimary]);

  // ── 使用稳定的 ref 缓存 thinkingItem 的 Timeline item 对象 ─────────
  // 核心思路：即使 SegmentTimeline 因为 nonUserMsgs 变化而重新渲染，
  // thinkingItem 的 JSX 元素引用也保持不变，避免 ThinkingAnimation 被卸载/重建。
  // 仅当 showThinkingAnimation / animationMode / isDark / isLastSegment 中任一
  // 真正变化时才用 useEffect 重建缓存。
  const thinkingItemCacheRef = useRef<{
    isLastSegment: boolean;
    showThinkingAnimation: boolean;
    animationMode: 'thinking' | 'compacting';
    isDark: boolean;
    item: any;
  } | null>(null);

  const buildThinkingItem = useCallback(() => {
    if (!isLastSegment) return null;
    return {
      key: 'thinking-animation',
      color: 'transparent' as const,
      dot: (
        <div className="ripple-dot-container" data-hidden={!showThinkingAnimation ? '' : undefined}>
          <div className="ripple-center" style={{
            backgroundColor: isDark ? 'rgba(167, 139, 250, 0.9)' : 'rgba(99, 102, 241, 0.8)',
          }} />
          <div className="ripple-ring" style={{
            borderColor: isDark ? 'rgba(167, 139, 250, 0.7)' : 'rgba(99, 102, 241, 0.6)',
          }} />
          <div className="ripple-ring" style={{
            borderColor: isDark ? 'rgba(167, 139, 250, 0.7)' : 'rgba(99, 102, 241, 0.6)',
          }} />
          <div className="ripple-ring" style={{
            borderColor: isDark ? 'rgba(167, 139, 250, 0.7)' : 'rgba(99, 102, 241, 0.6)',
          }} />
        </div>
      ),
      children: (
        <div className="thinking-animation-wrapper" data-hidden={!showThinkingAnimation ? '' : undefined}>
          <ThinkingAnimation isVisible={showThinkingAnimation} isDark={isDark} mode={animationMode} />
        </div>
      ),
    };
  }, [isLastSegment, showThinkingAnimation, animationMode, isDark]);

  // 校验缓存是否过期，过期则重建
  const cached = thinkingItemCacheRef.current;
  const cacheValid = cached !== null
    && cached.isLastSegment === isLastSegment
    && cached.showThinkingAnimation === showThinkingAnimation
    && cached.animationMode === animationMode
    && cached.isDark === isDark;

  if (!cacheValid) {
    thinkingItemCacheRef.current = {
      isLastSegment,
      showThinkingAnimation,
      animationMode,
      isDark,
      item: buildThinkingItem(),
    };
  }

  const currentThinkingItem = thinkingItemCacheRef.current!.item;

  // Cache timeline items in stable references, only update when corresponding message changes
  const timelineItems = useMemo(() => {
    return nonUserMsgs.map((message, msgIndex) => {
      const statusColor = message.status === 'success'
        ? colors.timelineStatusSuccess
        : message.status === 'running'
          ? colors.timelineStatusRunning
          : message.status === 'fail'
            ? colors.timelineStatusFail
            : colors.timelineStatusNormal;

      return {
        key: message.toolCallId || `msg-${segmentIndex}-${msgIndex}`,
        color: statusColor,
        dot: message.role === 'toolcall' && message.status === 'running' ? (
          <div
            className="timeline-running-fan"
            style={{
              backgroundColor: colors.timelineStatusRunning,
              width: 10,
              height: 10,
              borderRadius: '50%',
              '--timeline-running-color': colors.timelineStatusRunning,
              '--timeline-running-shade': isDark ? '#a16207' : '#fde68a',
            } as React.CSSProperties}
          />
        ) : (
          <div style={{ backgroundColor: statusColor, width: 10, height: 10, borderRadius: '50%' }} />
        ),
        children: <MessageItem message={message} colors={colors} isDark={isDark} onNavigate={onNavigate} onThinkingToggle={onThinkingToggle} onExpandToggle={onExpandToggle} onBeforePreviewRender={onBeforePreviewRender} />,
      };
    });
  }, [nonUserMsgs, colors, isDark, segmentIndex]);

  // ── 缓存 allItems 的数组引用，仅当 timelineItems 或 thinkingItem 引用变化时才重建 ──
  // 避免每帧创建新数组引用导致 AntD Timeline 重渲染所有子节点
  const allItemsRef = useRef<any[] | null>(null);
  const prevTimelineItemsRef = useRef<readonly any[] | null>(null);
  const prevThinkingItemRef = useRef<any>(null);

  if (timelineItems !== prevTimelineItemsRef.current || currentThinkingItem !== prevThinkingItemRef.current) {
    prevTimelineItemsRef.current = timelineItems;
    prevThinkingItemRef.current = currentThinkingItem;
    allItemsRef.current = currentThinkingItem
      ? [...timelineItems, currentThinkingItem]
      : (timelineItems as any[]);
  }
  const allItems = allItemsRef.current;

  const hasThinkingItem = isLastSegment;

  const wrapperClassName = [
    !isLastSegment ? 'segment-timeline-continues' : '',
    hasThinkingItem && !showThinkingAnimation ? 'thinking-hidden' : '',
  ].filter(Boolean).join(' ') || undefined;

  return (
    <ConfigProvider theme={theme}>
      <div
        className={wrapperClassName}
        style={{ '--timeline-rail-color': colors.timelineLine } as React.CSSProperties}
      >
        <Timeline items={allItems ?? []} style={{ marginTop: '8px' }} />
      </div>
    </ConfigProvider>
  );
}, areSegmentTimelineEqual);

const MessagesView = memo(({
  messages,
  containerRef: containerRefProp,
  userScrolledAwayRef: userScrolledAwayRefProp,
  isLoadingConversation,
  showThinkingAnimation,
  animationMode,
  isDark,
  colors,
  forceScrollKey,
  streamingVersion,
  hasCompactArchive,
  isCompactExpanded,
  onExpandCompact,
  onNavigate,
}: MessagesViewProps) => {
  const fallbackContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = containerRefProp ?? fallbackContainerRef;

  // 对话加载遮罩的本地淡出状态。
  // conversationLoaded 会一次性把 messages 设为新内容并关闭 isLoadingConversation，
  // 如果直接卸载 Loading 组件，长对话首次渲染/自动滚动造成的布局抖动会暴露出来。
  // 这里在 loading 结束后继续保留遮罩，轮询 scrollHeight 直到异步内容
  // （EditFile diff meta、Shiki 高亮、图片等）基本稳定后再淡出。
  const [loadingVisible, setLoadingVisible] = useState(!!isLoadingConversation);
  const [loadingFading, setLoadingFading] = useState(false);
  const loadingSettleRafRef = useRef<number | null>(null);
  const loadingFadeTimerRef = useRef<number | null>(null);

  // 会话加载后可能仍有实时流/运行中工具（例如切换到一个正在 AI 回复的对话）。
  // 这类对话内容本来就会持续增长，不能一直等 scrollHeight 完全稳定，
  // 否则遮罩会挡住新内容太久；实时场景使用更短的等待上限。
  const hasLiveActivity = showThinkingAnimation
    || messages.some(m => m.isStreaming)
    || messages.some(m => m.role === 'toolcall' && m.status === 'running');

  useEffect(() => {
    const cancelLoadingTimers = () => {
      if (loadingSettleRafRef.current !== null) {
        cancelAnimationFrame(loadingSettleRafRef.current);
        loadingSettleRafRef.current = null;
      }
      if (loadingFadeTimerRef.current !== null) {
        window.clearTimeout(loadingFadeTimerRef.current);
        loadingFadeTimerRef.current = null;
      }
    };

    if (isLoadingConversation) {
      setLoadingVisible(true);
      setLoadingFading(false);
      cancelLoadingTimers();
      return;
    }

    if (!loadingVisible) return;

    const startFade = () => {
      cancelLoadingTimers();
      setLoadingFading(true);
      loadingFadeTimerRef.current = window.setTimeout(() => {
        loadingFadeTimerRef.current = null;
        setLoadingVisible(false);
        setLoadingFading(false);
      }, 220);
    };

    const container = containerRef.current;
    // 空会话没有异步内容会撑高，短暂保持后直接淡出。
    // 非空会话即使当前还没有滚动溢出，也可能因为 EditFile diff meta、图片等
    // 异步渲染而变高，因此统一进入 scrollHeight 稳定轮询。
    if (!container || messages.length === 0) {
      loadingFadeTimerRef.current = window.setTimeout(startFade, 80);
      return cancelLoadingTimers;
    }

    // 内容可滚动：轮询 scrollHeight，等待异步渲染（EditFile diff meta、
    // Shiki 高亮、图片等）把高度稳定下来再淡出，避免“滚动条先撑满再慢慢加载”的跳动。
    // 实时会话（流式/运行中工具）不能等太久，给一个较短上限。
    const MIN_HOLD_MS = hasLiveActivity ? 300 : 600;
    const SETTLE_MS = hasLiveActivity ? 150 : 200;
    const MAX_WAIT_MS = hasLiveActivity ? 1500 : 4000;
    const startedAt = performance.now();
    let prevScrollHeight = container.scrollHeight;
    let lastChange = startedAt;
    let stopped = false;

    const check = () => {
      loadingSettleRafRef.current = null;
      if (stopped) return;
      const c = containerRef.current;
      if (!c) {
        startFade();
        return;
      }
      const now = performance.now();
      const sh = c.scrollHeight;
      if (sh !== prevScrollHeight) {
        profileLog(`[LoadingOverlay] settle scrollHeight ${prevScrollHeight}->${sh}`);
        prevScrollHeight = sh;
        lastChange = now;
      }
      const stableMs = now - lastChange;
      const elapsedMs = now - startedAt;
      if ((elapsedMs >= MIN_HOLD_MS && stableMs >= SETTLE_MS) || elapsedMs >= MAX_WAIT_MS) {
        startFade();
        return;
      }
      loadingSettleRafRef.current = requestAnimationFrame(check);
    };
    loadingSettleRafRef.current = requestAnimationFrame(check);

    return () => {
      stopped = true;
      cancelLoadingTimers();
    };
  }, [isLoadingConversation, loadingVisible, containerRef, hasLiveActivity, messages.length]);

  const showLoadingOverlay = isLoadingConversation || loadingVisible;

  // Derive streaming state: true if any message is currently streaming.
  const isStreaming = useMemo(
    () => messages.some(m => m.isStreaming),
    [messages],
  );

  // Derive running tools state: true if any tool call is still running (e.g. Bash).
  // Used alongside isStreaming to keep rAF polling active during tool execution,
  // so tool output updates (like Bash results) trigger auto-scroll immediately.
  const hasRunningTools = useMemo(
    () => messages.some(m => m.role === 'toolcall' && m.status === 'running'),
    [messages],
  );

  const { userScrolledAwayRef, scrollToBottom } = useAutoScroll(containerRef, isStreaming, hasRunningTools, forceScrollKey, userScrolledAwayRefProp);

  // 用户展开 thinking / Edit diff / Write 预览 / 用户长消息时，
  // 先暂停自动滚动，避免 ResizeObserver 在展开后立刻把视口拉回底部，
  // 导致被展开内容的顶部“向上顶出”视口。
  // 如果展开后仍处于底部（内容很小、还没有可滚动区域），再恢复自动滚动。
  // 收起这些内容时等待布局稳定后再恢复自动滚动：如果收起后已经回到底部则恢复，
  // 否则继续保持“用户已滚走”状态，避免收起瞬间强制跳回底部。
  // 工具组件内部即将渲染大块 preview（Edit diff 等）前调用：
  // 如果用户本来就在底部附近，先预滚到底部，再让内部 setState 触发渲染。
  const handleBeforePreviewRender = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // 用户已滚离底部时，工具 preview 渲染前也不能预滚，避免与用户上滚冲突。
    if (userScrolledAwayRef.current) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= 50) {
      container.scrollTop = container.scrollHeight;
    }
  }, [containerRef, userScrolledAwayRef]);

  const handleContentToggle = useCallback((isOpen: boolean) => {
    const container = containerRef.current;
    const distanceFromBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : Infinity;

    // 展开时：先无条件暂停自动滚动，避免 ResizeObserver 在布局变化后
    // 立刻把视口拉回底部，导致 thinking / diff / 长消息的顶部被向上顶出视口。
    if (isOpen) {
      userScrolledAwayRef.current = true;
      // 如果展开后仍然在底部（例如内容很小、还没有产生可滚动区域），
      // 则恢复自动滚动，避免后续消息无法继续跟随。
      requestAnimationFrame(() => {
        const c = containerRef.current;
        if (!c) return;
        const d = c.scrollHeight - c.scrollTop - c.clientHeight;
        if (d <= 2) {
          userScrolledAwayRef.current = false;
        }
      });
      return;
    }

    // 收起时：若当前不在底部则保持暂停；若本身就在底部则继续自动滚动。
    if (distanceFromBottom > 2) {
      userScrolledAwayRef.current = true;
    } else {
      userScrolledAwayRef.current = false;
    }
    // 收起后布局可能让底部重新进入视口（内容变矮），此时应恢复自动滚动；
    requestAnimationFrame(() => {
      const c = containerRef.current;
      if (!c) return;
      const d = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (d <= 2) {
        userScrolledAwayRef.current = false;
      }
    });
  }, [containerRef, userScrolledAwayRef]);

  /**
   * useLayoutEffect: handles the "structural" scroll triggers that ResizeObserver
   * doesn't cover — new messages appearing, force-scroll events, initial load.
   * Content-size changes (streaming updates) are handled by ResizeObserver.
   */
  const lastMsgRoleRef = useRef<string | undefined>(undefined);
  const prevMsgCountRef = useRef(0);
  const prevForceScrollKeyRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      profileLog(`[AutoScroll] layoutEffect SKIP container=null len=${messages.length}`);
      return;
    }

    const prevCount = prevMsgCountRef.current;
    const lastMsg = messages[messages.length - 1];
    profileLog(`[AutoScroll] layoutEffect len=${messages.length} prevCount=${prevCount} lastRole=${lastMsg?.role} prevRole=${lastMsgRoleRef.current} showThinking=${showThinkingAnimation} animationMode=${animationMode} streamingVer=${streamingVersion} forceKey=${forceScrollKey} prevForceKey=${prevForceScrollKeyRef.current} hasRunningTools=${hasRunningTools} userScrolledAway=${userScrolledAwayRef.current}`);
    if (prevCount === 0 && messages.length > 0) {
      profileLog(`[AutoScroll] FIRST_MESSAGE role=${lastMsg?.role} container=${container.scrollHeight}/${container.clientHeight} scrollTop=${container.scrollTop}`);
    }

    // 空会话（新对话/清空消息）时重置滚动跟踪状态：
    // - prevMsgCountRef 重置为 0，确保第一条消息被判定为新消息；
    // - userScrolledAwayRef 重置为 false，避免上一次会话"用户滚走"的状态
    //   残留，导致新会话首批消息完全无法自动滚动。
    if (messages.length === 0) {
      prevMsgCountRef.current = 0;
      lastMsgRoleRef.current = undefined;
      userScrolledAwayRef.current = false;
      if (!showThinkingAnimation) {
        profileLog('[AutoScroll] layoutEffect empty return (no thinking animation)');
        return;
      }
    }

    // Detect new message appended (length increased)
    const hasNewMessage = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    // Detect new user message (role transition to 'user')
    const isNewUserMessage = lastMsg?.role === 'user' && lastMsgRoleRef.current !== 'user';
    if (lastMsg) {
      lastMsgRoleRef.current = lastMsg.role;
    }

    // forceScrollKey changed → always scroll (external trigger, e.g. "expand compact")
    const forceScrollChanged = forceScrollKey !== undefined && forceScrollKey !== prevForceScrollKeyRef.current;
    prevForceScrollKeyRef.current = forceScrollKey;

    // New user message or external force-scroll → reset scroll-away and scroll
    if (isNewUserMessage || forceScrollChanged) {
      profileLog(`[AutoScroll] layoutEffect branch=user/force hasNew=${hasNewMessage} isNewUser=${isNewUserMessage} forceChanged=${forceScrollChanged}`);
      userScrolledAwayRef.current = false;
      scrollToBottom(true);
      return;
    }

    // User has scrolled away → don't auto-scroll
    if (userScrolledAwayRef.current) {
      profileLog('[AutoScroll] layoutEffect SKIP userScrolledAway=true');
      return;
    }

    // New non-user message appended (tool call, assistant block) → scroll
    if (hasNewMessage) {
      profileLog(`[AutoScroll] layoutEffect branch=new-message lastRole=${lastMsg?.role}`);
      scrollToBottom(true);
      return;
    }

    // Streaming content update, user at bottom → ResizeObserver handles multi-frame
    // updates, but do one synchronous scroll for the first frame.
    profileLog(`[AutoScroll] layoutEffect branch=fallback-scroll hasNew=${hasNewMessage} lastRole=${lastMsg?.role}`);
    scrollToBottom();
  }, [messages.length, forceScrollKey, showThinkingAnimation, animationMode, streamingVersion, hasRunningTools, scrollToBottom, userScrolledAwayRef]);

  // Persistent segments cache
  const segmentsCacheRef = useRef<Array<{ userMsg?: Message; nonUserMsgs: Message[] }>>([]);

  // Cache message grouping results
  const messageGroups = useMemo(() => {
    const _t0 = performance.now();
    if (messages.length === 0) {
      segmentsCacheRef.current = [];
      return { beforeFirstUser: [], segments: [] };
    }

    const firstUserIndex = messages.findIndex((m) => m.role === 'user');
    const beforeFirstUser = messages.slice(0, firstUserIndex >= 0 ? firstUserIndex : 0);
    const fromFirstUser = firstUserIndex >= 0 ? messages.slice(firstUserIndex) : [];

    const newSegments: Array<{ userMsg?: Message; nonUserMsgs: Message[] }> = [];
    for (let i = 0; i < fromFirstUser.length; i++) {
      const message = fromFirstUser[i];
      if (message.role === 'user') {
        newSegments.push({ userMsg: message, nonUserMsgs: [] });
      } else if (newSegments.length > 0) {
        newSegments[newSegments.length - 1].nonUserMsgs.push(message);
      }
    }

    // 过滤 1：如果 segment 中没有 assistant 消息（只有 thinking + toolcall），
    // 则过滤掉 content 为空白的 thinking 消息，避免纯 tool_use 场景出现空白 thinking 节点。
    // 注意：只有 thinking 内容为空时才过滤 —— 有内容的 thinking 即使没有 assistant
    // 文本消息（thinking 后直接接 tool use）也必须正常显示。
    for (const seg of newSegments) {
      const hasAssistant = seg.nonUserMsgs.some(m => m.role === 'assistant');
      const hasToolcall = seg.nonUserMsgs.some(m => m.role === 'toolcall');
      if (!hasAssistant && hasToolcall) {
        seg.nonUserMsgs = seg.nonUserMsgs.filter(m =>
          !(m.role === 'thinking' && (!m.content || !m.content.trim()))
        );
      }
    }
    // 过滤 2：如果 segment 中有 toolcall，过滤掉 content 为空白的 assistant 消息
    for (const seg of newSegments) {
      const hasToolcall = seg.nonUserMsgs.some(m => m.role === 'toolcall');
      if (hasToolcall) {
        seg.nonUserMsgs = seg.nonUserMsgs.filter(m => !(m.role === 'assistant' && (!m.content || !m.content.trim())));
      }
    }

    // Reuse cached segments
    const cache = segmentsCacheRef.current;
    const merged: typeof newSegments = [];

    for (let i = 0; i < newSegments.length; i++) {
      const newSeg = newSegments[i];
      const cachedSeg = cache[i];

      if (cachedSeg && cachedSeg.userMsg === newSeg.userMsg) {
        const cachedMsgs = cachedSeg.nonUserMsgs;
        const newMsgs = newSeg.nonUserMsgs;
        if (cachedMsgs.length === newMsgs.length && cachedMsgs.every((m, idx) => m === newMsgs[idx])) {
          merged.push(cachedSeg);
        } else {
          const preserved: Message[] = [];
          for (let j = 0; j < newMsgs.length; j++) {
            if (j < cachedMsgs.length && cachedMsgs[j] === newMsgs[j]) {
              preserved.push(cachedMsgs[j]);
            } else {
              preserved.push(newMsgs[j]);
            }
          }
          merged.push({ userMsg: newSeg.userMsg, nonUserMsgs: preserved });
        }
      } else {
        merged.push(newSeg);
      }
    }

    segmentsCacheRef.current = merged;
    const _t1 = performance.now();
    if (_t1 - _t0 > 5) {
      profileLog(`[Profile] messageGroups分组 | 耗时=${(_t1 - _t0).toFixed(2)}ms | 消息数=${messages.length} | segments=${merged.length}`);
    }
    return { beforeFirstUser, segments: merged };
  }, [messages, streamingVersion]);

  const { beforeFirstUser, segments } = messageGroups;
  const hasBeforeFirstUser = beforeFirstUser.length > 0;
  const isEmpty = messages.length === 0;
  // 已禁用 content-visibility 离屏布局优化：它在滚动/渲染过程中会导致布局跳动，
  // 对长对话的稳定性影响大于性能收益。

  // 单次 commit 耗时监测：大消息量时输出超过阈值的渲染耗时（仅调试模式）。
  // 组件 body 末尾打点 → passive effect 里差值 ≈ render + commit 耗时，
  // 用于定位新增工具消息 / 流式更新时的长任务。
  const commitStartRef = useRef(performance.now());
  commitStartRef.current = performance.now();
  useEffect(() => {
    if (messages.length <= 50) return;
    const commitMs = performance.now() - commitStartRef.current;
    if (commitMs > 50) {
      profileLog(`[Profile] MessagesView commit | 耗时=${commitMs.toFixed(1)}ms | 消息数=${messages.length} | segments=${segments.length}`);
    }
  });

  // 渲染完成后帧率监测：定位大量 DOM 节点导致的浏览器布局阻塞问题
  useEffect(() => {
    if (messages.length <= 50) return;
    let frameCount = 0;
    let lastLog = performance.now();
    let rafId: number;
    const measure = () => {
      frameCount++;
      const now = performance.now();
      const elapsed = now - lastLog;
      if (elapsed >= 3000) {
        const fps = ((frameCount / elapsed) * 1000).toFixed(1);
        profileLog(`[Profile] 渲染后帧率监测 | ${frameCount}帧/${(elapsed / 1000).toFixed(1)}s = ${fps}fps | 已渲染=${messages.length}条`);
        frameCount = 0;
        lastLog = now;
        if (parseFloat(fps) > 30) return; // 恢复正常，停止监测
      }
      rafId = requestAnimationFrame(measure);
    };
    rafId = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(rafId);
  }, [messages.length]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 滚动容器始终使用 overflow-y-scroll，不随 loading 遮罩切换 overflow。
          这样 scrollbar-gutter: stable 在整个加载过程中始终按同一滚动盒计算，
          遮罩淡出时不会因为 overflow: hidden -> scroll 的切换产生宽度/高度重排。 */}
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 px-4 py-4 overflow-y-scroll ${isEmpty ? 'messages-container-empty' : 'messages-container'}${showLoadingOverlay ? ' loading-scrollbar-hidden' : ''}`}
        style={isEmpty ? undefined : { display: 'flex', flexDirection: 'column' }}
      >
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center h-full gap-3">
          <img
            src={getLogoUri()}
            alt="logo"
            className={LOGO_CLASS_NAME}
          />
        </div>
      ) : (
        <>
          {/* beforeFirstUser always at top */}
          {hasBeforeFirstUser && (
            <div key="before-first-user">
              {beforeFirstUser.map((message, index) => (
                <div key={`before-${index}`} className="mb-4">
                  <MessageItem message={message} colors={colors} isDark={isDark} onThinkingToggle={handleContentToggle} onExpandToggle={handleContentToggle} onBeforePreviewRender={handleBeforePreviewRender} />
                </div>
              ))}
            </div>
          )}

          {/* Expand compact button */}
          {hasCompactArchive && !isCompactExpanded && onExpandCompact && (
            <div key="expand-compact" className="mb-4 flex justify-center">
              <button
                onClick={() => {
                  handleContentToggle(true);
                  onExpandCompact?.();
                }}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 hover:scale-105 active:scale-95"
                style={{
                  backgroundColor: colors.harness + '18',
                  border: `1px dashed ${colors.harness}`,
                  color: colors.harness,
                  cursor: 'pointer',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 1L1 8L7 15" />
                  <path d="M15 1L9 8L15 15" />
                </svg>
                <span>{t('messagesView.expandCompactHistory')}</span>
              </button>
            </div>
          )}

          {/* All segments in order (old on top, new at bottom) */}
          {segments.map((segment, index) => {
            const isLastSegment = index === segments.length - 1;

            // 首次渲染时记录第一个和最后一个 segment 的渲染时间
            if (index === 0 || index === segments.length - 1) {
              const _t_segLogKey = `seg-${index}`;
              if (!window.__segLogged?.has(_t_segLogKey)) {
                if (!window.__segLogged) window.__segLogged = new Set();
                window.__segLogged.add(_t_segLogKey);
                const _t_now = performance.now();
                profileLog(`[Profile] segment渲染 | index=${index}/${segments.length - 1} | userMsg=${!!segment.userMsg} | nonUserMsgs=${segment.nonUserMsgs.length} | t=${_t_now.toFixed(2)}ms`);
              }
            }

            return (
              <div
                key={`segment-${index}`}
                className="mb-4"
              >
                {segment.userMsg && (
                  <div>
                    <MessageItem message={segment.userMsg} colors={colors} isDark={isDark} />
                  </div>
                )}

                {(segment.nonUserMsgs.length > 0 || isLastSegment) && (
                  <SegmentTimeline
                    segmentIndex={index}
                    isLastSegment={isLastSegment}
                    nonUserMsgs={segment.nonUserMsgs}
                    showThinkingAnimation={showThinkingAnimation}
                    animationMode={animationMode}
                    colors={colors}
                    isDark={isDark}
                    onNavigate={onNavigate}
                    onThinkingToggle={handleContentToggle}
                    onExpandToggle={handleContentToggle}
                    onBeforePreviewRender={handleBeforePreviewRender}
                  />
                )}
              </div>
            );
          })}
        </>
      )}
      </div>
      {showLoadingOverlay && (
        <div
          className={`conversation-loading-overlay${loadingFading ? ' conversation-loading-overlay-fading' : ''}`}
          aria-hidden={loadingFading || undefined}
        >
          <ConversationLoading colors={colors} isDark={isDark} />
        </div>
      )}
    </div>
  );
});

MessagesView.displayName = 'MessagesView';

export default MessagesView;
