/**
 * Auto-compact logic and trigger mechanism
 */

import type { Message } from '../types.js';
import type { AutoCompactTrackingState } from './types.js';
import { getContextWindow, getMaxOutputTokens, type ModelTokenLimits } from '../utils/modelConfig.js';
import { COMPACT_THRESHOLDS, getAutoCompactThreshold } from './types.js';
import { logger } from '../Logger.js';

const autoCompactEnabled = true;

/**
 * Check if auto-compact is enabled
 */
export function isAutoCompactEnabled(): boolean {
  // Check environment variable to disable
  if (process.env.DISABLE_AUTO_COMPACT === 'true') {
    return false;
  }
  return autoCompactEnabled;
}

/**
 * Get the auto-compact threshold in tokens
 *
 * 阈值 = contextWindow - min(50K, 0.3 * maxOutputTokens)。
 * 即为输出预留的缓冲最多 50K，且不超过输出上限的 30%；
 * 当已用 token（input + output）达到该值时触发压缩。
 *
 * @param modelName 当前使用的模型名称；未传时使用默认配置（1M 上下文）
 */
export function getThreshold(modelName?: string, modelConfigs?: Record<string, ModelTokenLimits>): number {
  const contextWindow = getContextWindow(modelName || '', modelConfigs);
  const maxOutputTokens = getMaxOutputTokens(modelName, modelConfigs);
  return getAutoCompactThreshold(contextWindow, maxOutputTokens);
}

/**
 * Determine if auto-compact should be triggered
 *
 * Conditions:
 * - Auto-compact must be enabled
 * - Context must be above threshold
 * - Circuit breaker: not exceeded max consecutive failures
 * - Not in session_memory or compact mode (sub-agents)
 */
export async function shouldAutoCompact(
  messages: Message[],
  tracking?: AutoCompactTrackingState,
  /** 精确 token 数（input+output），来自 API 返回的 usage */
  exactTokenCount?: number,
  /** 当前使用的模型名称，用于获取对应的上下文窗口阈值 */
  modelName?: string,
  /** 当前 provider 的模型 context/output 覆盖 */
  modelConfigs?: Record<string, ModelTokenLimits>,
): Promise<boolean> {
  // Check if enabled
  if (!isAutoCompactEnabled()) {
    logger.info('autoCompact', 'Auto-compact is disabled (isAutoCompactEnabled returned false)');
    return false;
  }

  // Circuit breaker check
  if (tracking?.consecutiveFailures !== undefined) {
    if (tracking.consecutiveFailures >= COMPACT_THRESHOLDS.MAX_CONSECUTIVE_FAILURES) {
      logger.info('autoCompact', `Circuit breaker active: ${tracking.consecutiveFailures} consecutive failures`);
      return false;
    }
  }

  // Token count must be provided via exactTokenCount (from API usage)
  if (exactTokenCount === undefined) {
    logger.warn('autoCompact', 'exactTokenCount is required but not provided, skipping auto-compact check');
    return false;
  }

  const tokenCount = exactTokenCount;
  const threshold = getThreshold(modelName, modelConfigs);
  const usagePct = threshold > 0 ? Math.round((tokenCount / threshold) * 100) : 100;

  logger.info('autoCompact', `Token count: ${tokenCount} (exact), threshold: ${threshold} (${usagePct}%)`);

  if (tokenCount >= threshold) {
    logger.info('autoCompact', `Triggering auto-compact: ${tokenCount} >= ${threshold}`);
    return true;
  }

  logger.info('autoCompact', `Not triggering auto-compact: ${tokenCount} < ${threshold}`);
  return false;
}

