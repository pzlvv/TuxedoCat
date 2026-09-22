/**
 * Glob 工具实现
 */

import * as path from 'path';
import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool, MAX_RESULT_SIZE_CHARS } from '../Tool.js';
import { expandPath } from '../../utils/path.js';
import { ripGrep } from '../../utils/ripgrep.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';

export const GLOB_TOOL_NAME = TOOL_NAME;

const DEFAULT_LIMIT = 100;

// Schema definitions
const inputSchema = z.strictObject({
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z.string().optional().describe('The directory to search in. If not specified, the current working directory will be used'),
});

const outputSchema = z.object({
  durationMs: z.number().describe('Time taken to execute the search in milliseconds'),
  numFiles: z.number().describe('Total number of files found'),
  filenames: z.array(z.string()).describe('Array of file paths that match the pattern'),
  truncated: z.boolean().describe('Whether results were truncated (limited to 100 files)'),
});

type GlobInput = z.infer<typeof inputSchema>;
type GlobOutput = z.infer<typeof outputSchema>;

function extractGlobBaseDirectory(pattern: string): { baseDir: string; relativePattern: string } {
  const globChars = /[*?[{]/;
  const match = pattern.match(globChars);

  if (!match || match.index === undefined) {
    const dir = path.dirname(pattern);
    const file = path.basename(pattern);
    return { baseDir: dir, relativePattern: file };
  }

  const staticPrefix = pattern.slice(0, match.index);
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(path.sep),
  );

  if (lastSepIndex === -1) {
    return { baseDir: '', relativePattern: pattern };
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);

  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/';
  }

  return { baseDir, relativePattern };
}

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  // 统一上限（4K，前 2K + 后 2K 预览）
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,
  strict: true,

  get inputSchema() {
    return inputSchema;
  },

  get outputSchema() {
    return outputSchema;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return getPrompt();
  },

  userFacingName() {
    return 'Glob';
  },

  getToolUseSummary(input?: { pattern?: string }) {
    return input?.pattern ? `Find "${input.pattern}"` : null;
  },

  getActivityDescription(input?: { pattern?: string }) {
    return input?.pattern ? `Finding "${input.pattern}"` : 'Finding files';
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    return true;
  },

  async call(
    input: GlobInput,
    context: ToolUseContext,
  ): Promise<ToolResult<GlobOutput>> {
    const { pattern, path: inputPath } = input;

    if (!pattern || typeof pattern !== 'string') {
      throw new Error('pattern is required and must be a string');
    }

    const start = Date.now();

    const projectRoot = context.cwd;
    let searchDir = inputPath ? expandPath(inputPath) : projectRoot;
    let searchPattern = pattern;

    if (path.isAbsolute(pattern)) {
      const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern);
      if (baseDir) {
        searchDir = baseDir;
        searchPattern = relativePattern;
      }
    }

    const args = [
      '--files',
      '--glob',
      searchPattern,
      '--sort=modified',
      '--no-ignore',
      '--hidden',
    ];

    const allPaths = await ripGrep(args, searchDir, {
      timeout: 20000,
      abortSignal: context.abortController.signal as AbortSignal,
    });

    const absolutePaths = allPaths.map((p) =>
      path.isAbsolute(p) ? p : path.join(searchDir, p),
    );

    const truncated = absolutePaths.length > DEFAULT_LIMIT;
    const files = absolutePaths.slice(0, DEFAULT_LIMIT);

    const filenames = files.map((p) => path.relative(searchDir, p));

    const output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
    };

    return { data: output };
  },

  mapToolResultToToolResultBlockParam(data: unknown, toolUseID: string) {
    const output = data as {
      filenames: string[];
      numFiles: number;
      truncated: boolean;
    };

    const { filenames, numFiles, truncated } = output;

    if (filenames.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
        exit_code: 0,
      };
    }

    const lines = [
      `Found ${numFiles} file${numFiles === 1 ? '' : 's'}`,
      ...filenames,
      ...(truncated ? ['(Results are truncated. Consider using a more specific path or pattern.)'] : []),
    ];

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    };
  },
});
