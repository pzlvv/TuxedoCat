/**
 * 会话元数据的宿主侧只读视图（`docs/core/standalone-core.md` 第 4 节的 owner 表）。
 *
 * 会话数据（meta.json / `<sid>.jsonl` / 压缩归档 / `workspace.meta.json`）由 Core
 * 独占写入；宿主侧只剩两类能力：
 *
 * - **meta.json 的类型与纯派生**（`ConversationMetadata` / `ConversationContext` /
 *   `getConversationModelRef`）：宿主拿 Core 经 `UiRequest` 应答的 JSON，用这份类型
 *   消费；派生只有一份纯函数。
 * - **删除闭包**（`collectConversationClosure`）：纯函数，Electron 删多视图会话前用它
 *   算出要关哪些视图；Core 收到 `conversationDeleted` 后按同一规则递归删盘。
 *
 * 落盘格式（JSONL 行形状 / `tool_use_update` 记录 / meta.json 字段）由
 * `core-rs/src/history.rs` 写、`core-rs/src/history_tests.rs` 锁定；本文件不再提供
 * 任何写入口（specs/defects/host-appends-session-jsonl.md）。
 */

import type { AgentMode } from '../types.js';
import type { PromptPresetId } from '../settingsSnapshot.js';
import type { ModelRef } from '../llm/modelRef.js';
import { modelRefOf } from '../llm/modelRef.js';
import type { SessionCreator } from '../sessionCreator.js';

/**
 * 对话会话上下文（meta.json 的 `context.*`，Core 写入、宿主只读）
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
   * 由 Core 的会话配置事件写入；空数组表示该会话显式禁用全部 MCP。
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
 * 对话会话元数据（meta.json 的形状，Core 写入、宿主只读）
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
  /** 父会话 ID（本地子对话专属），用于构建树形结构；跨工作区对话不写（specs/025 FR-001） */
  parentSessionId?: string;
  /** 子代理角色（子对话专属），用于恢复时确定可用工具 */
  role?: string;
  /** 是否涉及远程通信（跨节点消息发送/接收） */
  isRemote?: boolean;
  /**
   * 会话创建者（specs/025 FR-002）：`user` = 用户 prompt 发起；agent 形态携带创建方
   * 工作区身份与会话 id。全部会话创建时由 core 写入，读取缺失即数据异常。
   */
  creator: SessionCreator;
  /** 当前对话使用的模型名称 */
  model?: string;
  /** 当前对话使用的模型所属 provider key（模型 + provider 一起才能完整表征一个模型） */
  provider?: string;
  /**
   * 最后一条一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：core 写入 meta.json，
   * 一个对话至多一条；重开对话时追加到时间线末位，新消息落盘后由 core 清空。
   * `noticeKind` 随通知 JSON 整份落盘（specs/036 FR-001），恢复后 UI 仍能识别
   * LLM 失败通知并渲染重试按钮；core 侧原样透传（`emit_once_notice`），无结构化读取。
   */
  onceMessage?: { role: 'system'; content: string; noticeKind?: 'llmError' };
  /**
   * 会话工作模式（specs/016 FR-005）：`spin` = spin 模式会话（执行中或应用中断后
   * 恢复）；单向，进入后不再退出。由 core 在进入 spin 时写入，缺失即 normal（存量会话）。
   * 加载时随 `conversationLoaded` 载荷下发，webview 据此恢复输入框禁用态。
   */
  workMode?: 'normal' | 'spin';
  /**
   * 未读完成次数（specs/defects/orphan-completion-unread-light）：后台运行期间会话
   * running → idle 而宿主不在场时由 core 递增（daemon 检出迁移后经控制帧通知），
   * 打开对话（conversationLoadRequested）即清零。缺失即 0（存量会话 / 在线完成的
   * 会话恒为 0——在线完成不经过该路径，重启后不翻旧账）。宿主只读，不写 meta.json。
   */
  unreadCompletions?: number;
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
 * 「受影响闭包」：sessionId 自身 + 所有层级的子孙对话（沿 `parentSessionId` 传递闭包）。
 *
 * 纯函数，输入全量对话列表。宿主删除对话前用它算出要关哪些视图
 * （Electron 每个会话一个 webview）；Core 的 `conversationDeleted` 用同一条规则删盘。
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
