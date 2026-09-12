/**
 * Tool 接口定义 - 工具抽象层
 */

import type { z } from 'zod';

/**
 * 工具权限结果
 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; shouldTerminate?: boolean } // 添加 shouldTerminate 标志
  | {
      behavior: 'ask';
      message?: string;
      choices?: Array<{ label: string; description?: string }>;
      updatedInput?: Record<string, unknown>;
      // 内容预览相关
      showPreview?: boolean;
      previewContent?: string;
      previewTitle?: string;
      // diff 预览相关
      showDiff?: boolean;
      beforeContent?: string | null;
      afterContent?: string;
      diffTitle?: string;
    }

/**
 * 验证结果
 */
export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode: number }

/**
 * Bash 工具进度数据
 */
export interface BashProgress extends ToolProgressData {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes?: number
  taskId?: string
  timeoutMs?: number
}

/**
 * 工具进度数据基类
 */
export interface ToolProgressData {
  type: string
  [key: string]: unknown
}

/**
 * AbortController 兼容类型
 * 支持原生 AbortController 和 polyfill 版本
 */
export type AbortControllerLike = AbortController | {
  signal: AbortSignal | null;
  abort(): void;
}

/**
 * 工具使用上下文 - 在工具执行时传递的环境信息
 */
export interface ToolUseContext {
  /** 中断控制器 */
  abortController: AbortControllerLike

  /** 获取应用状态 */
  getAppState(): unknown

  /** 更新应用状态 */
  setAppState(updater: (prev: unknown) => unknown): void

  /** 消息历史 */
  messages: unknown[]

  /** 当前工具 ID */
  toolUseId?: string

  /** 当前会话 ID */
  sessionId?: string

  /** 当前角色 */
  role?: string

  /** 其他上下文信息 */
  [key: string]: unknown
}

/**
 * 工具结果
 */
export interface ToolResult<T> {
  data: T
  newMessages?: unknown[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

/**
 * 工具进度回调
 */
export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: { toolUseID: string; data: P },
) => void

/**
 * 工具接口定义
 * 提供工具抽象和执行机制
 */
export interface Tool<
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> {
  /** 工具名称 */
  readonly name: string

  /** 工具别名（用于向后兼容） */
  readonly aliases?: string[]

  /** 搜索提示 - 用于工具查找 */
  readonly searchHint?: string

  /** 输入参数 schema (Zod) */
  readonly inputSchema: Input

  /**
   * 可选：直接提供给 LLM 的 JSON Schema。
   *
   * 外部工具（如 MCP）的参数 schema 本身就是 JSON Schema，无法用 Zod 精确表达，
   * 而 zodToJsonSchema 只支持扁平原始类型。存在此字段时 toolToLlmFormat 会直接使用它，
   * 跳过 inputSchema 的自动转换（此时 inputSchema 仅用于放行参数校验）。
   */
  readonly llmInputSchema?: Record<string, unknown>

  /** 输出结果 schema (可选) */
  readonly outputSchema?: z.ZodType<unknown>

  /**
   * 最大结果字符数
   * 超过此大小的结果会持久化到磁盘
   */
  readonly maxResultSizeChars: number

  /**
   * 是否启用严格模式
   */
  readonly strict?: boolean

  /**
   * 核心方法：执行工具
   * @param args 解析后的输入参数
   * @param context 工具使用上下文
   * @param parentMessage 父消息
   * @param onProgress 进度回调
   */
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    parentMessage?: unknown,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>

  /**
   * 生成工具描述
   * 用于向 AI 解释工具的作用
   */
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: unknown
      tools: Tools
    },
  ): Promise<string>

  /**
   * 生成工具提示词
   * 用于系统提示词中
   */
  prompt(options: {
    getToolPermissionContext: () => Promise<unknown>
    tools: Tools
  }): Promise<string>

  /**
   * 验证输入参数
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 检查权限
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  /**
   * 判断输入是否并发安全
   */
  isConcurrencySafe(input: z.infer<Input>): boolean

  /**
   * 判断是否为只读操作
   */
  isReadOnly(input: z.infer<Input>): boolean

  /**
   * 判断是否为破坏性操作
   */
  isDestructive?(input: z.infer<Input>): boolean

  /**
   * 工具是否启用
   */
  isEnabled(): boolean

  /**
   * 用户友好的工具名称
   */
  userFacingName(input?: Partial<z.infer<Input>>): string

  /**
   * 获取工具使用摘要
   */
  getToolUseSummary?(input?: Partial<z.infer<Input>>): string | null

  /**
   * 获取活动描述
   */
  getActivityDescription?(input?: Partial<z.infer<Input>>): string | null

  /**
   * 将工具输出映射为 API 格式
   */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): {
    tool_use_id: string
    type: 'tool_result'
    content: string | unknown[]
    exit_code?: number
    is_canceled?: boolean
  }
}

/**
 * 工具集合类型 - readonly 防止意外修改
 */
export type Tools = readonly Tool[]

/**
 * 可选方法 - buildTool 会提供默认实现
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'userFacingName'
  | 'getToolUseSummary'
  | 'getActivityDescription'

/**
 * 工具定义 - 可以省略某些方法
 */
export type ToolDef<
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * 构建工具 - 填充默认实现
 */
export function buildTool<
  Input extends z.ZodType,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
>(def: ToolDef<Input, Output, P>): Tool<Input, Output, P> {
  const TOOL_DEFAULTS = {
    isEnabled: () => true,
    isConcurrencySafe: (_input?: unknown) => false,
    isReadOnly: (_input?: unknown) => false,
    isDestructive: (_input?: unknown) => false,
    checkPermissions: (
      _input: unknown,
      _ctx?: ToolUseContext,
    ): Promise<PermissionResult> =>
      Promise.resolve({
        behavior: 'allow',
        updatedInput: _input as Record<string, unknown>
      }),
    userFacingName: (_input?: unknown) => def.name,
    getToolUseSummary: (_input?: unknown) => null,
    getActivityDescription: (_input?: unknown) => null,
  };

  return {
    ...TOOL_DEFAULTS,
    ...def,
  } as Tool<Input, Output, P>;
}

/**
 * 检查工具是否匹配名称（包括别名）
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

/**
 * 从工具列表中查找工具
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find((t) => toolMatchesName(t, name));
}
