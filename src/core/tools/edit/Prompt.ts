/**
 * Edit 工具提示词
 */

export const TOOL_NAME = 'Edit';

export const DESCRIPTION = `Edits a file by replacing exact text matches. Preferred over Write tool for modifying existing files.`;

export function getPrompt(): string {
  return `## Edit Tool

Edits a file by replacing exact text matches. This is the preferred tool for modifying existing files.

**Parameters:**
- \`file_path\` (string, required): The absolute path to the file to edit
- \`old_string\` (string, required): The exact string to replace
- \`new_string\` (string, required): The new string to replace it with
- \`replace_all\` (boolean, optional): Replace all occurrences within the search range (default: false)
- \`offset\` (number, optional): The 1-based line number where the search range starts (default: 1)
- \`limit\` (number, optional): The number of lines to search within. If provided, \`old_string\` must match entirely within lines \`offset\` to \`offset+limit-1\` (1-based); if omitted, searches to the end of the file

**Usage:**
- Single replacement: Provide exact \`old_string\` to replace once
- Replace all occurrences: Set \`replace_all\` to true
- Edit a specific line range: Use \`offset\` and \`limit\` to restrict matching to a portion of the file

**Important:**
- The \`old_string\` must match exactly (including whitespace and indentation).
- When \`offset\` and/or \`limit\` are provided, only matches within the specified line range are considered.
- When \`replace_all\` is false, \`old_string\` must match exactly once within the search range. If it matches multiple locations, the tool returns an error instead of applying the first match; include more surrounding context to make \`old_string\` unique, or set \`replace_all\` to true.
- The tool result includes the edited line numbers (e.g. \`Edited lines 10-15\`), matching the line numbers shown by the Read tool.
- This tool only modifies the specific matched sections, not the entire file
- For creating new files or complete replacements, use the Write tool instead`;
}
