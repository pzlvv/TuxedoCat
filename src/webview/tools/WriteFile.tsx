import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { type Highlighter } from 'shiki';
import { getHighlighter, ensureLanguage, isLanguageReady } from './highlighter';
import { ToolHeader } from './ToolHeader';
import { usePreviewLimit, PreviewMoreHint, PREVIEW_LINES, PREVIEW_BOX_HEIGHT, PREVIEW_LINE_HEIGHT } from './previewLimit';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';

/** 在 Shiki 高亮结果可用前，先转义原始文件内容，避免把文件里的 <style>/<link> 等当作真实 HTML 注入页面。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const WriteFile: React.FC<ToolCallProps> = ({ args, colors, status, isDark, toolCallId, onExpandToggle }) => {
  const filePath = args?.file_path || args?.path;
  const contentPreview = args?.contentPreview;
  const totalLines = args?.totalLines || 0;
  const beforeContent = args?.beforeContent as string | undefined;
  const [isExpanded, setIsExpanded] = useState(true);
  const [highlightedCode, setHighlightedCode] = useState<string>('');
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  // ─── 预览按需渲染 + 折行感知限高 ──────────────────────────────────
  // contentPreview 是写入文件的完整内容，此前会整体走 Shiki 高亮并全部渲染进
  // 一个 300px 的滚动框（实测单条平均 1269 个 DOM 节点、最大 7243）。
  // 这里有**两个互相独立**的「展开」，不要混为一谈：
  //   ① 工具行右侧的箭头（上面的 isExpanded）—— 控制整个预览块的显隐，
  //      收起后预览完全不进 DOM；
  //   ② 点击预览框本身（usePreviewLimit 的 expand）—— 控制**行级截断**：
  //      默认只高亮/渲染前 PREVIEW_LINES 行，点击后渲染全部。
  // 例外：手动模式下 status === 'normal' 表示正在等待用户授权，
  // 此时必须完整展开（用户要看到完整内容才能确认），确认后自动恢复缩略。
  //
  // ⚠️ 长行会随 webview 宽度自动折行，「16 个逻辑行」并不等于「16 个视觉行」。
  // usePreviewLimit 会逐行实测真实高度，用于展开态的滚动布局。
  const previewLines = useMemo(
    () => (contentPreview ? String(contentPreview).split('\n') : []),
    [contentPreview],
  );
  const totalPreviewLines = previewLines.length;
  const candidatePreviewLines = Math.min(totalPreviewLines, PREVIEW_LINES);
  const {
    contentRef: previewContentRef,
    fittedLines: fittedPreviewLines,
    fittedHeight: fittedPreviewHeight,
    expanded: previewExpanded,
    truncated: previewTruncated,
    hasMore: previewHasMore,
    expand: expandPreview,
    handleBoxClick: handlePreviewBoxClick,
  } = usePreviewLimit(totalPreviewLines, status === 'normal', {
    revision: highlightedCode,
    // 通知外层暂停自动滚动，避免预览变高后视口被顶走
    onExpand: () => onExpandToggle?.(true),
  });

  // 实际送去 Shiki 高亮的文本：缩略态只高亮候选行，展开态高亮全文。
  const highlightSource = useMemo(() => {
    if (previewExpanded) return String(contentPreview ?? '');
    return previewLines.slice(0, candidatePreviewLines).join('\n');
  }, [previewExpanded, contentPreview, previewLines, candidatePreviewLines]);

  // 把 Shiki 的整段 HTML 按行拆开，逐行渲染成块级元素，便于实测每行高度。
  const previewLineHtmls = useMemo(() => {
    const sourceLines = previewExpanded ? previewLines : previewLines.slice(0, candidatePreviewLines);
    const fallback = sourceLines.map(escapeHtml);
    if (!highlightedCode) return fallback;
    // structure:'inline' 用 <br> 分隔各行。行内 token 不可能含 <br>（源码里的
    // <br> 已被 Shiki 转义为 &lt;br&gt;），因此按字面量切分是安全的；
    // 数量对不上时退回纯文本。
    const parts = highlightedCode.split('<br>');
    return parts.length === sourceLines.length ? parts : fallback;
  }, [highlightedCode, previewExpanded, previewLines, candidatePreviewLines]);

  // ─── 回滚状态 ────────────────────────────────────────────────────
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
  const [rollbackDirection, setRollbackDirection] = useState<'before' | 'after'>('before');
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; message: string } | null>(null);

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

  // 当可见内容变化时，应用语法高亮。
  // 语言语法按需加载：未加载时先 await ensureLanguage，再生成高亮 HTML
  // （期间保持纯文本渲染，由渲染层 escapeHtml 兜底）。
  // 只高亮 highlightSource（截断后），避免为不可见的上千行白跑 Shiki。
  useEffect(() => {
    if (!highlightSource || !isExpanded) return;
    const language = getLanguageFromPath(filePath);
    let cancelled = false;

    const applyHighlight = async () => {
      const h = await getHighlighter();
      if (cancelled) return;
      if (!isLanguageReady(language)) {
        await ensureLanguage(language);
        if (cancelled) return;
      }
      try {
        const html = h.codeToHtml(highlightSource, {
          lang: language,
          theme: isDark ? 'github-dark' : 'github-light',
          // structure:'inline' 直接输出每行的 token span、用 <br> 分隔，
          // 不再套 <span class="line">。该 wrapper 没有内联样式，是纯冗余：
          // 实测 795 行里 135 个空行原本各占一个空 span。
          structure: 'inline',
        });
        if (!cancelled) setHighlightedCode(html);
      } catch {
        if (!cancelled) setHighlightedCode(highlightSource);
      }
    };

    void applyHighlight();
    return () => { cancelled = true; };
  }, [highlightSource, isExpanded, filePath, highlighter, isDark]);

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
      'pas': 'pascal', 'pp': 'pascal', 'm': 'objective-c', 'mm': 'objective-c', 'vim': 'vim',
      'txt': 'plaintext', 'regex': 'regexp',
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
            <Icon name="rotate-ccw" size={12} />
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
            {isExpanded ? <Icon name="chevron-down" size={14} /> : <Icon name="chevron-right" size={14} />}
          </button>
        )}
      </ToolHeader>

      {/* 第二行：内容预览（可展开；按实测高度缩略，点击展开全部） */}
      {isExpanded && contentPreview && (
        <>
          <div
            className="mt-2"
            onClick={handlePreviewBoxClick}
            title={previewTruncated ? t('tool.preview.clickToShowAll') : undefined}
            style={{
              backgroundColor: 'transparent',
              maxHeight: PREVIEW_BOX_HEIGHT,
              // 缩略态高度 = 实测放得下的整行高度（折行感知）；展开态固定为
              // PREVIEW_BOX_HEIGHT 并在内部滚动。两者都基于真实行高，因此缩略态
              // 无论行怎么折都不会溢出、也就不会出现滚动条。
              height: previewHasMore
                ? (previewExpanded ? PREVIEW_BOX_HEIGHT : fittedPreviewHeight + 2)
                : undefined,
              // 缩略态裁掉多余内容（不滚动）；展开态才允许滚动。
              overflow: previewExpanded ? 'auto' : 'hidden',
              border: '1px solid',
              borderColor: colors.textSystem,
              // 底部提示条在缩略/展开两态都保留，因此底角始终是直角
              borderRadius: previewHasMore ? '4px 4px 0 0' : '4px',
              cursor: previewTruncated ? 'pointer' : undefined,
            }}
          >
            <div
              ref={previewContentRef}
              className="code-preview"
              style={{
                fontSize: '12px',
                lineHeight: `${PREVIEW_LINE_HEIGHT}px`,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                // 左侧留一点空隙，代码不贴着预览框左边框显示。
                paddingLeft: '4px',
              }}
            >
              {previewLineHtmls.map((html, i) => (
                <div
                  key={i}
                  // 空行没有行盒，用 minHeight 保证它仍占一行高度
                  style={{ minHeight: PREVIEW_LINE_HEIGHT }}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              ))}
            </div>
          </div>
          {previewHasMore && (
            <PreviewMoreHint
              shown={fittedPreviewLines}
              total={totalPreviewLines}
              expanded={previewExpanded}
              colors={colors}
              onClick={expandPreview}
            />
          )}
        </>
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
