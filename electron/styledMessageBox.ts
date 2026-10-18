/**
 * 自绘消息框：替代 Windows 原生 `dialog.showMessageBox` 的确认 / 提示类对话框
 * （关闭确认、关于、删除确认、主机密钥变更等）。
 *
 * 为什么自绘：主窗口是无边框深浅双主题的自绘 UI，原生消息框（系统标题栏 + 系统
 * 字体）与应用观感割裂。这里用与应用同一套配色（#1a1a1f / #6366f1，见
 * electron/sidebar/styles.css、electron/titlebar/styles.css）画一个小窗口，与偏好
 * 设置窗口（preferenceDialogHtml.ts）同构：主进程把 HTML 作为 data URL 载入
 * 无边框 BrowserWindow，页面只负责显示。
 *
 * 页面回传不配 preload：按钮点击 / 键盘 Enter / Esc 在页面里改写 document.title
 * （`tcmsg-result-<下标>`），主进程经 page-title-updated 事件收回下标——单向、
 * 无权限面。页面标题本身保持固定（MESSAGE_BOX_PAGE_TITLE），e2e 靠它在
 * app.windows() 里认出消息框页面。
 */

import { BrowserWindow, nativeTheme } from 'electron';

/** 消息框选项：原生 showMessageBox 在用字段子集；按钮文案由调用方先本地化好 */
export interface StyledMessageBoxOptions {
  /** info = 信息图标（indigo），warning = 警告图标（琥珀） */
  type: 'info' | 'warning';
  message: string;
  detail?: string;
  buttons: string[];
  /** 回车触发的按钮下标（该按钮按主按钮样式渲染） */
  defaultId: number;
  /** Esc 触发的按钮下标 */
  cancelId: number;
}

/** 页面标题标记（也即窗口标题）：e2e 在 app.windows() 里按它认出消息框 */
export const MESSAGE_BOX_PAGE_TITLE = 'tc-message-box';

/** 回传协议：页面把标题改写成该前缀 + 按钮下标 */
const RESULT_TITLE_PREFIX = 'tcmsg-result-';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getStyledMessageBoxHtml(options: StyledMessageBoxOptions): string {
  const isDark = nativeTheme.shouldUseDarkColors;
  const bg = isDark ? '#1a1a1f' : '#ffffff';
  const fg = isDark ? '#e5e5ea' : '#1f1f24';
  const muted = isDark ? '#9a9aa5' : '#6b6b76';
  const border = isDark ? '#3a3a44' : '#d8d8de';
  const accent = '#6366f1';
  const warn = '#f59e0b';

  const icon = options.type === 'warning'
    ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${warn}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`
    : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;

  const buttons = options.buttons
    .map((label, index) => `<button type="button" data-index="${index}"${index === options.defaultId ? ' class="primary"' : ''}>${escapeHtml(label)}</button>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<title>${MESSAGE_BOX_PAGE_TITLE}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: ${bg};
    color: ${fg};
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    padding: 20px 22px;
    gap: 14px;
    user-select: none;
  }
  .body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .head { display: flex; align-items: flex-start; gap: 10px; }
  .icon { flex-shrink: 0; margin-top: 1px; display: flex; }
  .message { font-size: 14px; font-weight: 600; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .detail { color: ${muted}; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit;
    padding: 6px 18px;
    border-radius: 6px;
    border: 1px solid ${border};
    background: transparent;
    color: ${fg};
    cursor: pointer;
  }
  button:hover { border-color: ${accent}; }
  button.primary { background: ${accent}; border-color: ${accent}; color: #ffffff; }
  button.primary:hover { filter: brightness(1.1); }
</style>
</head>
<body>
  <div class="body">
    <div class="head">
      <span class="icon">${icon}</span>
      <div class="message">${escapeHtml(options.message)}</div>
    </div>
    ${options.detail ? `<div class="detail">${escapeHtml(options.detail)}</div>` : ''}
  </div>
  <div class="actions">${buttons}</div>
<script>
  function pick(index) {
    document.title = '${RESULT_TITLE_PREFIX}' + index;
  }
  var defaultIndex = ${options.defaultId};
  var cancelIndex = ${options.cancelId};
  var buttons = document.querySelectorAll('button[data-index]');
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      pick(Number(button.getAttribute('data-index')));
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); pick(defaultIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); pick(cancelIndex); }
  });
</script>
</body>
</html>`;
}

/**
 * 弹出自绘消息框并等待用户选择，resolve 值 = 按钮下标（与原生 showMessageBox 的
 * `response` 同义）。窗口被外部关闭（无按钮可点的路径不存在，防御）按 cancelId 结算。
 */
export async function showStyledMessageBox(
  parent: BrowserWindow | null,
  options: StyledMessageBoxOptions,
): Promise<number> {
  const width = 460;
  const height = 240;
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const win = new BrowserWindow({
    width,
    height,
    ...(parentBounds
      ? {
          x: parentBounds.x + Math.round((parentBounds.width - width) / 2),
          y: parentBounds.y + Math.round((parentBounds.height - height) / 2),
        }
      : {}),
    ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    title: MESSAGE_BOX_PAGE_TITLE,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (index: number): void => {
      if (settled) return;
      settled = true;
      resolve(index);
      if (!win.isDestroyed()) win.close();
    };
    // 页面回传：preventDefault 让窗口标题停在标记值上（e2e 靠标题认窗口）
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      const match = new RegExp(`^${RESULT_TITLE_PREFIX}(\\d+)$`).exec(title);
      if (match) settle(Number(match[1]));
    });
    win.on('closed', () => settle(options.cancelId));
    win.once('ready-to-show', () => win.show());
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getStyledMessageBoxHtml(options))}`);
  });
}
