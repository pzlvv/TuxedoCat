/**
 * 内置图片查看器窗口入口（US-38 图片预览、US-42 双击打开图片）。
 *
 * 由 ElectronUIHost 打开：主进程读出文件字节构造成 data URL，经 preload 桥接
 * （`imageviewer-init` → window message）送进来。此前图片预览是把 file:// URL 直接
 * 交给 Chromium 渲染，没有滚轮缩放；这里自建 <img> 页面：
 * - 打开时「适配窗口」（不超过原图尺寸，避免小图被拉糊）；
 * - 滚轮以光标为锚点缩放（不按 Ctrl，滚轮就是缩放——窗口里没有别的滚动语义）；
 * - 放大超过窗口后可按住拖动平移；双击恢复适配。
 */

interface ImageViewerInit {
  title?: string;
  dataUrl: string;
}

const stage = document.getElementById('stage')!;
const image = document.getElementById('image') as HTMLImageElement;
const badge = document.getElementById('badge')!;

/** 当前缩放倍率：1 = 原始像素尺寸 */
let scale = 1;
/** 适配窗口的初始倍率（双击恢复的目标值） */
let fitScale = 1;
/** 相对窗口中心的平移量（缩放 / 平移都改它，transform 统一应用） */
let offsetX = 0;
let offsetY = 0;
/** 拖动平移进行中 */
let panning = false;
let panStartX = 0;
let panStartY = 0;
let panOffsetX = 0;
let panOffsetY = 0;
/** 缩放角标淡出计时器 */
let badgeTimer: number | null = null;

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
/** 滚轮每档的缩放步长（乘性：任意倍率下手感一致） */
const WHEEL_STEP = 1.1;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function render(): void {
  image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  // 可拖动只在放大到超出窗口后出现（缩小的图没有可平移的余量）
  const zoomable = scale > fitScale;
  image.classList.toggle('pannable', zoomable && !panning);
  image.classList.toggle('panning', panning);
}

function showBadge(): void {
  badge.textContent = `${Math.round(scale * 100)}%`;
  badge.classList.add('visible');
  if (badgeTimer !== null) window.clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => badge.classList.remove('visible'), 1200);
}

/** 以窗口内某点为锚缩放：让该点下的图像内容在缩放后仍停在原屏幕位置 */
function zoomAt(clientX: number, clientY: number, nextScale: number): void {
  const clamped = clampScale(nextScale);
  if (clamped === scale) return;
  const rect = image.getBoundingClientRect();
  // 光标相对图像中心的偏移（缩放前）
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const ratio = clamped / scale;
  // 保持光标点不动：中心平移量按缩放比例补偿
  offsetX = offsetX + dx - dx * ratio;
  offsetY = offsetY + dy - dy * ratio;
  scale = clamped;
  // 缩回到窗口内后把平移余量清零，避免图飘在一角回不来
  if (scale <= fitScale) {
    offsetX = 0;
    offsetY = 0;
  }
  render();
  showBadge();
}

function fitToWindow(): void {
  const natural = image.naturalWidth || 1;
  const naturalH = image.naturalHeight || 1;
  // 适配 = 恰好装进窗口；原图比窗口小就按 100%（放大没有信息增益，只会拉糊）
  const fit = Math.min(1, (stage.clientWidth - 24) / natural, (stage.clientHeight - 24) / naturalH);
  fitScale = clampScale(fit);
  scale = fitScale;
  offsetX = 0;
  offsetY = 0;
  render();
  showBadge();
}

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP));
}, { passive: false });

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || scale <= fitScale) return;
  panning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panOffsetX = offsetX;
  panOffsetY = offsetY;
  stage.setPointerCapture(e.pointerId);
  render();
});
stage.addEventListener('pointermove', (e) => {
  if (!panning) return;
  offsetX = panOffsetX + (e.clientX - panStartX);
  offsetY = panOffsetY + (e.clientY - panStartY);
  render();
});
const endPan = (e: PointerEvent): void => {
  if (!panning) return;
  panning = false;
  try { stage.releasePointerCapture(e.pointerId); } catch { /* 已释放则忽略 */ }
  render();
};
stage.addEventListener('pointerup', endPan);
stage.addEventListener('pointercancel', endPan);

// 双击在「适配」与「100%」之间切换（看细节 / 回览全图的两档常用位）
stage.addEventListener('dblclick', () => {
  if (scale !== 1) zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1);
  else fitToWindow();
});

window.addEventListener('resize', fitToWindow);

// 接收 main 进程初始化数据（经 preload 桥接为 window message）
window.addEventListener('message', (event) => {
  const data = event.data as ImageViewerInit;
  if (!data || typeof data.dataUrl !== 'string') return;
  image.onload = fitToWindow;
  image.src = data.dataUrl;
});
