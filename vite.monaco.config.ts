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
      // 双入口：文本查看窗口（index.html）与 Markdown 预览窗口（markdown.html），
      // Monaco 依赖由 rollup 拆成共享 chunk，只打一份
      input: {
        main: project.resolve('electron/monaco', 'index.html'),
        markdown: project.resolve('electron/monaco', 'markdown.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
