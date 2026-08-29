import { DefaultLinesDiffComputer } from 'vscode-diff';

/**
 * 统计字符串行数（不生成行数组，避免大文件 split 的内存/耗时）
 */
function countLines(text: string): number {
  if (text.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

/**
 * 截取指定 1-based 行范围并拆分成行数组。
 * 只扫描范围内的换行符，避免对大文件先 split 全量行数组。
 */
function sliceLinesByLineRange(
  text: string,
  startLine: number,
  endLine: number,
): string[] {
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));

  if (text.length === 0) {
    return [''];
  }

  let lineStart = 0;
  let line = 1;
  while (line < safeStart) {
    const newlineIndex = text.indexOf('\n', lineStart);
    if (newlineIndex === -1) {
      return [''];
    }
    lineStart = newlineIndex + 1;
    line++;
  }

  let lineEnd = lineStart;
  let currentLine = safeStart;
  while (currentLine <= safeEnd) {
    const newlineIndex = text.indexOf('\n', lineEnd);
    if (newlineIndex === -1) {
      lineEnd = text.length;
      break;
    }
    lineEnd = newlineIndex + 1;
    currentLine++;
  }

  return text.substring(lineStart, lineEnd).split('\n');
}

export interface DiffLine {
  lineNumber: number;
  content: string;
  type: 'unchanged' | 'removed' | 'added';
  wordDiff?: Array<{
    text: string;
    type: 'unchanged' | 'removed' | 'added';
  }>;
}

