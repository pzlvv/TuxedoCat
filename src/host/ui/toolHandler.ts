/**
 * src/host/ui/toolHandler.ts - 工具调用处理
 * 处理 requestToolPermission / onToolCall / onToolResult 等工具生命周期
 *
 * 阶段 2.5 起，权限规则（agentMode → checkPermissions → auto/risk/manual 加工 →
 * displayArgs 展开）全部搬到 core 的 PermissionPolicy。本类只剩「展示」：
 * - 把 core 传来的 displayArgs 上架成工具卡片（normal 状态）
 * - permResult.behavior === 'ask' 时弹确认框（UserChoiceManager）并回传用户选择
 * - 工具卡片的运行/失败状态更新
 * - Edit / Write 的 diff 信息暂存（供工具卡片展示与权限确认框复用）
 */
import type { UIHost } from '../UIHost.js';
import { logger } from '../../core/Logger.js';

import { updateToolUseMeta } from '../../core/history/index.js';
import type { AgentMode } from '../../core/types.js';
import type { PermissionResult } from '../../core/tools/Tool.js';
import type { UserChoiceManager } from './userChoice.js';

/**
 * ToolHandler - 管理工具调用的 UI 展示
 */
export class ToolHandler {
  private host: UIHost;
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private userChoiceManager: UserChoiceManager;

  constructor(deps: {
    host: UIHost;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    userChoiceManager: UserChoiceManager;
  }) {
    this.host = deps.host;
    this.postToWebview = deps.postToWebview;
    this.userChoiceManager = deps.userChoiceManager;
  }

  private log(...args: unknown[]): void {
    this.host.log(...args);
  }

  /**
   * core 层调用（CoreRequest.toolPermissionRequested 的处理方）：
   * permResult 已由 core 的 PermissionPolicy 加工完——
   * - allow → 直接返回
   * - deny  → 直接返回
   * - ask   → 弹确认框并返回用户选择
   * 同时负责把工具卡片上架 / 更新（展示职责）。
   */
  async requestToolPermission(
    sessionID: string,
    toolUseId: string,
    toolName: string,
    permResult: PermissionResult,
    displayArgs: Record<string, unknown>,
    agentMode?: AgentMode,
  ): Promise<PermissionResult> {
    const toolCallId = toolUseId;
    logger.info('ToolHandler', `requestToolPermission: ${toolName} (toolCallId: ${toolCallId})`);

    // 保存 Edit / Write 工具的 diff 信息。
    // 注意：只有在本次权限结果里确实携带了 diff 字段时才保存/使用
    // userChoiceManager 中的快照，否则会把上一次 Edit/Write 的 diff 错误地挂到
    // 本次（例如 old_string 多处匹配被 deny）的失败工具卡片上。
    const hasPermDiff = (toolName === 'Edit' || toolName === 'Write') && (permResult as any).beforeContent !== undefined;
    if (hasPermDiff) {
      // Write 新建文件时 beforeContent 为 null，需要保留 null 以便回滚时删除文件
      const pc = (permResult as any).beforeContent;
      this.userChoiceManager.saveDiffSnapshot(sessionID, {
        beforeContent: pc !== undefined ? pc : '',
        afterContent: (permResult as any).afterContent || '',
        contextBefore: (permResult as any).contextBefore || [],
        contextAfter: (permResult as any).contextAfter || [],
        startLine: (permResult as any).startLine,
        endLine: (permResult as any).endLine,
      });
    }

    // 授权前先显示这次改动：webview 侧是工具卡片里的 diff（normal 状态，等待授权/执行），
    // 宿主侧是 VS Code 的原生 diff 标签（Electron 空实现——它的 diff 只在 webview 里渲染）。
    // 两处渲染在权限确认框弹出前就已可见，用户确认后都保留。
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
    // 只有 manual 模式才在宿主侧打开 diff 标签：auto / risk 下改动是自动放行的，
    // 再弹一个原生 diff 编辑器只会打扰用户（webview 工具卡片里的 diff 仍然展示）。
    if (hasPermDiff && agentMode === 'manual') {
      this.showHostDiff(
        toolName,
        displayArgs,
        this.userChoiceManager.currentBeforeContent,
        this.userChoiceManager.currentAfterContent,
      );
    }

    const diffLineCount = Array.isArray((displayArgs as any).diffHunks)
      ? (displayArgs as any).diffHunks.reduce((s: number, h: any) => s + (h.lines?.length || 0), 0)
      : 0;
    this.log(`[ToolHandler] addMessage: ${toolName} file=${(displayArgs as any).file_path || '-'} diffLines=${diffLineCount} beforeLen=${(displayArgs as any).beforeContent?.length || 0} afterLen=${(displayArgs as any).afterContent?.length || 0}`);

    // 异步追加写入 block 顶层 _meta（append-only，避免整文件读改写）。
    // 不设置 updatedInput，避免 RunTools 再触发一次无意义的 updateToolUseInput。
    if (permResult && typeof permResult === 'object' && !('updatedInput' in permResult)) {
      if (hasPermDiff) {
        updateToolUseMeta(sessionID, toolUseId, {
          beforeContent: this.userChoiceManager.currentBeforeContent !== undefined ? this.userChoiceManager.currentBeforeContent : '',
          afterContent: this.userChoiceManager.currentAfterContent || '',
          contextBefore: this.userChoiceManager.currentContextBefore || [],
          contextAfter: this.userChoiceManager.currentContextAfter || [],
          startLine: this.userChoiceManager.currentStartLine,
          endLine: this.userChoiceManager.currentEndLine,
        }).catch((e: unknown) =>
          this.log(`[ToolHandler] updateToolUseMeta error: ${e}`)
        );
      }
    }

    // ask：不在这里弹确认框。RunTools 在拿到 'ask' 结果后会走
    // Integration.requestUserChoice（全局 UserChoiceQueue，多会话排队，不自动切换会话），
    // 这里提前弹框会造成双重确认。
    return permResult;
  }

  /**
   * 在宿主侧打开这次改动的 diff（VS Code 原生 diff 标签；Electron 空实现）。
   * 标题用展开后的文件路径，展开由 core 的 PermissionPolicy 完成。
   */
  private showHostDiff(
    toolName: string,
    displayArgs: Record<string, unknown>,
    beforeContent: string,
    afterContent: string,
  ): void {
    const filePath = typeof displayArgs.file_path === 'string' ? displayArgs.file_path : '';
    void this.host.showDiff({
      filePath: null,
      newContent: null,
      title: filePath || toolName,
      beforeContent,
      afterContent,
    }).catch((err: unknown) => {
      this.log(`[ToolHandler] showDiff error: ${err}`);
    });
  }

  /**
   * core 层调用：通知工具调用开始
   */
  onToolCall(sessionID: string, toolUseId: string, toolName: string): void {
    const toolCallId = toolUseId;
    logger.info('ToolHandler', `Tool call start: ${toolName} (toolCallId: ${toolCallId})`);
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
    logger.info('ToolHandler', `Tool result: ${toolName} - ${status} (toolCallId: ${toolCallId})`);

    const outputObj = output as any;
    if (toolName === 'Edit') {
      if (status === 'error') {
        this.log(`[ToolHandler] Edit tool failed, clearing diff display`);
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
        this.log(`[ToolHandler] Edit tool has context: ${outputObj.contextBefore?.length || 0} before, ${outputObj.contextAfter?.length || 0} after`);
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
}
