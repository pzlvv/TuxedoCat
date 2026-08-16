/**
 * AskUserQuestion 工具提示词
 */

export const TOOL_NAME = 'AskUserQuestion';

export const DESCRIPTION = `Ask the user a question and wait for their response.`;

export function getPrompt(): string {
  return `## AskUserQuestion Tool

Ask the user a question and get their response. Use this tool when you need input from the user during a task.

**Parameters:**
- \`question\` (string, required): The question to ask
- \`choices\` (array, optional): Up to 9 predefined choices for the user to pick from, each \`{ label, description? }\`

**How to use:**
- Provide a clear question in the "question" field
- Optionally provide choices as an array of { label, description? } objects
- Without choices: user can reply with any text
- With choices: user can pick an option or type free text

**Examples:**
- Ask a yes/no question: \`{ question: "Continue with this approach?", choices: [{ label: "Yes" }, { label: "No" }] }\`
- Ask for input: \`{ question: "What port number should I use?" }\`
- Ask with options: \`{ question: "Which database?", choices: [{ label: "PostgreSQL" }, { label: "MySQL", description: "Existing project uses MySQL" }] }\`

**Important:**
- This tool BLOCKS execution until the user responds
- The user can also type free text even when choices are provided
- Limit choices to 9 or fewer for readability`;
}
