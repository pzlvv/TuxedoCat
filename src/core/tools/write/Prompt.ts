/**
 * Write 工具提示词
 */

export const TOOL_NAME = 'Write';

export const DESCRIPTION = `Writes content to a file on the local filesystem (creates or overwrites).`;

export function getPrompt(): string {
  return `## Write Tool

Writes content to a file on the local filesystem. Creates the file if it doesn't exist, or overwrites it if it does.

**Parameters:**
- \`file_path\` (string, required): The absolute path to the file to write
- \`content\` (string, required): The content to write to the file

**Usage:**
- Create new file: Provide path and content
- Overwrite existing file: Completely replaces the file contents

**Important:**
- Prefer Edit tool for modifying existing files
- The file path must be absolute, not relative
- This tool will completely replace the file contents`;
}
