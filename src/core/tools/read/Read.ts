/**
 * Read 工具实现
 *
 * 限制：
 * 1. maxSizeBytes (256KB) - 读取前通过 stat 检查文件大小（仅未传 limit 的整文件读取）
 *    - xlsx / 图片文件跳过此检查；图片另有 15MB 上限
 * 2. maxLines (2000) / maxLineLength (2000) / maxOutputBytes (50KB)
 *    - 读取后构建有界窗口，传了 offset/limit 也生效
 *
 * 图片：扩展名声明 media_type 后还要过一遍「魔数 + 结构完整性」校验
 * （`imageValidation.ts`），内容与格式不符时报错而不是发非法 image block。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { statSync } from 'fs';
import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool, MAX_RESULT_SIZE_CHARS } from '../Tool.js';
import type { ReadInput, ReadOutput } from './Types.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';
import { expandPath } from '../../utils/path.js';
import { surrogateSafeHeadEnd } from '../../utils/stringUtils.js';
import {
  getDefaultLimits,
  FileTooLargeError,
} from './limits.js';
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  imageValidationErrorMessage,
  validateImageBytes,
} from './imageValidation.js';

/** xlsx 文件一次最多读取的行数 */
const XLSX_MAX_LINES = 50;

/** Read 窗口限制 */
interface ReadWindowCaps {
  maxLines: number;
  maxLineLength: number;
  maxOutputBytes: number;
}

/** 有界窗口构建结果 */
interface BoundedWindow {
  content: string;
  lineCount: number;
  truncatedByBytes: boolean;
}

/**
 * 单行超长截断（导出供单测直接覆盖代理对边界）
 */
export function truncateLine(line: string, maxLineLength: number): string {
  if (line.length <= maxLineLength) return line;
  // 按代理对边界对齐，避免行尾留下孤立代理项（会污染后续 LLM 请求）
  const end = surrogateSafeHeadEnd(line, maxLineLength);
  return `${line.substring(0, end)}... (line truncated to ${maxLineLength} chars)`;
}

/**
 * 计算一行在输出中的字节数（UTF-8 字节 + 非首行时的新行分隔符 1 字节）
 */
function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0);
}

/**
 * 从已选行中构建受 maxLines / maxLineLength / maxOutputBytes 限制的窗口
 */
function buildBoundedWindow(lines: string[], caps: ReadWindowCaps): BoundedWindow {
  const selected: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;

  for (const rawLine of lines) {
    if (selected.length >= caps.maxLines) break;

    const text = truncateLine(rawLine.replace(/\r$/, ''), caps.maxLineLength);
    const bytes = lineByteSize(text, selected.length);

    if (outputBytes + bytes > caps.maxOutputBytes) {
      truncatedByBytes = true;
      break;
    }

    outputBytes += bytes;
    selected.push(text);
  }

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    truncatedByBytes,
  };
}

/**
 * 检查一行是否全为空
 */
function isRowEmpty(row: unknown[]): boolean {
  return row.every(cell => cell === '' || cell === undefined || cell === null);
}

/**
 * 获取行中最后一个非空列的索引（超出该索引的列将被修剪掉）
 */
function getLastNonEmptyColIndex(data: unknown[][]): number {
  let maxColIdx = 0;
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    // 从后往前找第一个非空单元格
    for (let i = row.length - 1; i >= 0; i--) {
      const cell = row[i];
      if (cell !== '' && cell !== undefined && cell !== null) {
        if (i > maxColIdx) maxColIdx = i;
        break;
      }
    }
  }
  return maxColIdx;
}

/**
 * 读取 xlsx 文件内容，返回文本表格
 */
