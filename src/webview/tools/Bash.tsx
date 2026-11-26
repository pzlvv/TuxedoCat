import React, { useMemo, useLayoutEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { ToolCallProps } from './Types';
import { ToolHeader } from './ToolHeader';
import { postMessage, getWindowSessionId } from '../webviewEnv';
import { t } from '../i18n';
import { hasAnsi, renderAnsiToNodes, stripAnsi } from '../ansi';
import { formatSize, parsePersistedOutput } from './persistedOutput';
import { usePreviewLimit, PreviewMoreHint, TAIL_HINT_HEIGHT } from './previewLimit';

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

/**
 * 展开态输出框高度：缩略态的「提示条 + 输出框」总高。
 *
 * 提示条在展开后不再渲染（它提示的信息已由展开动作本身表达），让出的高度由输出框
 * 接管——卡片总高度在折叠 / 展开之间不变，展开后多出一整条提示条的高度用于显示内容。
 */
const OUTPUT_BOX_EXPANDED_HEIGHT = OUTPUT_BOX_HEIGHT + TAIL_HINT_HEIGHT;

export const Bash: React.FC<ToolCallProps> = ({ args, output, colors, toolCallId, status, isStreaming, onExpandToggle }) => {
  const command = args.command || '';
  const description = args.description || '';

  // 两个互斥的输出形态，输出框高度三态一致（OUTPUT_BOX_HEIGHT），且**渲染形态
  // 只有一套**（整段 <pre>，见 renderOutputContent 的 blockStyle 注释）：
  //   流式（isStreaming && running）：滚动容器 + 自动滚到底部，实时跟随最新输出；
  //   完成 / 历史加载：与 Edit / Write 预览同一套折叠实现（usePreviewLimit），
  //   按行高算出框高内放得下的整行数，缩略态只显示**末尾** fittedLines 行
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

  // 持久化输出「完整输出」按钮的大小文案（大小未知时留空，沿用既有文案形态）
  const persistedSizeStr = persistedInfo && persistedInfo.originalSize > 0
    ? formatSize(persistedInfo.originalSize)
    : '';

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

  // 整段渲染的文本：**逐行**给「渲染后没有字形」的行补一个 \u00A0。
  //
  // 判据是「去掉 ANSI 转义之后是否为空」，不是「原始串是否为空串」：一行只含
  // `\x1b[32m\x1b[0m` 这类序列时原始串非空，但 `renderAnsiToNodes` 不产出任何
  // 节点，于是它在整段 <pre> 里**不占行盒**——行数比 rawLines 少，行高与提示条
  // 行数都对不上。补上 \u00A0 后每一行都有一个行盒，逐行形态与整段形态的行高
  // 严格一致，输出框不会再围绕「放得下 ↔ 放不下」反复变高变矮（闪烁）。
  //
  // 末行的空行同样要补：`white-space: pre` 只保留中间的空行，末尾那一个换行
  // 不产生行盒（实测 `"a\n"` 与 `"a"` 同高）。
  const blockText = useMemo(
    () => rawLines.map((line) => (stripAnsi(line) === '' ? `${line}\u00A0` : line)).join('\n'),
    [rawLines],
  );

  // 与 Edit / Write 同一套预览折叠（usePreviewLimit），但测量口径是 `line-box`：
  // Bash 输出框里的文本不折行（`white-space: pre`，超宽行走省略号），所有视觉
  // 行盒同高，放得下的整行数由行高算出，不逐行实测。展开状态由 hook 持有
  // （不可逆，与卡片共存亡）。
  const {
    contentRef,
    contentEl,
    fittedLines,
    hasMore,
    expanded,
    expand,
  } = usePreviewLimit(rawLines.length, false, {
    revision: previewText,
    // 输出框与流式滚动容器同高（115），缩略/展开卡片总高度都不变
    contentHeight: OUTPUT_BOX_HEIGHT,
    measurement: 'line-box',
    // 展开会让消息区出现滚动条交互，通知外层暂停自动滚动（与 Edit / Write 一致）
    onExpand: () => onExpandToggle?.(true),
  });

  // 完成态输出框钉在底部（流式容器由上方 outputRef effect 负责）：
  //   缩略态 overflow hidden、程序滚动——框高装不下的行被裁在上方，
  //   可见窗口仍落在整段内容的**末尾** fittedLines 行；
  //   展开态换成 overflow auto 出滚动条，同样先钉在底部——与缩略态视点
  //   连续（看到的就是刚才那几行），之后由用户向上滚动查看更早输出。
  // 内容或行数变化（fittedLines、blockText）或状态切换时重新钉一次；
  // 用户手动滚动后依赖不变，不会被拽回底部。
  useLayoutEffect(() => {
    if (!hasMore) return;
    const el = contentEl;
    if (!el) return;
    el.scrollTop = SCROLL_TO_BOTTOM;
  }, [hasMore, expanded, fittedLines, blockText, contentEl]);

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

    const cursorStyle: React.CSSProperties = {
      display: 'inline-block',
      verticalAlign: 'text-bottom',
      width: '0.55em',
      height: '1.1em',
      backgroundColor: colors.textPrimary,
      animation: 'bashCursorBlink 1s step-end infinite',
    };

    // ─── 唯一的渲染形态：整段 <pre> ──────────────────────────────────
    // 流式 / 完成缩略 / 完成展开三态渲染的是**同一个** `<pre>`、同一份文本节点
    // 结构，区别只有外层框高与 overflow（见下方各分支）。此前缩略态是
    // 「逐行 <div> + 空行用 \u00A0 占位」，展开与流式是整段 <pre>，两套实现的
    // 行数口径一旦不同（一行只含 ANSI 转义时渲染后不产出任何节点、不占行盒），
    // 高度就围绕「放得下 ↔ 放不下」逐帧翻转，输出框 115 ↔ 自然高度来回跳、
    // 整页跟着闪。现在两形态合一，这个差异在结构上不存在。
    //
    // 段落内不折行（`white-space: pre`），超宽行由 ellipsis 在行末收尾——
    // 多行 <pre> 的省略号逐行生效，与逐行 <div> 逐一省略的视觉结果一致。
    // 整段解析意味着 ANSI 状态跨行延续，这与真实终端一致。
    const blockStyle: React.CSSProperties = {
      // 只覆盖 font-family（<pre> 的 UA 样式是 monospace，不继承）；
      // 不能用 `font: inherit` 简写——它会连带把 line-height 重置成继承值
      // （实测 16.5px vs 17.6px，每行差 1.1px 会让整卡位移）。
      fontFamily: 'inherit',
      margin: 0,
      padding: 0,
      whiteSpace: 'pre',
      overflow: 'hidden',
      // 超宽行末尾显示省略号而不是溢出
      textOverflow: 'ellipsis',
      lineHeight: '1.6',
    };

    /**
     * 整段渲染。`withCursor` 在末尾内联一个光标块（流式态）：光标紧跟最后一行
     * 末尾、不额外占行，因此流式与完成态的行高始终一致。
     */
    const renderBlock = (text: string, withCursor: boolean) => (
      <pre style={blockStyle}>
        {hasAnsi(text) ? renderAnsiToNodes(text) : text}
        {withCursor && <span style={cursorStyle} />}
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
          {/* 流式输出内容：自动滚动到底部，末尾显示闪烁光标。空输出时
              <pre> 里只剩光标块，高度仍是一行。 */}
          <div
            ref={outputRef}
            className="overflow-auto cursor-pointer inner-scrollbar"
            style={{ maxHeight: OUTPUT_BOX_HEIGHT }}
            onClick={handleOutputClick}
            title={t('tool.bash.clickFullOutput')}
          >
            {renderBlock(blockText, true)}
          </div>
        </div>
      );
    }

    // ─── 完成态（含历史加载）：与流式同高的折叠框，卡片总高度不变 ────
    // 两个分支渲染的都是整段 <pre>（与流式同一份实现、同一份文本），只有外层
    // 框高与 overflow 不同：
    // 缩略：框高固定 OUTPUT_BOX_HEIGHT、overflow hidden，由钉底 effect 让可见
    //       窗口落在末尾 fittedLines 行 → 行数再多也不出滚动条；
    // 展开：提示条隐藏、输出框接管它的高度（缩略高度 + 提示条高度），
    //       卡片总高不变；overflow 换成 auto 出现框内滚动条，初始视点仍在
    //       底部、可向上滚；
    // 提示条在输出框**上方**（tail 变体，chevron 朝上）：Bash 显示的是末尾，
    // 更多内容在上方，展开即向上滚。
    // 内容上限已在工具层统一执行（4K，前 2K + 后 2K）。
    const collapsed = hasMore && !expanded;
    // 展开态输出框高度：提示条不再占位，由输出框接管它的高度，卡片总高不变
    const boxHeight = hasMore ? (expanded ? OUTPUT_BOX_EXPANDED_HEIGHT : OUTPUT_BOX_HEIGHT) : undefined;

    const outputBox = (
      <div
        ref={contentRef}
        className={expanded ? 'cursor-pointer inner-scrollbar' : 'cursor-pointer'}
        onClick={handleOutputClick}
        title={t('tool.bash.clickFullOutput')}
        style={{
          // 缩略固定框高；展开 = 缩略高度 + 提示条高度（提示条已隐藏）；
          // 行数不足一框（无 hasMore）时自然高度、无滚动条。
          maxHeight: boxHeight,
          height: collapsed ? OUTPUT_BOX_HEIGHT : expanded ? boxHeight : undefined,
          overflow: expanded ? 'auto' : 'hidden',
        }}
      >
        {renderBlock(blockText, false)}
      </div>
    );

    // 超行提示条（tail 变体）放在输出框上方：显示的是末尾段，向上展开。提示条整条
    // 铺满命令卡片（不随输出框内缩），只自绘下边那一条作为与输出框之间的分割线——
    // 上 / 左 / 右三边落在卡片已有的线条上（命令行下边框、卡片外框），再画就是双圈。
    // 展开后提示条不再渲染——它让出的高度由输出框接管，卡片总高度不变，多出的空间
    // 用于显示内容。
    const moreHint = hasMore && !expanded && (
      <PreviewMoreHint
        shown={fittedLines}
        total={rawLines.length}
        expanded={expanded}
        tail
        colors={colors}
        onClick={expand}
      />
    );

    return (
      <>
        {moreHint}
        <div
          className="px-3 py-2 ui-fs-11 font-mono"
          style={{
            backgroundColor: colors.bgSecondary,
            color: colors.textSystem,
          }}
        >
          {outputBox}
        </div>
      </>
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
          {/* 超大输出被持久化到磁盘时，「完整输出」入口与复制按钮并排放在
              命令行右侧，不再单独占一行 */}
          {persistedInfo?.filePath && (
            <button
              onClick={handleOpenPersistedFile}
              className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer hover:underline ui-fs-12"
              style={{
                background: 'none',
                border: 'none',
                color: colors.harness,
                // 只继承字体族：字号交给 ui-fs-12（与同行命令文字同档），
                // 用 `font: inherit` 简写会把 class 的字号一并覆盖掉。
                fontFamily: 'inherit',
              }}
              title={t('tool.bash.openFullOutputFile')}
            >
              <Icon name="file" size={12} />
              {t('tool.bash.fullOutput', { size: persistedSizeStr })}
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
