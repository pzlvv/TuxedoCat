/**
 * Edit 工具实现
 */

import * as fs from 'fs/promises';
import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool } from '../Tool.js';
import { getPatchFromContents, countLinesChanged } from '../../../utils/diff.js';
import type { EditInput, EditOutput } from './Types.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';
import { expandPath } from '../../utils/path.js';

/**
 * 换行符类型
 */
type LineEndingType = 'CRLF' | 'LF';

/**
 * 检测字符串的换行符类型
 */
function detectLineEndings(content: string): LineEndingType {
  // 最常见的 LF 文件可以直接短路，避免对大文件做一次全量字符循环。
  if (!content.includes('\r\n')) {
    return 'LF';
  }

  let crlfCount = 0;
  let lfCount = 0;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++;
      } else {
        lfCount++;
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

/**
 * 将换行符统一为 LF
 */
function normalizeLineEndings(content: string): string {
  // 没有 CRLF 时直接返回原字符串，避免 replaceAll 产生一次全量新字符串。
  if (!content.includes('\r\n')) {
    return content;
  }
  return content.replaceAll('\r\n', '\n');
}

/**
 * 将换行符还原为原始格式
 */
function restoreLineEndings(content: string, lineEnding: LineEndingType): string {
  if (lineEnding === 'CRLF') {
    return content.replaceAll('\n', '\r\n');
  }
  return content;
}

/**
 * 解析 replace_all 输入，统一处理字符串/数字/布尔值。
 * checkPermissions 可能收到 LLM 原始参数（replace_all 可能为字符串），
 * call 收到的是 schema 解析后的值。
 * 注意：字符串感知转换而非 Boolean(value)——Boolean("false") === true，
 * 会导致 LLM 显式传 "replace_all": "false" 时执行全量替换。
 */
function resolveReplaceAll(value: unknown): boolean {
  if (typeof value === 'string') {
    if (value === 'false') return false;
    if (value === 'true') return true;
    return value.trim() !== '';
  }
  return Boolean(value);
}

/**
 * 搜索窗口：限定 old_string 匹配的文件行范围
 */
interface SearchWindow {
  slice: string;
  startIndex: number;
  endIndex: number;
}

/**
 * 统计字符串行数（不生成行数组，避免大文件 split 的内存开销）
 */
function countLines(content: string): number {
  if (content.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

/**
 * 统计子串出现次数（不生成数组，避免大文件 split 的内存开销）
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/**
 * 根据 offset/limit 计算搜索窗口。
 * offset 为 1-based 起始行，limit 为行数。
 * 返回的 slice 为窗口内连续行的文本（包含窗口内每行原有的行尾换行符）。
 */
function getSearchWindow(
  content: string,
  offset?: number,
  limit?: number,
): SearchWindow {
  // 最常见场景：未指定 offset/limit 时直接使用整个文件，
  // 避免对大文件执行 split('\n') 生成全量行数组。
  if (offset === undefined && limit === undefined) {
    return { slice: content, startIndex: 0, endIndex: content.length };
  }

  const lineCount = countLines(content);
  const startLine = offset !== undefined ? offset - 1 : 0;
  const endLine = Math.min(
    limit !== undefined ? startLine + limit : lineCount,
    lineCount,
  );

  if (startLine >= lineCount || endLine <= startLine) {
    return { slice: '', startIndex: content.length, endIndex: content.length };
  }

  let startIndex = 0;
  for (let i = 0; i < startLine; i++) {
    const newlineIndex = content.indexOf('\n', startIndex);
    if (newlineIndex === -1) {
      startIndex = content.length;
      break;
    }
    startIndex = newlineIndex + 1;
  }

  let endIndex = content.length;
  if (endLine < lineCount) {
    endIndex = startIndex;
    for (let i = startLine; i < endLine; i++) {
      const newlineIndex = content.indexOf('\n', endIndex);
      if (newlineIndex === -1) {
        endIndex = content.length;
        break;
      }
      endIndex = newlineIndex + 1;
    }
  }

  return {
    slice: content.substring(startIndex, endIndex),
    startIndex,
    endIndex,
  };
}

/**
 * 记录诊断日志：当 call 阶段找不到 old_string 时，分析差异原因
 */
function logNotFoundDiagnostic(
  normalizedContent: string,
  normalizedOldString: string,
  oldString: string,
  originalContent: string,
  checkContent?: string,
): void {
  const logger = require('../../Logger.js').logger;
  const log = logger?.info?.bind(logger, 'Edit') ?? console.log;

  log(`=== old_string not found in call() diagnostic ===`);
  log(`old_string length: ${normalizedOldString.length}, file length: ${normalizedContent.length}`);

  // 1. 显示 old_string 内容
  const oldStringLines = normalizedOldString.split('\n');
  log(`old_string has ${oldStringLines.length} lines`);
  for (let i = 0; i < Math.min(oldStringLines.length, 5); i++) {
    log(`  old_string line ${i + 1}: ${JSON.stringify(oldStringLines[i])} (${oldStringLines[i].length} chars)`);
  }
  if (oldStringLines.length > 5) {
    log(`  ... (${oldStringLines.length - 5} more lines)`);
  }

  // 2. 逐行检查 old_string 的每一行是否能匹配到文件中
  for (let i = 0; i < oldStringLines.length; i++) {
    const line = oldStringLines[i];
    if (line.length === 0) {
      log(`  old_string line ${i + 1}: (empty line)`);
      continue;
    }
    const found = normalizedContent.includes(line);
    if (!found) {
      log(`  old_string line ${i + 1}: NOT FOUND in file: ${JSON.stringify(line)}`);
    }
  }

  // 3. 显示文件头尾
  if (normalizedContent.length > 0) {
    log(`File head (200 chars): ${JSON.stringify(normalizedContent.substring(0, 200))}`);
    if (normalizedContent.length > 400) {
      log(`File tail (200 chars): ${JSON.stringify(normalizedContent.substring(normalizedContent.length - 200))}`);
    }
  }

  // 4. 与 checkPermissions 阶段的文件快照对比
  if (checkContent !== undefined) {
    const normalizedCheck = normalizeLineEndings(checkContent);
    const isSame = normalizedContent === normalizedCheck;
    log(`Compared to checkPermissions snapshot: ${isSame ? 'IDENTICAL' : 'DIFFERENT'}`);
    if (!isSame) {
      const checkLines = normalizedCheck.split('\n');
      const fileLines = normalizedContent.split('\n');
      log(`  checkPermissions: ${checkLines.length} lines, ${checkContent.length} chars`);
      log(`  current file: ${fileLines.length} lines, ${normalizedContent.length} chars`);
      const maxCheck = Math.min(checkLines.length, fileLines.length);
      for (let i = 0; i < maxCheck; i++) {
        if (checkLines[i] !== fileLines[i]) {
          log(`  First difference at line ${i + 1}:`);
          log(`    checkPermissions: ${JSON.stringify(checkLines[i])}`);
          log(`    current file:     ${JSON.stringify(fileLines[i])}`);
          break;
        }
      }
    }
  }

  // 5. 换行符检查
  log(`File contains CRLF: ${originalContent.includes('\r\n')}`);
  log(`old_string contains CRLF: ${oldString.includes('\r\n')}`);
  log(`========================================`);
}

/**
 * computeEdit 的返回值
 */
interface ComputedEdit {
  /** 替换后的原始（未还原换行符）内容；换行符还原由调用侧按文件原始格式执行 */
  newContent: string;
  replacementsMade: number;
  /** 1-based，搜索窗口内第一处匹配的行范围 */
  startLine: number;
  endLine: number;
  /** 搜索窗口内最后一处匹配的索引（replaceAll 时用于 diff 窗口终点） */
  lastMatchIndex: number;
  /** 第一处匹配在规范化内容中的索引（checkPermissions 计算上下文行用） */
  firstMatchIndex: number;
  /** 失败时的错误文案（保留原实现的 throw / deny 语义由调用侧决定） */
  error?: string;
}

/**
 * 在规范化内容上计算编辑结果（搜索窗口匹配 + 替换 + 行号计算）。
 *
 * checkPermissions（预览，不写盘）与 call/editFileContent（执行，写盘）的公共主体：
 * 两阶段曾各自内联实现约 80 行相同逻辑，此函数保证两阶段对
 * 「搜索窗口计算 / old_string 存在性 / 唯一性 / 替换结果 / 行号」的判定完全一致。
 *
 * 错误时返回 error 字段而不抛异常：原实现的错误文案在两处完全相同，
 * 但失败通道不同（checkPermissions 返回 deny，call 抛 Error），
 * 由调用侧根据原行为处理。
 */
function computeEdit(
  normalizedContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  offset?: number,
  limit?: number,
): ComputedEdit {
  // 根据 offset/limit 计算搜索窗口；未传时覆盖整个文件
  const searchWindow = getSearchWindow(normalizedContent, offset, limit);
  const searchContent = searchWindow.slice;

  // 执行替换（只在搜索窗口内匹配和替换）
  let newContent: string;
  let replacementsMade: number;
  const firstMatchLocalIndex = searchContent.indexOf(oldString);
  const firstMatchIndex = searchWindow.startIndex + firstMatchLocalIndex;

  // 检查 old_string 是否存在（仅限搜索窗口内）
  if (!searchContent.includes(oldString)) {
    const rangeHint = offset !== undefined || limit !== undefined
      ? ' within the specified line range'
      : ' in the file';
    return {
      newContent: normalizedContent,
      replacementsMade: 0,
      startLine: 1,
      endLine: 1,
      lastMatchIndex: -1,
      firstMatchIndex: -1,
      error: `The specified old_string was not found${rangeHint}. Please read the file first and use the exact text.\nNote: Read output uses | as separator between line number and content. Make sure NOT to include the line number and the separator | in old_string.`,
    };
  }

  // 非 replaceAll 时，old_string 在搜索窗口内必须唯一匹配；存在多处匹配时直接报错而不是替换第一处，
  // 避免模型误以为已经精确修改了目标位置。
  if (!replaceAll) {
    const occurrenceCount = countOccurrences(searchContent, oldString);
    if (occurrenceCount > 1) {
      return {
        newContent: normalizedContent,
        replacementsMade: 0,
        startLine: 1,
        endLine: 1,
        lastMatchIndex: -1,
        firstMatchIndex,
        error: `The old_string matches ${occurrenceCount} locations within the search range. When replace_all is false, old_string must match exactly once. Please include more surrounding context to make old_string unique, or set replace_all to true.`,
      };
    }
  }

  if (replaceAll) {
    // 替换搜索窗口内的所有匹配项
    const matches = searchContent.split(oldString);
    replacementsMade = matches.length - 1;
    newContent =
      normalizedContent.substring(0, searchWindow.startIndex) +
      matches.join(newString) +
      normalizedContent.substring(searchWindow.endIndex);
  } else {
    // 只替换搜索窗口内的第一个匹配项
    replacementsMade = 1;
    newContent =
      normalizedContent.substring(0, firstMatchIndex) +
      newString +
      normalizedContent.substring(firstMatchIndex + oldString.length);
  }

  // 计算 startLine 和 endLine（1-based，取搜索窗口内第一处匹配的行范围，replaceAll 也适用）
  let startLine = 1;
  let endLine = 1;
  if (firstMatchIndex !== -1) {
    const range = getLineRangeFromIndex(normalizedContent, firstMatchIndex, oldString.length);
    startLine = range.startLine;
    endLine = range.endLine;
  }

  // replaceAll 时计算搜索窗口内最后一处匹配的位置，用于 diff 窗口终点
  const lastMatchLocalIndex = searchContent.lastIndexOf(oldString);
  const lastMatchIndex = lastMatchLocalIndex === -1
    ? firstMatchIndex
    : searchWindow.startIndex + lastMatchLocalIndex;

  return {
    newContent,
    replacementsMade,
    startLine,
    endLine,
    lastMatchIndex,
    firstMatchIndex,
  };
}

/**
 * 替换文件内容
 */
async function editFileContent(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
  checkBeforeContent?: string,
  offset?: number,
  limit?: number,
): Promise<{
  type: 'create' | 'update';
  replacementsMade: number;
  lineCount: number;
  additions: number;
  deletions: number;
  patch: any[];
  lineEndings: LineEndingType;
  startLine: number;
  endLine: number;
  beforeContent: string;
}> {
  // 读取文件内容
  const content = await fs.readFile(filePath, 'utf-8');

  // 检测原始换行符类型
  const lineEndings = detectLineEndings(content);

  // 规范化内容（统一为 LF）以便匹配
  const normalizedContent = normalizeLineEndings(content);
  const normalizedOldString = normalizeLineEndings(oldString);
  const normalizedNewString = normalizeLineEndings(newString);

  const edit = computeEdit(normalizedContent, normalizedOldString, normalizedNewString, replaceAll, offset, limit);

  if (edit.error !== undefined) {
    if (edit.error.includes('was not found')) {
      // 记录详细诊断日志，排查 preview 正常但执行报找不到字符串的问题
      logNotFoundDiagnostic(normalizedContent, normalizedOldString, oldString, content, checkBeforeContent);
    }
    throw new Error(edit.error);
  }

  const newContent = restoreLineEndings(edit.newContent, lineEndings);

  // 计算差异（只对编辑区域附近的行做 diff，避免大文件全量 diff）
  const patch = getPatchFromContents({
    filePath,
    oldContent: normalizedContent,
    newContent,
    lineRange: getEditLineRange(
      normalizedContent,
      normalizedOldString,
      normalizedNewString,
      edit.replacementsMade,
      edit.startLine,
      edit.endLine,
      edit.lastMatchIndex,
    ),
  });

  const { additions, deletions } = countLinesChanged(patch);

  // 写入文件
  await fs.writeFile(filePath, newContent, 'utf-8');

  return {
    type: 'update',
    replacementsMade: edit.replacementsMade,
    lineCount: countLines(newContent),
    additions,
    deletions,
    patch,
    lineEndings,
    startLine: edit.startLine,
    endLine: edit.endLine,
    beforeContent: normalizedContent, // 规范化后的原始内容（用于历史记录恢复）
  };
}

function getLineRangeFromIndex(content: string, startIndex: number, length: number): { startLine: number; endLine: number } {
  // startLine: 1-based line number where old_string starts。
  // 使用 indexOf 按行跳跃，避免大文件场景下对前缀逐字符循环。
  let startLine = 1;
  let pos = 0;
  while (pos < startIndex) {
    const newlineIndex = content.indexOf('\n', pos);
    if (newlineIndex === -1 || newlineIndex >= startIndex) {
      break;
    }
    startLine++;
    pos = newlineIndex + 1;
  }

  // endLine: 1-based line number where old_string ends
  const end = Math.min(startIndex + length, content.length);
  let oldLines = 1;
  pos = startIndex;
  while (pos < end) {
    const newlineIndex = content.indexOf('\n', pos);
    if (newlineIndex === -1 || newlineIndex >= end) {
      break;
    }
    oldLines++;
    pos = newlineIndex + 1;
  }
  const endLine = startLine + oldLines - 1;

  return { startLine, endLine };
}

/**
 * 统计字符串按换行符拆分的行数（与 getLineRangeFromIndex 的 split('\n').length 语义一致）
 */
function countStringLines(text: string): number {
  return text.split('\n').length;
}

/**
 * 判断上下文行是否有实际内容（与 checkPermissions 中过滤空行/undefined 的逻辑一致）
 */
function isMeaningfulContextLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed !== 'undefined';
}

/**
 * 从指定位置向前收集最多 maxLines 个有内容的行。
 * 只扫描目标位置附近的换行符，避免对大文件前缀做 substring + split。
 */
function getContextLinesBefore(content: string, index: number, maxLines: number): string[] {
  const result: string[] = [];
  let pos = index;

  while (result.length < maxLines && pos > 0) {
    const newlineIndex = content.lastIndexOf('\n', pos - 1);
    const lineStart = newlineIndex === -1 ? 0 : newlineIndex + 1;
    const line = content.substring(lineStart, pos);
    if (isMeaningfulContextLine(line)) {
      result.push(line);
    }
    if (lineStart === 0) {
      break;
    }
    // 继续向前：pos 移到 lineStart 之前，即上一行的行尾换行符处
    pos = lineStart - 1;
  }

  return result.reverse();
}

/**
 * 从指定位置向后收集最多 maxLines 个有内容的行。
 * 只扫描目标位置附近的换行符，避免对大文件后缀做 substring + split。
 */
function getContextLinesAfter(content: string, startIndex: number, maxLines: number): string[] {
  const result: string[] = [];
  let pos = startIndex;

  while (result.length < maxLines && pos < content.length) {
    const newlineIndex = content.indexOf('\n', pos);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const line = content.substring(pos, lineEnd);
    if (isMeaningfulContextLine(line)) {
      result.push(line);
    }
    if (newlineIndex === -1) {
      break;
    }
    pos = newlineIndex + 1;
  }

  return result;
}

/**
 * 计算 diff 窗口的行范围。
 *
 * 非 replaceAll：窗口只覆盖唯一匹配处。
 * replaceAll：窗口覆盖第一个到最后一个匹配的跨度，避免截断中间或末尾的替换。
 * new 侧结束行按新旧字符串行数差和替换次数推导，与替换后的内容对齐。
 */
function getEditLineRange(
  content: string,
  oldString: string,
  newString: string,
  replacementsMade: number,
  firstStartLine: number,
  firstEndLine: number,
  lastMatchIndex?: number,
): {
  oldStartLine: number;
  oldEndLine: number;
  newStartLine: number;
  newEndLine: number;
} {
  const lineDelta = countStringLines(newString) - countStringLines(oldString);

  if (replacementsMade <= 1) {
    return {
      oldStartLine: firstStartLine,
      oldEndLine: firstEndLine,
      newStartLine: firstStartLine,
      newEndLine: firstEndLine + lineDelta,
    };
  }

  // replaceAll 时用搜索窗口内最后一个匹配的行范围作为窗口终点
  const finalLastMatchIndex = lastMatchIndex ?? content.lastIndexOf(oldString);
  const lastEndLine = finalLastMatchIndex === -1
    ? firstEndLine
    : getLineRangeFromIndex(content, finalLastMatchIndex, oldString.length).endLine;

  return {
    oldStartLine: firstStartLine,
    oldEndLine: lastEndLine,
    newStartLine: firstStartLine,
    newEndLine: lastEndLine + lineDelta * replacementsMade,
  };
}

/**
 * Edit 工具
 */
export const EditTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema() {
    const { inputSchema } = require('./Types.js');
    return inputSchema as z.ZodType<EditInput>;
  },

  get outputSchema() {
    const { outputSchema } = require('./Types.js');
    return outputSchema as z.ZodType<EditOutput>;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return getPrompt();
  },

  isConcurrencySafe() {
    return false;
  },

  isReadOnly() {
    return false;
  },

  isDestructive() {
    return true;
  },

  userFacingName() {
    return 'Edit';
  },

  async checkPermissions(input: EditInput) {
    // 验证输入
    if (!input.file_path || typeof input.file_path !== 'string') {
      return {
        behavior: 'deny',
        message: 'Invalid file path: file_path is required and must be a string',
      };
    }
    if (input.old_string === undefined || input.old_string === null) {
      return {
        behavior: 'deny',
        message: 'Invalid old_string: old_string is required',
      };
    }
    if (input.new_string === undefined || input.new_string === null) {
      return {
        behavior: 'deny',
        message: 'Invalid new_string: new_string is required',
      };
    }

    const fullPath = expandPath(input.file_path);

    // 检查文件是否存在
    try {
      await fs.access(fullPath);
    } catch {
      return {
        behavior: 'deny',
        message: `File does not exist: ${input.file_path}. Use Write tool to create new files.`,
      };
    }

    // 读取原内容
    let beforeContent = '';
    try {
      beforeContent = await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        behavior: 'deny',
        message: `Failed to read file: ${errorMessage}`,
      };
    }

    // 检测原始换行符类型
    const lineEndings = detectLineEndings(beforeContent);

    // 规范化内容（统一为 LF）以便匹配
    const normalizedContent = normalizeLineEndings(beforeContent);
    const normalizedOldString = normalizeLineEndings(input.old_string);
    const normalizedNewString = normalizeLineEndings(input.new_string);

    // 与 call/editFileContent 使用同一套编辑计算（搜索窗口 / 唯一性 / 替换结果 / 行号），
    // 仅做预览，不写盘。
    const replaceAll = resolveReplaceAll(input.replace_all);
    const edit = computeEdit(
      normalizedContent,
      normalizedOldString,
      normalizedNewString,
      replaceAll,
      input.offset,
      input.limit,
    );

    if (edit.error !== undefined) {
      return {
        behavior: 'deny',
        message: edit.error,
      };
    }

    const oldStringIndex = edit.firstMatchIndex;
    const afterContent = restoreLineEndings(edit.newContent, lineEndings);
    const { startLine, endLine } = edit;

    // 找到 old_string 在文件中的位置，并获取上下文行（前后各4行）
    // 使用规范化后的内容和索引
    let contextBefore: string[] = [];
    let contextAfter: string[] = [];

    if (oldStringIndex !== -1) {
      // 只扫描 old_string 附近行，避免大文件场景下对全量前缀/后缀做 substring + split
      contextBefore = getContextLinesBefore(normalizedContent, oldStringIndex, 4);
      contextAfter = getContextLinesAfter(
        normalizedContent,
        oldStringIndex + normalizedOldString.length,
        4,
      );
    }

    return {
      behavior: 'ask' as const,
      message: `请求编辑文件：${input.file_path}`,
      choices: [
        { label: '允许', description: '应用编辑' },
        { label: '拒绝', description: '取消操作' },
      ],
      beforeContent: normalizedContent,
      afterContent,
      contextBefore,
      contextAfter,
      lineEndings,
      startLine,
      endLine,
    };
  },

  async call(
    input: EditInput,
    _context: ToolUseContext,
  ): Promise<ToolResult<EditOutput>> {
    const { file_path, old_string, new_string, offset, limit } = input;

    // 验证参数
    if (!file_path || typeof file_path !== 'string') {
      throw new Error('file_path is required and must be a string');
    }
    if (old_string === undefined || old_string === null) {
      throw new Error('old_string is required');
    }
    if (new_string === undefined || new_string === null) {
      throw new Error('new_string is required');
    }

    // 与 checkPermissions 使用同一套解析规则，避免两阶段对 replace_all 解释不一致
    const replaceAll = resolveReplaceAll(input.replace_all);

    // 展开路径（支持 ~、相对路径等）
    const fullPath = expandPath(file_path);

    // _meta 已通过 updateToolUseMeta 写入 block 顶层，不再从 input 内部读取。
    // checkBeforeContent 仅用于诊断日志对比，传 undefined 表示跳过快照对比。

    // 执行编辑（editFileContent 会处理文件读取、匹配和写入）
    const result = await editFileContent(fullPath, old_string, new_string, replaceAll, undefined, offset, limit);

    // 返回执行结果，同时带上 beforeContent 用于历史记录恢复 diff 显示
    return {
      data: {
        type: result.type,
        filePath: file_path,
        replacementsMade: result.replacementsMade,
        lineCount: result.lineCount,
        additions: result.additions,
        deletions: result.deletions,
        startLine: result.startLine,
        endLine: result.endLine,
        beforeContent: result.beforeContent,
      },
    };
  },

  mapToolResultToToolResultBlockParam(
    data: EditOutput,
    toolUseID: string,
  ) {
    const replacement = data.replacementsMade === 1 ? 'replacement' : 'replacements';
    let content = `Edited file: ${data.filePath}\nMade ${data.replacementsMade} ${replacement}\n`;

    // 编辑行号（1-based），与 Read 工具输出的行号保持一致，方便定位修改位置
    if (data.startLine !== undefined && data.endLine !== undefined) {
      if (data.startLine === data.endLine) {
        content += `Edited line ${data.startLine}\n`;
      } else {
        content += `Edited lines ${data.startLine}-${data.endLine}\n`;
      }
    }

    content += `Lines: ${data.lineCount} (+${data.additions}, -${data.deletions})`;

    const result: any = {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    };

    // 传递行号信息，方便 UI 跳转时选中编辑的行
    if (data.startLine !== undefined && data.endLine !== undefined) {
      result.startLine = data.startLine;
      result.endLine = data.endLine;
    }

    // 保存编辑前的文件内容到工具结果中，用于历史记录恢复时还原 diff 显示。
    // 当加载历史对话时，enrichConversationWithDiffInfo 会读取此字段并重新计算 afterContent，
    // 从而在 webview 中展示完整的修改对比。
    if (data.beforeContent) {
      result.beforeContent = data.beforeContent;
    }

    return result;
  },
});
