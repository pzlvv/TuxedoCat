import { defineConfig } from 'vite';
import project from './project.config.cjs';

/**
 * 「打开远程工作区」窗口的页面构建（Electron 原生 UI，独立于 webview）
 * 输出到 dist/remoteWorkspace，由主进程 BrowserWindow 加载
 */
export default defineConfig({
  root: project.resolve('electron/remoteWorkspace'),
  base: './',
  plugins: [
    {
      name: 'html-title',
      transformIndexHtml(html) {
        return html.replace(
          /<title>.*<\/title>/,
          `<title>${project.productName} Remote Workspace</title>`,
        );
      },
    },
  ],
  build: {
    outDir: project.remoteWorkspaceOut,
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: project.resolve('electron/remoteWorkspace', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
