/**
 * 模型身份：provider + model。
 *
 * 同名模型可能属于不同 provider，而 baseURL / apiKey / modelConfigs 都随 provider 变化，
 * 所以「当前选中的模型」必须由两者一起表征，不能只传模型名。
 *
 * 不变量：
 * - `provider` 必须非空。空串表示「非法」，不表示「未知」——
 *   需要「尚未确定 / 未配置」语义的地方用 `ModelRef | undefined`，不要用空串。
 * - `model` 允许为空串：provider 已确定但该 provider 尚未指定模型
 *   （例如 settings.json 里配了 provider 但还没填模型列表）。
 */
export interface ModelRef {
  /** provider key（baseURL 的 hostname），必须非空 */
  provider: string;
  /** 模型名；空串表示该 provider 尚未指定模型 */
  model: string;
}

/**
 * 由扁平字段组装模型身份。
 *
 * 返回 undefined 表示「没有可用的模型身份」：
 * - provider 缺失或为空串 → 非法，按「未配置」处理（不猜测、不回退到其它 provider）
 * - 两侧都 trim，避免 meta.json / 消息里的空白串绕过非空判断
 */
export function modelRefOf(provider: string | undefined | null, model: string | undefined | null): ModelRef | undefined {
  const p = typeof provider === 'string' ? provider.trim() : '';
  if (!p) return undefined;
  return { provider: p, model: typeof model === 'string' ? model.trim() : '' };
}

/**
 * 两个模型身份是否相同（provider 与 model 都要比）。
 *
 * 只比 model 是不够的：从 (A, gpt-4o) 切到 (B, gpt-4o) 时模型名不变，
 * 但 provider 已经换了，旧的异步结果不得覆盖新选择。
 */
export function sameModelRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return a === b;
  return a.provider === b.provider && a.model === b.model;
}
