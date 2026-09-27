/**
 * PermissionPolicy - 权限规则加工（core 侧）
 *
 * 把「会话的 agentMode → 权限结果」的决策逻辑收进 core（原在 UI 侧 toolHandler.ts）：
 * - 读该会话的 agentMode（core 拥有会话配置，UI 只做展示）
 * - 调工具自身的 checkPermissions
 * - 按 auto / risk / manual 规则加工最终 PermissionResult
 * - 展开 displayArgs（路径展开 / Write / Edit 的 diff 字段），随 CoreRequest.toolPermissionRequested 下发
 *
 * UI（WebViewUI 的 requestToolPermission）收到请求时只负责「上架卡片 + 弹确认框」，
 * 不再做任何策略判断。
 */

import { expandPath } from '../utils/path.js';
import { getProjectRoot } from '../history/Config.js';
import { buildEditDiffHunks } from '../utils/editDiff.js';
import { logger } from '../Logger.js';
import type { PermissionDiffPayload, PermissionResult } from './Tool.js';
import type { AgentMode } from '../types.js';

/** 工具入参规范化：极端情况下 LLM 会把整个入参 double-encode 成字符串 */
function normalizeToolArgs(args: unknown): Record<string, any> {
  if (args && typeof args === 'object') {
    return args as Record<string, any>;
  }
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, any>;
        }
      } catch {
        // 不是合法 JSON，按空对象处理
      }
    }
  }
  return {};
}

/**
 * 会话询问模式的存储（core 拥有会话配置）。
 * 会话级覆盖 → settings.json 默认 → risk 兜底。
 */
const sessionAgentModes = new Map<string, AgentMode>();

/** 设置会话的询问模式（UiEvent.agentModeChanged 的 core 侧处理会调用） */
export function setSessionAgentMode(sessionId: string, mode: AgentMode): void {
  sessionAgentModes.set(sessionId, mode);
}

/** 读取会话已存储的询问模式（不做默认值回退）；供加载会话时展示 */
export function getStoredSessionAgentMode(sessionId: string): AgentMode | undefined {
  return sessionAgentModes.get(sessionId);
}

/** 读取会话的询问模式；未记录时回退默认（settings.json 的 defaultAgentMode） */
export function getSessionAgentMode(sessionId: string): AgentMode {
  const inMemory = sessionAgentModes.get(sessionId);
  if (inMemory) return inMemory;
  try {
    const { getDefaultAgentMode } = require('../llm/config.js') as typeof import('../llm/config.js');
    const cfg = require('../history/Config.js') as typeof import('../history/Config.js');
    void cfg;
    // getDefaultAgentMode 是异步的；这里不做异步化（权限决策在 async 链内，调用方再补读）。
    // 同步路径下先返回 risk 兜底，由调用方传入已解析的 mode 覆盖。
    void getDefaultAgentMode;
  } catch { /* ignore */ }
  return 'risk';
}

/**
 * 子会话继承父会话的询问模式。
 *
 * 完整继承主对话的 manual / risk / auto：子代理只是主对话的执行延伸，
 * 权限策略必须与主对话一致，否则会出现「主对话 manual 逐条确认、子代理却
 * 自动放行非危险操作」这类越权行为。父会话在内存中无记录时回退 risk。
 */
export function inheritAgentMode(parentSessionId: string, childSessionId: string): void {
  inheritAgentModeFrom(sessionAgentModes.get(parentSessionId), childSessionId);
}

/** 子会话继承父会话的询问模式（带显式父值；供没有 Map 记录时的 fallback） */
export function inheritAgentModeFrom(parentMode: AgentMode | undefined, childSessionId: string): void {
  sessionAgentModes.set(childSessionId, parentMode ?? 'risk');
}

/**
 * 判断操作是否为危险操作（用于风险拦截模式）。
 * 危险操作定义：
 * 1. Bash 破坏性命令（dd、mkfs、format、fdisk、shred、wipe 等）
 * 2. Git 破坏性命令（仅 checkout、reset）
 */
