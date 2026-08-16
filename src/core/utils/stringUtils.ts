/**
 * 字符串工具函数
 */

/**
 * 默认最大字符串长度（用于 EndTruncatingAccumulator）
 * 当输出超过此大小时，从末尾截断
 */
export const MAX_STRING_LENGTH = 30_000; // 30KB

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
      // 仅追加能容纳的部分
      const remainingSpace = this.maxSize - this.content.length;
      if (remainingSpace > 0) {
        this.content += str.slice(0, remainingSpace);
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
