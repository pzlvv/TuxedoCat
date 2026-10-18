/**
 * 字符串工具函数
 */

/**
 * 默认最大字符串长度（用于 EndTruncatingAccumulator）
 * 当输出超过此大小时，从末尾截断
 */
export const MAX_STRING_LENGTH = 30_000; // 30KB

// ==================== 代理对（surrogate pair）安全 ====================

/**
 * 背景（真实事故）：
 *   `String.prototype.slice` / `substring` 按 **UTF-16 code unit** 截断，可以在
 *   代理对中间切开，留下一个**孤立代理项**（lone surrogate，如 `\uDE00`）。
 *   `JSON.stringify` 会把它序列化成 `"\ude00"`——语法上是合法 JSON，但语义上是
 *   非法 Unicode。严格解析器（如 Rust 的 serde_json）直接报错，宽松解析器会替换成
 *   U+FFFD；LLM 网关因此返回 `400 Bad Request`。
 *
 *   事故现场：一段以 emoji 结尾的 Bash 输出落盘后，「前 2K + 后 2K」预览的尾部
 *   切在 `😀`（`D83D DE00`）的代理对中间，坏掉的 tool_result 进入对话历史后，
 *   该会话**每一轮**请求都带着这个 `\ude00`，全部 400。
 *
 *   因此：凡是按长度截断字符串的地方，都必须用下面这组工具，不要裸用
 *   `slice` / `substring`。
 */

/** 是否为高位代理项（U+D800–U+DBFF） */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 是否为低位代理项（U+DC00–U+DFFF） */
export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 是否为任意代理项 code unit */
export function isSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

/**
 * 字符串里是否存在孤立代理项（合法代理对不算）。
 *
 * 用 `charCodeAt` 扫一遍即可：高位代理后面不是低位代理 → 孤立；
 * 低位代理只要没被前面的高位代理「吃掉」→ 孤立。
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isSurrogate(code)) continue;
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      i++; // 合法代理对，跳过低位
      continue;
    }
    return true;
  }
  return false;
}

/**
 * 把孤立代理项替换为 U+FFFD（替换字符），保证结果是合法 Unicode。
 * 没有孤立代理项时原样返回（不产生新字符串）。
 */
export function sanitizeLoneSurrogates(text: string): string {
  if (!hasLoneSurrogate(text)) return text;

  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      out += text[i] + text[i + 1];
      i++;
    } else if (isSurrogate(code)) {
      out += '\uFFFD';
    } else {
      out += text[i];
    }
  }
  return out;
}

/**
 * 头部截断的结束下标：`text.slice(0, end)` 的结果不超过 `limit` 个 code unit，
 * 且不会切开代理对（必要时少取 1 个 code unit）。
 */
