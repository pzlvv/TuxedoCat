/**
 * Electron preload - Markdown 预览窗口专用（specs/018 FR-004）。
 *
 * Markdown 预览页是主进程生成的静态 data URL，没有内联脚本。刷新只替换
 * `.markdown-body` 的 innerHTML，并恢复滚动位置；标题消息用于「文件已删除 /
 * 读取失败 / 自动刷新不可用」标记。
 *
 * 本 preload 只使用 `ipcRenderer` 与 DOM，不向页面暴露任何 Node 能力；窗口保持
 * `sandbox: true`，内容仍在生成侧净化。
 */

import { ipcRenderer } from 'electron';

function withArticle(run: (article: Element) => void): void {
  const execute = (): void => {
    const article = document.querySelector('.markdown-body');
    if (article) run(article);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', execute, { once: true });
  } else {
    execute();
  }
}

ipcRenderer.on('markdown-refresh', (_event, data: { bodyHtml?: unknown }) => {
  if (typeof data?.bodyHtml !== 'string') return;
  withArticle((article) => {
    const scrolling = document.scrollingElement;
    const scrollTop = scrolling?.scrollTop ?? window.scrollY;
    article.innerHTML = data.bodyHtml as string;
    if (scrolling) scrolling.scrollTop = scrollTop;
    else window.scrollTo(0, scrollTop);
  });
});

ipcRenderer.on('viewer-title', (_event, data: { title?: unknown }) => {
  if (typeof data?.title === 'string' && data.title) document.title = data.title;
});
