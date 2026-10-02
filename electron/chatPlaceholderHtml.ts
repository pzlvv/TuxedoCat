/**
 * 聊天区占位页 HTML（electron 生成，data URL 装载，与 shortcutDialogHtml 同模式）
 *
 * 活动工作区建链中 / 不可用时替代对话视图：
 * - connecting：黄色呼吸点 + 「正在连接」（启动恢复的远程项 / 点击重连期间）；
 * - dirMissing：「目录不存在」+ 展示路径（本地目录 / 远程目录已不存在）；
 * - remoteUnreachable：「无法连接远程主机」+ 展示路径 + 「重新连接」按钮
 *   （经 chatPlaceholderPreload 的 IPC 通知主进程重试建链）。
 *
 * 主题由 nativeTheme.themeSource 驱动 prefers-color-scheme，两种配色都写在页面里，
 * 主题切换不需要重载。
 */

import { tt } from '../src/host/i18n.js';

export type ChatPlaceholderKind = 'connecting' | 'dirMissing' | 'remoteUnreachable';

export interface ChatPlaceholderPayload {
  kind: ChatPlaceholderKind;
  /** 展示路径（远程带 scheme://host 前缀） */
  path: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ICON_FOLDER_MISSING = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6h7a2 2 0 0 1 2 2v3.5"/><path d="M17 14l4 4M21 14l-4 4"/></svg>`;
const ICON_REMOTE_UNREACHABLE = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 15.2A4 4 0 0 1 6 7.5a5.5 5.5 0 0 1 10.7-1.6A4.5 4.5 0 0 1 19.5 15"/><path d="M12 11v5"/><path d="M12 19.5h.01"/></svg>`;

export function getChatPlaceholderHtml(payload: ChatPlaceholderPayload): string {
  const title =
    payload.kind === 'connecting'
      ? tt('正在连接', 'Connecting')
      : payload.kind === 'dirMissing'
        ? tt('目录不存在', 'Folder not found')
        : tt('无法连接远程主机', 'Cannot reach remote host');
  const icon =
    payload.kind === 'dirMissing'
      ? ICON_FOLDER_MISSING
      : payload.kind === 'remoteUnreachable'
        ? ICON_REMOTE_UNREACHABLE
        : '';
  const pathLine = payload.path
    ? `<div class="path" title="${escapeHtml(payload.path)}">${escapeHtml(payload.path)}</div>`
    : '';
  const reconnect =
    payload.kind === 'remoteUnreachable'
      ? `<button type="button" id="reconnectBtn" class="btn">${escapeHtml(tt('重新连接', 'Reconnect'))}</button>`
      : '';
  const connectingDot =
    payload.kind === 'connecting'
      ? '<div class="connecting-dot" aria-hidden="true"></div>'
      : '';
  const script =
    payload.kind === 'remoteUnreachable'
      ? `<script>
          document.getElementById('reconnectBtn').addEventListener('click', function () {
            window.chatPlaceholderAPI && window.chatPlaceholderAPI.reconnectWorkspace();
          });
        </script>`
      : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    background: #16161b;
    color: #c1c1c6;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 78%; text-align: center; }
  .icon { color: #71717a; margin-bottom: 2px; }
  .title { font-size: 14px; font-weight: 600; color: #d4d4d8; }
  .path {
    font-size: 12px;
    color: #71717a;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, Consolas, monospace;
  }
  /* 建链中：黄色呼吸点（与标题栏标签页 loading 同一动效语言） */
  .connecting-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #facc15;
    animation: breathing 1.6s ease-in-out infinite;
    margin: 6px 0;
  }
  @keyframes breathing {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
  .btn {
    appearance: none;
    border: none;
    background: #6366f1;
    color: #ffffff;
    font-family: inherit;
    font-size: 12.5px;
    padding: 7px 18px;
    border-radius: 6px;
    cursor: pointer;
    margin-top: 6px;
  }
  .btn:hover { background: #5458ee; }
  @media (prefers-color-scheme: light) {
    body { background: #e4e4e7; color: #3f3f46; }
    .title { color: #27272a; }
    .icon { color: #a1a1aa; }
    .path { color: #71717a; }
  }
</style>
</head>
<body>
  <div class="wrap">
    ${connectingDot}
    ${icon ? `<div class="icon">${icon}</div>` : ''}
    <div class="title">${escapeHtml(title)}</div>
    ${pathLine}
    ${reconnect}
  </div>
  ${script}
</body>
</html>`;
}