function readXlsxContent(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  sheetName: string | undefined,
  caps: ReadWindowCaps,
): {
  content: string;
  lineCount: number;
  startLine: number;
  totalLines: number;
  sheetName: string;
  sheets: string[];
  truncatedByBytes: boolean;
} {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);
  const allSheetNames = workbook.SheetNames.filter(
    (name: string) => name !== 'WpsReserved_CellImgList'
  );

  if (allSheetNames.length === 0) {
    return { content: '(Empty workbook - no sheets found)', lineCount: 0, startLine: 0, totalLines: 0, sheetName: '', sheets: [], truncatedByBytes: false };
  }

  // 确定要读取的 sheet
  let targetSheet: string;
  if (sheetName) {
    if (!allSheetNames.includes(sheetName)) {
      return {
        content: `Sheet "${sheetName}" not found. Available sheets: ${allSheetNames.join(', ')}`,
        lineCount: 0,
        startLine: 0,
        totalLines: 0,
        sheetName: sheetName,
        sheets: allSheetNames,
        truncatedByBytes: false,
      };
    }
    targetSheet = sheetName;
  } else {
    targetSheet = allSheetNames[0];
  }

  const sheet = workbook.Sheets[targetSheet];
  // 将 sheet 转为二维数组（不转换 header）
  const data: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // ---- 过滤空行 ----
  const nonEmptyData = data.filter(row => !isRowEmpty(row));
  const totalLines = nonEmptyData.length;

  // ---- 确定有效的列范围：去除尾部全空列 ----
  const nonEmptyColIndex = getLastNonEmptyColIndex(nonEmptyData);
  const trimmedData = nonEmptyData.map(row => {
    if (!Array.isArray(row)) return row;
    return row.slice(0, nonEmptyColIndex + 1);
  });

  // 计算实际要读取的行数（限制在 XLSX_MAX_LINES 内）
  // offset 为 1-based 行号（与文本读取路径一致），0/1 都映射到第一行。
  const firstLine = offset === undefined ? 0 : Math.max(0, offset - 1);
  const effectiveLimit = limit !== undefined
    ? Math.min(limit, XLSX_MAX_LINES)
    : XLSX_MAX_LINES;
  const endLine = Math.min(firstLine + effectiveLimit, totalLines);

  const selectedRows = trimmedData.slice(firstLine, endLine);

  // 找出最大列数以对齐输出
  let maxCols = 0;
  for (const row of selectedRows) {
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }

  // 计算每列最大宽度（用于对齐），限制防止极端情况
  const colWidths: number[] = [];
  for (let col = 0; col < maxCols; col++) {
    let maxWidth = 0;
    for (const row of selectedRows) {
      if (Array.isArray(row)) {
        const cellValue = String(row[col] ?? '');
        if (cellValue.length > maxWidth) {
          maxWidth = cellValue.length;
        }
      }
    }
    colWidths.push(Math.min(maxWidth, 120)); // 限制单个列宽度，避免极端情况
  }

  // 格式化为文本表格
  const lines: string[] = [];
  for (let i = 0; i < selectedRows.length; i++) {
    const row = selectedRows[i];
    const lineNum = firstLine + i + 1;
    if (Array.isArray(row)) {
      const cells = row.map((cell: unknown, colIdx: number) => {
        const value = String(cell ?? '');
        const width = colWidths[colIdx] ?? 0;
        return value.padEnd(width, ' ');
      });
      // 用 | 分隔，已去除尾部空列
      const line = `Row ${lineNum}: ${cells.join(' | ')}`;
      lines.push(line);
    } else {
      lines.push(`Row ${lineNum}: (empty row)`);
    }
  }

  const window = buildBoundedWindow(lines, caps);

  return {
    content: window.content,
    lineCount: window.lineCount,
    startLine: firstLine,
    totalLines,
    sheetName: targetSheet,
    sheets: allSheetNames,
    truncatedByBytes: window.truncatedByBytes,
  };
}

/**
 * 读取文件内容
 */
async function readFileContent(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  caps: ReadWindowCaps,
): Promise<{
  content: string;
  lineCount: number;
  startLine: number;
  totalLines: number;
  truncatedByBytes: boolean;
}> {
  const fileContent = await fs.readFile(filePath, 'utf-8');
  const lines = fileContent.split('\n');
  const totalLines = lines.length;

  // offset 语义为 1-based 行号（与 Read 输出展示的行号、Edit 工具的 offset 一致）；
  // 历史上本工具按 0-indexed 处理，为兼容旧调用（offset=0 / "Use offset=${endLine}" 的
  // 0-based 续读提示仍会出现）这里把 0/1 都映射到第一行。
  const firstLine = offset === undefined ? 0 : Math.max(0, offset - 1);
  const endLine = limit !== undefined
    ? Math.min(firstLine + limit, totalLines)
    : totalLines;

  const selectedLines = lines.slice(firstLine, endLine);
  const window = buildBoundedWindow(selectedLines, caps);

  return {
    content: window.content,
    lineCount: window.lineCount,
    startLine: firstLine,
    totalLines,
    truncatedByBytes: window.truncatedByBytes,
  };
}

/**
 * Read 工具
 */
