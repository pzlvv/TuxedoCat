/**
 * 对话历史管理
 * 存储和恢复完整的对话历史（增量保存）
 */

import { appendFile, writeFile, readFile, readdir, stat, unlink } from 'fs/promises';
import type { AgentMode } from '../types.js';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { getProjectConversationDir, getProjectRoot, getConversationDir, ensureProjectConversationDir, ensureProjectConversationDirSync, setSessionWorkspace, clearSessionWorkspace, WORKSPACE_META_FILE } from './Config.js';
import type { Message } from '../types.js';
import type { PromptPresetId } from '../settingsSnapshot.js';
import { requireEventBus, type CoreEvent } from '../AssistantEventBus.js';
import { buildConversationTitle, extractUserContent } from '../utils/contentBlocks.js';
import { stringifyJsonSafe } from '../utils/stringUtils.js';
import { deleteSessionToolResults } from '../tools/toolResultStorage.js';
import { logger } from '../Logger.js';
import { modelRefOf, type ModelRef } from '../llm/modelRef.js';

/** core → UI 单向事件的发送侧封装（history/Conversation 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/**
 * 从一条消息里提取围栏代码块的语言列表（去重）。
 * 扫描 user / assistant 消息的字符串内容中的 ```lang 围栏标记，
 * 供 appendMessage 上报 Shiki 高亮语言预热集合（见 `docs/architecture/host-ui-modules.md` 第 3 节）。
 */
function collectFenceLanguages(message: Message): string[] {
  const langs = new Set<string>();
  const scan = (text: unknown): void => {
    if (typeof text !== 'string' || !text) return;
    // 围栏开头行：```lang 或 ~~~lang（忽略缩进；lang 为常见标识符）
    const re = /(?:^|\n)[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+#-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const lang = m[1];
      if (lang && lang.length <= 32) {
        langs.add(lang);
      }
    }
  };

  const content = message.type === 'user' || message.type === 'assistant'
    ? message.message?.content
    : undefined;
  if (typeof content === 'string') {
    scan(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string; thinking?: string; content?: unknown; input?: Record<string, unknown> };
      if (b.type === 'text' || b.type === 'thinking') {
        scan(b.text ?? b.thinking);
      } else if (b.type === 'tool_result') {
        // 工具结果里也常出现代码（如 Read 输出文件内容）
        if (typeof b.content === 'string') scan(b.content);
      }
    }
  }
  return [...langs];
}

/**
 * 安全的 JSON 序列化，确保 \u2028（行分隔符）和 \u2029（段落分隔符）被转义。
 *
 * Node.js 的 JSON.stringify 默认不转义 \u2028 和 \u2029，
 * 这两个字符在 JSONL（每行一个 JSON）格式中会变成物理换行，导致文件损坏。
 * 参见 ES2019 规范：JSON.stringify 对 U+2028/U+2029 的序列化行为因引擎而异。
 *
 * 同时修复孤立代理项（`\ude00`）：这种转义语法合法但语义非法，Core（Rust）用
 * serde_json 严格解析，读到就**整行/整帧失败**。历史文件与帧通道共用这一出口。
 *
 * @param value - 要序列化的值
 * @returns 安全的 JSON 字符串（不含物理换行符）
 */
