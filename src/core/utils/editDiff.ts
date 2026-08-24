import { DefaultLinesDiffComputer } from 'vscode-diff';

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

  const beforeContent = rawBeforeContent.replace(/\r\n/g, '\n');
  const afterContent = rawAfterContent.replace(/\r\n/g, '\n');

  const originalLines = beforeContent.split('\n');
  const modifiedLines = afterContent.split('\n');

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

  let diffResult;
  let originalOffset = 0;
  let modifiedOffset = 0;

  if (hasEditRange) {
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
