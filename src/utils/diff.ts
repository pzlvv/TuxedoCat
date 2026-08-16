/**
 * 文件差异计算工具
 * 用于计算编辑前后的文件差异，生成 unified diff 格式的 patch
 */

import { structuredPatch, type Hunk } from 'diff';

/**
 * 上下文行数（diff 显示的上下文）
 */
export const CONTEXT_LINES = 3;

/**
 * 转义字符串用于 diff 计算
 * diff 库对 & 和 $ 字符有特殊处理，需要先转义
 */
function escapeForDiff(str: string): string {
  return str.replaceAll('&', '<<:AMPERSAND_TOKEN:>>').replaceAll('$', '<<:DOLLAR_TOKEN:>>');
}

/**
 * 从 diff 结果中恢复转义的字符
 */
function unescapeFromDiff(str: string): string {
  return str.replaceAll('<<:AMPERSAND_TOKEN:>>', '&').replaceAll('<<:DOLLAR_TOKEN:>>', '$');
}

/**
 * 限制 diff 计算的行范围（1-based，含端点）。
 * 传入后 diff 只会在该范围前后各 contextLines 行的窗口内计算，
 * 避免大文件 Edit 场景下对全量内容做 diff。
 */
export interface LineRange {
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
}

/**
 * 计算两个内容片段之间的 diff hunks
 */
function computePatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  ignoreWhitespace: boolean,
  contextLines: number,
): Hunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      context: contextLines,
    },
  );

  if (!result) {
    return [];
  }

  return result.hunks.map(hunk => ({
    ...hunk,
    lines: hunk.lines.map(unescapeFromDiff),
  }));
}

/**
 * 按 1-based 行范围截取内容片段。
 *
 * 行定义与 diff 库的 lineDiff 保持一致：每行包含行尾换行符；
 * 文件末尾无换行符时最后一行不包含换行符。
 * 截取时只扫描到目标行，不生成完整行数组，避免大文件场景下的额外内存开销。
 */
function sliceContentByLineRange(
  content: string,
  startLine: number,
  endLine: number,
): { text: string; offset: number } {
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));

  if (content.length === 0 || safeStart > safeEnd) {
    return { text: '', offset: safeStart - 1 };
  }

  // 定位 startLine 的起始偏移
  let lineStart = 0;
  let line = 1;

  while (line < safeStart) {
    const newlineIndex = content.indexOf('\n', lineStart);
    if (newlineIndex === -1) {
      // 起始行超过文件总行数，返回空片段
      return { text: '', offset: line - 1 };
    }
    lineStart = newlineIndex + 1;
    line++;
  }

  // 定位 endLine 的结束偏移（包含该行的行尾换行符）
  let lineEnd = lineStart;
  let currentLine = safeStart;
  while (currentLine <= safeEnd) {
    const newlineIndex = content.indexOf('\n', lineEnd);
    if (newlineIndex === -1) {
      lineEnd = content.length;
      break;
    }
    lineEnd = newlineIndex + 1;
    currentLine++;
  }

  return {
    text: content.substring(lineStart, lineEnd),
    offset: safeStart - 1,
  };
}

/**
 * 计算两个文件内容之间的差异
 *
 * @param options 差异计算选项。传入 lineRange 时仅在该范围附近计算 diff，
 * 用于大文件 Edit 场景的性能优化；未传入时保持全量 diff 行为不变。
 * @returns diff hunks 数组
 */
export function getPatchFromContents(options: {
  filePath: string;
  oldContent: string;
  newContent: string;
  ignoreWhitespace?: boolean;
  contextLines?: number;
  lineRange?: LineRange;
}): Hunk[] {
  const {
    filePath,
    oldContent,
    newContent,
    ignoreWhitespace = false,
    contextLines = CONTEXT_LINES,
    lineRange,
  } = options;

  if (!lineRange) {
    return computePatch(filePath, oldContent, newContent, ignoreWhitespace, contextLines);
  }

  // 只截取编辑区域前后各 contextLines 行的窗口，让 diff 结果保留上下文
  const oldWindowStart = Math.max(1, lineRange.oldStartLine - contextLines);
  const oldWindowEnd = lineRange.oldEndLine + contextLines;
  const newWindowStart = Math.max(1, lineRange.newStartLine - contextLines);
  const newWindowEnd = lineRange.newEndLine + contextLines;

  const oldSlice = sliceContentByLineRange(oldContent, oldWindowStart, oldWindowEnd);
  const newSlice = sliceContentByLineRange(newContent, newWindowStart, newWindowEnd);

  if (oldSlice.text.length === 0 && newSlice.text.length === 0) {
    return [];
  }

  const hunks = computePatch(
    filePath,
    oldSlice.text,
    newSlice.text,
    ignoreWhitespace,
    contextLines,
  );

  // 窗口内的 hunk 行号是相对窗口起点的，加上偏移量恢复到完整文件行号
  return hunks.map(hunk => ({
    ...hunk,
    oldStart: hunk.oldStart + oldSlice.offset,
    newStart: hunk.newStart + newSlice.offset,
  }));
}

/**
 * 统计差异中的添加和删除行数
 *
 * @param hunks diff hunks
 * @returns 添加和删除的行数
 */
export function countLinesChanged(hunks: Hunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        additions++;
      } else if (line.startsWith('-')) {
        deletions++;
      }
    }
  }

  return { additions, deletions };
}

/**
 * 将 diff hunks 格式化为可读的文本
 *
 * @param hunks diff hunks
 * @returns 格式化的 diff 文本
 */
export function formatPatch(hunks: Hunk[]): string {
  const lines: string[] = [];

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

    for (const line of hunk.lines) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * 调整 hunk 的行号偏移
 * 用于处理部分文件内容的情况
 *
 * @param hunks 原始 hunks
 * @param offset 行号偏移量
 * @returns 调整后的 hunks
 */
export function adjustHunkLineNumbers(
  hunks: Hunk[],
  offset: number,
): Hunk[] {
  if (offset === 0) {
    return hunks;
  }

  return hunks.map(hunk => ({
    ...hunk,
    oldStart: hunk.oldStart + offset,
    newStart: hunk.newStart + offset,
  }));
}
