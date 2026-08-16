/**
 * Bash 工具提示词
 */

import type { BashToolInput } from './Types.js';

/**
 * 获取工具描述
 */
export async function getDescription(input: BashToolInput): Promise<string> {
  if (input?.description) {
    return input.description;
  }
  if (input?.command) {
    const command = input.command.trim().split(/\s+/)[0];
    return `Run shell command: ${command}`;
  }
  return 'Execute Bash shell commands';
}

/**
 * 获取工具提示词
 */
export async function getPrompt(): Promise<string> {
  return `Execute shell commands.

**IMPORTANT**: Always use bash/POSIX syntax for commands, regardless of the actual shell. This ensures commands work across bash, PowerShell, and cmd.exe.

**Syntax Guidelines**:
- Use forward slashes for paths
- Use unix-style commands: ls, cat, rm, cp, mv, mkdir, touch, sort, grep, find, head, tail, wc, awk, sed, cut, tr, uniq, diff, tar, zip, unzip, curl, wget
- Use pipes and redirection: |, >, >>, <
- Use command chains: &&, ||, ;
- Environment variables: $VAR (not %VAR%)
- Quote handling: Use single quotes for strings with spaces

**Pipes & Command Chains**:
- \`|\` pipes the output of one command into the next: \`grep pattern file.txt | sort | uniq\`
- \`&&\` runs the next command only if the previous succeeded: \`npm run build && npm test\`
- \`||\` runs the next command only if the previous failed: \`cd dist || mkdir dist\`
- \`;\` runs commands sequentially regardless of success: \`cd src; ls -la\`
- IMPORTANT: A \`|\` inside quotes is part of the argument, NOT a separator. For example \`grep "a|b" file.txt\` searches for the literal text \`a|b\`. Do not split commands at a \`|\` that appears inside single or double quotes.

**Common Usage**:
- Run tests: npm test
- Build: npm run build or make build
- List files: ls -la
- Search: grep 'pattern' file.txt
- Sort lines: sort file.txt
- Count lines/words: wc -l file.txt

**Path Handling**:
- Always use forward slashes in paths, even on Windows
- Use relative paths from the current working directory when possible
- Absolute paths should use forward slashes

Commands will be executed in the current working directory unless you specify a different path using cd.

**Background Execution**:
- You can use the \`run_in_background\` parameter to run commands in the background.
- Use this when you don't need the result immediately and want to continue with other tasks.
- You will be notified when the background command completes — no need to poll or check manually.
- Do not use shell backgrounding operators like \`&\` or \`nohup\` — use the \`run_in_background\` parameter instead.`;
}

/**
 * 获取用户可见名称
 */
export function getUserFacingName(input?: BashToolInput): string {
  if (input?.description) {
    return `Bash: ${input.description}`;
  }
  if (input?.command) {
    const cmd = input.command.trim().split(/\s+/)[0];
    return `Bash: ${cmd}`;
  }
  return 'Bash';
}

/**
 * 获取工具使用摘要
 */
export function getToolUseSummary(input: BashToolInput): string | null {
  if (!input?.command) {
    return null;
  }
  if (input.description) {
    return input.description;
  }
  // 截断过长的命令
  const maxLength = 50;
  if (input.command.length <= maxLength) {
    return input.command;
  }
  return input.command.substring(0, maxLength) + '...';
}

/**
 * 获取活动描述
 */
export function getActivityDescription(input?: BashToolInput): string | null {
  if (!input?.command) {
    return 'Running command';
  }
  const summary = getToolUseSummary(input);
  const desc = input.description || summary || 'command';
  return `Running ${desc}`;
}
