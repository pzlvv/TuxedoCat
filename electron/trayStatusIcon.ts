/**
 * 托盘状态图标：在应用 Logo 的右下角叠加一个状态圆点。
 *
 * - idle    全部任务空闲          → 绿点
 * - running 有对话正在运行（非 idle） → 红点
 * - waiting 有对话在等待用户确认/提问 → 黄点
 *
 * 实现说明：
 * Electron 的 nativeImage 不提供图像合成 API，这里读取 Logo 的原始位图
 * （`toBitmap()`），直接在右下角绘制一个实心圆点（无描边），再用
 * `createFromBitmap()` 还原成 nativeImage。
 *
 * 注意 `toBitmap()` 的通道顺序是平台相关的（Windows 为 BGRA，其余平台多为
 * RGBA），因此这里用一张已知颜色（RGB = 200/100/50）的 1x1 PNG 探测实际
 * 顺序，避免把红/蓝通道写反导致绿点变蓝、红点变蓝等问题。
 */

import { nativeImage, type NativeImage } from 'electron';

export type TrayStatus = 'idle' | 'running' | 'waiting';

/** 状态圆点颜色（sRGB） */
const DOT_COLORS: Record<TrayStatus, readonly [number, number, number]> = {
  idle: [34, 197, 94], // green-500
  running: [239, 68, 68], // red-500
  waiting: [250, 204, 21], // yellow-400
};

/** 圆点几何参数，均以图标边长（像素）为基准 */
const DOT_RADIUS_RATIO = 0.19;
const DOT_MARGIN_RATIO = 0.02;

/** 1x1 不透明 PNG（RGB = 200/100/50），用于探测 toBitmap 的通道顺序 */
const CHANNEL_PROBE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4kWL0HwAFtAJeHzr7ywAAAABJRU5ErkJggg==';

/** 托盘图标提供 1x / 2x 两种分辨率，避免高 DPI 下模糊 */
const SMALL_SIZE = 16;
const LARGE_SIZE = 32;

/** 探测到的通道顺序：[R 索引, G 索引, B 索引]（alpha 固定为第 4 字节） */
let channelOrderCache: readonly [number, number, number] | null = null;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 探测 `toBitmap()` 返回位图的通道顺序。
 * 探测失败时回退到平台默认（Windows 为 BGRA，其余平台为 RGBA）。
 */
function detectChannelOrder(): readonly [number, number, number] {
  if (channelOrderCache) return channelOrderCache;
  let order: readonly [number, number, number] = process.platform === 'win32' ? [2, 1, 0] : [0, 1, 2];
  try {
    const bytes = nativeImage.createFromDataURL(CHANNEL_PROBE_DATA_URL).toBitmap();
    if (bytes.length >= 3) {
      const findIndex = (value: number): number => [0, 1, 2].find((i) => bytes[i] === value) ?? -1;
      const ri = findIndex(200);
      const gi = findIndex(100);
      const bi = findIndex(50);
      if (ri >= 0 && gi >= 0 && bi >= 0) {
        order = [ri, gi, bi];
      }
    }
  } catch {
    // 探测失败：使用平台默认顺序
  }
  channelOrderCache = order;
  return order;
}

/**
 * 以 src-over 方式把一个不透明颜色混合到目标像素上。
 * 位图为预乘 alpha（Electron/Skia 默认），因此直接按 `dst * (1 - a) + src * a` 混合。
 */
function blendPixel(
  buf: Buffer,
  offset: number,
  color: readonly [number, number, number],
  alpha: number,
  order: readonly [number, number, number],
): void {
  if (alpha <= 0) return;
  const inv = 1 - alpha;
  for (let c = 0; c < 3; c++) {
    const i = offset + order[c];
    buf[i] = Math.round(buf[i] * inv + color[c] * alpha);
  }
  const ai = offset + 3;
  buf[ai] = Math.round(buf[ai] * inv + 255 * alpha);
}

