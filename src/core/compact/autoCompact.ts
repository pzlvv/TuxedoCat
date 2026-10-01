/**
 * Auto-compact logic and trigger mechanism
 */

import type { Message } from '../types.js';
import type { AutoCompactTrackingState } from './types.js';
import { effectiveMaxOutputTokens } from '../llm/modelLimits.js';
import type { ModelLimits } from '../settingsSnapshot.js';
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
 * 限值来自配置快照（`limits` 命中模型，`fallback` 是全局兜底）。两者都没有
 * 说明当前没有任何可用配置——此时按无配置兜底算，查询本身也跑不起来。
 *
 * @param limits 当前模型的已解析限值；模型未知时为 undefined
 * @param fallback 快照的全局兜底限值
 */
export function getThreshold(
  limits: ModelLimits | undefined,
  fallback: ModelLimits | undefined,
): number {
  const contextWindow = (limits ?? fallback)?.context ?? NO_CONFIG_CONTEXT_WINDOW;
  const maxOutputTokens = effectiveMaxOutputTokens(limits ?? fallback);
  return getAutoCompactThreshold(contextWindow, maxOutputTokens);
}

/** 没有任何配置时的上下文窗口兜底（与历史「注册表兜底」口径一致） */
const NO_CONFIG_CONTEXT_WINDOW = 1024 * 1024;

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
  /**
   * 当前上下文已占用的 token 数：优先用 API usage（input + output），
   * 拿不到或已过期时由调用方传入「宁可高估」的请求估算值。
   */
  tokenCount?: number,
  /** 当前模型的已解析限值；模型未知时为 undefined */
  limits?: ModelLimits,
  /** 快照的全局兜底限值 */
  fallback?: ModelLimits,
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

  // Token count must be provided (API usage 或调用方的保守估算)
  if (tokenCount === undefined) {
    logger.warn('autoCompact', 'tokenCount is required but not provided, skipping auto-compact check');
    return false;
  }

  const threshold = getThreshold(limits, fallback);
  const usagePct = threshold > 0 ? Math.round((tokenCount / threshold) * 100) : 100;

  logger.info('autoCompact', `Token count: ${tokenCount}, threshold: ${threshold} (${usagePct}%)`);

  if (tokenCount >= threshold) {
    logger.info('autoCompact', `Triggering auto-compact: ${tokenCount} >= ${threshold}`);
    return true;
  }

  logger.info('autoCompact', `Not triggering auto-compact: ${tokenCount} < ${threshold}`);
  return false;
}

