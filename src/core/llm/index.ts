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
 * callLLM 的实现注入点（场景测试 / 诊断专用）。
 *
 * 为什么需要：Query / compact / smartNaming / SpinJudger 都从本模块取 `callLLM`，
 * 真实 API 会发网络请求，写死的 `callModelStub` 又只有固定三轮脚本；场景级测试
 * （事件序列、权限、中止、落盘）需要按场景编排 LLM 应答。注入只影响本分发点，
 * 不改变任何调用方行为。测试结束必须 `setCallLlmOverride(null)` 还原，
 * 否则后续真实调用会被吞掉。
 */
export type CallLlmImplementation = (
  options: StreamOptions,
) => AsyncGenerator<unknown, void, void>;

let callLlmOverride: CallLlmImplementation | null = null;

/** 注入 callLLM 实现；传 null 还原默认分发（USE_STUB ? 桩 : 真实 API） */
export function setCallLlmOverride(impl: CallLlmImplementation | null): void {
  callLlmOverride = impl;
}

/**
 * 统一的 LLM 调用接口
 * 优先级：注入实现 → USE_STUB 变量 → 真实 API
 *
 * yield 的事件类型：
 * - StreamEvent: 细粒度的流式事件（block_start, thinking_delta, text_delta, block_stop, message_delta）
 * - Message: 完整的 assistant 消息（用于持久化）
 */
export async function* callLLM(options: StreamOptions): AsyncGenerator<any> {
  if (callLlmOverride) {
    yield* callLlmOverride(options);
  } else if (USE_STUB) {
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
