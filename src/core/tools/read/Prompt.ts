/**
 * Read 工具提示词
 */

import {
  getDefaultLimits,
  formatFileSize,
} from './limits.js';

export const TOOL_NAME = 'Read';

export const DESCRIPTION = `Reads a file from the local filesystem.`;

export function getPrompt(): string {
  const { maxSizeBytes, maxLines, maxLineLength, maxOutputBytes } = getDefaultLimits();
  const sizeStr = formatFileSize(maxSizeBytes);
  const outputBytesStr = formatFileSize(maxOutputBytes);

  return `## Read Tool

Reads the contents of a file from the local filesystem.

**Parameters:**
- \`file_path\` (string, required): The absolute path to the file to read
- \`offset\` (number, optional): The line number to start reading from (0-indexed)
- \`limit\` (number, optional): The number of lines to read
- \`sheet\` (string, optional): For xlsx/xlsm files, specify the sheet name to read. Defaults to the first sheet if not specified.

**Usage:**
- Read entire file: Use just \`file_path\`
- Read specific range: Use \`offset\` and \`limit\` to read a portion of the file
- Read specific sheet: Use \`sheet\` parameter for Excel files
- Line numbers are 1-based and separated by \`|\`

**Limits:**
- Maximum file size for whole-file reads: ${sizeStr}. Files larger than this require \`offset\` and \`limit\`
- Maximum lines per read: ${maxLines}
- Maximum characters per line: ${maxLineLength} (longer lines are truncated)
- Maximum output bytes per read: ${outputBytesStr} (output is capped; use \`offset\` to continue)
- These limits apply even when \`offset\` and \`limit\` are provided

**xlsx/xlsm (Excel) Support:**
- Automatically detects \`.xlsx\` and \`.xlsm\` files
- Reads the specified sheet (or first sheet by default) into a text table
- Parses cells into a text table with aligned columns
- Supports \`offset\`, \`limit\`, and \`sheet\` parameters (max 50 rows per read)
- If there are multiple sheets, all sheet names are listed so you can read other sheets

**Word / PowerPoint Documents (.doc / .docx / .ppt / .pptx) Support:**
- Automatically converts to Markdown for reading

**Important:**
- Always read a file before attempting to edit it
- Use offset/limit for large files; the same output caps still apply
- The file path must be absolute, not relative`;
}
