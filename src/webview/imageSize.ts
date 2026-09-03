/**
 * 读取 data URL 图片的实际像素宽高。
 * 仅用于 webview 渲染进程（依赖浏览器 Image 对象）。
 */
export function getImageSize(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => reject(new Error('Failed to load image for size detection'));
    img.src = dataUrl;
  });
}

/** 确保图片对象包含 width/height；读取失败时原样返回。 */
export async function ensureImageSize<T extends { dataUrl: string; width?: number; height?: number }>(
  image: T,
): Promise<T & { width?: number; height?: number }> {
  if (image.width && image.height) return image;
  try {
    const { width, height } = await getImageSize(image.dataUrl);
    return { ...image, width, height };
  } catch {
    return image;
  }
}
