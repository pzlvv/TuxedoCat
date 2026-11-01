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

import { surrogateSafeHeadEnd } from './stringUtils.js';

export interface UiImage {
  /** 完整的 data URL，例如 data:image/png;base64,xxxx */
  dataUrl: string;
  /** media type，可从 dataUrl 解析；缺省时使用 image/png */
  mediaType?: string;
  /** 图片实际像素宽度（用于图片消息标题等） */
  width?: number;
  /** 图片实际像素高度（用于图片消息标题等） */
  height?: number;
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

/**
 * 对话标题的最大长度（UTF-16 code unit）。
 *
 * 与 Core 的 `history::derive_title`（`util::utf16_take(text, 50)`）同一个数：
 * 两处都是「首条用户消息的前 50 个 code unit」，漂移会让同一条消息在宿主侧与
 * Core 侧得到不同标题。
 */
const TITLE_MAX_CHARS = 50;

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

/**
 * 从用户输入文本和图片信息中生成对话标题。
 * - 图片 + 文本：使用文本作为标题（与纯文本规则一致）。
 * - 仅图片：优先使用第一张图片的实际宽高生成 `Image[<width>*<height>]`；
 *   宽高缺失时退化为 `Image`。
 *
 * 文本截断走 `surrogateSafeHeadEnd`（不是裸 `substring`）：第 50 个 UTF-16 code unit
 * 落在代理对中间时会切出孤立代理项，`JSON.stringify` 写出语义非法的 `"\ud83d"`，
 * 落盘与帧通道两侧各自修一遍、显示值还会出现 U+FFFD。Core 的
 * `history::derive_title` 用 `util::utf16_take`（放不下就停），这里与之同口径
 * （`docs/architecture/principles.md` 第 8 节：同一派生只有一份口径）。
 */
export function buildConversationTitle(text: string, images?: UiImage[]): string {
  const trimmedText = (text || '').trim();
  if (trimmedText) {
    return trimmedText.slice(0, surrogateSafeHeadEnd(trimmedText, TITLE_MAX_CHARS));
  }

  const firstImage = (images ?? []).find(
    (img) => img && img.dataUrl && img.width && img.height,
  );
  if (firstImage?.width && firstImage?.height) {
    return `Image[${firstImage.width}*${firstImage.height}]`;
  }

  if ((images ?? []).some((img) => img && img.dataUrl)) {
    return 'Image';
  }

  return '';
}