function safeJsonStringify(value: unknown): string {
  return stringifyJsonSafe(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 记录正在工作中的会话 ID（内存属性，不写入文件）
 */
const workingSessions = new Set<string>();

/**
 * 简易互斥锁，串行化 meta.json 的读-改-写操作
 * key = 文件路径, value = 前一个 Promise
 */
const metadataWriteQueue = new Map<string, Promise<void>>();

/**
 * 对话文件写队列，串行化对同一 JSONL 文件的所有写操作（appendFile / writeFile），
 * 避免 updateToolUseMeta / updateToolUseInput（追加更新记录）与 appendMessage（追加）并发导致的文件损坏。
 * key = 对话文件路径
 */
const conversationWriteQueue = new Map<string, Promise<void>>();

/**
 * 串行化对同一对话 JSONL 文件的写操作
 * @param conversationPath - 对话文件路径
 * @param fn - 写操作函数
 */
async function enqueueConversationWrite(conversationPath: string, fn: () => Promise<void>): Promise<void> {
  const prev = conversationWriteQueue.get(conversationPath) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const signal = next.then(() => {}, () => {});
  conversationWriteQueue.set(conversationPath, signal);
  signal.finally(() => {
    if (conversationWriteQueue.get(conversationPath) === signal) {
      conversationWriteQueue.delete(conversationPath);
    }
  });
  return next;
}

// ========================
// 内存缓存
// ========================

/**
 * 已加载的对话缓存
 * 首次从磁盘加载后缓存到内存，后续切换读取直接从内存返回，
 * 减少频繁磁盘 I/O，并避免不同加载之间的数据不一致。
 * 所有变更操作（追加/替换消息）会同步更新缓存，
 * 确保对话切换时读到的是最新数据。
 */
const conversationCache = new Map<string, Conversation>();

/**
 * updateToolUseMeta 写入 _meta 时的暂存区
 * key: sessionId + "::" + toolUseId
 * value: 要合并到 _meta 中的字段（如 confirmTimestamp）
 *
 * 因为 updateToolUseMeta 执行时助理消息可能尚未 push 到 mutableMessages，
 */
const pendingToolMetas = new Map<string, Record<string, unknown>>();
export { pendingToolMetas };

/**
 * 对话列表缓存（工作目录 → 列表）
 * 调用 loadConversationList() 后缓存结果，当任何对话发生变更时增量更新。
 * 每个工作目录各持一份，切换目录时互不清空（切回时无需重新读盘）。
 */
const conversationListCaches = new Map<string, ConversationMetadata[]>();

/** 获取某个工作目录对应的对话列表缓存（未缓存时返回 null） */
function getConversationListCache(projectPath: string): ConversationMetadata[] | null {
  return conversationListCaches.get(projectPath) ?? null;
}

/**
 * 按会话解析其工作目录，再取该目录的对话列表缓存。
 * 会话工作目录未登记（无法解析）时返回 null。
 */
function getConversationListCacheForSession(sessionId: string): ConversationMetadata[] | null {
  try {
    return getConversationListCache(getProjectRoot(sessionId));
  } catch {
    return null;
  }
}

/**
 * 清除对话列表缓存。
 * 传 projectPath 时只清该工作目录；不传时清空全部（工作目录关闭等场景）。
 */
export function resetConversationListCache(projectPath?: string): void {
  if (projectPath) {
    conversationListCaches.delete(projectPath);
  } else {
    conversationListCaches.clear();
  }
}

/**
 * 清空已加载的对话内存缓存
 * 用于外部删除对话文件后避免返回陈旧数据
 */
export function resetConversationCache(): void {
  conversationCache.clear();
}

/**
 * 从内存缓存中移除指定对话
 * 用于关闭对话（仅销毁视图、不删除磁盘数据）时释放缓存中的大对象；
 * 下次重新打开该会话时会从磁盘重新加载，避免长期持有已关闭对话的消息。
 */
export function removeConversationFromCache(sessionId: string): void {
  conversationCache.delete(sessionId);
}

/**
 * 将 metadataPath 的写操作加入队列，保证同一文件串行执行
 */
async function enqueueMetadataWrite(metadataPath: string, fn: () => Promise<void>): Promise<void> {
  const prev = metadataWriteQueue.get(metadataPath) ?? Promise.resolve();
  // 前一个完成后执行当前 fn（即使前一个失败也继续）
  const next = prev.then(() => fn(), () => fn());
  // 用一个新的无值 Promise 传递完成信号（吞掉错误以保持链不断）
  const signal = next.then(() => {}, () => {});
  metadataWriteQueue.set(metadataPath, signal);
  // 清理已完成锁
  signal.finally(() => {
    if (metadataWriteQueue.get(metadataPath) === signal) {
      metadataWriteQueue.delete(metadataPath);
    }
  });
  return next;
}

/**
 * 对话会话上下文（持久化到 meta.json，加载对话时恢复）
 *
 * 字段说明：
 * - totalContextTokens: 当前对话的上下文总 token 数（input_tokens + output_tokens）
 *   每次 LLM 返回消息后更新，用于 webview 显示进度条
 */
export interface ConversationContext {
  currentFile?: string;
  selectedLines?: { start: number; end: number };
  agentMode?: AgentMode;
  thinkingMode?: 'off' | 'low' | 'high' | 'max';
  /** 会话关联的提示词模式（普通 / 极简 / 混合） */
  promptMode?: PromptPresetId;
  /** 会话关联的 Web Search 开关（覆盖 settings.json 默认值） */
  webSearch?: boolean;
  /**
   * 会话关联的 MCP 启用列表（覆盖全局 settings.json 的 mcp.enabled 默认值）。
   * 由输入框菜单写入；空数组表示该会话显式禁用全部 MCP。
   */
  mcpEnabled?: string[];
  totalContextTokens?: number;
  /** 是否已进行过对话压缩（用于加载时只显示压缩后的消息） */
  isCompacted?: boolean;
  /** 是否已展开压缩（不可逆，展开后不再折叠） */
  isExpanded?: boolean;
  /** 当前对话使用的模型名称 */
  model?: string;
  /**
   * 当前对话使用的模型所属 provider key（baseURL 的 hostname）。
   * 模型 + provider 一起才能完整表征一个模型（同名模型可能属于不同 provider）。
   */
  provider?: string;
}

/**
 * 对话会话元数据
 */
export interface ConversationMetadata {
  sessionId: string;
  project: string;
  title: string; // 第一条用户消息的文本前50字符，或 Image[<width>*<height>]
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** 清空对话后标记：内容已清空但会话/标题保留 */
  clearedAt?: number;
  /** 当前对话的上下文（文件、模式等），用于加载时恢复 */
  context?: ConversationContext;
  /** 父会话 ID（子对话专属），用于构建树形结构 */
  parentSessionId?: string;
  /** 子代理角色（子对话专属），用于恢复时确定可用工具 */
  role?: string;
  /** 是否涉及远程通信（跨节点消息发送/接收） */
  isRemote?: boolean;
  /** 当前对话使用的模型名称 */
  model?: string;
  /** 当前对话使用的模型所属 provider key（模型 + provider 一起才能完整表征一个模型） */
  provider?: string;
  /**
   * 最后一条一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：core 写入 meta.json，
   * 一个对话至多一条；重开对话时追加到时间线末位，新消息落盘后由 core 清空。
   */
  onceMessage?: { role: 'system'; content: string };
  /**
   * 会话工作模式（specs/016 FR-005）：`spin` = spin 模式会话（执行中或应用中断后
   * 恢复）；由 core 在进入 / 退出 spin 时写入，缺失即 normal（存量会话）。
   * 加载时随 `conversationLoaded` 载荷下发，webview 据此恢复输入框禁用态。
   */
  workMode?: 'normal' | 'spin';
}

/**
 * 从 meta.json 元数据组装模型身份。
 *
 * meta.json 保持扁平字段（顶层 model/provider，兼容旧数据的 context.model/provider），
 * 组装只在这一处做，运行时一律传 ModelRef。
 * provider 缺失（旧数据 / 未配置）时返回 undefined，由调用方决定取 active provider 或按未配置处理。
 */
export function getConversationModelRef(metadata: ConversationMetadata | undefined): ModelRef | undefined {
  return modelRefOf(
    metadata?.provider ?? metadata?.context?.provider,
    metadata?.model ?? metadata?.context?.model,
  );
}

/**
 * 存储的消息格式（包含链式信息）
 */
interface StoredMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: number;
  message: Message;
}

/**
 * JSONL 中追加的 tool_use 更新记录。
 * 用于避免 updateToolUseMeta / updateToolUseInput 整文件读改写：
 * 修改已写入的 tool_use block 时，追加一条轻量更新记录，加载时按顺序回放。
 */
interface ToolUseUpdateRecord {
  type: 'tool_use_update';
  toolUseId: string;
  input?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  timestamp: number;
}

/**
 * 对话会话数据
 */
export interface Conversation {
  metadata: ConversationMetadata;
  messages: Message[];
  recovered: boolean; // 是否已执行过恢复（内存属性，不写入文件）
}

/**
 * 获取对话文件路径
 */
function getConversationPath(sessionId: string, projectPath: string): string {
  const projectDir = getProjectConversationDir(projectPath);
  return join(projectDir, `${sessionId}.jsonl`);
}

/**
 * 获取元数据文件路径
 */
export function getMetadataPath(sessionId: string, projectPath: string): string {
  const projectDir = getProjectConversationDir(projectPath);
  return join(projectDir, `${sessionId}.meta.json`);
}

/**
 * 确保所有 tool_use 都有对应的 tool_result（防御性编程）
 * 在加载对话时检查并补充缺失的 tool_result
 *
 * 这是为了处理进程崩溃等异常情况：
 * - AI 响应（tool_use）已保存
 * - 但进程崩溃，tool_result 未生成
 * - 恢复时需要补充默认的 tool_result
 */
async function ensureToolResults(messages: Message[], _sessionId: string): Promise<Message[]> {
  // 收集所有 tool_use，同时记录包含该 tool_use 的 assistant 消息 uuid（用于设置恢复消息的 parentUuid）
  const toolUseInfo = new Map<string, { name: string; parentUuid: string | null }>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block !== null && (block as any).type === 'tool_use') {
          const toolUseId = (block as any).id as string;
          const toolUseName = (block as any).name as string;
          toolUseInfo.set(toolUseId, { name: toolUseName, parentUuid: msg.uuid ?? null });
        }
      }
    }
  }

  // 收集已完成的 tool_use
  const completedToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block !== null && (block as any).type === 'tool_result') {
          completedToolIds.add((block as any).tool_use_id);
        }
      }
    }
  }

  // 为未完成的 tool_use 生成 tool_result
  for (const [toolUseId, info] of toolUseInfo) {
    if (!completedToolIds.has(toolUseId)) {
      const toolResultMessage: Message = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: `[Previous session interrupted] Tool "${info.name}" was canceled before execution.`,
              is_canceled: true,
            } as unknown,
          ],
        },
        uuid: `tool_recovered_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        timestamp: Date.now(),
      };
      // 关键：设置 parentUuid 指向包含该 tool_use 的 assistant 消息，
      // 自引用节点会使整条链在 BFS 遍历时被孤立。
      (toolResultMessage as any).parentUuid = info.parentUuid;
      messages.push(toolResultMessage);
    }
  }

  return messages;
}

/**
 * 将 tool_use 更新应用到一组消息上（内存缓存共用）
 */
export function applyToolUseUpdateToMessages(
  messages: Message[],
  toolUseId: string,
  update: { input?: Record<string, unknown>; meta?: Record<string, unknown> },
): number {
  let updatedCount = 0;
  for (const msg of messages) {
    if (msg.type !== 'assistant' || !Array.isArray((msg.message as any)?.content)) continue;
    for (const block of (msg.message as any).content) {
      if (typeof block === 'object' && block !== null && (block as any).type === 'tool_use' && (block as any).id === toolUseId) {
        if (update.input) {
          (block as any).input = update.input;
        }
        if (update.meta) {
          if (!(block as any)._meta || typeof (block as any)._meta !== 'object') {
            (block as any)._meta = {};
          }
          Object.assign((block as any)._meta as Record<string, unknown>, update.meta);
        }
        updatedCount++;
      }
    }
  }
  return updatedCount;
}

/**
 * 追加一条 tool_use 更新记录到会话 JSONL，并同步内存缓存 / mutableMessages。
 * 利用 JSONL 追加写的特性，避免 updateToolUseInput / updateToolUseMeta
 * 对已写入的 tool_use 行做整文件读改写。
 */
async function appendToolUseUpdate(
  sessionId: string,
  toolUseId: string,
  update: { input?: Record<string, unknown>; meta?: Record<string, unknown> },
  logLabel: string,
): Promise<void> {
  const startTs = Date.now();
  const projectPath = getProjectRoot(sessionId);
  if (!projectPath) return;

  const conversationPath = getConversationPath(sessionId, projectPath);
  const record: ToolUseUpdateRecord = {
    type: 'tool_use_update',
    toolUseId,
    ...update,
    timestamp: Date.now(),
  };

  try {
    await enqueueConversationWrite(conversationPath, () =>
      appendFile(conversationPath, safeJsonStringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    );
  } catch (e) {
    logger.error('Conversation', `${logLabel}: 追加更新记录失败: ${e}`);
    return;
  }

  const keys = update.input ? ['input'] : Object.keys(update.meta ?? {});
  logger.info('Conversation', `${logLabel} APPENDED | toolUseId=${toolUseId} | session=${sessionId.substring(0,20)} | key=${keys.join(',')} | time=${Date.now()-startTs}ms`);

  // 更新内存缓存
  const cached = conversationCache.get(sessionId);
  if (cached) {
    applyToolUseUpdateToMessages(cached.messages, toolUseId, update);
  }
}

/**
 * 更新已存在的 tool_use 消息的 input 内容
 * 用于在 checkPermissions 获取到额外数据（如 beforeContent/afterContent）后，
 * 更新历史记录中的 tool_use.input，确保会话切换后恢复时数据不丢失
 *
 * @param sessionId - 会话 ID
 * @param toolUseId - 工具使用 ID（对应 tool_use block 的 id）
 * @param input - 新的 input（包含 checkPermissions 返回的额外数据）
 */
export async function updateToolUseInput(
  sessionId: string,
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<void> {
  await appendToolUseUpdate(sessionId, toolUseId, { input }, 'updateToolUseInput');
}

/**
 * 更新已存在的 tool_use 消息 block 顶层的 _meta 字段（仅合并更新 _meta，不影响其他字段）
 * 用于在工具执行时记录 confirmTimestamp 等元数据，同时保留已有 _meta 字段（如 toolCallTimestamp）
 *
 * @param sessionId - 会话 ID
 * @param toolUseId - 工具使用 ID（对应 tool_use block 的 id）
 * @param meta - 要合并到 _meta 中的字段
 */
export async function updateToolUseMeta(
  sessionId: string,
  toolUseId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await appendToolUseUpdate(sessionId, toolUseId, { meta }, 'updateToolUseMeta');
}

/**
 * 追加单条消息到对话（增量保存）
 * @param message - 要保存的消息
 * @param sessionId - 会话 ID（优先使用），否则使用活动会话
 * @param parentUuid - 父消息的 UUID
 * @param totalContextTokens - 可选：当前对话的上下文总 token 数（input_tokens + output_tokens），
 *   写入 metadata.context.totalContextTokens，用于 webview 显示进度条
 * @returns 保存的消息的 UUID 和新创建的 title（如果有）
 */
export async function appendMessage(message: Message, sessionId: string, parentUuid: string | null = null, totalContextTokens?: number): Promise<{ uuid: string; newTitle?: string }> {
  const effectiveSessionId = sessionId;
  const projectPath = getProjectRoot(sessionId);

  // 只有用户主动发送的消息（Integration.sendMessage / 排队消息）才更新 updatedAt，
  // 子代理回复 / reminder / 后台任务通知 / 工具结果等自动消息都不算。
  const userInitiated = (message as any)._userInitiated === true;

  // 生成或使用消息的 UUID（使用类型守卫检查是否有 uuid 属性）
  const existingUuid = 'uuid' in message && typeof message.uuid === 'string' ? message.uuid : null;
  const uuid = existingUuid || `${effectiveSessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // 创建存储格式
  const storedMessage: StoredMessage = {
    uuid,
    parentUuid,
    timestamp: Date.now(),
    message,
  };

  // 先更新内存缓存，确保后续 loadConversation 能立即看到这条新消息
  // 必须放在 await 之前，因为 appendMessage 有时是 fire-and-forget 调用
  //
  // 注意：调用方可能已经将 message 追加到了缓存数组末尾。为避免重复追加（导致
  // LLM 上下文中出现重复消息进而产生双倍输出），需要检查 message 是否已经是最后一条。
  const cached = conversationCache.get(effectiveSessionId);
  if (cached) {
    const last = cached.messages[cached.messages.length - 1];
    const isSame = last === message;
    if (!isSame) {
      cached.messages.push(message);
    }
    // 缓存更新追踪：打印每次 appendMessage 时的缓存状态
    // 用 Math.random 避免重复日志被 VSCode 输出通道合并
    const tag = Math.random().toString(36).substring(2, 6);
    logger.info('Conversation', `[CacheTrack:${tag}] appendMessage | session=${effectiveSessionId.substring(0,20)} | msgType=${(message as any).type} | msgRole=${(message as any).message?.role} | cacheLen=${cached.messages.length} | lastSame=${isSame}`);
  } else {
    logger.info('Conversation', `[CacheTrack] appendMessage | session=${effectiveSessionId.substring(0,20)} | NO_CACHE`);
  }

  // 确保项目对话目录存在（目录由 core 建；其中的 settings.json 由宿主写）
  await ensureProjectConversationDir(projectPath);

  // 高亮语言：core 只从消息里扫出**本条消息用到**的语言并上报，不维护「已记录」集合
  // ——那是 UI 的 `highlightLanguages` 字段，core 不感知、不进配置快照。
  // 去重与上限由宿主承担，因此同一种语言可能被重复上报，宿主按幂等处理。
  try {
    const langs = collectFenceLanguages(message);
    if (langs.length > 0) {
      emitToUi({ type: 'highlightLanguagesUsed', languages: langs });
    }
  } catch {
    // 扫描 / 上报失败不影响落盘主流程
  }

	  // 追加到 JSONL 文件（通过写队列串行化，防止与 updateToolUseMeta 并发导致文件损坏）
	  const conversationPath = getConversationPath(effectiveSessionId, projectPath);
	  const jsonLine = safeJsonStringify(storedMessage) + '\n';
	  await enqueueConversationWrite(conversationPath, () =>
	    appendFile(conversationPath, jsonLine, { encoding: 'utf8', mode: 0o600 })
	  );

  // 更新元数据
  const newTitle = await updateMetadataForNewMessage(effectiveSessionId, projectPath, message, totalContextTokens, userInitiated);

  // 更新缓存中的元数据
  if (cached) {
    cached.metadata.messageCount = (cached.metadata.messageCount || 0) + 1;
    if (userInitiated) {
      cached.metadata.updatedAt = Date.now();
    }
    if (newTitle) {
      cached.metadata.title = newTitle;
    }
  }

  // 增量更新对话列表缓存
  const listCache = getConversationListCache(projectPath);
  if (listCache) {
    const existing = listCache.find(c => c.sessionId === effectiveSessionId);
    if (existing) {
      existing.messageCount = (existing.messageCount || 0) + 1;
      if (userInitiated) {
        existing.updatedAt = Date.now();
      }
      if (newTitle) {
        existing.title = newTitle;
      }
    } else {
      // 缓存中没有这项（偶尔会出现，例如并发场景），重置该工作目录的缓存
      resetConversationListCache(projectPath);
    }
  }

  // 通知 UI 刷新对话列表，让侧栏消息数在对话进行中实时更新。
  // 「推给哪些视图、怎么推」是 UI 的表现策略，由 WebViewUI 的
  // onConversationListChanged → ConversationManager.refresh 决定，core 只报告事实。
  emitToUi({ type: 'conversationListChanged' });

  return { uuid, newTitle: newTitle ?? undefined };
}