export function surrogateSafeHeadEnd(text: string, limit: number): number {
  if (limit <= 0) return 0;
  if (limit >= text.length) return text.length;
  // `limit` 落在低位代理上 → 说明 `limit - 1` 是配对的另一半，丢掉它
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/**
 * 尾部截断的起始下标：`text.slice(start)` 的结果不超过 `limit` 个 code unit，
 * 且不会切开代理对（必要时少取 1 个 code unit）。
 */
export function surrogateSafeTailStart(text: string, limit: number): number {
  if (limit <= 0) return text.length;
  const start = text.length - limit;
  if (start <= 0) return 0;
  // `start` 落在低位代理上 → 它属于前一个字符，从下一个 code unit 开始
  return isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
}

/**
 * 修复 JSON 文本里的孤立代理项转义（`\ude00` → U+FFFD），与 Core 侧
 * `util::sanitize_json_surrogates` 行为一致。
 *
 * 两处细节：
 * - **字面量** `\ude00` 文本不能被误改：它在 JSON 里是 `\\ude00`，此时 `\u` 前面
 *   有奇数个反斜杠（那个反斜杠自身被转义了）；只有前面有偶数个反斜杠才是真转义。
 * - 合法代理对转义（`\ud83d\ude00`）原样保留。`JSON.stringify` 其实从不把合法
 *   代理对写成转义（会直接输出字符），这里兼容只是为了和 Core 侧口径一致。
 */
export function repairLoneSurrogatesInJson(json: string): string {
  let escapeStart = json.indexOf('\\u');
  if (escapeStart === -1) return json;

  const HEX4 = /^[0-9a-fA-F]{4}$/;
  const codeAt = (start: number): number | null => {
    const hex = json.slice(start, start + 4);
    return HEX4.test(hex) ? Number.parseInt(hex, 16) : null;
  };

  let out = '';
  let copiedTo = 0;
  while (escapeStart !== -1) {
    // `indexOf` 命中的是「反斜杠串的最后一个反斜杠 + u」。前面连续的反斜杠有
    // 偶数个时，这个反斜杠才是转义起点（奇数个说明它自己被转义了，是字面量）。
    let precedingBackslashes = 0;
    for (let i = escapeStart - 1; i >= 0 && json.charCodeAt(i) === 0x5c; i--) {
      precedingBackslashes++;
    }

    const escapeEnd = escapeStart + 6; // `\uXXXX`
    let searchFrom = escapeStart + 2;
    const code = precedingBackslashes % 2 === 0 ? codeAt(escapeStart + 2) : null;
    if (code !== null) {
      const lowCode = json.startsWith('\\u', escapeEnd) ? codeAt(escapeEnd + 2) : null;
      if (isHighSurrogate(code) && lowCode !== null && isLowSurrogate(lowCode)) {
        searchFrom = escapeEnd + 2; // 合法代理对：整对跳过
      } else if (isSurrogate(code)) {
        out += json.slice(copiedTo, escapeStart) + '\uFFFD';
        copiedTo = escapeEnd;
        searchFrom = escapeEnd;
      }
    }
    escapeStart = json.indexOf('\\u', searchFrom);
  }

  return copiedTo === 0 ? json : out + json.slice(copiedTo);
}

/**
 * 序列化 JSON，并保证输出里没有非法 Unicode 转义。
 *
 * 所有「会发给 LLM 或 Core 的 JSON」都应该走这里：即使某处历史数据已经被
 * 老版本的截断逻辑写坏了，也不会再把整轮请求带崩。
 */
export function stringifyJsonSafe(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return repairLoneSurrogatesInJson(json);
}

/**
 * EndTruncatingAccumulator - 从末尾截断的字符串累加器
 *
 * 安全处理大型输出，当超过大小限制时从末尾截断，防止 RangeError 崩溃
 * 同时保留输出开头的内容
 */
export class EndTruncatingAccumulator {
  private content: string = '';
  private isTruncated = false;
  private totalBytesReceived = 0;

  /**
   * @param maxSize 触发截断前的最大字符数
   */
  constructor(private readonly maxSize: number = MAX_STRING_LENGTH) {}

  /**
   * 追加数据到累加器。如果总大小超过 maxSize，末尾将被截断以维持大小限制
   */
  append(data: string | Buffer): void {
    const str = typeof data === 'string' ? data : data.toString();
    this.totalBytesReceived += str.length;

    // 如果已达到容量且已截断，不再修改内容
    if (this.isTruncated && this.content.length >= this.maxSize) {
      return;
    }

    // 检查添加字符串是否会超出限制
    if (this.content.length + str.length > this.maxSize) {
      // 仅追加能容纳的部分（按代理对边界对齐，避免尾部留下孤立代理项）
      const remainingSpace = this.maxSize - this.content.length;
      if (remainingSpace > 0) {
        this.content += str.slice(0, surrogateSafeHeadEnd(str, remainingSpace));
      }
      this.isTruncated = true;
    } else {
      this.content += str;
    }
  }

  /**
   * 返回累积的字符串，如果已截断则包含截断标记
   */
  toString(): string {
    if (!this.isTruncated) {
      return this.content;
    }

    const truncatedBytes = this.totalBytesReceived - this.maxSize;
    const truncatedKB = Math.round(truncatedBytes / 1024);
    return this.content + `\n... [output truncated - ${truncatedKB}KB removed]`;
  }

  /**
   * 清除所有累积的数据
   */
  clear(): void {
    this.content = '';
    this.isTruncated = false;
    this.totalBytesReceived = 0;
  }

  /**
   * 返回当前累积数据的大小
   */
  get length(): number {
    return this.content.length;
  }

  /**
   * 返回是否已截断
   */
  get truncated(): boolean {
    return this.isTruncated;
  }
}
