/**
 * 构建 baseURL 与 /v1 端点的请求 URL（LLM 配置探测与请求 URL 共用）。
 * 统一规则：
 *   - baseURL 已以 /v1 结尾（如 https://api.deepseek.com/v1）→ `${baseURL}/${endpoint}`
 *   - 否则（如 https://api.deepseek.com、https://opencode.ai/zen/go）→ `${baseURL}/v1/${endpoint}`
 */

export function joinV1Path(baseURL: string, endpoint: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/${endpoint}`;
  }
  return `${trimmed}/v1/${endpoint}`;
}