/**
 * 从用户消息中提取对话标题。
 * 文本优先；仅图片时优先使用随消息保存的宽高生成 `Image[<width>*<height>]`。
 */
function titleFromUserMessage(message: Message): string {
  if (message.type !== 'user' || !('message' in message)) return '';

  const content = message.message.content;
  if (typeof content === 'string') {
    return buildConversationTitle(content);
  }

  const imageSizes = (message as any).imageSizes as Array<{ width?: number; height?: number }> | undefined;
  const { text, images } = extractUserContent(content);

  // 将持久化在 userMsg 顶层的宽高合并回 UI 图片对象，供标题生成使用
  const sizedImages = images.map((img, index) => ({
    ...img,
    ...(imageSizes?.[index] ?? {}),
  }));

  return buildConversationTitle(text, sizedImages.length > 0 ? sizedImages : undefined);
}

/**
 * 更新对话元数据
 * @param totalContextTokens 可选：当前对话的上下文总 token 数（input_tokens + output_tokens），
 *   写入 metadata.context.totalContextTokens
 * @param userInitiated 是否为用户主动发送的消息；只有 true 时才更新 updatedAt
 *   （updatedAt 用于对话列表按"最后一条用户消息时间"显示和排序）
 * @returns 如果是新创建的 metadata 则返回 title，否则返回 null
 */
