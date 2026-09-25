/**
 * Write 工具实现
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool, MAX_RESULT_SIZE_CHARS } from '../Tool.js';
import type { WriteInput, WriteOutput } from './Types.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';
import { expandPath } from '../../utils/path.js';

/**
 * 确保目录存在
 */
async function ensureDirectoryExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * 写入文件内容
 */
async function writeFileContent(
  filePath: string,
  content: string,
): Promise<{
  type: 'create' | 'update';
  lineCount: number;
  bytesWritten: number;
}> {
  // 检查文件是否存在
  let type: 'create' | 'update' = 'create';
  try {
    await fs.access(filePath);
    type = 'update';
  } catch {
    type = 'create';
  }

  // 确保目录存在
  await ensureDirectoryExists(filePath);

  // 写入文件
  const buffer = Buffer.from(content, 'utf-8');
  await fs.writeFile(filePath, buffer, { mode: 0o644 });

  return {
    type,
    lineCount: content.split('\n').length,
    bytesWritten: buffer.length,
  };
}

/**
 * Write 工具
 */
export const WriteTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'create or overwrite files',
  // 统一上限（4K，前 2K + 后 2K 预览）
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,
  strict: true,

  get inputSchema() {
    const { inputSchema } = require('./Types.js');
    return inputSchema as z.ZodType<WriteInput>;
  },

  get outputSchema() {
    const { outputSchema } = require('./Types.js');
    return outputSchema as z.ZodType<WriteOutput>;
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
    return 'Write';
  },

  async checkPermissions(input: WriteInput, context: ToolUseContext) {
    // 验证输入
    if (!input.file_path || typeof input.file_path !== 'string') {
      return {
        behavior: 'deny',
        message: 'Invalid file path: file_path is required and must be a string',
      };
    }
    if (input.content === undefined || input.content === null) {
      return {
        behavior: 'deny',
        message: 'Invalid content: content is required',
      };
    }

    // 准备内容预览
    const fullPath = expandPath(input.file_path, context.cwd);

    // 检查文件是否存在（区分 create 和 update）
    let actionType = 'create';
    let beforeContent = '';
    try {
      await fs.access(fullPath);
      actionType = 'overwrite';
      // 文件存在，读取原内容
      beforeContent = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    const actionText = actionType === 'create' ? '创建新文件' : '覆盖现有文件';

    const result = {
      behavior: 'ask' as const,
      message: `请求${actionText}：${input.file_path}`,
      choices: [
        { label: '允许', description: actionType === 'create' ? '创建文件' : '覆盖文件' },
        { label: '拒绝', description: '取消操作' },
      ],
      // 始终带 diff 内容：创建文件时左边是空的，覆盖文件时左边是旧内容
      beforeContent: actionType === 'overwrite' ? beforeContent : null,
      afterContent: input.content,
    };

    return result;
  },

  async call(
    input: WriteInput,
    context: ToolUseContext,
  ): Promise<ToolResult<WriteOutput>> {
    const { file_path, content } = input;

    // 验证参数
    if (!file_path || typeof file_path !== 'string') {
      throw new Error('file_path is required and must be a string');
    }
    if (content === undefined || content === null) {
      throw new Error('content is required');
    }

    // 展开路径（支持 ~、相对路径等）
    const fullPath = expandPath(file_path, context.cwd);

    // 读取写入前的文件内容（用于回滚备份）
    let beforeContent: string | null = null;
    try {
      beforeContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      beforeContent = null; // 文件不存在
    }

    // 写入文件
    const result = await writeFileContent(fullPath, content);

    return {
      data: {
        type: result.type,
        filePath: file_path,
        lineCount: result.lineCount,
        bytesWritten: result.bytesWritten,
        beforeContent,
      },
    };
  },

  mapToolResultToToolResultBlockParam(
    data: WriteOutput,
    toolUseID: string,
  ) {
    const action = data.type === 'create' ? 'Created' : 'Updated';
    const content = `${action} file: ${data.filePath}\nLines: ${data.lineCount}\nBytes: ${data.bytesWritten}`;

    const result: any = {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    };

    // 保存写入前的文件内容到 _meta，用于回滚
    if (data.beforeContent !== undefined) {
      result.beforeContent = data.beforeContent;
    }

    return result;
  },
});
