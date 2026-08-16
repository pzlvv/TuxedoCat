import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import project from './project.config.cjs';

export default defineConfig({
  plugins: [react()],
  root: project.resolve('src/webview'),
  base: './',
  build: {
    outDir: project.webviewOut,
    emptyOutDir: true,
    chunkSizeWarningLimit: 12000,
    rollupOptions: {
      input: project.resolve('src/webview', 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
        manualChunks(id) {
          // Shiki 的 languages/themes 动态导入会产生大量小 chunk，
          // 统一归入一个 chunk，避免 VSIX 内 JS 文件数过多触发 vsce 警告。
          if (id.includes('node_modules/shiki') || id.includes('node_modules/@shikijs')) {
            return 'shiki';
          }
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design') || id.includes('node_modules/rc-')) {
            return 'antd';
          }
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/remark-gfm') ||
            id.includes('node_modules/github-markdown-css') ||
            id.includes('node_modules/remark-math') ||
            id.includes('node_modules/rehype-')
          ) {
            return 'markdown';
          }
        },
      },
    },
  },
});