async function updateMetadataForNewMessage(
  sessionId: string,
  projectPath: string,
  message: Message,
  totalContextTokens?: number,
  userInitiated = false,
): Promise<string | null> {
  const metadataPath = getMetadataPath(sessionId, projectPath);

  // 使用互斥锁串行化，避免并发写导致数据损坏
  return enqueueMetadataWrite(metadataPath, async () => {
    let metadata: ConversationMetadata;
    let created = false;
    let titleUpdated = false;

    try {
      // 尝试读取现有元数据
      const existing = await readFile(metadataPath, 'utf8');
      metadata = JSON.parse(existing) as ConversationMetadata;
      // 仅用户主动发送的消息刷新修改时间，避免后台自动消息把旧会话顶到最前
      if (userInitiated) {
        metadata.updatedAt = Date.now();
      }

      // 更新前记录原始 messageCount，用于判断是否为第一条消息
      const prevMessageCount = metadata.messageCount;
      metadata.messageCount += 1;

      // 清空对话只清空内容，不清空标题：后续再发新消息不得覆盖原标题
      const isCleared = metadata.clearedAt !== undefined;

      // 如果当前还没有用户消息（新对话或从历史恢复但无消息）且没有显式标题
      // （用户重命名 / 智能命名 / spin 改名会先写标题），用首条用户消息生成标题；
      // 清空过的会话与已显式命名的会话保留原标题
      if (!isCleared && prevMessageCount === 0 && !metadata.title && message.type === 'user' && 'message' in message) {
        const title = titleFromUserMessage(message);
        if (title) {
          metadata.title = title;
          titleUpdated = true;
        }
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        // 文件不存在，创建新元数据
        // 文本优先；仅图片时使用 Image[<width>*<height>]
        const title = titleFromUserMessage(message) || 'New Conversation';

        metadata = {
          sessionId,
          project: projectPath,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 1,
        };
        created = true;
      } else {
        // 非 ENOENT 错误（如 JSON 解析失败，可能是并发写导致）
        // 不盲目创建脏数据，记录错误并提前返回
        console.error(`[Conversation] Failed to read/parse metadata for ${sessionId}:`, error);
        return;
      }
    }

    // 保存元数据
    await ensureProjectConversationDir(projectPath);

    // 如果传入了 totalContextTokens，直接按服务端返回的数值覆盖，
    // 不再取 max，避免压缩后 meta.json 中仍保留压缩前的大值。
    if (totalContextTokens !== undefined && totalContextTokens > 0) {
      metadata.context = {
        ...(metadata.context ?? {}),
        totalContextTokens,
      };
    }

    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

    // 新对话标记为工作中
    workingSessions.add(sessionId);

    // 通过闭包变量传递结果：新创建或标题被更新时返回标题
    if (created || titleUpdated) {
      // 保存到外层的结果变量
      throw new MetadataUpdatedTitle(metadata.title);
    }
  }).then(
    () => null as string | null, // 正常完成，无需更新标题
    (err: unknown) => {
      if (err instanceof MetadataUpdatedTitle) {
        return err.title; // 标题已更新
      }
      // 其他错误已在上面记录，这里忽略
      return null;
    }
  );
}

/**
 * 内部信号：用于从互斥执行上下文中传递"标题已更新"的结果
 */
class MetadataUpdatedTitle {
  constructor(public title: string) {}
}

/**
 * 同步创建会话文件（meta.json + 空的 .jsonl）
 *
 * 用于需要在注册到引擎池之前确保文件已存在的场景（如子代理），
 * 避免 webview 加载到不存在的文件。
 *
 * @param sessionId - 会话 ID
 * @param title - 会话标题
 * @param parentSessionId - 可选，父会话 ID
 * @param modelRef - 可选，模型身份（provider + model）；写入时拆回扁平的 model / provider 字段
 */
export function createConversationMetadataSync(
  sessionId: string,
  title: string,
  parentSessionId?: string,
  role?: string,
  modelRef?: ModelRef,
): void {
  const projectPath = getProjectRoot(sessionId);
  ensureProjectConversationDirSync(projectPath);

  // 创建 meta.json（保持扁平字段）
  const metadataPath = getMetadataPath(sessionId, projectPath);
  const metadata: ConversationMetadata = {
    sessionId,
    project: projectPath,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    parentSessionId,
    role,
    ...(modelRef?.model ? { model: modelRef.model } : {}),
    ...(modelRef?.provider ? { provider: modelRef.provider } : {}),
  };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

  // 创建空的 .jsonl 文件（确保 loadConversation 不会因文件不存在而报错）
  const conversationPath = getConversationPath(sessionId, projectPath);
  writeFileSync(conversationPath, '', { encoding: 'utf8', mode: 0o600 });
}

/**
 * 加载对话列表。
 *
 * 列表是「按工作目录」的，目录由调用方（宿主）显式给出。
 * 每个工作目录各有一份缓存，切换目录不清空其它目录的缓存。
 */
