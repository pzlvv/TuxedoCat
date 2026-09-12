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
          // Vite 的虚拟模块必须单独成 chunk（而不是让它被 Rollup 提升）。
          // 原因：shiki chunk 内部也有动态导入（按需加载语法/主题），会共用
          // __vitePreload helper；Rollup 于是把 helper 提升进 shiki chunk，
          // 入口再静态 import 这个 helper，结果把整个 9.2MB 的 shiki 又拉回
          // 启动关键路径（实测 index.js 首行出现 `import{_ as uo}from"./shiki-*.js"`）。
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vite-runtime';
          }
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
