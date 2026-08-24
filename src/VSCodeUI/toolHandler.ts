/**
 * VSCodeUI/toolHandler.ts - 工具调用处理
 * 处理 onPreToolCall / onToolCall / onToolResult 等工具生命周期
 */
import type { LogChannel } from '../host/UIHost.js';
import { expandPath } from '../core/utils/path.js';
import { logger } from '../core/Logger.js';
import { buildEditDiffHunks } from '../core/utils/editDiff.js';
import type { PermissionResult } from '../core/tools/Tool.js';
import type { UserChoiceManager } from './userChoice.js';

/**
 * ToolHandler - 管理工具调用的 UI 展示
 */
export class ToolHandler {
  private outputChannel: LogChannel | undefined;
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'>;
  private userChoiceManager: UserChoiceManager;

  constructor(deps: {
    outputChannel: LogChannel | undefined;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'>;
    userChoiceManager: UserChoiceManager;
  }) {
    this.outputChannel = deps.outputChannel;
    this.postToWebview = deps.postToWebview;
    this.sessionAgentModes = deps.sessionAgentModes;
    this.userChoiceManager = deps.userChoiceManager;
  }

  private log(...args: unknown[]): void {
    this.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
  }

  /**
   * core 层调用：通知工具调用开始前
   */
  async onPreToolCall(
    sessionID: string,
    toolUseId: string,
    toolName: string,
    args: Record<string, any>,
    tool: unknown,
  ): Promise<PermissionResult> {
    const toolCallId = toolUseId;
    logger.info('VSCodeUI', `onPreToolCall: ${toolName} (toolCallId: ${toolCallId})`);

    // 调用 checkPermissions 获取权限结果
    let permResult: PermissionResult = { behavior: 'allow' };
    if (tool && typeof tool === 'object' && 'checkPermissions' in tool && typeof tool.checkPermissions === 'function') {
      const context = {
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
        messages: [],
        sessionId: sessionID,
      };
      try {
        permResult = await (tool as any).checkPermissions(args, context);
      } catch (error) {
        this.log(`[VSCodeUI] checkPermissions error: ${error}`);
        permResult = { behavior: 'deny', message: `权限检查失败: ${error}` };
      }
    }

    // 保存 Edit / Write 工具的 diff 信息。
    // 注意：只有在本次 checkPermissions 结果里确实携带了 diff 字段时才保存/使用
    // userChoiceManager 中的快照，否则会把上一次 Edit/Write 的 diff 错误地挂到
    // 本次（例如 old_string 多处匹配被 deny）的失败工具卡片上。
    const hasPermDiff = (toolName === 'Edit' || toolName === 'Write') && 'beforeContent' in permResult;
    if (hasPermDiff) {
      // Write 新建文件时 beforeContent 为 null，需要保留 null 以便回滚时删除文件
      const pc = (permResult as any).beforeContent;
      this.userChoiceManager.currentBeforeContent = pc !== undefined ? pc : '';
      this.userChoiceManager.currentAfterContent = (permResult as any).afterContent || '';
      this.userChoiceManager.currentContextBefore = (permResult as any).contextBefore || [];
      this.userChoiceManager.currentContextAfter = (permResult as any).contextAfter || [];
      this.userChoiceManager.currentStartLine = (permResult as any).startLine;
      this.userChoiceManager.currentEndLine = (permResult as any).endLine;
    }

    // 自动模式跳过确认
    const effectiveAgentMode = this.sessionAgentModes.get(sessionID) ?? 'manual';

    // Auto 模式下 AskUserQuestion 不可用：不弹出提问框，直接返回不可用结果
    if (toolName === 'AskUserQuestion' && effectiveAgentMode === 'auto') {
      logger.info('VSCodeUI', `Auto mode (session ${sessionID}): AskUserQuestion unavailable, denying tool call`);
      permResult = {
        behavior: 'deny',
        message: 'AskUserQuestion is unavailable in Auto mode. Please analyze the situation and make a reasonable decision on your own.',
      };
    }

    if (effectiveAgentMode === 'auto' && permResult.behavior === 'ask') {
      logger.info('VSCodeUI', `Auto mode (session ${sessionID}): allowing tool ${toolName} without confirmation`);
      permResult = { behavior: 'allow' };
    }

    // 风险拦截模式：只拦截危险操作，普通操作自动放行
    if (effectiveAgentMode === 'risk' && permResult.behavior === 'ask') {
      if (this.isOperationRisky(tool, toolName, args)) {
        logger.info('VSCodeUI', `Risk mode (session ${sessionID}): intercepting risky tool ${toolName}`);
        // Keep 'ask' behavior - still ask user for confirmation
      } else {
        logger.info('VSCodeUI', `Risk mode (session ${sessionID}): allowing non-risky tool ${toolName} without confirmation`);
        permResult = { behavior: 'allow' };
      }
    }

    // 对文件操作工具展开路径
    let displayArgs = { ...args };
    if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
      const filePath = args.file_path || args.path;
      if (filePath && typeof filePath === 'string') {
        try {
          const absolutePath = expandPath(filePath);
          displayArgs = { ...args, file_path: absolutePath };
        } catch (error) {
          logger.error('VSCodeUI', `路径展开失败: ${error}`);
        }
      }

      if (toolName === 'Write' && args.content) {
        const content = String(args.content);
        // 保留 null（新建文件）以便回滚时删除文件
        const permBeforeContent = (permResult as any).beforeContent;
        const wBeforeContent = permBeforeContent !== undefined && permBeforeContent !== '' ? permBeforeContent : (this.userChoiceManager.currentBeforeContent !== undefined ? this.userChoiceManager.currentBeforeContent : null);
        const wAfterContent = this.userChoiceManager.currentAfterContent || args.content || '';
        displayArgs = {
          ...displayArgs,
          content: args.content,
          contentPreview: content,
          totalLines: content.split('\n').length,
          isTruncated: false,
          beforeContent: wBeforeContent,
          afterContent: wAfterContent,
        };
      }

      if (toolName === 'Edit') {
        const oldString = args.old_string ? String(args.old_string) : '';
        const newString = args.new_string ? String(args.new_string) : '';
        const replaceAll = args.replace_all || false;

        displayArgs = {
          ...displayArgs,
          old_string: oldString,
          new_string: newString,
          replace_all: replaceAll,
        };

        // 只有本次权限检查确实携带 diff 信息时才附加 diff 字段。
        // 若 checkPermissions 直接 deny（例如 old_string 匹配到多处），
        // permResult 中没有 beforeContent/afterContent，此时不应使用
        // userChoiceManager 中上一次请求遗留的 diff，否则 webview 会显示错误 diff。
        if (hasPermDiff) {
          const beforeContent = this.userChoiceManager.currentBeforeContent || '';
          const afterContent = this.userChoiceManager.currentAfterContent || '';
          displayArgs = {
            ...displayArgs,
            contextBefore: this.userChoiceManager.currentContextBefore || [],
            contextAfter: this.userChoiceManager.currentContextAfter || [],
            // Edit 只发送 diff 相关行，避免把整个文件内容发给 webview
            diffHunks: buildEditDiffHunks({
              beforeContent,
              afterContent,
              startLine: this.userChoiceManager.currentStartLine,
              endLine: this.userChoiceManager.currentEndLine,
              replaceAll,
            }),
            startLine: this.userChoiceManager.currentStartLine,
            endLine: this.userChoiceManager.currentEndLine,
          };
        }
      }
    }

