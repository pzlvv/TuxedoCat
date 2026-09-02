/**
 * 多模态内容块工具
 *
 * 内部统一使用 Anthropic 风格的 content block：
 * - 文本:  { type: 'text', text: '...' }
 * - 图片:  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
 *
 * 上层（Responses API）在发请求时再转换为 input_image / input_text。
 * UI 层只消费轻量的 dataUrl 图片对象，避免依赖具体 API 格式。
 */

export interface UiImage {
  /** 完整的 data URL，例如 data:image/png;base64,xxxx */
  dataUrl: string;
  /** media type，可从 dataUrl 解析；缺省时使用 image/png */
  mediaType?: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type UserContentBlock = TextContentBlock | ImageContentBlock;

/** 从 dataUrl 中解析 media type 与 base64 数据 */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (match) {
    return { mediaType: match[1] || 'image/png', data: match[2] };
  }
  // 如果不是标准 data URL，视为纯 base64
  return { mediaType: 'image/png', data: dataUrl };
}

/** 将图片块转为 UI 使用的 dataUrl */
export function imageBlockToDataUrl(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
  if (b.type !== 'image' || !b.source || b.source.type !== 'base64' || typeof b.source.data !== 'string') {
    return null;
  }
  const mediaType = b.source.media_type || 'image/png';
  return `data:${mediaType};base64,${b.source.data}`;
}

/** 构建用户消息 content：没有图片时保持 string，避免影响现有纯文本路径 */
export function buildUserContent(text: string, images?: UiImage[]): string | UserContentBlock[] {
  const safeImages = images?.filter((img) => img && img.dataUrl) ?? [];
  if (safeImages.length === 0) {
    return text;
  }

  const blocks: UserContentBlock[] = [];
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const img of safeImages) {
    const { mediaType, data } = parseDataUrl(img.dataUrl);
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType || mediaType,
        data,
      },
    });
  }
  return blocks;
}

/**
 * 从内部用户 content（string 或 content block 数组）中提取 UI 展示所需内容。
 * tool_result 等工具相关块不会显示在普通用户消息中。
 */
export function extractUserContent(content: string | unknown[]): { text: string; images: UiImage[] } {
  const images: UiImage[] = [];
  if (typeof content === 'string') {
    return { text: content, images };
  }
  if (!Array.isArray(content)) {
    return { text: String(content ?? ''), images };
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; image?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
      continue;
    }
    if (b.type === 'image') {
      const dataUrl = imageBlockToDataUrl(block);
      if (dataUrl) {
        const mediaType = parseDataUrl(dataUrl).mediaType;
        images.push({ dataUrl, mediaType });
      }
    }
  }
  return { text: textParts.join('\n'), images };
}

/** 判断 content 数组是否包含普通用户可见的图片（排除 tool_result 内的图片） */
export function hasUserVisibleImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const b = block as { type?: string };
    return b.type === 'image';
  });
}