function isOperationRisky(tool: unknown, toolName: string, args: Record<string, any>): boolean {
  if (toolName === 'Bash') {
    const command = (args as any)?.command || '';
    if (tool && typeof tool === 'object' && 'isDestructive' in tool && typeof (tool as any).isDestructive === 'function') {
      try {
        if ((tool as any).isDestructive(args)) {
          return true;
        }
      } catch {
        // ignore
      }
    }
    if (/\bgit\s+(checkout|reset)\b/.test(command)) {
      return true;
    }
  }
  return false;
}

/**
 * 按会话的 agentMode 规则加工权限结果（含 checkPermissions 调用与 displayArgs 展开）。
 *
 * @param sessionId 会话 ID
 * @param toolName 工具名
 * @param rawArgs 工具入参（可能是未解析的原始值）
 * @param tool 工具实例；不存在（找不到工具 / 校验失败前的展示）时传 null
 * @returns permResult（最终权限决策）、displayArgs（展示用参数，路径已展开）
 *          与 agentMode（本次决策实际采用的询问模式，供 UI 决定是否打开宿主侧 diff）
 */
export async function resolveToolPermission(
  sessionId: string,
  toolName: string,
  rawArgs: Record<string, any>,
  tool: unknown,
): Promise<{ permResult: PermissionResult; displayArgs: Record<string, unknown>; agentMode: AgentMode }> {
  // 统一规范化为对象，避免 rawArgs 为 JSON 字符串时后续展开 / `in` 运算崩溃
  const args = normalizeToolArgs(rawArgs);

  // 会话询问模式：内存记录优先，未记录时读 settings.json 默认
  let effectiveAgentMode = sessionAgentModes.get(sessionId);
  if (!effectiveAgentMode) {
    try {
      const { getDefaultAgentMode } = await import('../llm/config.js');
      effectiveAgentMode = await getDefaultAgentMode();
    } catch {
      effectiveAgentMode = 'risk';
    }
  }

  // 调用 checkPermissions 获取原始权限结果
  let permResult: PermissionResult = { behavior: 'allow' };
  if (tool && typeof tool === 'object' && 'checkPermissions' in tool && typeof (tool as any).checkPermissions === 'function') {
    const context = {
      abortController: new AbortController(),
      cwd: getProjectRoot(sessionId),
      getAppState: () => ({}),
      setAppState: () => {},
      messages: [],
      sessionId,
    };
    try {
      permResult = await (tool as any).checkPermissions(args, context);
    } catch (error) {
      logger.error('PermissionPolicy', `checkPermissions error: ${error}`);
      permResult = { behavior: 'deny', message: `权限检查失败: ${error}` };
    }
  }

  // 改动内容（展示用）取自**工具自己的**权限结果，与下面按 agentMode 做的决策加工无关：
  // auto / risk 把 ask 自动放行为 allow 时，改动内容仍要保留，用户才看得到这次修改。
  const diffPayload: PermissionDiffPayload = (toolName === 'Edit' || toolName === 'Write') && permResult.behavior === 'ask'
    ? {
        beforeContent: permResult.beforeContent,
        afterContent: permResult.afterContent,
        contextBefore: permResult.contextBefore,
        contextAfter: permResult.contextAfter,
        startLine: permResult.startLine,
        endLine: permResult.endLine,
        lineEndings: permResult.lineEndings,
      }
    : {};

  // Auto 模式下 AskUserQuestion 不可用：不弹出提问框，直接返回不可用结果
  if (toolName === 'AskUserQuestion' && effectiveAgentMode === 'auto') {
    logger.info('PermissionPolicy', `Auto mode (session ${sessionId}): AskUserQuestion unavailable, denying tool call`);
    permResult = {
      behavior: 'deny',
      message: 'AskUserQuestion is unavailable in Auto mode. Please analyze the situation and make a reasonable decision on your own.',
    };
  }

  // auto 模式：ask → allow（跳过确认）；改动内容照常带上供 UI 展示
  if (effectiveAgentMode === 'auto' && permResult.behavior === 'ask') {
    logger.info('PermissionPolicy', `Auto mode (session ${sessionId}): allowing tool ${toolName} without confirmation`);
    permResult = { behavior: 'allow', ...diffPayload };
  }

  // 风险拦截模式：只拦截危险操作，普通操作自动放行
  if (effectiveAgentMode === 'risk' && permResult.behavior === 'ask') {
    if (isOperationRisky(tool, toolName, args)) {
      logger.info('PermissionPolicy', `Risk mode (session ${sessionId}): intercepting risky tool ${toolName}`);
      // Keep 'ask' behavior - still ask user for confirmation
    } else {
      logger.info('PermissionPolicy', `Risk mode (session ${sessionId}): allowing non-risky tool ${toolName} without confirmation`);
      permResult = { behavior: 'allow', ...diffPayload };
    }
  }

  // manual 模式：保持 ask（无需加工）

  // 展示用参数：路径展开 + Write / Edit 的 diff 字段
  const hasPermDiff = (toolName === 'Edit' || toolName === 'Write') && diffPayload.beforeContent !== undefined;
  const pc = diffPayload.beforeContent;
  const diffBeforeContent: string = hasPermDiff ? (pc !== undefined && pc !== null ? String(pc) : '') : '';
  const diffAfterContent: string = hasPermDiff ? String(diffPayload.afterContent ?? '') : '';
  const diffContextBefore = hasPermDiff ? diffPayload.contextBefore || [] : [];
  const diffContextAfter = hasPermDiff ? diffPayload.contextAfter || [] : [];
  const diffStartLine = hasPermDiff ? diffPayload.startLine : undefined;
  const diffEndLine = hasPermDiff ? diffPayload.endLine : undefined;

  let displayArgs: Record<string, unknown> = { ...args };
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') {
    const filePath = args.file_path || args.path;
    if (filePath && typeof filePath === 'string') {
      try {
        const absolutePath = expandPath(filePath, getProjectRoot(sessionId));
        displayArgs = { ...displayArgs, file_path: absolutePath };
      } catch (error) {
        logger.error('PermissionPolicy', `路径展开失败: ${error}`);
      }
    }

    if (toolName === 'Write' && args.content) {
      const content = String(args.content);
      // 保留 null（新建文件）以便回滚时删除文件
      displayArgs = {
        ...displayArgs,
        content: args.content,
        contentPreview: content,
        totalLines: content.split('\n').length,
        isTruncated: false,
        beforeContent: diffBeforeContent === '' ? null : diffBeforeContent,
        afterContent: diffAfterContent || args.content || '',
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
      // permResult 中没有 beforeContent/afterContent，此时不应展示上一次的 diff。
      if (hasPermDiff) {
        displayArgs = {
          ...displayArgs,
          contextBefore: diffContextBefore,
          contextAfter: diffContextAfter,
          // Edit 只发送 diff 相关行，避免把整个文件内容发给 webview
          diffHunks: buildEditDiffHunks({
            beforeContent: diffBeforeContent || '',
            afterContent: diffAfterContent,
            startLine: diffStartLine,
            endLine: diffEndLine,
            replaceAll,
          }),
          startLine: diffStartLine,
          endLine: diffEndLine,
        };
      }
    }
  }

  // previewContent（工具在 checkPermissions 时给出的展示预览）
  const previewContent = (permResult as { previewContent?: unknown }).previewContent;
  if (typeof previewContent === 'string' && previewContent) {
    displayArgs = { ...displayArgs, _preview: previewContent };
  }

  return { permResult, displayArgs, agentMode: effectiveAgentMode };
}

/**
 * 权限结果是否携带 Edit / Write 的 diff 字段（供 RunTools 持久化 _meta 用）。
 * 持久化职责在 core（block._meta 随消息落盘），UI 不再自己写 meta。
 */
export function permResultHasDiff(permResult: PermissionResult): boolean {
  return 'beforeContent' in (permResult as Record<string, unknown>);
}