    // 添加 previewContent
    if (permResult && typeof permResult === 'object' && 'previewContent' in permResult && permResult.previewContent) {
      displayArgs = { ...displayArgs, _preview: String(permResult.previewContent) };
    }

    // 发送到 webview
    this.postToWebview(sessionID, {
      type: 'addMessage',
      role: 'toolcall',
      content: '',
      param: `⚙️ ${toolName}`,
      toolName,
      toolArgs: displayArgs,
      status: 'normal',
      toolCallId,
    });

    const diffLineCount = Array.isArray((displayArgs as any).diffHunks)
      ? (displayArgs as any).diffHunks.reduce((s: number, h: any) => s + (h.lines?.length || 0), 0)
      : 0;
    this.log(`[VSCodeUI] addMessage: ${toolName} file=${(displayArgs as any).file_path || '-'} diffLines=${diffLineCount} beforeLen=${(displayArgs as any).beforeContent?.length || 0} afterLen=${(displayArgs as any).afterContent?.length || 0}`);

    // 异步写入 block 顶层 _meta
    if (permResult && typeof permResult === 'object' && !('updatedInput' in permResult)) {
      const hasExtraFields = Object.keys(displayArgs).some(k => !(k in args));
      if (hasExtraFields) {
        (permResult as any).updatedInput = { ...args };
        const { updateToolUseMeta } = require('../core/history/index.js');
        updateToolUseMeta(sessionID, toolUseId, {
          beforeContent: this.userChoiceManager.currentBeforeContent !== undefined ? this.userChoiceManager.currentBeforeContent : '',
          afterContent: this.userChoiceManager.currentAfterContent || '',
          contextBefore: this.userChoiceManager.currentContextBefore || [],
          contextAfter: this.userChoiceManager.currentContextAfter || [],
          startLine: this.userChoiceManager.currentStartLine,
          endLine: this.userChoiceManager.currentEndLine,
        }).catch((e: unknown) =>
          this.log(`[VSCodeUI] updateToolUseMeta error: ${e}`)
        );
      }
    }