export interface DiffHunk {
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
  lineNumber?: number,
): Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }> {
  if (!innerChanges || innerChanges.length === 0) {
    return [{ text: lineContent, type: 'unchanged' }];
  }

  const result: Array<{ text: string; type: 'unchanged' | 'removed' | 'added' }> = [];
  let lastPos = 1;

  const getRange = (change: DiffInnerChange) => {
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
    const currentLine = lineNumber ?? startLineNumber;

    if (startLineNumber === endLineNumber) {
      if (startLineNumber === currentLine) {
        effectiveChanges.push({ startColumn, endColumn });
      }
    } else {
      if (currentLine < startLineNumber || currentLine > endLineNumber) {
        continue;
      }
      if (currentLine === startLineNumber) {
        effectiveChanges.push({
          startColumn,
          endColumn: lineContent.length + 1,
        });
      } else if (currentLine === endLineNumber) {
        effectiveChanges.push({
          startColumn: 1,
          endColumn,
        });
      } else {
        effectiveChanges.push({
          startColumn: 1,
          endColumn: lineContent.length + 1,
        });
      }
    }
  }

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

/**
 * 根据完整 before/after 内容生成只包含 diff 相关行的 hunks。
 * 这是 webview Edit diff 渲染所需的最小数据集，避免把整个文件内容发给 webview。
 *
 * 行为与原 EditFile 内联实现保持一致：
 * - 非 replaceAll 且存在 startLine/endLine 时，只对编辑区域附近窗口做 diff；
 * - replaceAll 时回退到全量 diff，保证结果完整；
 * - 每个 hunk 仍包含少量上下文行，用于 UI 展示。
 */
export function buildEditDiffHunks(input: {
  beforeContent: string;
  afterContent: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
  contextLines?: number;
  windowPaddingLines?: number;
}): DiffHunk[] {
  const rawBeforeContent = input.beforeContent;
  const rawAfterContent = input.afterContent;
  if (!rawBeforeContent || !rawAfterContent) return [];

  const beforeContent = rawBeforeContent.includes('\r\n')
    ? rawBeforeContent.replace(/\r\n/g, '\n')
    : rawBeforeContent;
  const afterContent = rawAfterContent.includes('\r\n')
    ? rawAfterContent.replace(/\r\n/g, '\n')
    : rawAfterContent;

  const computer = new DefaultLinesDiffComputer();
  const contextLines = input.contextLines ?? 2;
  // diff 计算窗口在编辑区域外额外保留的行数。
  // 窗口只用于限制 computeDiff 的输入规模，渲染时仍会展示 contextLines 行上下文。
  const windowPaddingLines = input.windowPaddingLines ?? 20;

  const editStartLine = input.startLine;
  const editEndLine = input.endLine;
  // replaceAll 时 startLine/endLine 只覆盖第一处匹配，窗口 diff 会漏掉后续替换，
  // 因此 replaceAll 先回退到全量 diff，保证结果完整。
  const replaceAll = Boolean(input.replaceAll);
  const hasEditRange =
    !replaceAll &&
    typeof editStartLine === 'number' &&
    typeof editEndLine === 'number' &&
    editStartLine > 0 &&
    editEndLine >= editStartLine;

  const originalLineCount = countLines(beforeContent);
  const modifiedLineCount = countLines(afterContent);

  let diffResult;
  let originalWindow: string[];
  let modifiedWindow: string[];
  let originalOffset = 0;
  let modifiedOffset = 0;

  if (hasEditRange) {
    const originalWindowStart = Math.max(1, editStartLine - windowPaddingLines);
    const originalWindowEnd = Math.min(originalLineCount, editEndLine + windowPaddingLines);
    const modifiedWindowStart = originalWindowStart;
    // 编辑前后总行数差会整体平移修改侧的行号
    const modifiedEditEndLine = editEndLine + (modifiedLineCount - originalLineCount);
    const modifiedWindowEnd = Math.min(
      modifiedLineCount,
      modifiedEditEndLine + windowPaddingLines,
    );

    // 只截取编辑窗口附近的行，避免对大文件先 split 全量行数组
    originalWindow = sliceLinesByLineRange(beforeContent, originalWindowStart, originalWindowEnd);
    modifiedWindow = sliceLinesByLineRange(afterContent, modifiedWindowStart, modifiedWindowEnd);

    originalOffset = originalWindowStart - 1;
    modifiedOffset = modifiedWindowStart - 1;

    diffResult = computer.computeDiff(originalWindow, modifiedWindow, {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 0,
    });
  } else {
    originalWindow = beforeContent.split('\n');
    modifiedWindow = afterContent.split('\n');
    diffResult = computer.computeDiff(originalWindow, modifiedWindow, {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 0,
    });
  }

  const getOriginalLine = (lineNumber: number): string =>
    originalWindow[lineNumber - 1 - originalOffset] ?? '';
  const getModifiedLine = (lineNumber: number): string =>
    modifiedWindow[lineNumber - 1 - modifiedOffset] ?? '';

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
    const contextEndOriginal = Math.min(originalLineCount + 1, originalEnd + contextLines);
    const contextEndModified = Math.min(modifiedLineCount + 1, modifiedEnd + contextLines);

    // 添加上下文行（上方）
    for (let i = contextStart; i < Math.min(originalStart, modifiedStart); i++) {
      lines.push({
        lineNumber: i,
        content: getOriginalLine(i) || getModifiedLine(i),
        type: 'unchanged',
      });
    }

    // 添加删除的行（带单词级差异）
    for (let i = originalStart; i < originalEnd; i++) {
      const content = getOriginalLine(i);
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
      const content = getModifiedLine(i);
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
      const content = i <= modifiedLineCount ? getModifiedLine(i) : getOriginalLine(i);
      lines.push({
        lineNumber: i,
        content,
        type: 'unchanged',
      });
    }

    hunks.push({ lines });
  }

  return hunks;
}

/**
 * 判断一段 _meta 是否包含可发送给 webview 的紧凑 diff 数据所需字段。
 * 只用于 Edit 工具；Write 仍走原有 beforeContent/afterContent 字段。
 */
export function isEditMetaWithDiffContent(meta: Record<string, unknown> | undefined): meta is Record<string, unknown> & {
  beforeContent: string;
  afterContent: string;
} {
  return !!meta && typeof meta.beforeContent === 'string' && typeof meta.afterContent === 'string';
}
