/**
 * 唤醒快捷键设置对话框的 HTML（File - Shortcut...）
 *
 * 与 Spin 设计窗口同构：主进程把 HTML 作为 data URL 载入 BrowserWindow，
 * 页面只负责显示。按键捕获在主进程的 before-input-event 里做（复用
 * src/core/utils/shortcut.ts），页面里不重复实现一遍快捷键解析。
 *
 * 页面通过 preload 暴露的 window.shortcutAPI 与主进程通信：
 *   getState()   取当前显示值
 *   save()       保存并关闭
 *   cancel()     取消并关闭
 *   onShortcut() 订阅主进程推来的显示状态
 */

export interface ShortcutDialogHtmlOptions {
  isDark: boolean;
  locale: 'zh' | 'en';
}

export function getShortcutDialogHtml(options: ShortcutDialogHtmlOptions): string {
  const zh = options.locale === 'zh';
  const title = zh ? '唤醒快捷键' : 'Wake Shortcut';
  const hint = zh
    ? '按下新的组合键。Esc 取消，Enter 保存。'
    : 'Press the new key combination. Esc to cancel, Enter to save.';
  const saveLabel = zh ? '保存' : 'Save';
  const cancelLabel = zh ? '取消' : 'Cancel';

  const bg = options.isDark ? '#1a1a1f' : '#ffffff';
  const fg = options.isDark ? '#e5e5ea' : '#1f1f24';
  const muted = options.isDark ? '#9a9aa5' : '#6b6b76';
  const border = options.isDark ? '#3a3a44' : '#d8d8de';
  const boxBg = options.isDark ? '#24242b' : '#f5f5f7';
  const accent = '#7c5cff';
  const danger = '#ef4444';

  return `<!DOCTYPE html>
<html lang="${zh ? 'zh' : 'en'}">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
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
    padding: 18px;
    gap: 10px;
    user-select: none;
  }
  .title { font-size: 14px; font-weight: 600; }
  .hint { color: ${muted}; font-size: 12px; line-height: 1.5; }
  .key {
    margin-top: 4px;
    padding: 14px;
    border: 1px solid ${border};
    border-radius: 8px;
    background: ${boxBg};
    text-align: center;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.5px;
    min-height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .error { color: ${danger}; font-size: 12px; min-height: 16px; }
  .actions { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit;
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid ${border};
    background: transparent;
    color: ${fg};
    cursor: pointer;
  }
  button:hover { border-color: ${accent}; }
  button.primary { background: ${accent}; border-color: ${accent}; color: #ffffff; }
</style>
</head>
<body>
  <div class="title">${title}</div>
  <div class="hint">${hint}</div>
  <div class="key" id="key">-</div>
  <div class="error" id="error"></div>
  <div class="actions">
    <button id="cancel" type="button">${cancelLabel}</button>
    <button id="save" class="primary" type="button">${saveLabel}</button>
  </div>
<script>
  var keyEl = document.getElementById('key');
  var errorEl = document.getElementById('error');

  function render(state) {
    if (!state) return;
    if (state.display) keyEl.textContent = state.display;
    errorEl.textContent = state.error || '';
  }

  window.shortcutAPI.onShortcut(render);
  window.shortcutAPI.getState().then(render);

  document.getElementById('save').addEventListener('click', function () {
    window.shortcutAPI.save();
  });
  document.getElementById('cancel').addEventListener('click', function () {
    window.shortcutAPI.cancel();
  });
</script>
</body>
</html>`;
}
