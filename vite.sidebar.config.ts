import { defineConfig } from 'vite';
import project from './project.config.cjs';

/**
 * 侧栏构建（Electron 原生 UI，独立于 webview）
 * 输出到 dist/sidebar，由主进程 WebContentsView 加载
 */
export default defineConfig({
  root: project.resolve('electron/sidebar'),
  base: './',
  publicDir: project.resolve('assets'),
  plugins: [
    {
      name: 'html-title',
      transformIndexHtml(html) {
        return html.replace(/<title>.*<\/title>/, `<title>${project.productName} Sidebar</title>`);
      },
    },
  ],
  build: {
    outDir: project.sidebarOut,
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: project.resolve('electron/sidebar', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
