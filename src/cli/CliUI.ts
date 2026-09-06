/**
 * CLI UI - AssistantUI 的 CLI 实现
 * 单次执行模式，不交互、不需要确认、简要输出
 */

import type { AssistantUI, MessageData, StreamMessageData, StreamEndData } from '../core/AssistantUI.js';
import type { PermissionResult } from '../core/tools/Tool.js';
import type { UIDynamicInfo } from '../core/prompt/SystemPrompt.js';

export class CLIUI implements AssistantUI {
  /** 缓存当前正在执行的 tool use args，用于 onToolCall 输出详细信息 */
  private pendingToolArgs = new Map<string, Record<string, any>>();
  /** 当前查询中是否已输出过任何内容（文本或 tool call） */
  private hasOutput = false;

  async onPreToolCall(
    _sessionID: string,
    toolUseId: string,
    _toolName: string,
    args: Record<string, any>,
    _tool: unknown,
  ): Promise<PermissionResult> {
    // 缓存 args 供 onToolCall 使用
    this.pendingToolArgs.set(toolUseId, args);
    // 不需要确认，直接允许
    return { behavior: 'allow' };
  }

  onToolCall(_sessionID: string, toolUseId: string, toolName: string): void {
    const args = this.pendingToolArgs.get(toolUseId);
    this.pendingToolArgs.delete(toolUseId);

    // 纯 tool_use（无文本输出）时前面不加额外换行
    if (!this.hasOutput) {
      this.hasOutput = true;
    }

    if (args && Object.keys(args).length > 0) {
      const argsStr = JSON.stringify(args, null, 2);
      process.stdout.write(`--- Tool Call: ${toolName} ---\n${argsStr}\n`);
    } else {
      process.stdout.write(`--- Tool Call: ${toolName} ---\n`);
    }
  }

  onToolResult(
    _sessionID: string,
    _toolUseId: string,
    toolName: string,
    output: string,
    status: 'success' | 'error',
  ): void {
    const statusIcon = status === 'success' ? 'OK' : 'FAIL';
    const truncated = output.length > 500 ? output.slice(0, 500) + '\n... (truncated)' : output;
    process.stdout.write(`--- Tool Result: ${toolName} [${statusIcon}] ---\n`);
    if (truncated) {
      process.stdout.write(`${truncated}\n`);
    }
    process.stdout.write('\n');
  }

  async requestUserChoice(
    _sessionID: string,
    _options: {
      toolName: string;
      message: string;
      choices: Array<{ label: string; description?: string }>;
      showPreview?: boolean;
      previewContent?: string;
      previewTitle?: string;
      showDiff?: boolean;
      beforeContent?: string;
      afterContent?: string;
      diffTitle?: string;
      contextBefore?: string[];
      contextAfter?: string[];
    },
  ): Promise<{ index: number; reply?: string }> {
    // 单次执行模式下不应该出现需要用户选择的场景
    throw new Error('CLI mode does not support user choice requests');
  }

  async requestPassword(_sessionID: string, _prompt: string, _validationRule?: { pattern: RegExp; message: string }, _plainText?: boolean): Promise<string | null> {
    // CLI mode does not support password input
    throw new Error('CLI mode does not support password input');
  }

  onMessage(_sessionID: string, data: MessageData): void {
    // 只输出 assistant 的非空纯文本内容（非流式场景，如压缩恢复后的消息）
    // 跳过空串和纯空白内容，避免引入多余换行
    if (data.role === 'assistant' && data.content && data.content.trim().length > 0) {
      this.hasOutput = true;
      process.stdout.write(data.content);
    }
  }

  onStreamMessage(_sessionID: string, data: StreamMessageData): void {
    // 流式输出：逐 delta 追加到 stdout，跳过纯空白 delta
    if (data.role === 'assistant' && data.delta && data.delta.trim().length > 0) {
      this.hasOutput = true;
      process.stdout.write(data.delta);
    }
  }

  onStreamEnd(_sessionID: string, data: StreamEndData): void {
    // AI 文本末尾已自带换行时不重复输出
    if (data.role === 'assistant' && data.accumulated) {
      this.hasOutput = true;
      if (!data.accumulated.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
  }

  onAbort(_sessionID: string): void {
    // 不处理
  }

  onAIBegin(_sessionID: string): void {
    // 不输出
  }

  onAIEnd(_sessionID: string): void {
    // 不输出
  }

  onQueryBegin(_sessionID: string): void {
    // 重置输出标记，用于判断流式输出是否为空
    this.hasOutput = false;
  }

  onQueryEnd(_sessionID: string): void {
    // 不输出（onStreamEnd 已负责结尾换行）
  }

  scheduleConversationListRefresh(): void {
    // CLI 没有侧栏对话列表，无需刷新
  }

  async getUIDynamicInfo(_sessionID: string): Promise<UIDynamicInfo> {
    return { cwd: process.cwd() };
  }

  setTitle(_sessionID: string, _title: string): void {
    // 不处理
  }

  clearMessages(_sessionID: string): void {
    // 不处理
  }
}