    return permResult;
  }

  /**
   * core 层调用：通知工具调用开始
   */
  onToolCall(sessionID: string, toolUseId: string, toolName: string): void {
    const toolCallId = toolUseId;
    logger.info('VSCodeUI', `Tool call start: ${toolName} (toolCallId: ${toolCallId})`);
    this.postToWebview(sessionID, {
      type: 'updateToolStatus',
      toolCallId,
      status: 'running',
    });
  }

  /**
   * core 层调用：通知工具执行结果
   */
  onToolResult(sessionID: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void {
    const toolCallId = toolUseId;
    logger.info('VSCodeUI', `Tool result: ${toolName} - ${status} (toolCallId: ${toolCallId})`);

    const outputObj = output as any;
    if (toolName === 'Edit') {
      if (status === 'error') {
        this.log(`[VSCodeUI] Edit tool failed, clearing diff display`);
        this.postToWebview(sessionID, {
          type: 'updateToolArgs',
          toolCallId,
          beforeContent: '',
          afterContent: '',
          diffHunks: [],
          contextBefore: [],
          contextAfter: [],
        });
      } else if (outputObj.hasContext || status === 'success') {
        this.log(`[VSCodeUI] Edit tool has context: ${outputObj.contextBefore?.length || 0} before, ${outputObj.contextAfter?.length || 0} after`);
        this.postToWebview(sessionID, {
          type: 'updateToolArgs',
          toolCallId,
          contextBefore: outputObj.contextBefore || this.userChoiceManager.currentContextBefore || [],
          contextAfter: outputObj.contextAfter || this.userChoiceManager.currentContextAfter || [],
          startLine: outputObj.startLine !== undefined ? outputObj.startLine : this.userChoiceManager.currentStartLine,
          endLine: outputObj.endLine !== undefined ? outputObj.endLine : this.userChoiceManager.currentEndLine,
        });
      }
    }

    const statusUpdate: any = {
      type: 'updateToolStatus',
      toolCallId,
      status: status === 'error' ? 'fail' : 'success',
      output,
    };

    if (toolName === 'Edit' && status === 'success') {
      if (this.userChoiceManager.currentStartLine !== undefined) statusUpdate.startLine = this.userChoiceManager.currentStartLine;
      if (this.userChoiceManager.currentEndLine !== undefined) statusUpdate.endLine = this.userChoiceManager.currentEndLine;
    }

    this.postToWebview(sessionID, statusUpdate);
  }

  /**
   * 判断操作是否为危险操作（用于风险拦截模式）
   * 危险操作定义：
   * 1. Bash 破坏性命令（dd、mkfs、format、fdisk、shred、wipe 等）
   * 2. Git 破坏性命令（仅 checkout、reset）
   * 注意：cp、mv 以及除 checkout/reset 之外的 git 操作不属于危险操作，无需确认。
   */
  private isOperationRisky(tool: unknown, toolName: string, args: Record<string, any>): boolean {
    // Bash 命令
    if (toolName === 'Bash') {
      const command = (args as any)?.command || '';
      // 使用工具自身的 isDestructive 方法判断（mv、cp 已不属于破坏性命令）
      if (tool && typeof tool === 'object' && 'isDestructive' in tool && typeof (tool as any).isDestructive === 'function') {
        try {
          if ((tool as any).isDestructive(args)) {
            return true;
          }
        } catch {
          // ignore
        }
      }
      // Git 破坏性命令（仅 checkout、reset）
      if (/\bgit\s+(checkout|reset)\b/.test(command)) {
        return true;
      }
    }

    return false;
  }
}