/**
 * 把 Logo 缩放到 size×size 并在右下角绘制状态圆点，返回原始 BGRA/RGBA 位图。
 * Logo 缺失或位图尺寸异常时返回 null（调用方回退到原始 Logo）。
 *
 * `alpha` 是整张图标的整体不透明度（0~1），用于闪烁：Logo 与状态圆点一起变化，
 * 传入 0 得到一张全透明位图（图标整体“熄灭”）。
 */
function renderStatusBitmap(
  base: NativeImage,
  size: number,
  status: TrayStatus,
  order: readonly [number, number, number],
  alpha = 1,
): Buffer | null {
  const resized = base.resize({ width: size, height: size, quality: 'best' });
  const bitmap = Buffer.from(resized.toBitmap());
  const expected = size * size * 4;
  if (bitmap.length < expected) return null;
  const buf = bitmap.length === expected ? bitmap : bitmap.subarray(0, expected);

  // 整体完全透明：清空所有通道即可（预乘 alpha 下等价于不可见）
  if (alpha <= 0) {
    buf.fill(0);
    return buf;
  }

  const radius = Math.max(2, size * DOT_RADIUS_RATIO);
  const margin = size * DOT_MARGIN_RATIO;
  // 圆点位于右下角
  const cx = size - margin - radius;
  const cy = size - margin - radius;
  const fillColor = DOT_COLORS[status];

  // 无描边：整个圆面都填充状态色（原描边区域同样显示该颜色）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 以像素中心计算距离，配合 +0.5 的覆盖率实现简单抗锯齿
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const coverage = clamp(radius + 0.5 - dist, 0, 1);
      if (coverage <= 0) continue;
      blendPixel(buf, (y * size + x) * 4, fillColor, coverage, order);
    }
  }

  // 位图为预乘 alpha，整体缩放四个通道即可得到统一的不透明度
  if (alpha < 1) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] * alpha);
  }
  return buf;
}

/**
 * 生成带状态圆点的托盘图标。
 * 同时提供 16px（1x）与 32px（2x）两种表示，供不同 DPI 的托盘使用。
 *
 * `options.alpha` 控制整张图标的不透明度（0~1），默认 1（完全显示）。
 * 传入 0 可得到全透明图标，配合定时器实现整个图标（Logo + 状态圆点）的闪烁效果。
 */
export function createTrayStatusIcon(
  status: TrayStatus,
  baseIconPath: string,
  options: { alpha?: number } = {},
): NativeImage {
  const alpha = clamp(options.alpha ?? 1, 0, 1);
  const base = nativeImage.createFromPath(baseIconPath);
  if (base.isEmpty()) return nativeImage.createEmpty();

  const order = detectChannelOrder();
  const large = renderStatusBitmap(base, LARGE_SIZE, status, order, alpha);
  if (!large) {
    // 兜底：无法读取位图时直接使用原始 Logo，不显示状态点
    return base.resize({ width: SMALL_SIZE, height: SMALL_SIZE });
  }

  const image = nativeImage.createFromBitmap(large, {
    width: LARGE_SIZE,
    height: LARGE_SIZE,
    scaleFactor: LARGE_SIZE / SMALL_SIZE,
  });
  const small = renderStatusBitmap(base, SMALL_SIZE, status, order, alpha);
  if (small) {
    image.addRepresentation({ scaleFactor: 1, width: SMALL_SIZE, height: SMALL_SIZE, buffer: small });
  }
  return image;
}

/**
 * 从会话运行时状态流聚合托盘状态：
 * waiting > running > idle。托盘是聚合状态，吃的是 SessionRuntimeState[] 全量推送，
 * 不从对话列表（磁盘元数据）推导（DEVELOPMENT.md 第 5.4 节规则 8）。
 * 会话是否「在跑」用 `idle === false` 判定（core 的 isIdle 语义）。
 */
export function deriveTrayStatusFromStates(states: ReadonlyArray<{ idle?: boolean; waiting?: boolean }>): TrayStatus {
  let running = false;
  for (const item of states) {
    if (item.waiting === true) return 'waiting';
    if (item.idle === false) running = true;
  }
  return running ? 'running' : 'idle';
}
