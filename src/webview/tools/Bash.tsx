import React, { useMemo, useLayoutEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage } from '../webviewEnv';
import { t } from '../i18n';
import { AnsiText, hasAnsi, renderAnsiToNodes } from '../ansi';

/**
 * 解析持久化输出标签
 * 格式:
 * <persisted-output>
 * Output too large (XXKB). Full output saved to: /path/to/file
 *
 * Preview (first 8KB):
 * ...preview text...
 * ...
 * </persisted-output>
 */
function parsePersistedOutput(output: string): {
  isPersisted: boolean;
  originalSize: number;
  filePath: string;
  preview: string;
  hasMore: boolean;
} | null {
  const persistedTag = '<persisted-output>';
  const closingTag = '</persisted-output>';

  const startIdx = output.indexOf(persistedTag);
  const endIdx = output.indexOf(closingTag);

  if (startIdx === -1 || endIdx === -1) {
    return null;
  }

  const body = output.slice(startIdx + persistedTag.length, endIdx).trim();

  // 解析文件路径
  // 格式: "Output too large (XXKB). Full output saved to: /path/to/file"
  const filePathMatch = body.match(/Full output saved to: (.+)$/m);
  const sizeMatch = body.match(/Output too large \((\d+)KB\)/);

  // 预览文本在 "Preview (first 8KB):" 之后
  const previewMarker = 'Preview';
  const previewMarkerIdx = body.indexOf(previewMarker);
  let preview = '';
  let hasMore = false;

  if (previewMarkerIdx !== -1) {
    // 跳过 "Preview (first 8KB):\n"
    const previewStart = body.indexOf('\n', previewMarkerIdx);
    if (previewStart !== -1) {
      preview = body.slice(previewStart + 1).trimEnd();
      // 移除末尾的 "..." 和 closing tag 之前的内容
      if (preview.endsWith('...')) {
        hasMore = true;
        preview = preview.slice(0, -3).trimEnd();
      }
      // 去掉末尾可能残留的换行
      preview = preview.replace(/\n\.\.\.$/, '');
    }
  }

  return {
    isPersisted: true,
    originalSize: sizeMatch ? parseInt(sizeMatch[1], 10) * 1024 : 0,
    filePath: filePathMatch ? filePathMatch[1] : '',
    preview,
    hasMore,
  };
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 输出行渲染上限：超长输出（如构建日志、测试输出）只渲染末尾窗口，
 * 避免一次渲染数万个 DOM 节点导致卡顿。盒子本身 maxHeight 只有 115px，
 * 300 行已足够滚动浏览；完整输出可点击打开虚拟文档/持久化文件。
 */
const MAX_RENDERED_LINES = 300;

/**
 * 用于「滚到底部」的超大 scrollTop 值。
 * 浏览器会把它夹到 scrollHeight - clientHeight，因此无需读取 scrollHeight
 * （读取会强制同步布局，见下方 useLayoutEffect 的注释）。
 */
const SCROLL_TO_BOTTOM = 1e9;

export const Bash: React.FC<ToolCallProps> = ({ args, output, colors, toolCallId, status, isStreaming }) => {
  const command = args.command || '';
  const description = args.description || '';

  // 输出内容变化或流式结束时自动滚动到底部。
  // 注意：流式状态切换会挂载新的滚动容器（流式 div ↔ 普通 div），
  // 因此 ref 必须同时挂到所有输出容器上，且滚动不依赖 isStreaming 条件——
  // 否则执行完成后新容器停留在顶部（滚动条不在最后）。
  // 使用 useLayoutEffect 在绘制前同步滚动，避免长输出先闪一下顶部内容。
  const outputRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    // 滚到底部：直接写一个远超最大值的数，浏览器按 CSSOM View 规范把它夹到
    // scrollHeight - clientHeight，等价于原来的 `scrollTop = scrollHeight`，
    // 但省掉一次 scrollHeight 读取。
    // 这一步很关键：本 effect 在 React 提交后立即执行，此时布局是脏的，
    // 读 scrollHeight 会强制整棵消息树同步重排。539 条消息的会话实测
    // 56 次读取累计 190ms，是本页最大的 JS 热点（滚动容器只有 115px 高，
    // 每次重排都要重新计算整个 19000+ 节点的容器）。
    el.scrollTop = SCROLL_TO_BOTTOM;
  }, [output, isStreaming, status]);

  // 构造唯一 title，编码 toolCallId 确保每个 Bash 框有独立的虚拟文档
  const outputTitle = toolCallId ? `Bash Output (${toolCallId})` : 'Bash Output';
  const commandTitle = toolCallId ? `Bash Command (${toolCallId})` : 'Bash Command';

  // 解析持久化输出信息
  const persistedInfo = useMemo(() => {
    if (!output) return null;
    return parsePersistedOutput(output);
  }, [output]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (command) {
      navigator.clipboard.writeText(command);
    }
  };

  const handleCommandClick = () => {
    if (command) {
      postMessage({
        type: 'showVirtualDocument',
        content: command,
        title: commandTitle,
        language: 'shellscript',
      });
    }
  };

  const handleOutputClick = () => {
    if (output) {
      postMessage({
        type: 'showVirtualDocument',
        content: output,
        title: outputTitle,
      });
    }
  };

  const handleOpenPersistedFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (persistedInfo?.filePath) {
      postMessage({
        type: 'openFile',
        filePath: persistedInfo.filePath,
      });
    }
  };

  // 构建输出内容显示
  const renderOutputContent = () => {
    if (!output) return null;

    // ─── 流式/完成共用同一套结构，保证切换时高度一致、显示连续 ───
    // 外层 px-3 py-2（padding 不参与 maxHeight 计算），内层滚动容器 maxHeight: 115，
    // 行样式、尾部空行裁剪规则也保持一致，避免流式结束后高度跳变。
    const lineStyle: React.CSSProperties = {
      whiteSpace: 'pre',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      lineHeight: '1.6',
    };
    const cursorStyle: React.CSSProperties = {
      display: 'inline-block',
      verticalAlign: 'text-bottom',
      width: '0.55em',
      height: '1.1em',
      backgroundColor: colors.textPrimary,
      animation: 'bashCursorBlink 1s step-end infinite',
    };
    // 去掉末尾因换行产生的空行（流式与完成共用同一行数，避免光标/高度差异）
    const rawLines = output.split('\n');
    while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    const lines = rawLines;

    // ─── 行数裁剪：超长输出只渲染末尾窗口 ───────────────────────────
    // key 使用绝对行号（hiddenLines + idx）：流式时窗口每帧滑动 1 行，
    // 大部分行 key 不变可复用 DOM 节点，只有滑出/滑入的少量行变化。
    const totalLines = lines.length;
    const hiddenLines = totalLines > MAX_RENDERED_LINES ? totalLines - MAX_RENDERED_LINES : 0;
    const visibleLines = hiddenLines > 0 ? lines.slice(hiddenLines) : lines;

    // 统一行渲染（withCursor 用于流式末尾光标）
    const renderLines = (withCursor: boolean) => (
      <>
        {hiddenLines > 0 && (
          <div
            style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
          >
            {t('tool.bash.linesHidden', { count: hiddenLines })}
          </div>
        )}
        {visibleLines.map((line, idx) => (
          <div key={hiddenLines + idx} style={lineStyle}>
            {line ? <AnsiText text={line} /> : '\u00A0'}
            {/* 光标内联在最后一行末尾，不额外占一行，保证高度与完成态一致 */}
            {withCursor && idx === visibleLines.length - 1 && <span style={cursorStyle} />}
          </div>
        ))}
      </>
    );

    // ─── 非流式：整段一次性渲染 ──────────────────────────────────────
    // 逐行 <div> 的唯一作用是承载 line-height 与「逐行独立解析 ANSI」。
    // 实测 4248 个输出行里只有 1.5% 含 ANSI 转义，为这 1.5% 让每行都付一个
    // div + 一个文本节点的代价并不划算。因此输出定型后（执行完成 / 从历史
    // 加载）改为整段渲染：
    //   不含 ANSI → 只有一个文本节点
    //   含 ANSI   → 只给着色片段包 <span>，其余仍是文本节点
    // 空行由 <pre> 的 white-space:pre 自然保留（无需 \u00A0 占位）。
    // 注意：整段解析意味着 ANSI 状态会跨行延续，这与真实终端一致
    //（逐行解析时每行都会重置，属于旧实现的副作用）。
    const blockStyle: React.CSSProperties = {
      // 只覆盖 font-family（<pre> 的 UA 样式是 monospace，不继承）；
      // 不能用 `font: inherit` 简写——它会连带把 line-height 重置成继承值
      // （实测 16.5px vs 逐行 div 的 17.6px，每行差 1.1px 会让整卡位移）。
      fontFamily: 'inherit',
      margin: 0,
      padding: 0,
      whiteSpace: 'pre',
      overflow: 'hidden',
      // 与逐行 div 一致：超宽行末尾显示省略号而不是溢出
      textOverflow: 'ellipsis',
      lineHeight: '1.6',
    };

    const renderBlock = () => {
      const text = visibleLines.join('\n');
      return (
        <>
          {hiddenLines > 0 && (
            <div
              style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}
              onClick={handleOutputClick}
              title={t('tool.bash.clickFullOutput')}
            >
              {t('tool.bash.linesHidden', { count: hiddenLines })}
            </div>
          )}
          <pre style={blockStyle}>
            {hasAnsi(text) ? renderAnsiToNodes(text) : text}
          </pre>
        </>
      );
    };

    // ─── 流式输出：实时显示最新累积输出 + 自动滚动 ───
    if (isStreaming && status === 'running') {
      return (
        <div
          className="px-3 py-2 text-[11px] font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {/* 流式输出内容：自动滚动到底部，末尾显示闪烁光标 */}
          <div
            ref={outputRef}
            className="overflow-auto cursor-pointer"
            style={{ maxHeight: 115 }}
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
          >
            {lines.length === 0 ? (
              <span style={cursorStyle} />
            ) : (
              renderLines(true)
            )}
          </div>
        </div>
      );
    }

    // 如果是持久化输出，显示预览和文件链接
    if (persistedInfo) {
      const sizeStr = persistedInfo.originalSize > 0
        ? formatSize(persistedInfo.originalSize)
        : '';

      return (
        <div
          className="px-3 py-2 text-[11px] font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {/* 大小提示栏：仅保留“完整输出”按钮 */}
          <div
            className="flex items-center justify-end mb-2 pb-1.5 text-[11px]"
            style={{
              borderBottom: `1px solid ${colors.border}`,
              color: colors.textSystem,
            }}
          >
            <button
              onClick={handleOpenPersistedFile}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer hover:underline"
              style={{
                background: 'none',
                border: `1px solid ${colors.border}`,
                color: colors.harness,
                font: 'inherit',
                fontSize: 'inherit',
              }}
              title={t('tool.bash.openFullOutputFile')}
            >
              <Icon name="file" size={10} />
              {t('tool.bash.fullOutput', { size: sizeStr })}
            </button>
          </div>

          {/* 预览内容：与流式共用滚动容器（maxHeight 115），不换行截断。
              这里同样是整段渲染（加载历史时走这条路径）。 */}
          <div
            ref={outputRef}
            className="cursor-pointer overflow-auto"
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
            style={{ maxHeight: 115 }}
          >
            {(() => {
              const previewLines = persistedInfo.preview.split('\n');
              const MAX_PREVIEW_LINES = 5;
              const showTruncated = previewLines.length > MAX_PREVIEW_LINES;
              const displayLines = showTruncated ? previewLines.slice(0, MAX_PREVIEW_LINES) : previewLines;
              const text = displayLines.join('\n');
              return (
                <>
                  <pre style={blockStyle}>
                    {hasAnsi(text) ? renderAnsiToNodes(text) : text}
                  </pre>
                  {showTruncated && (
                    <div style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}>
                      {t('tool.bash.previewTruncated', { count: previewLines.length, size: formatSize(persistedInfo.originalSize) })} ...
                    </div>
                  )}
                  {!showTruncated && persistedInfo.hasMore && (
                    <div style={{ color: colors.textSystem, opacity: 0.7, whiteSpace: 'pre', lineHeight: '1.6' }}>
                      ...
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      );
    }

    // 普通输出：与流式显示共用同一滚动结构，完成后高度与流式保持一致
    return (
      <div
        className="px-3 py-2 text-[11px] font-mono"
        style={{
          backgroundColor: colors.bgSecondary,
          color: colors.textSystem,
        }}
      >
        <div
          ref={outputRef}
          className="overflow-auto cursor-pointer"
          style={{ maxHeight: 115 }}
          onClick={handleOutputClick}
          title={t('tool.bash.clickFullOutput')}
        >
          {/* 执行完成 / 从历史加载：按是否含 ANSI 分流整段渲染 */}
          {renderBlock()}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full">
      {/* 第一行：工具名 + 描述 */}
      <ToolHeader icon="Terminal" name="Bash" colors={colors}>
        {description && (
          <span style={{ color: colors.textSystem }}>{description}</span>
        )}
      </ToolHeader>

      {/* 第二行：命令面板 */}
      <div
        className="w-full max-w-[95%] rounded-lg overflow-hidden mt-1"
        style={{
          backgroundColor: colors.bgSecondary,
          border: `1px solid ${colors.border}`,
        }}
      >
        {/* 命令行 */}
        <div
          className="flex items-center gap-2 px-3 border-b"
          style={{
            borderColor: colors.border,
            backgroundColor: colors.primaryFrame,
            minHeight: '32px',
          }}
        >
          <div className="flex-1 min-w-0">
            <button
              onClick={handleCommandClick}
              className="text-[12px] font-mono truncate cursor-pointer text-left w-full"
              style={{
                color: colors.textPrimary,
                background: 'none',
                border: 'none',
                padding: 0,
              }}
              title={t('tool.bash.clickFullCommand')}
            >
              {command}
            </button>
          </div>
          <button
            onClick={handleCopy}
            className="flex-shrink-0 p-1 rounded hover:bg-opacity-80 transition-colors"
            style={{ backgroundColor: 'transparent' }}
            title={t('tool.bash.copyCommand')}
          >
            <Icon name="copy" size={12} style={{ color: colors.textSystem }} />
          </button>
        </div>

        {/* 执行结果 */}
        {output && renderOutputContent()}
      </div>
    </div>
  );
};
