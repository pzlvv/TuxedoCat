/**
 * 聊天区占位页 HTML（electron 生成，data URL 装载，与 preferenceDialogHtml 同模式）
 *
 * 活动工作区建链中 / 不可用时替代对话视图：
 * - connecting：黄色呼吸点 + 「正在连接」（启动恢复的远程项 / 点击重连期间）；
 * - dirMissing：「目录不存在」+ 展示路径（本地目录 / 远程目录已不存在）；
 * - remoteUnreachable：「无法连接远程主机」+ 展示路径 + 原因 + 「重新连接」按钮
 *   （经 chatPlaceholderPreload 的 IPC 通知主进程重试建链）。原因里「主机密钥
 *   已变更」是安全敏感形态，单独引导用户走「重新连接 → 比对指纹 → 确认」流程，
 *   其余原因直接展示原始错误。
 *
 * 主题由 nativeTheme.themeSource 驱动 prefers-color-scheme，两种配色都写在页面里，
 * 主题切换不需要重载。
 */

import { tt } from '../src/host/i18n.js';

export type ChatPlaceholderKind =
  | 'connecting'
  | 'dirMissing'
  | 'remoteUnreachable'
  /** 跨工作区子代理的占位父对话（specs/022 FR-004）：不可作为普通对话打开 */
  | 'crossWorkspaceAgent';

/** 不可用原因（判别联合）：指纹变更有专属引导文案，其余原因展示原始错误详情 */
export type ChatPlaceholderReason =
  | { kind: 'hostKeyChanged'; expectedFingerprint: string; observedFingerprint: string }
  | { kind: 'generic'; detail: string };

export interface ChatPlaceholderPayload {
  kind: ChatPlaceholderKind;
  /** 展示路径（远程带 scheme://host 前缀） */
  path: string;
  /** 不可用原因；建链中 / 目录缺失 / 原因未知时为 null */
  reason: ChatPlaceholderReason | null;
  /**
   * 跨工作区占位页的跳转目标（specs/022 FR-005）；其它 kind 为 null。
   * `null` 表示发起方工作区已关闭、链接不可用（页面展示原因，不给按钮）。
   */
  jump: { workspaceId: string; sessionId: string; title: string } | null;
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
        : payload.kind === 'crossWorkspaceAgent'
          ? tt('跨工作区子代理容器', 'Cross-workspace agent container')
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
  /** 原因区：指纹变更走专属引导（点击重连后主进程弹比对告警），其余展示原始错误 */
  const reasonHtml = (() => {
    if (payload.kind !== 'remoteUnreachable' || !payload.reason) return '';
    if (payload.reason.kind === 'hostKeyChanged') {
      return `<div class="reason">
        <div class="reason-title">${escapeHtml(tt('SSH 主机密钥与首次连接的记录不一致', 'SSH host key differs from the one recorded on first connect'))}</div>
        <div class="fp">${escapeHtml(tt('记录的指纹', 'Recorded'))}: ${escapeHtml(payload.reason.expectedFingerprint)}</div>
        <div class="fp">${escapeHtml(tt('当前的指纹', 'Observed'))}: ${escapeHtml(payload.reason.observedFingerprint)}</div>
        <div class="reason-hint">${escapeHtml(tt('点击「重新连接」，确认后重建信任', 'Click "Reconnect" and confirm to trust it again'))}</div>
      </div>`;
    }
    return `<div class="reason-detail" title="${escapeHtml(payload.reason.detail)}">${escapeHtml(payload.reason.detail)}</div>`;
  })();
  const reconnect =
    payload.kind === 'remoteUnreachable'
      ? `<button type="button" id="reconnectBtn" class="btn">${escapeHtml(tt('重新连接', 'Reconnect'))}</button>`
      : '';
  const jump =
    payload.kind === 'crossWorkspaceAgent' && payload.jump
      ? `<button type="button" id="jumpBtn" class="btn">${escapeHtml(tt('跳转到发起方对话', 'Open the initiating conversation'))}</button>`
      : '';
  const jumpHint =
    payload.kind === 'crossWorkspaceAgent' && !payload.jump
      ? `<div class="reason-hint">${escapeHtml(tt('发起方工作区未打开，跳转链接不可用', 'The initiating workspace is closed; the link is unavailable'))}</div>`
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
      : payload.kind === 'crossWorkspaceAgent' && payload.jump
        ? `<script>
            document.getElementById('jumpBtn').addEventListener('click', function () {
              window.chatPlaceholderAPI && window.chatPlaceholderAPI.jumpToOrigin();
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
  /* 不可用原因：指纹变更是安全敏感形态，用醒目一点的语气与等宽指纹行 */
  .reason {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
    max-width: 100%;
  }
  .reason-title { font-size: 12.5px; color: #fbbf24; }
  .fp {
    font-size: 11.5px;
    color: #71717a;
    word-break: break-all;
    font-family: ui-monospace, Consolas, monospace;
  }
  .reason-hint { font-size: 12px; color: #a1a1aa; margin-top: 2px; }
  .reason-detail {
    font-size: 12px;
    color: #71717a;
    max-width: 100%;
    max-height: 4.5em;
    overflow: hidden;
    text-overflow: ellipsis;
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
    .reason-title { color: #b45309; }
    .fp { color: #71717a; }
    .reason-hint { color: #52525b; }
    .reason-detail { color: #71717a; }
  }
</style>
</head>
<body>
  <div class="wrap">
    ${connectingDot}
    ${icon ? `<div class="icon">${icon}</div>` : ''}
    <div class="title">${escapeHtml(title)}</div>
    ${pathLine}
    ${reasonHtml}
    ${jumpHint}
    ${reconnect}
    ${jump}
  </div>
  ${script}
</body>
</html>`;
}
