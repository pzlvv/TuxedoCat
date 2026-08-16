/**
 * Glob 工具提示词
 */

export const TOOL_NAME = 'Glob';

export const DESCRIPTION = `Finds files by name pattern or wildcard using ripgrep.`;

export function getPrompt(): string {
  return `## Glob Tool
Finds files by name pattern or wildcard using ripgrep.

**When to use:**
- Use this tool when you need to find files matching a specific pattern
- Prefer this tool over Bash with find commands
- ALWAYS use this tool for file pattern matching - never use the Bash tool with find commands

**Parameters:**
- pattern (required): The glob pattern to match files against (e.g. "**/*.js", "src/**/*.ts")
- path (optional): The directory to search in. If not specified, the current working directory will be used

**Output:**
- Returns matching file paths sorted by modification time
- Results are limited to 100 files by default`;
}
