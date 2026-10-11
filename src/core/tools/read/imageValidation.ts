/**
 * 图片合法性校验（Embedded Core 侧）。
 *
 * Read 按**扩展名**给图片定 media_type，但扩展名不是事实：`.png` 里可能是任意
 * 二进制。发给 LLM 的 image content block 一旦不是真图片，provider 会整轮报错，
 * 而错误现场（哪个文件、为什么）在 tool_result 里已经丢失。这里在「内容确实是
 * 二进制 + 扩展名是支持的图片类型」之后补一层「魔数 + 结构完整性」校验：
 * 文件头必须匹配扩展名声明的格式，且声明长度 / 结束标记必须自洽（CRC 与像素数据
 * 的解码交给 provider，不做重复实现）。
 *
 * 判定规则与 Standalone Core 的 `tools::image_validation_failure` 一一对应，
 * 两侧共用对照表 `src/test/fixtures/imageValidation.json`（docs/core/core-parity.md 第 4 节）。
 */

/** 支持的图片扩展名 -> MIME 类型（图片以 base64 返回，不受文本大小限制） */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 图片文件的最大字节数（15MB） */
export const MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

/**
 * 校验失败原因。
 *
 * 取值是两侧共享的稳定标识（进对照表），不是用户可见文案——文案由
 * {@link IMAGE_VALIDATION_REASON_TEXT} 单点给出。
 */
export type ImageValidationFailure =
  /** 文件头与格式签名不符（含文件短于签名） */
  | 'signature'
  /** 结构声明的长度超出实际字节数（截断） */
  | 'truncated'
  /** 缺少结束标记（PNG 的 IEND / JPEG 的 EOI / GIF 的 trailer） */
  | 'missing-end-marker'
  /** 结束标记之后还有多余字节 */
  | 'trailing-data'
  /** 结构本身不合法（如 PNG IEND 块长度非 0、BMP 声明长度小于文件头） */
  | 'malformed'
  /** 未登记的图片类型（media_type 不在 {@link IMAGE_MEDIA_TYPES} 的取值里） */
  | 'unsupported';

/** 失败原因 -> 工具错误消息里的英文说明（工具错误文案统一用英文） */
export const IMAGE_VALIDATION_REASON_TEXT: Record<ImageValidationFailure, string> = {
  signature: 'file signature does not match the format',
  truncated: 'declared length exceeds the actual file size',
  'missing-end-marker': 'missing the end-of-image marker',
  'trailing-data': 'extra bytes after the end-of-image marker',
  malformed: 'malformed image structure',
  unsupported: 'unsupported image type',
};

/** PNG 文件签名（8 字节） */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** GIF 的两种文件头 */
const GIF_HEADERS = ['GIF87a', 'GIF89a'] as const;

/** 读大端 u32（PNG 块长度） */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

/** 读小端 u32（RIFF / BMP 头的长度字段） */
function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/** 取开头的 ASCII 文本；字节数不足时返回空串（调用方按签名不符处理） */
function asciiPrefix(bytes: Uint8Array, length: number): string {
  if (bytes.length < length) return '';
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

/** 文件头是否等于给定字节序列 */
function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * PNG：签名 + 逐块走到 IEND。
 *
 * 块格式为「长度(4, BE) + 类型(4) + 数据(length) + CRC(4)」。这里只校验块长度自洽、
 * IEND 是最后一块且长度为 0——CRC 值不校验（那是解码方的职责，且能挡住的情况
 * 「文件被改坏一个字节」在 provider 侧同样会报错）。
 */
function validatePng(bytes: Uint8Array): ImageValidationFailure | null {
  if (!startsWithBytes(bytes, PNG_SIGNATURE)) return 'signature';

  let offset = PNG_SIGNATURE.length;
  while (true) {
    // 连块头（长度 + 类型）都不完整：后面不可能再有 IEND
    if (offset + 8 > bytes.length) return 'missing-end-marker';

    const length = readUint32BE(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return 'truncated';

    const chunkType = asciiPrefix(bytes.subarray(offset + 4), 4);
    if (chunkType === 'IEND') {
      if (length !== 0) return 'malformed';
      return end === bytes.length ? null : 'trailing-data';
    }

    offset = end;
  }
}

/** JPEG：SOI（FF D8）+ 紧随的标记前缀 FF，且以 EOI（FF D9）收尾 */
function validateJpeg(bytes: Uint8Array): ImageValidationFailure | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return 'signature';
  }
  const end = bytes.length;
  if (bytes[end - 2] !== 0xff || bytes[end - 1] !== 0xd9) return 'missing-end-marker';
  return null;
}

/** GIF：GIF87a / GIF89a 头 + 逻辑屏幕描述符 + trailer 0x3B */
function validateGif(bytes: Uint8Array): ImageValidationFailure | null {
  const header = asciiPrefix(bytes, 6);
  if (!GIF_HEADERS.includes(header as (typeof GIF_HEADERS)[number])) return 'signature';
  // 头之后还有 7 字节逻辑屏幕描述符；不足即结构不完整
  if (bytes.length < 13) return 'truncated';
  if (bytes[bytes.length - 1] !== 0x3b) return 'missing-end-marker';
  return null;
}

/** WebP：RIFF 容器 + `WEBP` 四字符码，且 RIFF 声明长度与实际文件长度一致 */
function validateWebp(bytes: Uint8Array): ImageValidationFailure | null {
  if (bytes.length < 12 || asciiPrefix(bytes, 4) !== 'RIFF' || asciiPrefix(bytes.subarray(8), 4) !== 'WEBP') {
    return 'signature';
  }
  // RIFF 的长度字段不含前 8 字节（'RIFF' + 长度本身）
  const declared = readUint32LE(bytes, 4) + 8;
  if (declared > bytes.length) return 'truncated';
  if (declared < bytes.length) return 'trailing-data';
  return null;
}

/** BMP：`BM` 头 + 文件头里声明的文件长度与实际长度一致 */
function validateBmp(bytes: Uint8Array): ImageValidationFailure | null {
  if (bytes.length < 14 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return 'signature';
  const declared = readUint32LE(bytes, 2);
  // 文件头本身就有 14 字节，声明比它还短说明结构不合法
  if (declared < 14) return 'malformed';
  if (declared > bytes.length) return 'truncated';
  if (declared < bytes.length) return 'trailing-data';
  return null;
}

/**
 * 校验图片字节是否与 media_type 声明的格式相符。
 *
 * 返回 `null` 表示通过，否则返回失败原因。`mediaType` 取自
 * {@link IMAGE_MEDIA_TYPES} 的取值。
 */
export function validateImageBytes(bytes: Uint8Array, mediaType: string): ImageValidationFailure | null {
  switch (mediaType) {
    case 'image/png':
      return validatePng(bytes);
    case 'image/jpeg':
      return validateJpeg(bytes);
    case 'image/gif':
      return validateGif(bytes);
    case 'image/webp':
      return validateWebp(bytes);
    case 'image/bmp':
      return validateBmp(bytes);
    default:
      return 'unsupported';
  }
}

/** 校验失败时的工具错误消息（文案与 Standalone 侧逐字一致） */
export function imageValidationErrorMessage(
  filePath: string,
  mediaType: string,
  failure: ImageValidationFailure,
): string {
  return `Invalid image file: ${filePath}. The content is not a valid ${mediaType} image (${IMAGE_VALIDATION_REASON_TEXT[failure]}).`;
}
