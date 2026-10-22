import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { type Highlighter } from 'shiki';
import { getHighlighter, getHighlighterSync, ensureLanguage, isLanguageReady } from './highlighter';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';
import { profileLog } from '../debug';
import { uiFontSizePx } from '../fontSize';
import { buildEditDiffHunks, type DiffHunk, type DiffLine } from '../../shared/utils/editDiff';
import { usePreviewLimit, PreviewMoreHint, PREVIEW_BOX_HEIGHT, PREVIEW_LINE_HEIGHT } from './previewLimit';

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

/** 仅转义尖括号，与改动前的行为一致（保持渲染结果逐像素不变）。 */
function escapeLineText(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把 Shiki 输出的内联样式字符串（如 `color:#6A737D;font-weight:bold`）
 * 解析成 React 的 style 对象，用于把「整行只有一个 token」的样式
 * 直接提到行元素上、省掉那层 span。
 */
function parseInlineStyle(s: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    const key = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!key || !value) continue;
    out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as React.CSSProperties;
}

export const EditFile: React.FC<ToolCallProps> = ({ args, colors, status, isDark, toolCallId, onExpandToggle, onBeforePreviewRender }) => {
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
    const sid = getWindowSessionId();
    if (needsMeta && !metaLoaded && toolUseId && sid) {
      postMessage({
        type: 'requestToolMeta',
        sessionId: sid,
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
  // 语言语法按需加载完成后 +1，用于触发 diff 重新高亮
  const [highlightVersion, setHighlightVersion] = useState(0);
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
    // 回滚在 core 侧异步执行，结果以一条系统消息（CoreEvent.message）回传聊天区展示，
    // 因此这里直接关闭确认框；旧实现等待 rollbackEditResult 回包，该回包已随总线重构移除。
    setShowRollbackConfirm(false);
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

  // ─── 预览按需渲染 + 折行感知限高 ──────────────────────────────────
  // 这里有**两个互相独立**的「展开」，不要混为一谈：
  //   ① 工具行右侧的箭头（上面的 isExpanded）—— 控制整个 diff 预览块的显隐，
  //      收起后 diff 完全不进 DOM；
  //   ② 点击预览框本身（usePreviewLimit 的 expand）—— 控制**行级截断**：
  //      默认只处理前 PREVIEW_LINES 行，点击后渲染全部。
  // 例外：手动模式下 status === 'normal' 表示正在等待用户授权，
  // 此时必须完整展开（用户要看到全部改动才能确认），确认后自动恢复缩略。
  //
  // ⚠️ 长行会随 webview 宽度自动折行，一个逻辑行可能占多个视觉行。
  // usePreviewLimit 会逐行实测真实高度、只显示放得下的整行，并在宽度变化时
  // 重新测量，避免缩略态出现滚动条。
  const totalDiffLines = useMemo(
    () => diffHunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
    [diffHunks],
  );
  const {
    contentRef: diffContentRef,
    truncated: diffTruncated,
    hasMore: diffHasMore,
    visibleLines: visibleDiffLines,
    fittedLines: fittedDiffLines,
    fittedHeight: fittedDiffHeight,
    expanded: diffExpanded,
    expand: expandDiff,
    handleBoxClick: handleDiffBoxClick,
  } = usePreviewLimit(totalDiffLines, status === 'normal', {
    revision: diffHunks,
    // 通知外层暂停自动滚动，避免预览变高后视口被顶走
    onExpand: () => onExpandToggle?.(true),
  });

  // 只保留前 visibleDiffLines 行（跨 hunk 连续计数）
  const visibleDiffHunks = useMemo(() => {
    if (visibleDiffLines >= totalDiffLines) return diffHunks;
    const out: DiffHunk[] = [];
    let remaining = visibleDiffLines;
    for (const hunk of diffHunks) {
      if (remaining <= 0) break;
      const lines = hunk.lines.length <= remaining ? hunk.lines : hunk.lines.slice(0, remaining);
      out.push({ ...hunk, lines });
      remaining -= lines.length;
    }
    return out;
  }, [diffHunks, visibleDiffLines, totalDiffLines]);

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

  // 从文件路径获取 Monaco 语言类型。
  // 路径可能缺失（模型漏传 file_path，卡片会走下方 unknown file 分支），缺失时按纯文本处理：
  // 这里不能假设 path 存在，否则 undefined.split 会把整个 webview 打崩。
  const getLanguageFromPath = (path: string | undefined): string => {
    if (!path) return 'plaintext';
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
      // ── 常见扩展名补全 ──
      // 此前只列了"语言名"（haskell/perl/assembly…），而这里取的是文件扩展名，
      // 导致 .hs / .pl / .h / .cpp / .mjs 等真实扩展名匹配不到、静默降级为纯文本。
      // 语法高亮已改为按需加载，补全扩展名不再增加启动成本。
      'mjs': 'javascript',
      'cjs': 'javascript',
      'mts': 'typescript',
      'cts': 'typescript',
      'pyi': 'python',
      'pyw': 'python',
      'h': 'c',
      'cc': 'cpp',
      'cxx': 'cpp',
      'hpp': 'cpp',
      'hxx': 'cpp',
      'htm': 'html',
      'markdown': 'markdown',
      'rst': 'markdown',
      'hs': 'haskell',
      'lhs': 'haskell',
      'pl': 'perl',
      'pm': 'perl',
      'kts': 'kotlin',
      'gemfile': 'ruby',
      'phtml': 'php',
      'docker': 'dockerfile',
      'mk': 'makefile',
      'psm1': 'powershell',
      'psd1': 'powershell',
      'zsh': 'bash',
      'fish': 'bash',
      'asm': 'asm',
      's': 'asm',
      'f': 'fortran',
      'f90': 'fortran',
      'f95': 'fortran',
      'pas': 'pascal',
      'pp': 'pascal',
      'fs': 'fsharp',
      'fsi': 'fsharp',
      'fsx': 'fsharp',
      'ml': 'ocaml',
      'mli': 'ocaml',
      'clj': 'clojure',
      'cljs': 'clojure',
      'cljc': 'clojure',
      'ex': 'elixir',
      'exs': 'elixir',
      'erl': 'erlang',
      'hrl': 'erlang',
      'jl': 'julia',
      'gradle': 'groovy',
      'gvy': 'groovy',
      'jsonc': 'jsonc',
      'ini': 'ini',
      'cfg': 'ini',
      'conf': 'ini',
      'tsql': 'tsql',
      'm': 'objective-c',
      'mm': 'objective-c',
      'matlab': 'matlab',
    };

    const ext = path.split('.').pop()?.toLowerCase();
    return languageMap[ext || ''] || 'plaintext';
  };

  const language = getLanguageFromPath(filePath);
  const theme = isDark ? 'github-dark' : 'github-light';

  // 语言语法按需加载：当前语言尚未加载时异步加载，完成后 bump highlightVersion
  // 触发 diff 重新高亮（在此之前 diff 以纯文本渲染，不做语法着色）。
  // 没有 filePath 时卡片走下方 unknown file 分支，不必为不渲染的 diff 加载语法。
  useEffect(() => {
    if (!filePath || !highlighter || isLanguageReady(language)) return;
    let mounted = true;
    ensureLanguage(language).then(() => {
      if (mounted) setHighlightVersion((v) => v + 1);
    });
    return () => { mounted = false; };
  }, [filePath, highlighter, language]);

  // 生成高亮的 HTML。
  // style 非空表示「整行只有一个 token」，它的内联样式可以直接提到行元素上，
  // 于是每行省掉一个 <span>（实测 7394 行里 3568 行属于这种）。
  const highlightLine = (
    line: string,
    wordDiff?: Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }>,
  ): { html: string; style: React.CSSProperties | null } => {
    const hl = highlighter;
    if (!hl) {
      return { html: escapeLineText(line), style: null };
    }

    try {
      if (wordDiff) {
        // 单词级差异：只有 removed/added 段需要背景色。
        // unchanged 段原本也包了一层 background-color:transparent 的 span，
        // 它没有任何视觉效果（transparent 上的 border-radius 不可见），
        // 直接输出纯文本即可（实测省 2622 个节点）。
        const html = wordDiff.map((word) => {
          const escapedText = escapeLineText(word.text);
          if (word.type === 'unchanged') return escapedText;
          const bgColor =
            word.type === 'removed'
              ? `var(--vscode-diffEditor-removedTextBackground, ${DIFF_COLORS.removedText})`
              : `var(--vscode-diffEditor-insertedTextBackground, ${DIFF_COLORS.insertedText})`;
          return `<span style="background-color: ${bgColor}; border-radius: 2px;">${escapedText}</span>`;
        }).join('');
        return { html, style: null };
      }

      // 没有单词级差异，使用 shiki 高亮。
      // structure:'inline' 只输出 token 的 <span>，不再套一层 <span class="line">。
      // 每行本来就是一个独立的 <pre>，这层 wrapper 是纯冗余：它没有内联样式，
      // 去掉后渲染结果完全一致，但每行少 1 个节点。
      const html = hl.codeToHtml(line, {
        lang: language,
        theme: theme,
        structure: 'inline',
      });
      // 整行只有一个 token 时，把它的内联样式（color / font-weight / …）
      // 提到行元素上，省掉这层 span。
      // 用「内层不含 <span」来排除多 token 行——贪婪匹配会把中间的 </span><span>
      // 一并吞进来；而源码里的 `<` 已被 Shiki 转义成 &lt;，不会误判。
      const single = /^<span style="([^"]*)">([\s\S]*)<\/span>$/.exec(html);
      if (single && !single[2].includes('<span')) {
        return { html: single[2], style: parseInlineStyle(single[1]) };
      }
      return { html, style: null };
    } catch (error) {
      console.error('[EditFile] Highlight error:', error);
      return { html: escapeLineText(line), style: null };
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
    if (!filePath || !isExpanded || diffHunks.length === 0) return null;
    const _t0 = performance.now();
    // 扁平化：hunk 之间不再需要包裹层，key 用 "hunkIndex-lineIndex" 保证唯一。
    const rendered: Array<{ key: string; bg: string; html: string; style: React.CSSProperties | null }> = [];
    visibleDiffHunks.forEach((hunk, hunkIndex) => {
      hunk.lines.forEach((line, lineIndex) => {
        const hl = highlightLine(line.content, line.wordDiff);
        rendered.push({
          key: `${hunkIndex}-${lineIndex}`,
          bg: getBackgroundColor(line.type),
          html: hl.html,
          style: hl.style,
        });
      });
    });
    const _t1 = performance.now();
    const elapsed = _t1 - _t0;
    if (elapsed > 10) {
      const lineCount = visibleDiffHunks.reduce((s, h) => s + h.lines.length, 0);
      profileLog(`[Profile] EditFile diff高亮 | 耗时=${elapsed.toFixed(2)}ms | 行数=${lineCount}/${totalDiffLines} | file=${filePath}`);
    }
    return rendered;
  }, [filePath, isExpanded, visibleDiffHunks, totalDiffLines, diffHunks.length, highlighter, highlightVersion, language, theme, colors]);

  // 模型漏传 file_path 时降级成「unknown file」头部。
  // ⚠️ 这个条件返回必须留在**所有 hooks 之后**：React 按调用顺序匹配 hooks，把它放在
  // hooks 前面会让同一个卡片实例在 args 补齐 file_path 前后调用数量不同，直接抛
  // 「Rendered more hooks than during the previous render」——webview 没有 error
  // boundary，整棵树会卸载。
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
            <Icon name="rotate-ccw" size={12} />
          </button>
        ) : undefined}
      >
        <span style={{ opacity: 0.5, marginLeft: '8px' }}>{t('tool.editFile.unknownFile')}</span>
      </ToolHeader>
    );
  }

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
            <Icon name="rotate-ccw" size={13} />
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
            {isExpanded ? <Icon name="chevron-down" size={14} /> : <Icon name="chevron-right" size={14} />}
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
              <span className="ui-fs-15 font-semibold">{t('tool.editFile.rollback')}</span>
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
              <div className="ui-fs-13" style={{ color: colors.textSystem }}>
                {t('tool.editFile.chooseRollback')}
              </div>
              <div className="flex gap-3 mt-3" style={{ color: colors.textPrimary }}>
                <button
                  className="flex-1 py-3 px-4 rounded-lg ui-fs-13 font-semibold transition-all cursor-pointer"
                  style={{
                    border: `1px solid ${rollbackDirection === 'before' ? colors.harness : colors.border}`,
                    backgroundColor: rollbackDirection === 'before' ? `${colors.harness}15` : 'transparent',
                    color: rollbackDirection === 'before' ? colors.harness : colors.textSystem,
                  }}
                  onClick={() => setRollbackDirection('before')}
                >
                  <div className="ui-fs-13" style={{ color: colors.textPrimary }}>{t('tool.editFile.beforeChange')}</div>
                  <div className="ui-fs-11 font-normal mt-1" style={{ color: colors.textPrimary, opacity: 0.7 }}>
                    {t('tool.editFile.undoAllChanges')}
                  </div>
                </button>
                <button
                  className="flex-1 py-3 px-4 rounded-lg ui-fs-13 font-semibold transition-all cursor-pointer"
                  style={{
                    border: `1px solid ${rollbackDirection === 'after' ? colors.harness : colors.border}`,
                    backgroundColor: rollbackDirection === 'after' ? `${colors.harness}15` : 'transparent',
                    color: rollbackDirection === 'after' ? colors.harness : colors.textSystem,
                  }}
                  onClick={() => setRollbackDirection('after')}
                >
                  <div className="ui-fs-13" style={{ color: colors.textPrimary }}>{t('tool.editFile.afterChange')}</div>
                  <div className="ui-fs-11 font-normal mt-1" style={{ color: colors.textPrimary, opacity: 0.7 }}>
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
                className="px-4 py-1.5 rounded-lg ui-fs-13 transition-all cursor-pointer"
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
                className="px-4 py-1.5 rounded-lg ui-fs-13 transition-all cursor-pointer"
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
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg ui-fs-13"
          style={{
            backgroundColor: colors.harness,
            color: colors.textPrimary,
          }}
        >
          {rollbackResult.message}
        </div>
      )}

      {diffRender && (
        <>
          <div
            className="mt-2 code-preview"
            onClick={handleDiffBoxClick}
            title={diffTruncated ? t('tool.preview.clickToShowAll') : undefined}
            style={{
              maxHeight: PREVIEW_BOX_HEIGHT,
              // 缩略态高度 = 实测放得下的整行高度（折行感知）；展开态固定为
              // PREVIEW_BOX_HEIGHT 并在内部滚动。缩略态用真实高度限高，
              // 因此无论行怎么折都不会溢出、也就不会出现滚动条。
              height: diffHasMore
                ? (diffExpanded ? PREVIEW_BOX_HEIGHT : fittedDiffHeight + 2)
                : undefined,
              // 缩略态裁掉多余内容（不滚动）；展开态才允许滚动。
              overflow: diffExpanded ? 'auto' : 'hidden',
              backgroundColor: 'transparent',
              border: '1px solid',
              borderColor: colors.textSystem,
              // 底部提示条在缩略/展开两态都保留，因此底角始终是直角
              borderRadius: diffHasMore ? '4px 4px 0 0' : '4px',
              cursor: diffTruncated ? 'pointer' : undefined,
            }}
          >
            <div ref={diffContentRef}>
              {diffRender.map((line) => (
                <pre
                  key={line.key}
                  style={{
                    margin: 0,
                    // padding 留在行元素上（而不是外层滚动框），
                    // 这样差异背景色依然铺满整行宽度。
                    // 左侧多留一点空隙，代码不贴着预览框左边框。
                    padding: '0 8px 0 12px',
                    // 空行没有行盒，用 minHeight 保证它仍占一行高度
                    minHeight: PREVIEW_LINE_HEIGHT,
                    fontSize: uiFontSizePx(12),
                    lineHeight: `${PREVIEW_LINE_HEIGHT}px`,
                    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                    color: colors.textPrimary,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    backgroundColor: line.bg,
                    // 单 token 行的颜色/字重直接作用在行元素上（放在最后，
                    // 以便覆盖上面的 color: colors.textPrimary）
                    ...(line.style || {}),
                  }}
                  dangerouslySetInnerHTML={{
                    __html: line.html,
                  }}
                />
              ))}
            </div>
          </div>
          {diffHasMore && (
            <PreviewMoreHint
              shown={fittedDiffLines}
              total={totalDiffLines}
              expanded={diffExpanded}
              colors={colors}
              onClick={expandDiff}
            />
          )}
        </>
      )}
    </div>
  );
};
