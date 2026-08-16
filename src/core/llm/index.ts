/**
 * LLM 调用统一入口
 * 控制使用桩实现还是真实 API
 */

import { callRealLLM } from './RealApi.js';
import { callModelStub } from './Stub.js';
import type { LLMConfig } from './config.js';

/**
 * 控制变量：true = 使用桩，false = 使用真实 API
 *
 * 使用桩的场景：
 * - 开发测试：不需要消耗 API 额度
 * - 离线开发：不需要网络连接
 * - 快速验证：测试工具流程和 UI 交互
 *
 * 使用真实 API 的场景：
 * - 生产环境：实际的 AI 助手功能
 * - 完整测试：验证真实 API 集成
 */
export const USE_STUB = false;

export interface StreamOptions {
  messages: Array<{ role: string; content: string | unknown[] }>;
  systemPrompt?: string;
  tools: unknown[];
  signal: AbortSignal | null;
  onProgress?: (message: any) => void;
  /** 覆盖 LLM 默认的 thinking 模式，不指定则无 thinking */
  thinkingEffort?: 'off' | 'low' | 'high' | 'max';
  /** 覆盖配置文件中的 thinking 预算 token 数，通常来自 ModelConfig */
  thinkingTokenBudget?: number;
  /** LLM 配置覆盖，不指定则使用 settings.json 中的配置 */
  modelConfig?: LLMConfig;
  /** 会话 ID，附加到请求头 x-session-id */
  sessionId: string;
}

/** 从 RealApi 重新导出流式事件类型 */
export type { StreamEvent } from './RealApi.js';

/**
 * 统一的 LLM 调用接口
 * 根据 USE_STUB 变量自动选择实现
 *
 * yield 的事件类型：
 * - StreamEvent: 细粒度的流式事件（block_start, thinking_delta, text_delta, block_stop, message_delta）
 * - Message: 完整的 assistant 消息（用于持久化）
 */
export async function* callLLM(options: StreamOptions): AsyncGenerator<any> {
  if (USE_STUB) {
    // 使用桩实现
    yield* callModelStub(options);
  } else {
    // 使用真实 API
    yield* callRealLLM(options);
  }
}

/**
 * 获取当前使用的模式
 */
export function getCurrentMode(): 'stub' | 'real' {
  return USE_STUB ? 'stub' : 'real';
}
