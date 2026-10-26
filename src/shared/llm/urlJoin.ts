/**
 * 构建 baseURL 与版本化端点的请求 URL（LLM 配置探测与请求 URL 共用）。
 * 统一规则：
 *   - baseURL 已以版本段结尾（如 `/v1`、智谱的 `/api/paas/v4`）→ `${baseURL}/${endpoint}`，
 *     版本号按路径末段的 `v<数字>` 匹配，因此未来 `/v5`、`/v6` 同样适用；
 *   - 否则（如 https://api.deepseek.com、https://opencode.ai/zen/go）→ `${baseURL}/v1/${endpoint}`。
 */

/** 路径末段的版本段：`/v1`、`/v4`、`/v12` 等（`/v1beta` 不算，仍按无版本段处理）。 */
const VERSION_SEGMENT = /\/v\d+$/;

export function joinV1Path(baseURL: string, endpoint: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (VERSION_SEGMENT.test(trimmed)) {
    return `${trimmed}/${endpoint}`;
  }
  return `${trimmed}/v1/${endpoint}`;
}
