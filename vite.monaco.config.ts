import { defineConfig } from 'vite';
import project from './project.config.cjs';

/**
 * Monaco 编辑器窗口构建（Electron 特有，独立于 webview）
 * 输出到 dist/monaco，由 ElectronUI 加载
 */
export default defineConfig({
  root: project.resolve('electron/monaco'),
  base: './',
  plugins: [
    {
      name: 'html-title',
      transformIndexHtml(html) {
        return html.replace(/<title>.*<\/title>/, `<title>${project.productName} Editor</title>`);
      },
    },
  ],
  build: {
    outDir: project.monacoOut,
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: project.resolve('electron/monaco', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
