/**
 * 根据 base URL 计算 provider key（服务商身份）。
 *
 * 规则：取 URL 的**主机与显式端口**（去掉路径与查询串）。
 * 例如 https://opencode.ai/zen/go -> opencode.ai
 *      http://127.0.0.1:11434/v1  -> 127.0.0.1:11434
 *
 * 端口是身份的一部分：同一台机器上不同端口是两个不同的服务商
 * （`docs/architecture/core-ui-separation.md` 第 4.3 节）。协议默认端口由 URL 解析器
 * 归一化后省略——`https://a.example:443` 与 `https://a.example` 同一个键，
 * 不产生两份身份。
 *
 * 如果输入不是合法 URL，则回退为去协议后取第一个 '/' 之前的部分（含端口）。
 *
 * 注意：余额与 Web Search 的「DeepSeek 官方 Key 查找」不走这里——它按**域名**匹配
 * （`docs/features/web-search.md` 第 3 节 行为规格），端口不参与判定。
 */
export function providerKeyFromBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return fallbackProviderKey(trimmed);
    // url.port 在端口等于协议默认值时为空串，因此默认端口不会分裂出第二个键
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return fallbackProviderKey(trimmed);
  }
}

function fallbackProviderKey(baseURL: string): string {
  const withoutProtocol = baseURL.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  // 端口保留：与 URL 解析分支同口径（同主机不同端口是两个服务商）
  return withoutProtocol.split('/')[0] || '';
}