export async function loadConversationList(workspacePath: string | undefined): Promise<ConversationMetadata[]> {
  // 宿主未打开工作目录时（如 VS Code 扩展开发宿主窗口、用户尚未选择文件夹）
  // 没有项目对话目录，返回空列表而不是抛错：异常会一路冒泡到 webview 消息回调，
  // 变成 "rejected promise not handled within 1 second"。
  if (!workspacePath) {
    return [];
  }
  const currentProject = workspacePath;

  // 检查缓存
  const cached = getConversationListCache(currentProject);
  if (cached !== null) {
    return cached;
  }

  const projectDir = getProjectConversationDir(currentProject);

  try {
    const files = await readdir(projectDir);
    const conversations: ConversationMetadata[] = [];

    for (const file of files) {
      // 工作区清单（workspace.meta.json）也以 .meta.json 结尾，但它不是会话：
      // 混进列表会渲染成「(未命名对话) NaN/NaN/NaN」的幽灵条目，必须排除。
      if (!file.endsWith('.meta.json') || file === WORKSPACE_META_FILE) {
        continue;
      }

      try {
        const filePath = join(projectDir, file);
        const content = await readFile(filePath, 'utf8');

        const metadata: ConversationMetadata = JSON.parse(content);
        // 跳过未发送过消息的空对话（messageCount === 0）；
        // 但清空过的会话保留在列表中（标题和条目不随内容清空而消失）
        if (metadata.messageCount === 0 && !metadata.clearedAt) {
          continue;
        }
        conversations.push(metadata);
      } catch (error) {
        console.error(`[Conversation] Failed to load conversation from ${file}:`, error);
      }
    }

    // 按修改时间（最后一条用户消息）倒序排序；缺失时回退到创建时间
    conversations.sort(
      (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
    );

    // 存入缓存
    conversationListCaches.set(currentProject, conversations);

    return conversations;
  } catch (error) {
    if ((error as any).code !== 'ENOENT') {
      console.error('[Conversation] Failed to load conversation list:', error);
    }
    return [];
  }
}

/**
 * 加载完整对话
 */
export async function loadConversation(sessionId: string): Promise<Conversation> {

    const currentProject = getProjectRoot(sessionId);

    // 检查缓存
    const cached = conversationCache.get(sessionId);
    if (cached) {
      logger.info('Conversation', `Cache hit for session ${sessionId}: ${cached.messages.length} messages`);
      // 打印缓存消息类型分布
      const typeCounts: Record<string, number> = {};
      for (const m of cached.messages) {
        const t = (m as any).type || 'unknown';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      }
      logger.info('Conversation', `[CacheTrack] loadConversation cache hit | session=${sessionId.substring(0,20)} | total=${cached.messages.length} | types=${JSON.stringify(typeCounts)}`);
      return cached;
    }

    const metadataPath = getMetadataPath(sessionId, currentProject);
    const conversationPath = getConversationPath(sessionId, currentProject);

    // 从磁盘加载
    let messages: Message[] = [];

      // 加载元数据
      const metadataContent = await readFile(metadataPath, 'utf8');
      const metadata = JSON.parse(metadataContent);

      // 记录该对话的工作目录：后续按会话解析工作目录时无需再回退到活动工作目录
      if (metadata && typeof metadata.project === 'string' && metadata.project) {
        setSessionWorkspace(sessionId, metadata.project);
      }

      // 加载消息（JSONL 格式）
      const content = await readFile(conversationPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      // 构建消息链（O(n) 算法）
      const messageMap = new Map<string, StoredMessage>();
      // 追加式 tool_use 更新记录，按文件顺序回放到对应 tool_use block
      const updates: ToolUseUpdateRecord[] = [];

      // 第一遍：解析所有消息
      // 容错：单条损坏（异常退出产生的半行、NUL 空字节行等）只跳过该行，
      // 不应导致整个对话加载失败（此前 JSON.parse 抛错会让 loadConversation 整体失败，
      // 表现为"对话加载失败/对话消失"）。
      // 注意：不尝试从 NUL/非法行里“猜” JSON，非法行直接忽略；
      // 链完整性由第二遍的“父节点缺失时退化为根节点”兜底保证。
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === 'tool_use_update') {
            updates.push(parsed as ToolUseUpdateRecord);
            continue;
          }
          const stored = parsed as StoredMessage;
          if (!stored || typeof stored.uuid !== 'string') continue;
          messageMap.set(stored.uuid, stored);
        } catch {
          logger.warn('Conversation', `loadConversation: 跳过损坏行 | session=${sessionId.substring(0, 20)} | line=${line.substring(0, 80)}`);
        }
      }

      // 1.5 遍：修复历史数据中自引用 parentUuid 的合成恢复消息
      // 旧版本 bug：tool_recovered_* 消息被持久化时 parentUuid === 自身 uuid，
      // 导致 BFS 链遍历无法从任何根节点到达该节点，其自身及后续消息全部被孤立。
      // 修复方式：根据 tool_result 中的 tool_use_id 找到包含对应 tool_use 的
      // assistant 消息，将 parentUuid 重新链接到该 assistant 消息。
      if (messageMap.size > 0) {
        const assistantByToolUseId = new Map<string, string>();
        for (const stored of messageMap.values()) {
          const msg = stored.message as any;
          if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              if (typeof block === 'object' && block !== null && block.type === 'tool_use' && typeof block.id === 'string') {
                assistantByToolUseId.set(block.id, stored.uuid);
              }
            }
          }
        }
        for (const stored of messageMap.values()) {
          if (stored.parentUuid && stored.parentUuid === stored.uuid) {
            let repairedParent: string | null = null;
            const msg = stored.message as any;
            if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
              for (const block of msg.message.content) {
                if (typeof block === 'object' && block !== null && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                  const assistantUuid = assistantByToolUseId.get(block.tool_use_id);
                  if (assistantUuid) {
                    repairedParent = assistantUuid;
                    break;
                  }
                }
              }
            }
            // 找不到对应 assistant 消息时退化为根节点，避免整条链被孤立
            stored.parentUuid = repairedParent;
            logger.info('Conversation', `Repaired self-referencing parentUuid for ${stored.uuid} -> ${repairedParent ?? 'null(root)'}`);
          }
        }
      }

      // 第二遍：按 parentUuid 链接消息（使用 childrenMap 索引，O(n)）
      if (messageMap.size > 0) {
        // 建立 parentUuid -> children[] 映射，O(n)
        const childrenMap = new Map<string, StoredMessage[]>();
        const roots: StoredMessage[] = [];

        for (const stored of messageMap.values()) {
          // 父节点缺失时（例如父行是非法 JSON 被跳过，或进程异常导致中间消息丢失），
          // 不能把该节点及其整棵子树一起丢掉；退化为根节点，保证后续消息链仍可完整加载。
          if (stored.parentUuid && messageMap.has(stored.parentUuid)) {
            let children = childrenMap.get(stored.parentUuid);
            if (!children) {
              children = [];
              childrenMap.set(stored.parentUuid, children);
            }
            children.push(stored);
          } else {
            if (stored.parentUuid) {
              logger.warn('Conversation', `loadConversation: 父节点缺失，退化为根节点 | session=${sessionId.substring(0, 20)} | uuid=${stored.uuid} | parent=${stored.parentUuid}`);
            }
            roots.push(stored);
          }
        }

        // 对每个根节点按时间戳排序
        roots.sort((a, b) => a.timestamp - b.timestamp);

        // 广度优先遍历链（真正的 BFS 算法），O(n)
        // 注意：此前的实现使用 while 循环只取每个层级最早子节点，
        // 当一条消息有多个子节点（如多条 tool_result 对应多次 tool_call）时，
        // 非最早的子节点及其整个子树会被丢弃，导致消息丢失。
        const bfsQueue: StoredMessage[] = [];
        for (const root of roots) {
          bfsQueue.push(root);
        }

        while (bfsQueue.length > 0) {
          const current = bfsQueue.shift()!;
          messages.push(current.message);

          const children = childrenMap.get(current.uuid);
          if (children) {
            children.sort((a, b) => a.timestamp - b.timestamp);
            for (const child of children) {
              bfsQueue.push(child);
            }
          }
        }
      }

      // 回放追加式 tool_use 更新记录（保持文件顺序，后写覆盖先写）
      for (const upd of updates) {
        applyToolUseUpdateToMessages(messages, upd.toolUseId, {
          input: upd.input,
          meta: upd.meta,
        });
      }

      // 从磁盘加载的消息天然是"已持久化"状态：统一打上 _persisted 标记。
      // 背景：压缩生成的 boundary/summary 是 compactConversation 新建的对象，
      // 写入磁盘时可能未带 _persisted 标记（replaceConversationMessages 在
      // 序列化时依赖对象自带的属性）。若该会话随后被重新加载（loadConversation），
      // 这些消息会因缺少 _persisted 而被 persist-all 循环再次 appendMessage，
      // 产生相同 uuid 的重复记录，进而导致 messageMap 覆盖根节点、BFS 无根、
      // 对话空白。这里统一标记，确保磁盘上已有的消息不会被重复持久化。
      for (const msg of messages) {
        (msg as any)._persisted = true;
      }

      // 第三遍：检查并补充缺失的 tool_result（仅首次加载时）
      const isWorking = workingSessions.has(sessionId);
      if (!isWorking) {
        messages = await ensureToolResults(messages, sessionId);
        workingSessions.add(sessionId);
      }
      const result: Conversation = { metadata, messages, recovered: isWorking };

      // 存入缓存
      conversationCache.set(sessionId, result);
      logger.info('Conversation', `[CacheTrack] loadConversation cache SET | session=${sessionId.substring(0,20)} | messages=${messages.length}`);

      // recovered 表示是否已恢复过（已恢复=不需要再次恢复）
      logger.info('Conversation', `Restored session ${sessionId}: ${messages.length} messages, ${Buffer.byteLength(JSON.stringify(messages), 'utf8')} bytes, context_tokens=${metadata.context?.totalContextTokens ?? 'N/A'}, recovered=${isWorking}`);
      return result;
}

