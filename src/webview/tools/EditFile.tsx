import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import { ToolCallProps } from './Types';
import { type Highlighter } from 'shiki';
import { getHighlighter, getHighlighterSync } from './highlighter';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';
import { profileLog } from '../debug';
import { buildEditDiffHunks, type DiffHunk, type DiffLine } from '../../core/utils/editDiff';

// VS Code 扩展模式下由 vscode 注入 --vscode-diffEditor-* CSS 变量；
// Electron App 模式下这些变量不存在，背景色会解析为空（透明），
// 因此这里提供与 VS Code 默认 diff 一致的兜底色，保证红/绿差异可见。
const DIFF_COLORS = {
  removedLine: 'rgba(255, 0, 73, 0.15)',
  insertedLine: 'rgba(155, 185, 85, 0.2)',
  removedText: 'rgba(255, 0, 73, 0.25)',
  insertedText: 'rgba(155, 185, 85, 0.25)',
};

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

export const EditFile: React.FC<ToolCallProps> = ({ args, colors, isDark, toolCallId, onExpandToggle, onBeforePreviewRender }) => {
  const filePath = args?.file_path;
  const needsMeta = args?._needsMeta === true;
  const toolUseId = args?._toolUseId as string | undefined;

  // 按需加载 _meta（Edit 现在是紧凑 diffHunks；旧数据仍可能是 beforeContent/afterContent）
  // 如果 args 已经带有 diff 数据，初始渲染就直接生成 diff，避免 passive effect
  // 二次渲染导致“先渲染再滚动”。
  const [loadedDiffHunks, setLoadedDiffHunks] = useState<DiffHunk[]>(() =>
    Array.isArray(args?.diffHunks) ? (args.diffHunks as DiffHunk[]) : []
  );
  const hasInitialDiffData = loadedDiffHunks.length > 0 || !!args?.beforeContent || !!args?.afterContent;
  const [metaLoaded, setMetaLoaded] = useState(() => !needsMeta || hasInitialDiffData);
  const [beforeContent, setBeforeContent] = useState(() =>
    typeof args?.beforeContent === 'string' ? normalizeLineEndings(args.beforeContent) : ''
  );
  const [afterContent, setAfterContent] = useState(() =>
    typeof args?.afterContent === 'string' ? normalizeLineEndings(args.afterContent) : ''
  );

  useEffect(() => {
    if (needsMeta && !metaLoaded && toolUseId) {
      postMessage({
        type: 'requestToolMeta',
        sessionId: getWindowSessionId(),
        toolUseIds: [toolUseId],
      });
    }
  }, [needsMeta, metaLoaded, toolUseId]);

  // 监听 toolMetaData 响应
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'toolMetaData' && msg.toolMeta && toolUseId && msg.toolMeta[toolUseId]) {
        const meta = msg.toolMeta[toolUseId];
        // 先让外层把滚动容器预滚到底部，再渲染 diff，避免 diff 先出现再滚动
        onBeforePreviewRender?.();
        if (Array.isArray(meta.diffHunks)) {
          setLoadedDiffHunks(meta.diffHunks as DiffHunk[]);
          setBeforeContent('');
          setAfterContent('');
        } else {
          setLoadedDiffHunks([]);
          setBeforeContent(normalizeLineEndings(meta.beforeContent || ''));
          setAfterContent(normalizeLineEndings(meta.afterContent || ''));
        }
        setMetaLoaded(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [toolUseId]);

  // 非按需场景：直接从 args 中读取（已由 conversationLoaded 恢复逻辑填充的新对话，或没有 _meta 的老数据）。
  // 注意：不能只在 !metaLoaded 时读取一次——Edit 执行失败时扩展端会通过 updateToolArgs
  // 把 beforeContent/afterContent/diffHunks 清空，组件必须同步 args 的后续变化，否则 diff 会残留在 UI 上。
  useEffect(() => {
    if (!needsMeta) {
      const hunks = Array.isArray(args?.diffHunks) ? (args.diffHunks as DiffHunk[]) : [];
      const bc = normalizeLineEndings(args?.beforeContent || '');
      const ac = normalizeLineEndings(args?.afterContent || '');
      // args 后续补上 diff 数据时，先预滚动再渲染
      onBeforePreviewRender?.();
      const hunkLineCount = hunks.reduce((s, h) => s + (h.lines?.length || 0), 0);
      profileLog(`[EditFile] args data loaded | diffLines=${hunkLineCount} beforeContent.len=${bc.length} | afterContent.len=${ac.length}`);
      setLoadedDiffHunks(hunks);
      setBeforeContent(bc);
      setAfterContent(ac);
      if (!metaLoaded) {
        setMetaLoaded(true);
      }
    }
  }, [needsMeta, metaLoaded, args?.diffHunks, args?.beforeContent, args?.afterContent, onBeforePreviewRender]);

  const [isExpanded, setIsExpanded] = useState(true);
  // 共享单例 highlighter 用 state 持有：加载完成后触发一次重渲染，
  // 让 diff 重新走语法高亮（用 ref 的话加载完不会重渲染，diff 永远不高亮）。
  const [highlighter, setHighlighter] = useState<Highlighter | null>(() => getHighlighterSync());
  useEffect(() => {
    if (getHighlighterSync()) return; // already loaded
    let mounted = true;
    getHighlighter().then((h) => {
      if (mounted) setHighlighter(h);
    }).catch((err) => {
      console.error('[EditFile] Failed to initialize highlighter:', err);
    });
    return () => { mounted = false; };
  }, []);

  // ─── 回滚状态 ────────────────────────────────────────────────────
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
  const [rollbackDirection, setRollbackDirection] = useState<'before' | 'after'>('before');
  const [rollbackResult, setRollbackResult] = useState<{ success: boolean; message: string } | null>(null);

  const effectiveToolCallId = toolCallId || toolUseId || '';

  // 监听 rollbackEditResult 消息
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'rollbackEditResult') {
        setShowRollbackConfirm(false);
        setRollbackResult({ success: msg.success, message: msg.message });
        // 5 秒后自动清除状态提示
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
      toolUseId: effectiveToolCallId,
      filePath: filePath || '',
      direction: rollbackDirection,
    });
  };

  const handleRollbackCancel = () => {
    setShowRollbackConfirm(false);
  };

  // 计算差异：优先使用扩展端预计算的紧凑 diffHunks（只含 diff 相关行），
  // 旧数据仍保留完整 before/after 时在这里兼容计算。
  const diffHunks = useMemo(() => {
    if (loadedDiffHunks.length > 0) return loadedDiffHunks;
    if (!beforeContent || !afterContent) return [];

    return buildEditDiffHunks({
      beforeContent,
      afterContent,
      startLine: args?.startLine,
      endLine: args?.endLine,
      replaceAll: Boolean(args?.replace_all),
    });
  }, [loadedDiffHunks, beforeContent, afterContent, args?.startLine, args?.endLine, args?.replace_all]);

  if (!filePath) {
    return (
      <ToolHeader icon="FileText" name="Edit" colors={colors}
        rightExtra={metaLoaded && (diffHunks.length > 0 || beforeContent) && effectiveToolCallId ? (
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
        <span style={{ opacity: 0.5, marginLeft: '8px' }}>{t('tool.editFile.unknownFile')}</span>
      </ToolHeader>
    );
  }

  const handleToggleExpand = () => {
    const next = !isExpanded;
    onExpandToggle?.(next);
    setIsExpanded(next);
  };

  const handleOpenFile = () => {
    const startLine = args?.startLine;
    const endLine = args?.endLine;
    const selectedLines = startLine && endLine
      ? { start: startLine, end: endLine }
      : undefined;
    postMessage({
      type: 'openFile',
      filePath,
      selectedLines,
    });
  };

  // 获取 Monaco 语言类型
  const getLanguageFromPath = (path: string): string => {
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'php': 'php',
      'rb': 'ruby',
      'swift': 'swift',
      'kt': 'kotlin',
      'dart': 'dart',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'sass': 'scss',
      'less': 'scss',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'toml': 'toml',
      'xml': 'xml',
      'md': 'markdown',
      'sh': 'bash',
      'bash': 'shell',
      'ps1': 'powershell',
      'sql': 'sql',
      'dockerfile': 'dockerfile',
      'makefile': 'makefile',
      'cmake': 'cmake',
      'lua': 'lua',
      'perl': 'perl',
      'r': 'r',
      'scala': 'scala',
      'haskell': 'haskell',
      'clojure': 'clojure',
      'elixir': 'elixir',
      'erlang': 'erlang',
      'fsharp': 'fsharp',
      'ocaml': 'ocaml',
      'julia': 'julia',
      'groovy': 'groovy',
      'assembly': 'asm',
      'fortran': 'fortran',
      'pascal': 'pascal',
      'vim': 'vim',
      'txt': 'plaintext',
    };

    const ext = path.split('.').pop()?.toLowerCase();
    return languageMap[ext || ''] || 'plaintext';
  };

  const language = getLanguageFromPath(filePath);
  const theme = isDark ? 'github-dark' : 'github-light';

  // 生成高亮的 HTML
  const highlightLine = (line: string, wordDiff?: Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }>): string => {
    const hl = highlighter;
    if (!hl) {
      return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    try {
      if (wordDiff) {
        // 有单词级差异时，手动渲染
        return wordDiff.map((word) => {
          const bgColor =
            word.type === 'removed'
              ? `var(--vscode-diffEditor-removedTextBackground, ${DIFF_COLORS.removedText})`
              : word.type === 'added'
              ? `var(--vscode-diffEditor-insertedTextBackground, ${DIFF_COLORS.insertedText})`
              : 'transparent';

          const escapedText = word.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<span style="background-color: ${bgColor}; border-radius: 2px;">${escapedText}</span>`;
        }).join('');
      } else {
        // 没有单词级差异，使用 shiki 高亮
        const html = hl.codeToHtml(line, {
          lang: language,
          theme: theme,
        });
        // shiki 返回 <pre><code>...</code></pre>，我们需要提取内容
        const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
        return match ? match[1] : line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
    } catch (error) {
      console.error('[EditFile] Highlight error:', error);
      return line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  };

  // 获取背景色
  const getBackgroundColor = (type: DiffLine['type']) => {
    switch (type) {
      case 'removed':
        return `var(--vscode-diffEditor-removedLineBackground, ${DIFF_COLORS.removedLine})`;
      case 'added':
        return `var(--vscode-diffEditor-insertedLineBackground, ${DIFF_COLORS.insertedLine})`;
      default:
        return 'transparent';
    }
  };

  // ─── 高亮 diff 渲染数据（memo）────────────────────────────────────
  // 每行 highlightLine 都是一次 shiki codeToHtml 同步调用（数百行 diff 时
  // 单次可达几十 ms）。之前这段直接在 JSX 里执行，导致 EditFile 因 status
  // /content 变化重渲染时整份 diff 全部重新高亮（例如 running→success 时
  // 白跑一遍）。这里把高亮结果缓存起来，仅当 diff 内容、语言、主题、
  // highlighter 或颜色变化时才重算。
  const diffRender = useMemo(() => {
    if (!isExpanded || diffHunks.length === 0) return null;
    const _t0 = performance.now();
    const rendered = diffHunks.map((hunk, hunkIndex) => ({
      key: hunkIndex,
      lines: hunk.lines.map((line, lineIndex) => ({
        key: lineIndex,
        bg: getBackgroundColor(line.type),
        html: highlightLine(line.content, line.wordDiff),
      })),
    }));
    const _t1 = performance.now();
    const elapsed = _t1 - _t0;
    if (elapsed > 10) {
      const lineCount = diffHunks.reduce((s, h) => s + h.lines.length, 0);
      profileLog(`[Profile] EditFile diff高亮 | 耗时=${elapsed.toFixed(2)}ms | 行数=${lineCount} | file=${filePath}`);
    }
    return rendered;
  }, [isExpanded, diffHunks, highlighter, language, theme, colors]);

  return (
    <div className="w-full">
      <ToolHeader icon="FileText" name="Edit" colors={colors}
        rightExtra={metaLoaded && (diffHunks.length > 0 || beforeContent) && effectiveToolCallId ? (
          <button
            onClick={() => setShowRollbackConfirm(true)}
            className="cursor-pointer"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: colors.textSystem,
              font: 'inherit',
              fontSize: 'inherit',
              opacity: 0.5,
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
            title={t('tool.editFile.rollbackHere')}
          >
            <RotateCcw size={13} />
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
        {(diffHunks.length > 0 || beforeContent || afterContent) && (
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
            title={isExpanded ? t('tool.editFile.collapseDiff') : t('tool.editFile.expandDiff')}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </ToolHeader>

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
            {/* 标题栏 */}
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

            {/* 内容 */}
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

            {/* 底部按钮 */}
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

      {diffRender && (
        <div
          className="mt-2 code-preview"
          style={{
            maxHeight: '300px',
            overflow: 'auto',
            backgroundColor: 'transparent',
            border: '1px solid',
            borderColor: colors.textSystem,
            borderRadius: '4px',
          }}
        >
          {diffRender.map((hunk) => (
            <div key={hunk.key}>
              {hunk.lines.map((line) => (
                <div
                  key={line.key}
                  style={{
                    backgroundColor: line.bg,
                  }}
                >
                  <pre
                    style={{
                      margin: 0,
                      padding: '0 8px',
                      fontSize: '12px',
                      fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                      color: colors.textPrimary,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                    dangerouslySetInnerHTML={{
                      __html: line.html,
                    }}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
