import { defineConfig } from 'vite';
import project from './project.config.cjs';

/**
 * 远程终端窗口的页面构建（Electron 原生 UI，独立于 webview；specs/022）。
 * 输出到 dist/terminal，由主进程 BrowserWindow 加载；渲染端依赖 @xterm/xterm +
 * @xterm/addon-fit（终端仿真在渲染端，通道与状态在主进程）。
 */
export default defineConfig({
  root: project.resolve('electron/terminal'),
  base: './',
  // 品牌 logo（连接中的加载动画用）：与 titlebar / sidebar 同一管线，拷进产物根目录
  publicDir: project.resolve('assets'),
  plugins: [
    {
      name: 'html-title',
      transformIndexHtml(html) {
        return html.replace(
          /<title>.*<\/title>/,
          `<title>${project.productName} Terminal</title>`,
        );
      },
    },
  ],
  build: {
    outDir: project.terminalOut,
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: project.resolve('electron/terminal', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
