/**
 * 根据 base URL 计算 provider key。
 *
 * 规则：取 URL 的 hostname（去掉端口与路径）。
 * 例如 https://opencode.ai/zen/go -> opencode.ai
 *
 * 如果输入不是合法 URL，则回退为去协议后取第一个 '/' 之前的部分。
 */
export function providerKeyFromBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return url.hostname || fallbackProviderKey(trimmed);
  } catch {
    return fallbackProviderKey(trimmed);
  }
}

function fallbackProviderKey(baseURL: string): string {
  const withoutProtocol = baseURL.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const host = withoutProtocol.split('/')[0] || '';
  // 去掉端口
  return host.split(':')[0] || '';
}
