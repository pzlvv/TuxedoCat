/**
 * 三个查看器窗口（Markdown 预览 / 图片查看器 / Monaco 查看，specs/018 刷新面）的
 * webPreferences 工厂：同一字段只有一处定义。
 *
 * 关键字段是 `backgroundThrottling: false`（缺陷 viewer-refresh-stalls-when-unfocused）：
 * 真实机器上窗口被遮挡 / 最小化后，Chromium 让渲染进程进入后台态——rAF 停摆、重绘
 * 被合成器压到窗口重新可见，Monaco 的 `model.setValue` 已落但视图停在旧内容，表现即
 * 「聚焦后才刷新」。文件监听与投递全在主进程、失焦期间照常工作，缺口只在渲染侧；
 * 主窗口子视图（侧栏 / 标题栏 / 聊天 webview）此前都因同类事故带上了该字段，三个
 * 查看器是仅有的缺失位点。specs/018 的自动刷新必须失焦期间照常落界面。
 */

import type { WebPreferences } from 'electron';
import * as path from 'path';

/** 查看器窗口种类：决定 preload 与 sandbox 取值 */
export type ViewerWindowKind = 'markdown' | 'image' | 'text';

export function viewerWindowWebPreferences(kind: ViewerWindowKind): WebPreferences {
  switch (kind) {
    case 'markdown':
      // 预览页是主进程生成的 data URL 静态页、无内联脚本，渲染器对内容零信任，
      // 沙箱保持开启；contextIsolation / nodeIntegration 原靠 Electron 默认值
      // （true / false），这里写显式，三窗口同一契约
      return {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'markdownPreload.cjs'),
        backgroundThrottling: false,
      };
    case 'image':
      return {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'imageViewerPreload.cjs'),
        backgroundThrottling: false,
      };
    case 'text':
      return {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'monacoPreload.cjs'),
        backgroundThrottling: false,
      };
  }
}
