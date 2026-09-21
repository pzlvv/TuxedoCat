/**
 * 请求 token 的粗略估算。
 *
 * 背景：`exactTokenCount` 来自上一轮 API 返回的 usage（input + output），
 * 它不包含本轮新增的消息、system prompt 变化与工具 schema，直接拿它去预留
 * max_tokens 会低估真实输入，导致 `input + max_tokens` 超出上下文窗口。
 *
 * 这里只求「宁可高估」：低估会让请求被服务端拒绝，高估只会少留一点输出空间。
 * 经验折算：
 * - 中日韩 / 全角字符约 1 token/字，保守按 1.2 计；
 * - 其余字符约 4 字符/token，保守按 3 字符/token 计；
 * - 内联图片（base64）字符数远超真实 token，按固定成本计。
 */

/** 单张内联图片的 token 成本估算（与 ResponsesApi 的 IMAGE_TOKEN_ESTIMATE 口径一致） */
const IMAGE_TOKEN_ESTIMATE = 1_500;

/** 判断是否为中日韩 / 全角字符（按 UTF-16 code unit 判断即可，代理对会被当作两个非 CJK） */
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 汉字扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 常用汉字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0x3000 && code <= 0x303f)    // CJK 标点
  );
}

/**
 * 估算一段文本的 token 数（偏保守，可能高于真实值）。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.2 + other / 3);
}

/**
 * 估算一次 LLM 请求的输入 token 数（消息 + system prompt + 工具 schema）。
 *
 * 图片：内联 base64 会先替换成占位符再统计长度，最后按固定成本补回，
 * 避免 base64 长度把估算值抬到远高于真实 token 的水平。
 */
export function estimateRequestTokens(params: {
  messages?: unknown;
  systemPrompt?: string;
  tools?: unknown;
}): number {
  let imageCount = 0;
  const messagesJson = params.messages === undefined
    ? ''
    : JSON.stringify(params.messages, function replacer(key, value) {
        // OpenAI / Responses：{ image_url: 'data:image/...;base64,...' }
        if (key === 'image_url' && typeof value === 'string' && value.startsWith('data:')) {
          imageCount++;
          return 'data:image/omitted;base64,';
        }
        // Anthropic：{ type: 'image', source: { type: 'base64', data: '...' } }
        if (
          key === 'data' &&
          typeof value === 'string' &&
          value.length > 1024 &&
          (this as { type?: string } | undefined)?.type === 'base64'
        ) {
          imageCount++;
          return '';
        }
        return value;
      });
  const toolsJson = params.tools === undefined ? '' : JSON.stringify(params.tools);
  return estimateTextTokens(messagesJson + (params.systemPrompt ?? '') + toolsJson)
    + imageCount * IMAGE_TOKEN_ESTIMATE;
}
