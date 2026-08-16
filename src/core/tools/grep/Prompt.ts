/**
 * Grep 工具提示词
 */

export const TOOL_NAME = 'Grep';

export const DESCRIPTION = `Searches for patterns in file contents using ripgrep (rg).`;

export function getPrompt(): string {
  return `## Grep Tool
Searches for patterns in file contents using ripgrep (rg).

**When to use:**
- Use this tool when you need to find files containing specific text or patterns
- Prefer this tool over Bash with grep/ripgrep commands
- ALWAYS use this tool for content searching - never use the Bash tool with grep/rg commands

**Parameters:**
- pattern (required): The regular expression pattern to search for
- path (optional): File or directory to search in. Defaults to current working directory
- glob (optional): Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")
- output_mode (optional): "files_with_matches" (default), "content", or "count"
- -C/-B/-A/context (optional): Number of context lines to show
- -i (optional): Case insensitive search
- type (optional): File type to search (js, py, rust, go, java, etc.)
- head_limit (optional): Limit output to first N results. Defaults to 250. Pass 0 for unlimited
- offset (optional): Skip first N results before applying head_limit
- multiline (optional): Enable multiline mode where . matches newlines

**Usage:**
- Search for text: pattern="keyword"
- Search in directory: pattern="TODO", path="src"
- Filter by file type: pattern="import", glob="*.ts"
- Show matching content: pattern="TODO", output_mode="content", -C=2
- Case insensitive: pattern="error", -i=true
- Count matches: pattern="function", output_mode="count"

**Output modes:**
- "files_with_matches" (default): Returns file paths
- "content": Returns matching lines with line numbers
- "count": Returns match counts per file`;
}
