/**
 * Read 工具输出限制
 *
 * 限制：
 *
 *   | 限制           | 默认值    | 检查时机      | 超出时              |
 *   |----------------|-----------|---------------|---------------------|
 *   | maxSizeBytes   | 256 KB    | 读取前 (stat) | 抛 FileTooLargeError |
 *   | maxLines       | 2,000     | 读取后        | 截断输出 / 校验 limit |
 *   | maxLineLength  | 2,000     | 读取后        | 单行截断            |
 *   | maxOutputBytes | 50 KB     | 读取后        | 截断输出            |
 *
 * maxSizeBytes 仅在未传 limit 的整文件读取时检查（xlsx / 图片文件跳过）；
 * 传了 limit/offset 时仍会执行 maxLines / maxLineLength / maxOutputBytes 窗口限制。
 */

/**
 * 默认最大文件大小（字节），超出后拒绝整文件读取
 * 256 KB = 0.25 * 1024 * 1024
 */
export const DEFAULT_MAX_SIZE_BYTES = 0.25 * 1024 * 1024;

/**
 * 默认单次读取最大行数
 */
export const DEFAULT_MAX_LINES = 2000;

/**
 * 默认单行最大字符数，超出后截断
 */
export const DEFAULT_MAX_LINE_LENGTH = 2000;

/**
 * 默认单次读取最大输出字节数
 * 50 KB = 50 * 1024
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * 默认最大输出 token 数（保留兼容，Read 主限制已切换为上面的窗口限制）
 */
export const DEFAULT_MAX_TOKENS = 25_000;

/**
 * FileTooLargeError - 文件大小超限
 */
export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
      `Use offset and limit parameters to read specific portions of the file.`
    );
    this.name = 'FileTooLargeError';
  }
}

/**
 * MaxTokenExceededError - token 数超限（保留兼容）
 */
export class MaxTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). ` +
      `Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`
    );
    this.name = 'MaxTokenExceededError';
  }
}

/**
 * 获取默认的读取限制
 * 支持环境变量 FILE_READ_MAX_OUTPUT_TOKENS 覆盖 maxTokens（保留兼容）
 */
export function getDefaultLimits(): {
  maxSizeBytes: number;
  maxTokens: number;
  maxLines: number;
  maxLineLength: number;
  maxOutputBytes: number;
} {
  const envMaxTokens = getEnvMaxTokens();
  return {
    maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
    maxTokens: envMaxTokens ?? DEFAULT_MAX_TOKENS,
    maxLines: DEFAULT_MAX_LINES,
    maxLineLength: DEFAULT_MAX_LINE_LENGTH,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/**
 * 从环境变量读取 maxTokens 覆盖值（保留兼容）
 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.FILE_READ_MAX_OUTPUT_TOKENS;
  if (override) {
    const parsed = parseInt(override, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * 格式化文件大小为人类可读字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
