/**
 * Grep 工具实现
 */

import * as path from 'path';
import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool, MAX_RESULT_SIZE_CHARS } from '../Tool.js';
import { expandPath } from '../../utils/path.js';
import { ripGrep } from '../../utils/ripgrep.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';

export const GREP_TOOL_NAME = TOOL_NAME;

// Version control system directories to exclude
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
const DEFAULT_HEAD_LIMIT = 250;

// Schema definitions
const inputSchema = z.strictObject({
  pattern: z.string().describe('The regular expression pattern to search for in file contents'),
  path: z.string().optional().describe('File or directory to search in. Defaults to current working directory'),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .describe('Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts'),
  '-B': z.coerce.number().int().nonnegative().optional().describe('Number of lines to show before each match'),
  '-A': z.coerce.number().int().nonnegative().optional().describe('Number of lines to show after each match'),
  '-C': z.coerce.number().int().nonnegative().optional().describe('Alias for context'),
  context: z.coerce.number().int().nonnegative().optional().describe('Number of lines to show before and after each match'),
  '-n': z.coerce.boolean().optional().describe('Show line numbers in output'),
  '-i': z.coerce.boolean().optional().describe('Case insensitive search'),
  type: z.string().optional().describe('File type to search (js, py, rust, go, java, etc.)'),
  head_limit: z.coerce.number().int().nonnegative().optional().describe('Limit output to first N results. Defaults to 250. Pass 0 for unlimited'),
  offset: z.coerce.number().int().nonnegative().optional().describe('Skip first N results before applying head_limit. Defaults to 0'),
  multiline: z.coerce.boolean().optional().describe('Enable multiline mode where . matches newlines'),
});

const outputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  appliedLimit: z.number().optional(),
  appliedOffset: z.number().optional(),
});

