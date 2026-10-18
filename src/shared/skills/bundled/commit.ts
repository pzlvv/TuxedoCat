/**
 * commit 内置 Skill
 *
 * 由 /commit 或 Skill Tool 触发，引导 LLM 创建 Git 提交。
 * 参考自 Claude Code 的 commit 命令实现。
 */

import type { BundledSkillDefinition } from '../Types.js';

/**
 * 生成 commit skill 的 prompt 内容
 */
function getPromptContent(): string {
  return `## Context

- Current git status: run \`git status\`
- Current git diff (staged and unstaged changes): run \`git diff HEAD\`
- Current branch: run \`git branch --show-current\`
- Recent commits: run \`git log --oneline -10\`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use \`git commit --amend\`, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like \`git rebase -i\` or \`git add -i\`) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Use Bash tool to check git status and diff (as shown in the Context section above)
2. Analyze all changes and draft a commit message:
   - Look at the recent commits to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

3. Stage relevant files and create the commit using heredoc syntax:
   \`\`\`
   git add <files>
   git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
   \`\`\`

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else.`;
}

/**
 * 获取 commit skill 的 BundledSkillDefinition
 * 由 bundledSkills.ts 在模块初始化时调用
 */
export function getCommitSkillDefinition(): BundledSkillDefinition {
  return {
    name: 'commit',
    description: 'Create a git commit from staged and unstaged changes',
    whenToUse: 'Use this when the user asks you to commit changes or create a git commit',
    getPromptForCommand: async (args: string) => {
      let content = getPromptContent();

      // 如果用户提供了额外的提交信息，追加到 prompt 中
      const trimmedArgs = args?.trim();
      if (trimmedArgs) {
        content += `\n\n## Additional instructions from user\n\n${trimmedArgs}`;
      }

      return [{ type: 'text', text: content }];
    },
  };
}
