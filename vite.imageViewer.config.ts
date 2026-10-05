import { defineConfig } from 'vite';
import project from './project.config.cjs';

/**
 * 图片查看器窗口构建（Electron 特有，独立于 webview）
 * 输出到 dist/imageViewer，由 ElectronUIHost.openImagePreviewWindow 加载
 */
export default defineConfig({
  root: project.resolve('electron/imageViewer'),
  base: './',
  plugins: [
    {
      name: 'html-title',
      transformIndexHtml(html) {
        return html.replace(/<title>.*<\/title>/, `<title>${project.productName} Image Viewer</title>`);
      },
    },
  ],
  build: {
    outDir: project.imageViewerOut,
    emptyOutDir: true,
    rollupOptions: {
      input: project.resolve('electron/imageViewer', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