export const ReadTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'read file contents',
  // 统一上限（4K，前 2K + 后 2K 预览）
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,
  strict: true,

  get inputSchema() {
    const { inputSchema } = require('./Types.js');
    return inputSchema as z.ZodType<ReadInput>;
  },

  get outputSchema() {
    const { outputSchema } = require('./Types.js');
    return outputSchema as z.ZodType<ReadOutput>;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return getPrompt();
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    return true;
  },

  userFacingName() {
    return 'Read';
  },

  async call(
    input: ReadInput,
    context: ToolUseContext,
  ): Promise<ToolResult<ReadOutput>> {
    // 支持 file_path 和 path 两种参数名
    const filePath = (input as any).file_path || (input as any).path;
    const { offset, limit } = input;

    // 验证 file_path 参数
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('file_path is required and must be a string');
    }

    // 展开路径（支持 ~、相对路径等）
    const fullPath = expandPath(filePath, context.cwd);

    // 获取限制值
    const { maxSizeBytes, maxLines, maxLineLength, maxOutputBytes } = getDefaultLimits();
    const caps: ReadWindowCaps = { maxLines, maxLineLength, maxOutputBytes };

    // 即使显式传了 limit，也不能超过单次最大行数
    if (limit !== undefined && limit > maxLines) {
      throw new Error(`limit must be less than or equal to ${maxLines}`);
    }

    // 获取文件扩展名，判断是否为 xlsx/xlsm
    const fileExt = path.extname(fullPath).toLowerCase();
    const isXlsx = fileExt === '.xlsx' || fileExt === '.xlsm';
    const isImage = fileExt in IMAGE_MEDIA_TYPES;

    // ---- 第 1 层：文件大小预检查（读取前） ----
    // 只有读取整个文本文件（未提供 limit）时才检查文件大小。
    // xlsx / 图片文件跳过此检查（图片有自己的 15MB 上限）。
    if (limit === undefined && !isXlsx && !isImage) {
      try {
        const stats = statSync(fullPath);
        if (stats.size > maxSizeBytes) {
          throw new FileTooLargeError(stats.size, maxSizeBytes);
        }
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          throw err;
        }
        // 其他错误（权限等）忽略，后续读取时会处理
      }
    }

    // 检查文件是否存在
    const myFs = require('fs');
    const fileExists = myFs.existsSync(fullPath);

    if (!fileExists) {
      throw new Error(`File not found: ${fullPath}`);
    }

    // xlsx 文件绕过二进制检查和常规文本读取
    if (isXlsx) {
      // 读取 xlsx 内容
      const result = readXlsxContent(fullPath, offset, limit, input.sheet, caps);

      return {
        data: {
          content: result.content,
          lineCount: result.lineCount,
          startLine: result.startLine,
          totalLines: result.totalLines,
          filePath: filePath,
          sheetName: result.sheetName,
          sheets: result.sheets,
          truncatedByBytes: result.truncatedByBytes,
        },
      };
    }

    // 检查文件是否为二进制
    const { isBinaryFile: checkBinary } = await import('isbinaryfile');
    const isBinary = await checkBinary(fullPath);
    if (isBinary) {
      const ext = path.extname(fullPath).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[ext];
      if (mediaType) {
        // 图片文件直接以 base64 形式返回，由上层构造成 image content block 发给 LLM
        const imageStat = statSync(fullPath);
        if (imageStat.size > MAX_IMAGE_SIZE_BYTES) {
          throw new Error(`Image file too large to read: ${filePath} (${imageStat.size} bytes, max 15MB)`);
        }
        const imageBuffer = await fs.readFile(fullPath);
        // 扩展名不是事实：内容与扩展名声明的格式不符时不发 image block，
        // 否则 provider 会因非法图片整轮报错（docs/core-parity.md 第 4 节）
        const failure = validateImageBytes(imageBuffer, mediaType);
        if (failure) {
          throw new Error(imageValidationErrorMessage(filePath, mediaType, failure));
        }
        return {
          data: {
            content: '',
            lineCount: 0,
            startLine: 0,
            totalLines: 1,
            filePath: filePath,
            truncatedByBytes: false,
            image: {
              mediaType,
              data: imageBuffer.toString('base64'),
            },
          },
        };
      }
      throw new Error(
        `Cannot read binary file: ${filePath}. This tool only supports text and common image files.`,
      );
    }

    // 读取文件内容
    const { content, lineCount, startLine, totalLines, truncatedByBytes } = await readFileContent(
      fullPath,
      offset,
      limit,
      caps,
    );

    return {
      data: {
        content,
        lineCount,
        startLine,
        totalLines,
        filePath: filePath,
        truncatedByBytes,
      },
    };
  },

  mapToolResultToToolResultBlockParam(
    data: ReadOutput,
    toolUseID: string,
  ) {
    // 图片文件直接以 image content block 返回，使 LLM 能“看到”图片而不是收到文本
    if (data.image) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: data.image.mediaType,
            data: data.image.data,
          },
        }],
      };
    }

    // 格式化输出，添加行号，使用 | 分隔
    const lines = data.content.split('\n');
    const numberedContent = lines
      .map((line, i) => `${data.startLine + i + 1}|${line}`)
      .join('\n');

    // 输出被 50KB/2000 行限制截断时，追加继续读取提示。
    // offset 是 1-based：下一窗口从「已展示的最后一行（1-based）的下一行」开始，
    // 即 endLine（1-based，含）+ 1 = endLine + 1。
    const lastShownLine = data.startLine + data.lineCount; // 1-based 最后一行
    let content = numberedContent;
    if (data.lineCount > 0 && lastShownLine < data.totalLines) {
      const capNote = data.truncatedByBytes ? 'Output capped. ' : '';
      const footer = `(${capNote}Showing lines ${data.startLine + 1}-${lastShownLine} of ${data.totalLines}. Use offset=${lastShownLine + 1} to continue.)`;
      content = `${numberedContent}\n${footer}`;
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    };
  },
});
