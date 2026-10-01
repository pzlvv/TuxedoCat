/**
 * 模型限值的读取与派生：Core 侧只从配置快照取值，**不持有内置注册表**。
 *
 * 注册表与用户覆盖的合并由 UI 在产出快照时完成（`src/core/settingsSnapshot.ts`），
 * 这里只做「查表 → 兜底 → 派生」三件事（`docs/core-ui-separation.md` 第 4.3 节）。
 */

import { ENV_MAX_OUTPUT_TOKENS } from '../../config/project.js';
import type { ModelLimits } from '../settingsSnapshot.js';

/** 模型未知时的输出上限兜底（与历史 `getMaxOutputTokens` 的全局默认一致） */
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
/** 输出 token 的硬上限：所有来源都不得超过 */
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 384 * 1024;

/**
 * 取某模型的限值。
 *
 * `model` 为空时返回 `undefined`——「模型未知」与「模型未命中」是两回事：
 * 前者按全局默认输出上限处理，后者用快照的兜底限值。
 */
export function limitsFor(
  model: string | undefined,
  limits: Record<string, ModelLimits>,
  fallback: ModelLimits,
): ModelLimits | undefined {
  if (!model) return undefined;
  return limits[model] ?? fallback;
}

/**
 * 最终生效的 max_tokens。
 *
 * 优先级：环境变量覆盖（最高）→ 模型限值 → 全局默认；都不超过硬上限。
 * `limits` 为 `undefined` 表示模型未知，直接用全局默认。
 */
export function effectiveMaxOutputTokens(limits: ModelLimits | undefined): number {
  const envVal = process.env[ENV_MAX_OUTPUT_TOKENS];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    }
  }
  if (!limits) return MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(limits.output || MAX_OUTPUT_TOKENS_DEFAULT, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
}

/**
 * 本次请求实际可用的最大输出 token 数：`min(output, context - currentContextTokens)`。
 *
 * 输出预留不能超过上下文窗口的剩余空间，否则「输入 + 输出」会超出窗口导致请求失败。
 * `limits` 为 `undefined` 时上下文窗口取快照的全局兜底。
 */
export function availableOutputTokens(
  limits: ModelLimits | undefined,
  fallback: ModelLimits,
  currentContextTokens: number,
): number {
  const output = effectiveMaxOutputTokens(limits);
  const contextWindow = (limits ?? fallback).context;
  const remaining = contextWindow - Math.max(0, currentContextTokens);
  return Math.max(1, Math.min(output, remaining));
}
