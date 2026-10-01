/**
 * AgentTool 工具的 Prompt 定义
 * 子代理工具 - 委托复杂任务给专用子代理
 */

export const TOOL_NAME = "Agent";

export const DESCRIPTION = `Create a new sub-agent that runs autonomously in the background.`;

/**
 * Master 子代理的 `## Communication` 段。
 *
 * 子代理的 system prompt = 主对话同款提示词（按继承的预设组装）+ 本段前缀，因此这里
 * 只产出 Communication 段本身（核心身份 / 工具说明 / 环境由预设组装产出）。
 * 文本与 Standalone 的 `prompt::sub_agent_communication_section` 逐字对齐
 * （对照表 `systemPromptParity.json` 锁定）。
 */
export function buildAgentCommunicationSection(creatorSessionId: string): string {
  return `## Communication
You are a sub-agent created by the main conversation. When you complete your task (or need to provide progress updates), use the **Reply** tool to send a message back to the conversation that created you.

Important guidelines:
- Work autonomously and complete the assigned task
- Keep the conversation that created you informed of your progress
- When done, send a clear summary of what you accomplished using the Reply tool
- When calling the Reply tool, set \`targetSessionId\` to \`${creatorSessionId}\` to ensure the reply reaches the correct session`;
}

/**
 * 获取角色描述列表（用于工具描述中的格式）
 */
export function getAgentRolesDescription(): string {
  return `Available agent roles (required):
- "Master": Same capabilities as the main Agent (excluding the role capabilities listed above), used for handling tasks in an independent context.`;
}

export function getPrompt(): string {
  return `## Agent Tool

Launches a specialized sub-agent to handle complex, multi-step tasks autonomously.

**Parameters:**
- \`prompt\` (string, required): The task for the agent to perform
- \`description\` (string, optional): A short (3-5 word) description summarizing what the agent will do
- \`agentRole\` (string, required): The role of the agent to spawn

${getAgentRolesDescription()}

**Usage:**
- Use when a task requires multiple steps that can be delegated
- Use for research tasks that need independent investigation
- Use for parallelizable work that benefits from isolation
- The sub-agent has its own isolated context and tool access

**Important:**
- Always include a short description (3-5 words) summarizing what the agent will do
- Provide clear, self-contained task instructions
- The agent's outputs should generally be trusted
- The agent runs synchronously - it returns a single result message
- **Delegate entire sub-agent tasks**: Describe the final goal in the prompt and let the sub-agent handle everything.
- If you have additional requests for the sub-agent, use the **Reply** tool to communicate with it. Otherwise, please wait patiently — the sub-agent will always report its results on its own.
- After creating a sub-agent, you can continue with other tasks. If you depend on the sub-agent's results, you may end the conversation temporarily — do not actively poll the sub-agent for results.`;
}
