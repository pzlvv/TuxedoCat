/**
 * 查看器窗口（Monaco 文本查看 + Markdown 预览同一页面工程 / 图片查看器）的
 * webPreferences 工厂：同一字段只有一处定义。
 *
 * Markdown 预览窗口加载 `dist/monaco/markdown.html`（与文本查看器同一 vite 工程
 * 多入口、同一 monacoPreload 桥），webPreferences 与 `text` 完全同一形态，不设
 * 独立 kind；渲染内容的安全不靠窗口沙箱，靠生成侧净化（`src/host/markdownHtml.ts`）
 * 加页面 CSP 拦内联脚本（`electron/monaco/markdown.html`）。
 *
 * 关键字段是 `backgroundThrottling: false`（缺陷 viewer-refresh-stalls-when-unfocused）：
 * 真实机器上窗口被遮挡 / 最小化后，Chromium 让渲染进程进入后台态——rAF 停摆、重绘
 * 被合成器压到窗口重新可见，Monaco 的 `model.setValue` 已落但视图停在旧内容，表现即
 * 「聚焦后才刷新」。文件监听与投递全在主进程、失焦期间照常工作，缺口只在渲染侧；
 * 主窗口子视图（侧栏 / 标题栏 / 聊天 webview）此前都因同类事故带上了该字段，查看器
 * 是仅有的缺失位点。specs/018 的自动刷新必须失焦期间照常落界面。
 */

import type { WebPreferences } from 'electron';
import * as path from 'path';

/** 查看器窗口种类：决定 preload 与 sandbox 取值 */
export type ViewerWindowKind = 'image' | 'text';

export function viewerWindowWebPreferences(kind: ViewerWindowKind): WebPreferences {
  switch (kind) {
    case 'image':
      return {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'imageViewerPreload.cjs'),
        backgroundThrottling: false,
      };
    case 'text':
      // Markdown 预览窗口（markdown.html）与 Monaco 查看窗口共用
      return {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'monacoPreload.cjs'),
        backgroundThrottling: false,
      };
  }
}