type GrepInput = z.infer<typeof inputSchema>;
type GrepOutput = z.infer<typeof outputSchema>;

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined };
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const wasTruncated = items.length - offset > effectiveLimit;
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  };
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
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
    return 'Grep';
  },

  getToolUseSummary(input?: { pattern?: string }) {
    return input?.pattern ? `Search for "${input.pattern}"` : null;
  },

  getActivityDescription(input?: { pattern?: string }) {
    return input?.pattern ? `Searching for "${input.pattern}"` : 'Searching';
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    return true;
  },

  async call(
    input: GrepInput,
    context: ToolUseContext,
  ): Promise<ToolResult<GrepOutput>> {

    const {
      pattern,
      path: inputPath,
      glob,
      type,
      output_mode = 'files_with_matches',
      '-B': contextBefore,
      '-A': contextAfter,
      '-C': contextC,
      context: contextLines,
      '-n': showLineNumbers = true,
      '-i': caseInsensitive = false,
      head_limit,
      offset = 0,
      multiline = false,
    } = input;

    if (!pattern || typeof pattern !== 'string') {
      throw new Error('pattern is required and must be a string');
    }

    const projectRoot = context.cwd;
    const searchPath = inputPath ? expandPath(inputPath) : projectRoot;

    const args = ['--hidden'];

    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`);
    }

    args.push('--max-columns', '500');

    if (multiline) {
      args.push('-U', '--multiline-dotall');
    }

    if (caseInsensitive) {
      args.push('-i');
    }

    if (output_mode === 'files_with_matches') {
      args.push('-l');
    } else if (output_mode === 'count') {
      args.push('-c');
    }

    if (showLineNumbers && output_mode === 'content') {
      args.push('-n');
    }

    if (output_mode === 'content') {
      if (contextLines !== undefined) {
        args.push('-C', contextLines.toString());
      } else if (contextC !== undefined) {
        args.push('-C', contextC.toString());
      } else {
        if (contextBefore !== undefined) {
          args.push('-B', contextBefore.toString());
        }
        if (contextAfter !== undefined) {
          args.push('-A', contextAfter.toString());
        }
      }
    }

    if (pattern.startsWith('-')) {
      args.push('-e', pattern);
    } else {
      args.push(pattern);
    }

    if (type) {
      args.push('--type', type);
    }

    if (glob) {
      const globPatterns: string[] = [];
      const rawPatterns = glob.split(/\s+/);

      for (const rawPattern of rawPatterns) {
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern);
        } else {
          globPatterns.push(...rawPattern.split(',').filter(Boolean));
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern);
      }
    }

    const results = await ripGrep(args, searchPath, {
      timeout: 20000,
      abortSignal: context.abortController.signal as AbortSignal,
    });

    if (output_mode === 'content') {
      const { items: limitedResults, appliedLimit } = applyHeadLimit(results, head_limit, offset);

      const finalLines = limitedResults.map((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex);
          const rest = line.substring(colonIndex);
          const relativePath = path.relative(searchPath, filePath);
          return `${relativePath}${rest}`;
        }
        return line;
      });

      const output = {
        mode: 'content' as const,
        numFiles: 0,
        filenames: [],
        content: finalLines.join('\n'),
        numLines: finalLines.length,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      };

      return { data: output };
    }

    if (output_mode === 'count') {
      const { items: limitedResults, appliedLimit } = applyHeadLimit(results, head_limit, offset);

      const finalCountLines = limitedResults.map((line) => {
        const colonIndex = line.lastIndexOf(':');
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex);
          const count = line.substring(colonIndex);
          const relativePath = path.relative(searchPath, filePath);
          return `${relativePath}${count}`;
        }
        return line;
      });

      let totalMatches = 0;
      let fileCount = 0;
      for (const line of finalCountLines) {
        const colonIndex = line.lastIndexOf(':');
        if (colonIndex > 0) {
          const countStr = line.substring(colonIndex + 1);
          const count = parseInt(countStr, 10);
          if (!isNaN(count)) {
            totalMatches += count;
            fileCount += 1;
          }
        }
      }

      const output = {
        mode: 'count' as const,
        numFiles: fileCount,
        filenames: [],
        content: finalCountLines.join('\n'),
        numMatches: totalMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      };

      return { data: output };
    }

    const { items: finalMatches, appliedLimit } = applyHeadLimit(results, head_limit, offset);

    const relativeMatches = finalMatches.map((p) => path.relative(searchPath, p));

    const output = {
      mode: 'files_with_matches' as const,
      filenames: relativeMatches,
      numFiles: relativeMatches.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    };

    return { data: output };
  },

  mapToolResultToToolResultBlockParam(data: unknown, toolUseID: string) {
    const output = data as {
      mode?: 'content' | 'files_with_matches' | 'count';
      numFiles: number;
      filenames: string[];
      content?: string;
      numLines?: number;
      numMatches?: number;
      appliedLimit?: number;
      appliedOffset?: number;
    };

    const { mode = 'files_with_matches', numFiles, filenames, content, numMatches, appliedLimit, appliedOffset } = output;

    if (mode === 'content') {
      const limitInfo = appliedLimit !== undefined || appliedOffset !== undefined
        ? `limit: ${appliedLimit ?? 'unlimited'}, offset: ${appliedOffset ?? 0}`
        : '';

      const resultContent = content || 'No matches found';
      const finalContent = limitInfo
        ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
        : resultContent;

      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: finalContent,
        exit_code: 0,
      };
    }

    if (mode === 'count') {
      const limitInfo = appliedLimit !== undefined || appliedOffset !== undefined
        ? `limit: ${appliedLimit ?? 'unlimited'}, offset: ${appliedOffset ?? 0}`
        : '';

      const rawContent = content || 'No matches found';
      const matches = numMatches ?? 0;
      const files = numFiles ?? 0;
      const summary = `\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`;

      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: rawContent + summary,
        exit_code: 0,
      };
    }

    const limitInfo = appliedLimit !== undefined || appliedOffset !== undefined
      ? `limit: ${appliedLimit ?? 'unlimited'}, offset: ${appliedOffset ?? 0}`
      : '';

    if (numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
        exit_code: 0,
      };
    }

    const result = `Found ${numFiles} ${numFiles === 1 ? 'file' : 'files'}${limitInfo ? ` ${limitInfo}` : ''}\n${filenames.join('\n')}`;
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    };
  },
});
