import React, { useMemo, useLayoutEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';
import { AnsiText, hasAnsi, renderAnsiToNodes } from '../ansi';
import { formatSize, parsePersistedOutput } from './persistedOutput';
import { usePreviewLimit, PreviewMoreHint } from './previewLimit';

/**
 * 用于「滚到底部」的超大 scrollTop 值。
 * 浏览器会把它夹到 scrollHeight - clientHeight，因此无需读取 scrollHeight
 * （读取会强制同步布局，见下方 useLayoutEffect 的注释）。
 */
const SCROLL_TO_BOTTOM = 1e9;

/**
 * 输出框高度（流式 / 完成缩略 / 完成展开三态同高）。
 * 与旧版滚动容器的 115px 一致：展开只是出现框内滚动条，卡片总高度不变。
 */
const OUTPUT_BOX_HEIGHT = 115;

export const Bash: React.FC<ToolCallProps> = ({ args, output, colors, toolCallId, status, isStreaming, onExpandToggle }) => {
  const command = args.command || '';
  const description = args.description || '';

  // 两个互斥的输出形态，输出框高度三态一致（OUTPUT_BOX_HEIGHT）：
  //   流式（isStreaming && running）：滚动容器 + 自动滚到底部，实时跟随最新输出；
  //   完成 / 历史加载：与 Edit / Write 预览同一套折叠实现（usePreviewLimit）——
  //   逐行实测在框高内放得下的整行数，缩略态只显示**末尾** fittedLines 行
  //   （overflow hidden，无滚动条）；点击上方提示条展开：框高不变，只是换成
  //   overflow auto 出现框内滚动条，内容渲染全部行、初始视点仍在底部，可向上
  //   滚动查看更早输出。取末尾而非开头：与流式期间「最新输出在底部」的阅读
  //   位置一致，执行完成后视线不用跳。
  const streaming = isStreaming && status === 'running';

  // 流式输出内容变化时自动滚动到底部。outputRef 只挂在流式容器上——完成态
  // 的钉底由下方 contentRef effect 负责（缩略态程序钉底无滚动条、展开态钉底
  // 后由用户接管滚动）。
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
  }, [output, streaming, status]);

  // 构造唯一 title，编码 toolCallId 确保每个 Bash 框有独立的虚拟文档
  const outputTitle = toolCallId ? `Bash Output (${toolCallId})` : 'Bash Output';
  const commandTitle = toolCallId ? `Bash Command (${toolCallId})` : 'Bash Command';

  // 解析持久化输出信息
  const persistedInfo = useMemo(() => {
    if (!output) return null;
    return parsePersistedOutput(output);
  }, [output]);

  // 折叠预览的源文本：持久化输出用其预览（前 2K + 后 2K，末尾行即真实输出的
  // 末尾行），其余用原始输出。流式期间一律用原始输出（持久化标签随 toolResult
  // 才到达，且命令回显里出现同名标签时不能误判）。
  //
  // CRLF 必须在这里归一成 \n：行 div（white-space: pre）对孤立 \r 不产生换行，
  // 只含 \r 的空行高度为 0；而展开态整段 <pre> 里 \r\n 是真实换行、空行占一行。
  // 同一输出在两种形态下高度不等时，usePreviewLimit 的实测会围绕「放得下 ↔
  // 放不下」逐帧翻转（输出框 115 ↔ 自然高度），整页后半部分跟着闪烁。
  const previewText = (
    streaming
      ? (output || '')
      : persistedInfo
        ? persistedInfo.preview
        : (output || '')
  ).replace(/\r\n/g, '\n');

  // 去掉末尾因换行产生的空行（流式与完成共用同一行数，避免光标/高度差异）
  const rawLines = useMemo(() => {
    const arr = previewText.split('\n');
    while (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
    return arr;
  }, [previewText]);

  // 与 Edit / Write 同一套预览折叠（usePreviewLimit）：逐行实测真实高度、
  // 只显示放得下的整行，宽度变化时自动重测。Bash 行不折行（超宽行走省略号），
  // 实测主要兜字号缩放等行高变化。展开状态由 hook 持有（不可逆，与卡片共存亡）。
  const {
    contentRef,
    visibleLines,
    fittedLines,
    hasMore,
    expanded,
    expand,
  } = usePreviewLimit(rawLines.length, false, {
    revision: previewText,
    // 输出框与流式滚动容器同高（115），缩略/展开卡片总高度都不变
    contentHeight: OUTPUT_BOX_HEIGHT,
    // 展开会让消息区出现滚动条交互，通知外层暂停自动滚动（与 Edit / Write 一致）
    onExpand: () => onExpandToggle?.(true),
  });

  // 完成态输出框钉在底部（流式容器由上方 outputRef effect 负责）：
  //   缩略态 overflow hidden、程序滚动——实测放得下的行数少于候选数时
  //   （字号放大等），可见窗口仍落在候选段的**末尾** fittedLines 行；
  //   展开态换成 overflow auto 出滚动条，同样先钉在底部——与缩略态视点
  //   连续（看到的就是刚才那几行），之后由用户向上滚动查看更早输出。
  // 内容/行高变化（ fittedLines、previewText）或状态切换时重新钉一次；
  // 用户手动滚动后依赖不变，不会被拽回底部。
  useLayoutEffect(() => {
    if (!hasMore) return;
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = SCROLL_TO_BOTTOM;
  }, [hasMore, expanded, fittedLines, previewText, contentRef]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (command) {
      navigator.clipboard.writeText(command);
    }
  };

  // 转后台：只对「正在前台执行」的命令有意义（status === 'running' 才渲染按钮）。
  // 点击后 core 侧把该次执行转入后台并暂停下一轮 agent 循环；按钮随工具卡片
  // 收到 toolResult 自然消失，重复点击在 core 侧幂等。
  const handleBackground = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sid = getWindowSessionId();
    if (!sid || !toolCallId) return;
    postMessage({
      type: 'backgroundBashTool',
      sessionId: sid,
      toolUseId: toolCallId,
    });
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

    // 逐行 div 样式：流式与缩略态共用。每行独立 ellipsis（超宽行末尾省略号
    // 而不是横向溢出），行高与整段渲染的 <pre> 一致。
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

    // 统一行渲染（withCursor 用于流式末尾光标）
    const renderLines = (lines: string[], withCursor: boolean) => (
      <>
        {lines.map((line, idx) => (
          <div key={idx} style={lineStyle}>
            {line ? <AnsiText text={line} /> : '\u00A0'}
            {/* 光标内联在最后一行末尾，不额外占一行，保证高度与完成态一致 */}
            {withCursor && idx === lines.length - 1 && <span style={cursorStyle} />}
          </div>
        ))}
      </>
    );

    // ─── 整段渲染（展开态 / 行数未超上限）─────────────────────────────
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

    const renderBlock = (text: string) => (
      <pre style={blockStyle}>
        {hasAnsi(text) ? renderAnsiToNodes(text) : text}
      </pre>
    );

    // ─── 流式输出：实时显示最新累积输出 + 自动滚动 ───
    if (streaming) {
      return (
        <div
          className="px-3 py-2 ui-fs-11 font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {/* 流式输出内容：自动滚动到底部，末尾显示闪烁光标 */}
          <div
            ref={outputRef}
            className="overflow-auto cursor-pointer"
            style={{ maxHeight: OUTPUT_BOX_HEIGHT }}
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
          >
            {rawLines.length === 0 ? (
              <span style={cursorStyle} />
            ) : (
              renderLines(rawLines, true)
            )}
          </div>
        </div>
      );
    }

    // ─── 完成态（含历史加载）：与流式同高的折叠框，卡片总高度不变 ────
    // 缩略：渲染 min(total, PREVIEW_LINES) 行**候选段**（取末尾，逐行 div 供
    //       usePreviewLimit 实测），框高固定 OUTPUT_BOX_HEIGHT、overflow
    //       hidden，由钉底 effect 让可见窗口落在末尾 fittedLines 行 → 行数
    //       再多也不出滚动条；
    // 展开：框高不变，overflow 换成 auto 出现框内滚动条，内容整段 <pre>
    //       渲染全部行（见 blockStyle 注释），初始视点仍在底部、可向上滚；
    // 提示条在输出框**上方**（tail 变体，chevron 朝上）：Bash 显示的是末尾，
    // 更多内容在上方，展开即向上滚。
    // 内容上限已在工具层统一执行（4K，前 2K + 后 2K）。
    // 注意：候选段必须按 visibleLines 渲染满（不能按 fittedLines 切小）——
    // hook 的实测只看已渲染的行，切小会让「实测 → 少渲染 → 实测」自锁在 1 行。
    const collapsed = hasMore && !expanded;
    const candidateLines = collapsed ? rawLines.slice(-visibleLines) : rawLines;

    const outputBox = (
      <div
        ref={contentRef}
        className="cursor-pointer"
        onClick={handleOutputClick}
        title={t('tool.bash.clickFullOutput')}
        style={{
          // 三态同高：缩略固定框高；展开只放开滚动（maxHeight 兜住）；
          // 行数不足一框（无 hasMore）时自然高度、无滚动条。
          maxHeight: hasMore ? OUTPUT_BOX_HEIGHT : undefined,
          height: collapsed ? OUTPUT_BOX_HEIGHT : undefined,
          overflow: expanded ? 'auto' : 'hidden',
        }}
      >
        {collapsed ? renderLines(candidateLines, false) : renderBlock(rawLines.join('\n'))}
      </div>
    );

    // 超行提示条用 flat 变体（不自绘边框，边框交给外层命令卡片），放在输出框
    // 上方：显示的是末尾段，向上展开。
    const moreHint = hasMore && (
      <PreviewMoreHint
        shown={fittedLines}
        total={rawLines.length}
        expanded={expanded}
        flat
        tail
        colors={colors}
        onClick={expand}
      />
    );

    // 如果是持久化输出，顶部保留「完整输出」按钮栏
    if (persistedInfo) {
      const sizeStr = persistedInfo.originalSize > 0
        ? formatSize(persistedInfo.originalSize)
        : '';

      return (
        <div
          className="px-3 py-2 ui-fs-11 font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {/* 大小提示栏：仅保留“完整输出”按钮 */}
          <div
            className="flex items-center justify-end mb-2 pb-1.5 ui-fs-11"
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

          {moreHint}
          {outputBox}
        </div>
      );
    }

    return (
      <div
        className="px-3 py-2 ui-fs-11 font-mono"
        style={{
          backgroundColor: colors.bgSecondary,
          color: colors.textSystem,
        }}
      >
        {moreHint}
        {outputBox}
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
              className="ui-fs-12 font-mono truncate cursor-pointer text-left w-full"
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
          {status === 'running' && (
            <button
              onClick={handleBackground}
              className="flex-shrink-0 p-1 rounded hover:bg-opacity-80 transition-colors"
              style={{ backgroundColor: 'transparent' }}
              title={t('tool.bash.moveBackground')}
            >
              <Icon name="clock" size={12} style={{ color: colors.textSystem }} />
            </button>
          )}
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