/**
 * 替换整个对话消息列表（用于压缩后重写）
 * 读取现有元数据，然后用新的消息列表完全替换 JSONL 文件内容
 * @param sessionId - 会话 ID
 * @param messages - 新的消息列表
 */
export async function replaceConversationMessages(sessionId: string, messages: Message[]): Promise<void> {
  const effectiveSessionId = sessionId;
  const projectPath = getProjectRoot(sessionId);
  await ensureProjectConversationDir(projectPath);

  const conversationPath = getConversationPath(effectiveSessionId, projectPath);

  // 构建新的 JSONL 内容：给每条消息分配 uuid 和 parentUuid 链
  const storedMessages: StoredMessage[] = [];
  let previousUuid: string | null = null;

  for (const msg of messages) {
    // 整文件重写后，文件中的每条消息都已是"已持久化"状态。
    // 必须在序列化前打上 _persisted 标记（否则 boundary/summary 等压缩新建的
    // 对象写盘时不带该标记，会话重载后会被 persist-all 循环再次 appendMessage，
    // 产生相同 uuid 的重复记录，导致 loadConversation 的 messageMap 覆盖根节点、
    // BFS 无根、对话空白）。
    (msg as any)._persisted = true;

    const uuid = 'uuid' in msg && typeof msg.uuid === 'string' ? msg.uuid : `${effectiveSessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    storedMessages.push({
      uuid,
      parentUuid: previousUuid,
      timestamp: 'timestamp' in msg && typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      message: msg,
    });

    previousUuid = uuid;
  }

	  // 整个文件重写（通过写队列串行化，防止与 appendMessage 并发导致文件损坏）
	  const jsonLines = storedMessages.map(sm => safeJsonStringify(sm)).join('\n') + '\n';
	  await enqueueConversationWrite(conversationPath, () =>
	    writeFile(conversationPath, jsonLines, { encoding: 'utf8', mode: 0o600 })
	  );

  // 更新元数据中的 messageCount
  const metadataPath = getMetadataPath(effectiveSessionId, projectPath);
  await enqueueMetadataWrite(metadataPath, async () => {
    try {
      const existing = await readFile(metadataPath, 'utf8');
      const metadata: ConversationMetadata = JSON.parse(existing) as ConversationMetadata;
      // 压缩 / 清空属于后台或命令操作，不刷新 updatedAt（它只反映用户发消息的时间）
      metadata.messageCount = messages.length;
      // 清空对话（空列表替换）只清内容：标记 clearedAt，后续新消息不得覆盖原标题
      if (messages.length === 0) {
        metadata.clearedAt = Date.now();
      }
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 元数据不存在则创建。
      // 注意：空列表替换（清空对话）发生在已有会话上时，上面的 try 分支已写入 clearedAt；
      // 若连 meta.json 都不存在则说明没有可保留的原标题，不应标记为 cleared 空会话。
      const metadata: ConversationMetadata = {
        sessionId: effectiveSessionId,
        project: projectPath,
        title: 'Compressed Conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: messages.length,
      };
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
  });

  // 同步更新内存缓存（如果已加载过该对话）
  const cached = conversationCache.get(effectiveSessionId);
  if (cached) {
    cached.messages = messages;
    cached.metadata.messageCount = messages.length;
    if (messages.length === 0) {
      cached.metadata.clearedAt = Date.now();
    }
  }

  // 增量更新对话列表缓存
  const listCache = getConversationListCache(projectPath);
  if (listCache) {
    const existing = listCache.find(c => c.sessionId === effectiveSessionId);
    if (existing) {
      existing.messageCount = messages.length;
      if (messages.length === 0) {
        existing.clearedAt = Date.now();
      }
    }
  }

  // 压缩 / 清空会整体改写消息数，同样通知 UI 刷新列表
  emitToUi({ type: 'conversationListChanged' });
}

// ========== Compact Archive Functions ==========

/**
 * Get the path for the compact archive file
 */
function getCompactArchivePath(sessionId: string, projectPath: string): string {
  const projectDir = getProjectConversationDir(projectPath);
  return join(projectDir, `${sessionId}.compact_archive.jsonl`);
}

/**
 * Save original messages to compact archive before compacting
 * @param sessionId - 会话 ID
 * @param messages - 压缩前要归档的原始消息
 */
export async function saveCompactArchive(sessionId: string, messages: Message[]): Promise<void> {
  const projectPath = getProjectRoot(sessionId);
  const archivePath = getCompactArchivePath(sessionId, projectPath);
  await ensureProjectConversationDir(projectPath);

  // Build stored messages with UUID chain
  const storedMessages: StoredMessage[] = [];
  let previousUuid: string | null = null;
  for (const msg of messages) {
    const uuid = 'uuid' in msg && typeof msg.uuid === 'string' ? msg.uuid : `${sessionId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    storedMessages.push({
      uuid,
      parentUuid: previousUuid,
      timestamp: 'timestamp' in msg && typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      message: msg,
    });
    previousUuid = uuid;
  }

  const jsonLines = storedMessages.map(sm => safeJsonStringify(sm)).join('\n') + '\n';
  await writeFile(archivePath, jsonLines, { encoding: 'utf8', mode: 0o600 });
  logger.info('Conversation', `Saved compact archive for ${sessionId}: ${storedMessages.length} messages`);
}

/**
 * Load archived original messages from compact archive
 */
export async function loadCompactArchive(sessionId: string): Promise<Message[] | null> {
  const projectPath = getProjectRoot(sessionId);
  const archivePath = getCompactArchivePath(sessionId, projectPath);

  try {
    const content = await readFile(archivePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const messages: Message[] = [];
    for (const line of lines) {
      const stored = JSON.parse(line) as StoredMessage;
      messages.push(stored.message);
    }
    logger.info('Conversation', `Loaded compact archive for ${sessionId}: ${messages.length} messages`);
    return messages;
  } catch (err) {
    if ((err as any)?.code === 'ENOENT') {
      logger.info('Conversation', `No compact archive found for ${sessionId}`);
      return null;
    }
    logger.error('Conversation', `Failed to load compact archive for ${sessionId}:`, err);
    return null;
  }
}

/**
 * Delete the compact archive file (after expanding)
 */
export async function deleteCompactArchive(sessionId: string): Promise<void> {
  const projectPath = getProjectRoot(sessionId);
  const archivePath = getCompactArchivePath(sessionId, projectPath);

  try {
    await unlink(archivePath);
    logger.info('Conversation', `Deleted compact archive for ${sessionId}`);
  } catch (err) {
    if ((err as any)?.code !== 'ENOENT') {
      logger.warn('Conversation', `Failed to delete compact archive for ${sessionId}:`, err);
    }
  }
}

/**
 * Check if a session has a compact archive
 */
export async function hasCompactArchive(sessionId: string): Promise<boolean> {
  const projectPath = getProjectRoot(sessionId);
  const archivePath = getCompactArchivePath(sessionId, projectPath);

  try {
    await stat(archivePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 更新对话上下文（持久化到 meta.json，用于加载时恢复 UI 状态）
 * 每当当前文件、agent 模式、context length 等变化时调用
 * 如果 meta.json 不存在，则不创建（只有在有消息对话时才应有 meta.json）
 */
export async function updateConversationContext(
  sessionId: string,
  context: ConversationContext
): Promise<void> {
  // 防御性检查：拒绝无效的 sessionId
  if (!sessionId || sessionId === 'undefined') {
    console.error(`[Conversation] Invalid sessionId: ${sessionId}, skipping context update`);
    return;
  }

  const projectPath = getProjectRoot(sessionId);
  const metadataPath = getMetadataPath(sessionId, projectPath);

  await enqueueMetadataWrite(metadataPath, async () => {
    try {
      // 尝试读取现有 meta.json
      const existing = await readFile(metadataPath, 'utf8');
      const metadata: ConversationMetadata = JSON.parse(existing) as ConversationMetadata;
      // 合并而非替换，避免覆盖之前保存的 totalContextTokens 等字段
      // 之前是整体赋值 metadata.context = context，导致用户在 VSCode 中切换文件时
      // 触发 persistCurrentFileContext -> updateConversationContext({ currentFile, selectedLines })
      // 会清掉之前 appendMessage 写入的 totalContextTokens
      // totalContextTokens 单独处理：直接采用服务端/meta 返回的最新值，不再取 max，
      // 这样压缩后写入的较小 token 数不会被旧的大值覆盖。
      // 合并 context，但使用 Object.assign 手动处理以避免显式 undefined 覆盖
      // totalContextTokens 不能放进通用合并循环：
      // 显式 0（清空对话）会被当成"新值"合并进去。单独处理：
      // - 显式传 0 → 重置为 0（clear 场景）
      // - 传 > 0 → 直接覆盖为服务端返回的最新值
      const mergedContext = { ...(metadata.context ?? {}) };
      for (const [key, value] of Object.entries(context)) {
        if (key === 'totalContextTokens') continue; // 单独处理
        if (value !== undefined) {
          (mergedContext as Record<string, unknown>)[key] = value;
        }
      }
      metadata.context = mergedContext as ConversationContext;
      if (context.totalContextTokens !== undefined && context.totalContextTokens >= 0) {
        metadata.context.totalContextTokens = context.totalContextTokens;
      }
      // model / provider 字段同时写入 metadata 顶层（便于快速读取）和 context
      if (context.model !== undefined) {
        metadata.model = context.model;
      }
      if (context.provider !== undefined) {
        metadata.provider = context.provider;
      }
      // 注意：不更新 updatedAt —— 它只反映"最后消息时间"（appendMessage 维护），
      // UI 上下文（输入框/当前文件/token 数）的保存不应让旧会话显示为"刚刚"
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

      // 同步更新内存缓存中的 context（如果已加载过该对话）
      const cached = conversationCache.get(sessionId);
      if (cached) {
        const mergedCache = { ...(cached.metadata.context ?? {}) };
        for (const [key, value] of Object.entries(context)) {
          if (key === 'totalContextTokens') continue; // 单独处理
          if (value !== undefined) {
            (mergedCache as Record<string, unknown>)[key] = value;
          }
        }
        cached.metadata.context = mergedCache as ConversationContext;
        if (context.totalContextTokens !== undefined && context.totalContextTokens >= 0) {
          cached.metadata.context.totalContextTokens = context.totalContextTokens;
        }
        if (context.model !== undefined) {
          cached.metadata.model = context.model;
        }
        if (context.provider !== undefined) {
          cached.metadata.provider = context.provider;
        }
      }
    } catch (err) {
      if ((err as any)?.code === 'ENOENT') {
        // meta.json 不存在：不创建。
        // meta.json 只在发第一条消息（appendMessage -> updateMetadataForNewMessage）时创建，
        // 更新上下文（model/thinkingMode/currentFile 等）不应提前生成会话文件。
      } else {
        console.error(`[Conversation] Failed to update context for ${sessionId}:`, err);
      }
    }
  });
}

/**
 * 更新对话 metadata 的标题
 * 用于需要显式修正对话标题的场景（用户重命名、智能命名、spin 模式改名）。
 * meta.json 缺失时建档：显式改标题必须落到磁盘，否则 UI 收到的 titleChanged
 * 与磁盘不一致——重启 / 刷新列表后标题回到「未命名」。
 */
export async function updateConversationMetadataTitle(
  sessionId: string,
  title: string
): Promise<void> {
  if (!sessionId || sessionId === 'undefined') {
    return;
  }

  const projectPath = getProjectRoot(sessionId);
  const metadataPath = getMetadataPath(sessionId, projectPath);

  await enqueueMetadataWrite(metadataPath, async () => {
    let metadata: ConversationMetadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as ConversationMetadata;
    } catch (err) {
      if ((err as any)?.code !== 'ENOENT') {
        logger.warn('Conversation', `Failed to update metadata title for ${sessionId}: ${err}`);
        return;
      }
      // 建档。messageCount 从已落盘的 .jsonl 数出：只数真实消息记录，排除
      // stream / tombstone / tool_use_update 记录（tool_use_update 是顶层 type、
      // 无 message 包装；口径同 Standalone count_messages），避免掩盖已写消息。
      const conversationPath = getConversationPath(sessionId, projectPath);
      let messageCount = 0;
      try {
        for (const line of (await readFile(conversationPath, 'utf8')).split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as {
              type?: string;
              message?: { type?: string };
            };
            const innerType = record.message?.type;
            if (record.type === 'tool_use_update'
              || innerType === 'stream_event' || innerType === 'stream_request_start'
              || innerType === 'tombstone' || innerType === 'tool_use_update') {
              continue;
            }
            if (innerType === undefined) continue; // 非消息记录（无 message 包装）
            messageCount++;
          } catch { /* 损坏行不计 */ }
        }
      } catch { /* .jsonl 不存在按 0 计 */ }
      await ensureProjectConversationDir(projectPath);
      metadata = {
        sessionId,
        project: projectPath,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount,
      };
      // 补空 .jsonl：loadConversation 要求消息文件存在（同 createConversationMetadataSync）
      try {
        await readFile(conversationPath, 'utf8');
      } catch {
        await writeFile(conversationPath, '', { encoding: 'utf8', mode: 0o600 });
      }
    }
    metadata.title = title;
    // 标题更新不 touch updatedAt（保持"最后消息时间"语义；建档时已在上面赋值）
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

    // 同步更新内存缓存
    const cached = conversationCache.get(sessionId);
    if (cached) {
      cached.metadata.title = title;
    }

    // 同步更新对话列表缓存（新建档的会话此前不在缓存里，不追加：
    // messageCount === 0 的会话按规则不进列表，等首条消息落盘后自然进入）
    const listCache = getConversationListCacheForSession(sessionId);
    if (listCache) {
      const entry = listCache.find(c => c.sessionId === sessionId);
      if (entry) {
        entry.title = title;
      }
    }
  });
}

/** 读取项目对话目录下的全部元数据（用于计算「受影响闭包」） */
export async function readProjectConversationMetadata(currentProject: string): Promise<ConversationMetadata[]> {
  const projectDir = getProjectConversationDir(currentProject);
  const result: ConversationMetadata[] = [];
  try {
    const files = await readdir(projectDir);
    for (const file of files) {
      // 工作区清单不是会话（同 loadConversationList 的排除规则）
      if (!file.endsWith('.meta.json') || file === WORKSPACE_META_FILE) continue;
      try {
        const content = await readFile(join(projectDir, file), 'utf8');
        result.push(JSON.parse(content) as ConversationMetadata);
      } catch (e) {
        logger.error('Conversation', `读取对话元数据失败: ${e}`);
      }
    }
  } catch (e) {
    logger.error('Conversation', `扫描对话目录失败: ${e}`);
  }
  return result;
}

/**
 * 「受影响闭包」：sessionId 自身 + 所有层级的子孙对话（沿 `parentSessionId` 传递闭包）。
 *
 * 纯函数，输入全量对话列表。宿主删除对话前用它算出要关哪些视图
 * （Electron 每个会话一个 webview）；`deleteConversation` 用同一条规则删盘。
 */
export function collectConversationClosure(
  sessionId: string,
  list: readonly ConversationMetadata[],
): string[] {
  const affected = new Set<string>([sessionId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of list) {
      const pid = c.parentSessionId;
      if (pid && affected.has(pid) && c.sessionId && !affected.has(c.sessionId)) {
        affected.add(c.sessionId);
        grew = true;
      }
    }
  }
  return [...affected];
}

/**
 * 删除对话：**递归**删除该会话及其所有层级的子孙对话（文件 / 缓存 / 引擎 / MCP 引用 / 运行时状态）。
 *
 * 子代理可以再起子代理，`parentSessionId` 链可以任意深；闭包规则与宿主关视图
 * （`collectConversationClosure`）一致。先删子孙再删自己，中途失败不会留下孤儿。
 */
export async function deleteConversation(sessionId: string): Promise<void> {
  const currentProject = getProjectRoot(sessionId);
  const list = await readProjectConversationMetadata(currentProject);
  const closure = collectConversationClosure(sessionId, list);
  for (const id of closure) {
    if (id === sessionId) continue;
    await deleteSingleConversation(id, currentProject);
  }
  await deleteSingleConversation(sessionId, currentProject);
}

/** 删除单个会话的落盘数据与内存 / 引擎 / MCP 引用（**不处理子对话**） */
async function deleteSingleConversation(sessionId: string, currentProject: string): Promise<void> {
  // 删除消息文件（JSONL）
  const conversationPath = getConversationPath(sessionId, currentProject);
  await unlink(conversationPath).catch((e) => {
    logger.error('Conversation', `删除对话文件失败: ${e}`);
  });

  // 删除元数据文件
  const metadataPath = getMetadataPath(sessionId, currentProject);
  await unlink(metadataPath).catch((e) => {
    logger.error('Conversation', `删除元数据文件失败: ${e}`);
  });

  // 同步删除对应的 compact_archive（如果有）
  const archivePath = getCompactArchivePath(sessionId, currentProject);
  await unlink(archivePath).catch((e) => {
    if ((e as any)?.code !== 'ENOENT') {
      logger.warn('Conversation', `删除 compact_archive 失败: ${e}`);
    }
  });

  // 同步删除该对话在 tool-results 下带会话前缀的持久化结果文件。
  // 传 currentProject：子对话可能未登记在会话工作目录表里，按 sessionId 解析会
  // 回退到活动工作目录，导致结果文件残留在真正的项目目录中
  try {
    const removed = await deleteSessionToolResults(sessionId, currentProject);
    if (removed > 0) {
      logger.info('Conversation', `删除对话关联的工具结果文件 ${removed} 个 | session=${sessionId.substring(0, 20)}`);
    }
  } catch (e) {
    logger.warn('Conversation', `删除工具结果文件失败: ${e}`);
  }

  // 清理内存缓存
  conversationCache.delete(sessionId);

  // 注销会话工作目录（会话已删除，按会话解析工作目录不再需要该条目）
  clearSessionWorkspace(sessionId);

  // 清理 pendingToolMetas 中该 session 的条目
  // updateToolUseMeta 在助理消息尚未 push 到 mutableMessages 时使用此暂存区
  for (const key of pendingToolMetas.keys()) {
    if (key.startsWith(sessionId + '::')) {
      pendingToolMetas.delete(key);
    }
  }

  // 引擎侧外围引用（MCP 引用计数 / 运行时状态）由 Core 进程自理：
  // 宿主进程内没有引擎池，历史层删完磁盘与内存缓存即完成

  // 增量更新对话列表缓存（移除已删除的对话）。
  // 用参数 currentProject 而不是按会话重解析（getConversationListCacheForSession）：
  // 上面的 clearSessionWorkspace 已注销本会话的工作目录，按会话解析会抛错被吞掉，
  // 缓存静默不更新——conversationListChanged → refresh() 读到脏缓存，侧栏条目残留。
  const listCache = getConversationListCache(currentProject);
  if (listCache) {
    const idx = listCache.findIndex((c) => c.sessionId === sessionId);
    if (idx >= 0) listCache.splice(idx, 1);
  }
}

/**
 * 获取指定会话的 isRemote 状态
 */
export async function getConversationIsRemote(sessionId: string): Promise<boolean> {
  const projectPath = getProjectRoot(sessionId);
  const metadataPath = getMetadataPath(sessionId, projectPath);

  try {
    const content = await readFile(metadataPath, 'utf8');
    const metadata: ConversationMetadata = JSON.parse(content);
    return metadata.isRemote === true;
  } catch {
    return false;
  }
}

/**
 * 标记对话为远程对话（涉及跨节点通信）
 *
 * 在 meta.json 中记录 isRemote 标记。
 */
export async function markConversationAsRemote(sessionId: string, _title?: string): Promise<void> {
  const projectPath = getProjectRoot(sessionId);
  const metadataPath = getMetadataPath(sessionId, projectPath);

  // 更新 meta.json 中的 isRemote 字段
  await enqueueMetadataWrite(metadataPath, async () => {
    try {
      const existing = await readFile(metadataPath, 'utf8');
      const metadata: ConversationMetadata = JSON.parse(existing) as ConversationMetadata;
      if (metadata.isRemote !== true) {
        metadata.isRemote = true;
        // 标记远程不刷新 updatedAt（它只反映用户发消息的时间）
        await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

        // 同步更新内存缓存
        const cached = conversationCache.get(sessionId);
        if (cached) {
          cached.metadata.isRemote = true;
        }

        // 同步更新列表缓存
        const listCache = getConversationListCacheForSession(sessionId);
        if (listCache) {
          const entry = listCache.find(c => c.sessionId === sessionId);
          if (entry) {
            entry.isRemote = true;
          }
        }

        logger.info('Conversation', `Marked session ${sessionId} as remote`);
      }
    } catch {
      // meta.json 不存在，忽略（新对话首次 appendMessage 时会被标记）
    }
  });
}

/**
 * 清理过期的对话
 */
export async function cleanupOldConversations(cutoffDate: Date): Promise<void> {
  const conversationDir = getConversationDir();
  const cutoffTime = cutoffDate.getTime();

  // 读取所有项目目录
  const projectDirs = await readdir(conversationDir, { withFileTypes: true });

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }

    const projectPath = join(conversationDir, projectDir.name);
    // 读取项目目录中的对话文件
    const files = await readdir(projectPath);

    for (const file of files) {
      // 工作区清单（workspace.meta.json）也以 .meta.json 结尾，但它不是会话：
      // 混进列表会渲染成「(未命名对话) NaN/NaN/NaN」的幽灵条目，必须排除。
      if (!file.endsWith('.meta.json') || file === WORKSPACE_META_FILE) {
        continue;
      }

      const filePath = join(projectPath, file);
      const stats = await stat(filePath);
      if (stats.mtimeMs < cutoffTime) {
        await unlink(filePath);

        // 同时删除对应的 .jsonl 消息文件
        const jsonlFile = file.replace('.meta.json', '.jsonl');
        const jsonlPath = join(projectPath, jsonlFile);
        await unlink(jsonlPath);
      }
    }
  }
}
