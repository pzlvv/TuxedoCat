/**
 * 图片文件类型判定（宿主打开文件时共用）。
 *
 * 图片是二进制内容，不能按文本打开：
 * - VS Code: workspace.openTextDocument 会抛
 *   "File seems to be binary and cannot be opened as text"
 * - Electron: Monaco 按 utf-8 读取会显示乱码
 * 因此两个宿主都需要把它交给各自的默认图片预览打开。
 */

/** 图片扩展名（与 Read 工具支持的图片类型保持一致） */
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 判断路径是否为图片文件 */
export function isImageFile(filePath: string): boolean {
  return IMAGE_FILE_RE.test(filePath);
}
