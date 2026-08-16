import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import { ToolCallProps } from './Types';
import { DefaultLinesDiffComputer } from 'vscode-diff';
import { type Highlighter } from 'shiki';
import { getHighlighter, getHighlighterSync } from './highlighter';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';
import { profileLog } from '../debug';

interface DiffLine {
  lineNumber: number;
  content: string;
  type: 'unchanged' | 'removed' | 'added';
  wordDiff?: Array<{
    text: string;
    type: 'unchanged' | 'removed' | 'added';
  }>;
}

interface DiffHunk {
  lines: DiffLine[];
}

interface DiffInnerChange {
  originalRange: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  };
  modifiedRange: {
    startLineNumber: number;
    endLineNumber: number;
    startColumn: number;
    endColumn: number;
  };
}

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

  // 按需加载 _meta（beforeContent/afterContent 等大字段）
  // 如果 args 已经带有 diff 数据，初始渲染就直接生成 diff，避免 passive effect
  // 二次渲染导致“先渲染再滚动”。
  const [metaLoaded, setMetaLoaded] = useState(() => !needsMeta || !!(args?.beforeContent || args?.afterContent));
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
        setBeforeContent(normalizeLineEndings(meta.beforeContent || ''));
        setAfterContent(normalizeLineEndings(meta.afterContent || ''));
        setMetaLoaded(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [toolUseId]);

  // 非按需场景：直接从 args 中读取（已由 conversationLoaded 恢复逻辑填充的新对话，或没有 _meta 的老数据）。
  // 注意：不能只在 !metaLoaded 时读取一次——Edit 执行失败时扩展端会通过 updateToolArgs
  // 把 beforeContent/afterContent 清空，组件必须同步 args 的后续变化，否则 diff 会残留在 UI 上。
  useEffect(() => {
    if (!needsMeta) {
      const bc = normalizeLineEndings(args?.beforeContent || '');
      const ac = normalizeLineEndings(args?.afterContent || '');
      // args 后续补上 diff 数据时，先预滚动再渲染
      onBeforePreviewRender?.();
      profileLog(`[EditFile] args data loaded | beforeContent.len=${bc.length} | afterContent.len=${ac.length}`);
      setBeforeContent(bc);
      setAfterContent(ac);
      if (!metaLoaded) {
        setMetaLoaded(true);
      }
    }
  }, [needsMeta, metaLoaded, args?.beforeContent, args?.afterContent, onBeforePreviewRender]);

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

  // 计算差异
  const diffHunks = useMemo(() => {
    if (!beforeContent || !afterContent) return [];

    const originalLines = beforeContent.split('\n');
    const modifiedLines = afterContent.split('\n');

    const computer = new DefaultLinesDiffComputer();
    const contextLines = 2;
    // diff 计算窗口在编辑区域外额外保留的行数。
    // 窗口只用于限制 computeDiff 的输入规模，渲染时仍会展示 contextLines 行上下文。
    const windowPaddingLines = 20;

    const editStartLine = args?.startLine;
    const editEndLine = args?.endLine;
    // replaceAll 时 startLine/endLine 只覆盖第一处匹配，窗口 diff 会漏掉后续替换，
    // 因此 replaceAll 先回退到全量 diff，保证结果完整。
    const replaceAll = Boolean(args?.replace_all);
    const hasEditRange =
      !replaceAll &&
      typeof editStartLine === 'number' &&
      typeof editEndLine === 'number' &&
      editStartLine > 0 &&
      editEndLine >= editStartLine;

    let diffResult;
    let originalOffset = 0;
    let modifiedOffset = 0;

    if (hasEditRange) {
      // 只截取编辑区域前后各 windowPaddingLines 行的窗口做 diff，
      // 大文件编辑时避免对全量行数组做 computeDiff。
      const originalWindowStart = Math.max(1, editStartLine - windowPaddingLines);
      const originalWindowEnd = Math.min(originalLines.length, editEndLine + windowPaddingLines);
      const modifiedWindowStart = originalWindowStart;
      // 编辑前后总行数差会整体平移修改侧的行号
      const modifiedEditEndLine = editEndLine + (modifiedLines.length - originalLines.length);
      const modifiedWindowEnd = Math.min(
        modifiedLines.length,
        modifiedEditEndLine + windowPaddingLines,
      );

      const originalWindow = originalLines.slice(originalWindowStart - 1, originalWindowEnd);
      const modifiedWindow = modifiedLines.slice(modifiedWindowStart - 1, modifiedWindowEnd);

      originalOffset = originalWindowStart - 1;
      modifiedOffset = modifiedWindowStart - 1;

      diffResult = computer.computeDiff(originalWindow, modifiedWindow, {
        ignoreTrimWhitespace: false,
        computeMoves: false,
        maxComputationTimeMs: 0,
      });
    } else {
      diffResult = computer.computeDiff(originalLines, modifiedLines, {
        ignoreTrimWhitespace: false,
        computeMoves: false,
        maxComputationTimeMs: 0,
      });
    }

    const hunks: DiffHunk[] = [];

    for (const change of diffResult.changes) {
      const originalStart = change.original.startLineNumber + originalOffset;
      const originalEnd = change.original.endLineNumberExclusive + originalOffset;
      const modifiedStart = change.modified.startLineNumber + modifiedOffset;
      const modifiedEnd = change.modified.endLineNumberExclusive + modifiedOffset;

      const lines: DiffLine[] = [];

      // 按 original 行号分组 innerChanges
      const innerChangesByOriginalLine = new Map<number, DiffInnerChange[]>();
      const innerChangesByModifiedLine = new Map<number, DiffInnerChange[]>();

      if (change.innerChanges) {
        for (const rawInner of change.innerChanges) {
          // 窗口 diff 的 innerChanges 行号也需要映射回完整文件行号
          const inner: DiffInnerChange = {
            originalRange: {
              startLineNumber: rawInner.originalRange.startLineNumber + originalOffset,
              endLineNumber: rawInner.originalRange.endLineNumber + originalOffset,
              startColumn: rawInner.originalRange.startColumn,
              endColumn: rawInner.originalRange.endColumn,
            },
            modifiedRange: {
              startLineNumber: rawInner.modifiedRange.startLineNumber + modifiedOffset,
              endLineNumber: rawInner.modifiedRange.endLineNumber + modifiedOffset,
              startColumn: rawInner.modifiedRange.startColumn,
              endColumn: rawInner.modifiedRange.endColumn,
            },
          };

          const origStartLine = inner.originalRange.startLineNumber;
          const origEndLine = inner.originalRange.endLineNumber;

          for (let lineNum = origStartLine; lineNum <= origEndLine; lineNum++) {
            if (!innerChangesByOriginalLine.has(lineNum)) {
              innerChangesByOriginalLine.set(lineNum, []);
            }
            innerChangesByOriginalLine.get(lineNum)!.push(inner);
          }

          const modStartLine = inner.modifiedRange.startLineNumber;
          const modEndLine = inner.modifiedRange.endLineNumber;

          for (let lineNum = modStartLine; lineNum <= modEndLine; lineNum++) {
            if (!innerChangesByModifiedLine.has(lineNum)) {
              innerChangesByModifiedLine.set(lineNum, []);
            }
            innerChangesByModifiedLine.get(lineNum)!.push(inner);
          }
        }
      }

      const contextStart = Math.max(1, Math.min(originalStart, modifiedStart) - contextLines);
      const contextEndOriginal = Math.min(originalLines.length + 1, originalEnd + contextLines);
      const contextEndModified = Math.min(modifiedLines.length + 1, modifiedEnd + contextLines);

      // 添加上下文行（上方）
      for (let i = contextStart; i < Math.min(originalStart, modifiedStart); i++) {
        lines.push({
          lineNumber: i,
          content: originalLines[i - 1] || modifiedLines[i - 1],
          type: 'unchanged',
        });
      }

      // 添加删除的行（带单词级差异）
      for (let i = originalStart; i < originalEnd; i++) {
        const content = originalLines[i - 1];
        const innerChanges = innerChangesByOriginalLine.get(i);
        const wordDiff = computeWordDiffFromInnerChanges(content, innerChanges, false, i);
        lines.push({
          lineNumber: i,
          content,
          type: 'removed',
          wordDiff,
        });
      }

      // 添加添加的行（带单词级差异）
      for (let i = modifiedStart; i < modifiedEnd; i++) {
        const content = modifiedLines[i - 1];
        const innerChanges = innerChangesByModifiedLine.get(i);
        const wordDiff = computeWordDiffFromInnerChanges(content, innerChanges, true, i);
        lines.push({
          lineNumber: i,
          content,
          type: 'added',
          wordDiff,
        });
      }

      // 添加上下文行（下方）
      for (let i = modifiedEnd; i < Math.max(contextEndOriginal, contextEndModified); i++) {
        const content = i <= modifiedLines.length ? modifiedLines[i - 1] : originalLines[i - 1];
        lines.push({
          lineNumber: i,
          content,
          type: 'unchanged',
        });
      }

      hunks.push({ lines });
    }

    return hunks;
  }, [beforeContent, afterContent, args?.startLine, args?.endLine, args?.replace_all]);

  /**
   * 使用 vscode-diff 的 innerChanges 构建单词级差异。
   *
   * innerChanges 可能跨越多行（例如 modifiedRange 从第 8 行第 32 列到
   * 第 9 行第 30 列），此时列范围跨越了行边界。本函数需要根据当前行号
   * (lineNumber) 将跨行 innerChange 拆分为仅覆盖当前行的列范围，从而
   * 正确提取单词级差异文本。
   */
  function computeWordDiffFromInnerChanges(
    lineContent: string,
    innerChanges: DiffInnerChange[] | undefined,
    isModifiedLine: boolean = false,
    lineNumber?: number // 当前行号，用于拆分跨行 innerChanges
  ): Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }> {
    if (!innerChanges || innerChanges.length === 0) {
      return [{ text: lineContent, type: 'unchanged' }];
    }

    const result: Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }> = [];
    let lastPos = 1;

    const getRange = (change: typeof innerChanges[0]) => {
      return isModifiedLine ? change.modifiedRange : change.originalRange;
    };

    // 将每个 innerChange 的列范围适配到当前行。
    // 如果是单行 innerChange 且就是当前行 → 直接用
    // 如果是跨行 innerChange 且当前行在范围内 → 提取当前行部分
    // 如果当前行不在范围内 → 跳过
    const effectiveChanges: Array<{ startColumn: number; endColumn: number }> = [];

    for (const change of innerChanges) {
      const range = getRange(change);
      const { startLineNumber, endLineNumber, startColumn, endColumn } = range;
      const currentLine = lineNumber ?? startLineNumber; // 如果没有传 lineNumber，使用 innerChange 的行号

      if (startLineNumber === endLineNumber) {
        // 单行 innerChange
        if (startLineNumber === currentLine) {
          effectiveChanges.push({ startColumn, endColumn });
        }
      } else {
        // 跨行 innerChange：提取当前行的部分
        if (currentLine < startLineNumber || currentLine > endLineNumber) {
          continue; // 当前行不在范围内
        }
        if (currentLine === startLineNumber) {
          // 第一行：从 startColumn 到行末
          effectiveChanges.push({
            startColumn,
            endColumn: lineContent.length + 1, // +1 因为 endColumn 是 exclusive
          });
        } else if (currentLine === endLineNumber) {
          // 最后一行：从行首到 endColumn
          effectiveChanges.push({
            startColumn: 1,
            endColumn,
          });
        } else {
          // 中间行：整行
          effectiveChanges.push({
            startColumn: 1,
            endColumn: lineContent.length + 1,
          });
        }
      }
    }

    // 按起始列排序
    effectiveChanges.sort((a, b) => a.startColumn - b.startColumn);

    for (const { startColumn: start, endColumn: end } of effectiveChanges) {
      if (lastPos < start) {
        const unchangedText = lineContent.substring(lastPos - 1, start - 1);
        if (unchangedText) {
          result.push({ text: unchangedText, type: 'unchanged' });
        }
      }

      if (start < end) {
        const changedText = lineContent.substring(start - 1, end - 1);
        if (changedText) {
          result.push({ text: changedText, type: isModifiedLine ? 'added' : 'removed' });
        }
      }

      lastPos = end;
    }

    if (lastPos <= lineContent.length) {
      const unchangedText = lineContent.substring(lastPos - 1);
      if (unchangedText) {
        result.push({ text: unchangedText, type: 'unchanged' });
      }
    }

    return result.length > 0 ? result : [{ text: lineContent, type: 'unchanged' }];
  }

  if (!filePath) {
    return (
      <ToolHeader icon="FileText" name="Edit" colors={colors}
        rightExtra={metaLoaded && beforeContent && effectiveToolCallId ? (
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
        rightExtra={metaLoaded && beforeContent && effectiveToolCallId ? (
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
        {(beforeContent || afterContent) && (
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
