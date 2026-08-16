import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import { ToolCallProps } from './Types';
import { type Highlighter } from 'shiki';
import { getHighlighter } from './highlighter';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';

export const WriteFile: React.FC<ToolCallProps> = ({ args, colors, status, isDark, toolCallId, onExpandToggle }) => {
  const filePath = args?.file_path || args?.path;
  const contentPreview = args?.contentPreview;
  const totalLines = args?.totalLines || 0;
  const beforeContent = args?.beforeContent as string | undefined;
  const [isExpanded, setIsExpanded] = useState(true);
  const [highlightedCode, setHighlightedCode] = useState<string>('');
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  // ─── 回滚状态 ────────────────────────────────────────────────────
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
  const [rollbackDirection, setRollbackDirection] = useState<'before' | 'after'>('before');
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; message: string } | null>(null);

  // 监听 rollbackEditResult 消息
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'rollbackEditResult') {
        setShowRollbackConfirm(false);
        setRollbackResult({ success: msg.success, message: msg.message });
        setTimeout(() => setRollbackResult(null), 5000);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleRollbackConfirm = () => {
    const sid = getWindowSessionId();
    if (!sid) {
      setRollbackResult({ success: false, message: t('tool.editFile.noSessionForRollback') });
      setShowRollbackConfirm(false);
      setTimeout(() => setRollbackResult(null), 5000);
      return;
    }
    postMessage({
      type: 'rollbackEdit',
      sessionId: sid,
      toolUseId: toolCallId || '',
      filePath: filePath || '',
      direction: rollbackDirection,
    });
  };

  const handleRollbackCancel = () => {
    setShowRollbackConfirm(false);
  };

  // 初始化 Shiki highlighter（复用全局单例，避免每次创建新的高亮器实例）
  useEffect(() => {
    getHighlighter().then(setHighlighter).catch(() => {});
  }, []);

  // 当 contentPreview 变化时，应用语法高亮
  useEffect(() => {
    if (contentPreview && isExpanded && highlighter) {
      const language = getLanguageFromPath(filePath);
      try {
        const html = highlighter.codeToHtml(contentPreview, {
          lang: language,
          theme: isDark ? 'github-dark' : 'github-light',
        });
        const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        const codeContent = match ? match[1] : contentPreview;
        setHighlightedCode(codeContent);
      } catch {
        setHighlightedCode(contentPreview);
      }
    }
  }, [contentPreview, isExpanded, filePath, highlighter, isDark]);

  if (!filePath) {
    return (
      <ToolHeader icon="File" name="Write" colors={colors}>
        <span style={{ opacity: 0.5, marginLeft: '8px' }}>{t('tool.writeFile.unknownFile')}</span>
      </ToolHeader>
    );
  }

  const handleToggleExpand = () => {
    const next = !isExpanded;
    onExpandToggle?.(next);
    setIsExpanded(next);
  };

  const handleOpenFile = () => {
    postMessage({
      type: 'openFile',
      filePath,
    });
  };

  // 从文件路径获取语言类型
  const getLanguageFromPath = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      'js': 'javascript', 'jsx': 'jsx', 'mjs': 'javascript', 'cjs': 'javascript',
      'ts': 'typescript', 'tsx': 'tsx', 'mts': 'typescript', 'cts': 'typescript',
      'py': 'python', 'pyi': 'python', 'pyw': 'python',
      'java': 'java', 'c': 'c', 'h': 'c', 'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp',
      'hpp': 'cpp', 'hxx': 'cpp', 'cs': 'csharp',
      'go': 'go', 'rs': 'rust',
      'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
      'php': 'php', 'phtml': 'php', 'rb': 'ruby', 'gemfile': 'ruby',
      'swift': 'swift', 'kt': 'kotlin', 'kts': 'kotlin', 'dart': 'dart',
      'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
      'ps1': 'powershell', 'psm1': 'powershell', 'psd1': 'powershell',
      'lua': 'lua', 'pl': 'perl', 'pm': 'perl',
      'json': 'json', 'jsonc': 'jsonc', 'xml': 'xml', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml', 'ini': 'ini', 'cfg': 'ini', 'conf': 'ini',
      'md': 'markdown', 'markdown': 'markdown', 'rst': 'markdown',
      'sql': 'sql', 'tsql': 'tsql',
      'dockerfile': 'dockerfile', 'docker': 'dockerfile', 'makefile': 'makefile', 'cmake': 'cmake', 'mk': 'makefile',
      'scala': 'scala', 'hs': 'haskell', 'lhs': 'haskell', 'clj': 'clojure', 'cljs': 'clojure', 'cljc': 'clojure',
      'ex': 'elixir', 'exs': 'elixir', 'erl': 'erlang', 'hrl': 'erlang',
      'fs': 'fsharp', 'fsi': 'fsharp', 'fsx': 'fsharp', 'ml': 'ocaml', 'mli': 'ocaml',
      'jl': 'julia', 'r': 'r', 'matlab': 'matlab', 'groovy': 'groovy', 'gvy': 'groovy', 'gradle': 'groovy',
      'asm': 'assembly', 's': 'assembly', 'f': 'fortran', 'f90': 'fortran', 'f95': 'fortran',
      'pas': 'pascal', 'pp': 'pascal', 'm': 'objc', 'mm': 'objc', 'vim': 'vim',
      'txt': 'plaintext', 'regex': 'regex',
    };
    return languageMap[ext || ''] || 'plaintext';
  };

  return (
    <div className="w-full">
      {/* 第一行：Write 工具信息 */}
      <ToolHeader icon="File" name="Write" colors={colors}
        rightExtra={toolCallId && beforeContent !== undefined ? (
          <button
            onClick={() => setShowRollbackConfirm(true)}
            className="cursor-pointer"
            style={{
              background: 'none',
              border: 'none',
              padding: '2px 4px',
              borderRadius: '3px',
              color: colors.harness,
              font: 'inherit',
              fontSize: 'inherit',
              opacity: 0.6,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.backgroundColor = `${colors.harness}20`; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.backgroundColor = 'transparent'; }}
            title={t('tool.editFile.rollback')}
          >
            <RotateCcw size={12} />
          </button>
        ) : undefined}
      >
        <button
          onClick={handleOpenFile}
          className="hover:underline cursor-pointer"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: colors.textPrimary,
            font: 'inherit',
            fontSize: 'inherit',
          }}
          title={t('tool.editFile.clickOpenFile', { path: filePath })}
        >
          {filePath}
        </button>
        <span style={{ opacity: 0.6, marginLeft: '8px' }}>{t('tool.writeFile.lines', { count: totalLines })}</span>
        {contentPreview && status !== 'fail' && (
          <button
            onClick={handleToggleExpand}
            className="hover:underline cursor-pointer"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              marginLeft: '8px',
              color: colors.textSystem,
              font: 'inherit',
              fontSize: 'inherit',
            }}
            title={isExpanded ? t('tool.writeFile.collapsePreview') : t('tool.writeFile.expandPreview')}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </ToolHeader>

      {/* 第二行：内容预览（可展开） */}
      {isExpanded && contentPreview && (
        <div
          className="mt-2"
          style={{
            backgroundColor: 'transparent',
            maxHeight: '300px',
            overflow: 'auto',
            border: '1px solid',
            borderColor: colors.textSystem,
            borderRadius: '4px',
          }}
        >
          <div
            className="code-preview"
            style={{
              fontSize: '12px',
              fontFamily: 'Consolas, Monaco, "Courier New", monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
            dangerouslySetInnerHTML={{ __html: highlightedCode || contentPreview }}
          />
        </div>
      )}

      {/* 回滚确认对话框 */}
      {showRollbackConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={handleRollbackCancel}
        >
          <div
            className="rounded-xl shadow-2xl w-[95vw] max-w-[460px] flex flex-col"
            style={{
              backgroundColor: isDark ? '#1e1e24' : '#ffffff',
              border: `1px solid ${colors.border}`,
              color: colors.textPrimary,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center justify-between px-5 py-3 border-b"
              style={{ borderColor: colors.border }}
            >
              <span className="text-[15px] font-semibold">{t('tool.editFile.rollback')}</span>
              <button
                onClick={handleRollbackCancel}
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:brightness-110 transition-all"
                style={{ color: colors.textSystem }}
              >
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                  <path d="M9 3L3 9M3 3L9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>

            <div className="px-5 py-4">
              <div className="text-[13px]" style={{ color: colors.textSystem }}>
                {t('tool.editFile.chooseRollback')}
              </div>
              <div className="flex gap-3 mt-3" style={{ color: colors.textPrimary }}>
                <button
                  className="flex-1 py-3 px-4 rounded-lg text-[13px] font-semibold transition-all cursor-pointer"
                  style={{
                    border: `1px solid ${rollbackDirection === 'before' ? colors.harness : colors.border}`,
                    backgroundColor: rollbackDirection === 'before' ? `${colors.harness}15` : 'transparent',
                    color: rollbackDirection === 'before' ? colors.harness : colors.textSystem,
                  }}
                  onClick={() => setRollbackDirection('before')}
                >
                  <div className="text-[13px]" style={{ color: colors.textPrimary }}>{t('tool.editFile.beforeChange')}</div>
                  <div className="text-[11px] font-normal mt-1" style={{ color: colors.textPrimary, opacity: 0.7 }}>
                    {t('tool.editFile.undoAllChanges')}
                  </div>
                </button>
                <button
                  className="flex-1 py-3 px-4 rounded-lg text-[13px] font-semibold transition-all cursor-pointer"
                  style={{
                    border: `1px solid ${rollbackDirection === 'after' ? colors.harness : colors.border}`,
                    backgroundColor: rollbackDirection === 'after' ? `${colors.harness}15` : 'transparent',
                    color: rollbackDirection === 'after' ? colors.harness : colors.textSystem,
                  }}
                  onClick={() => setRollbackDirection('after')}
                >
                  <div className="text-[13px]" style={{ color: colors.textPrimary }}>{t('tool.editFile.afterChange')}</div>
                  <div className="text-[11px] font-normal mt-1" style={{ color: colors.textPrimary, opacity: 0.7 }}>
                    {t('tool.editFile.keepThisUndoLater')}
                  </div>
                </button>
              </div>
            </div>

            <div
              className="flex justify-end gap-2 px-5 py-3 border-t"
              style={{ borderColor: colors.border }}
            >
              <button
                className="px-4 py-1.5 rounded-lg text-[13px] transition-all cursor-pointer"
                style={{
                  border: `1px solid ${colors.border}`,
                  color: colors.textSystem,
                  backgroundColor: 'transparent',
                }}
                onClick={handleRollbackCancel}
              >
                {t('tool.editFile.cancel')}
              </button>
              <button
                className="px-4 py-1.5 rounded-lg text-[13px] transition-all cursor-pointer"
                style={{
                  border: `1px solid ${colors.harness}`,
                  backgroundColor: colors.harness,
                  color: '#fff',
                }}
                onClick={handleRollbackConfirm}
              >
                {t('tool.editFile.confirmRollback')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 回滚结果提示 */}
      {rollbackResult && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-[13px]"
          style={{
            backgroundColor: colors.harness,
            color: colors.textPrimary,
          }}
        >
          {rollbackResult.message}
        </div>
      )}
    </div>
  );
};
