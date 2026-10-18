/**
 * 偏好设置窗口的 HTML（菜单「偏好设置...」）。
 *
 * 与自绘消息框（`electron/styledMessageBox.ts`）/ Spin 设计窗口同构：主进程把 HTML
 * 作为 data URL 载入 BrowserWindow，页面只负责显示。这里承载三块宿主本地偏好：
 * - 主题：跟随系统 / 浅色 / 深色（单选，立即生效）
 * - 提示音：是否播放 + 音量（勾选后才显示音量条；拖完预览播放一次）
 * - 唤醒快捷键：点击后按键捕获（捕获在主进程的 before-input-event 里做，
 *   复用 electron/shortcut.ts，页面里不重复实现一遍快捷键解析）
 *
 * 配色走 `prefers-color-scheme`（`nativeTheme.themeSource` 驱动），不把深浅色烘进
 * 内联样式——用户在窗口里切换主题时，窗口自己跟着变，不需要关掉重开。
 *
 * 页面通过 preload 暴露的 window.preferenceAPI 与主进程通信：
 *   getState()           取当前状态（主题 / 快捷键显示值 / 提示音开关与音量）
 *   setTheme(mode)       切换主题（立即生效）
 *   setSoundEnabled(on)  开关提示音（打开时预览播放一次）
 *   setSoundVolume(v)    保存音量（0–1）并预览播放一次
 *   captureShortcut()    开始录制唤醒快捷键（点击快捷键字段时调用）
 *   close()              关闭窗口
 *   onState(cb)          订阅主进程推来的状态
 */

/** 偏好设置窗口页面的状态（主进程 → 页面） */
export interface PreferenceDialogState {
  theme: 'system' | 'light' | 'dark';
  /** 当前唤醒快捷键的显示形式（如 Ctrl+Alt+X） */
  shortcutDisplay: string;
  /** 是否正在录制新快捷键（录制中页面显示提示文案） */
  shortcutCapturing: boolean;
  /** 录制校验失败的原因（无错误时为 undefined） */
  shortcutError?: string;
  /** 是否播放任务结束提醒音 */
  soundEnabled: boolean;
  /** 提示音音量（0–1） */
  soundVolume: number;
}

export interface PreferenceDialogHtmlOptions {
  locale: 'zh' | 'en';
}

export function getPreferenceDialogHtml(options: PreferenceDialogHtmlOptions): string {
  const zh = options.locale === 'zh';
  const title = zh ? '偏好设置' : 'Preferences';
  const themeLabel = zh ? '主题' : 'Theme';
  const soundLabel = zh ? '提示音' : 'Sound';
  const soundToggleLabel = zh ? '播放任务结束提醒音' : 'Play sound when a task finishes';
  const volumeLabel = zh ? '音量' : 'Volume';
  const shortcutLabel = zh ? '唤醒快捷键' : 'Wake Shortcut';
  const shortcutHint = zh
    ? '点击后按下新的组合键。录制中按 Esc 取消。'
    : 'Click, then press the new key combination. Press Esc to cancel.';
  const capturingText = zh ? '请按下新的组合键…' : 'Press the new key combination...';
  const closeLabel = zh ? '关闭' : 'Close';

  const themeOptions: Array<{ mode: PreferenceDialogState['theme']; zh: string; en: string }> = [
    { mode: 'system', zh: '跟随系统', en: 'Follow System' },
    { mode: 'light', zh: '浅色', en: 'Light' },
    { mode: 'dark', zh: '深色', en: 'Dark' },
  ];
  const themeRadios = themeOptions.map(({ mode, zh: zhLabel, en }) =>
    `<label class="radio"><input type="radio" name="theme" value="${mode}" />`
    + `<span>${zh ? zhLabel : en}</span></label>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="${zh ? 'zh' : 'en'}">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1f1f24;
    --muted: #6b6b76;
    --border: #d8d8de;
    --box-bg: #f5f5f7;
    --accent: #7c5cff;
    --danger: #ef4444;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1f;
      --fg: #e5e5ea;
      --muted: #9a9aa5;
      --border: #3a3a44;
      --box-bg: #24242b;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    padding: 18px;
    gap: 14px;
    user-select: none;
  }
  .title { font-size: 14px; font-weight: 600; }
  .section { display: flex; flex-direction: column; gap: 8px; }
  .section-label { color: var(--muted); font-size: 12px; }
  .radios { display: flex; gap: 18px; }
  .radio { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .radio input { accent-color: var(--accent); margin: 0; }
  .checkbox { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .checkbox input { accent-color: var(--accent); margin: 0; }
  .volume {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 22px;
  }
  .volume[hidden] { display: none; }
  .volume input[type="range"] { flex: 1 1 auto; accent-color: var(--accent); }
  .volume .value { flex: 0 0 auto; color: var(--muted); font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
  .shortcut {
    font: inherit;
    text-align: left;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--box-bg);
    color: var(--fg);
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }
  .shortcut:hover { border-color: var(--accent); }
  .shortcut.capturing { color: var(--muted); font-weight: 400; }
  .hint { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .error { color: var(--danger); font-size: 12px; min-height: 16px; }
  .actions { margin-top: auto; display: flex; justify-content: flex-end; }
  button.primary {
    font: inherit;
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #ffffff;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="title">${title}</div>

  <div class="section">
    <div class="section-label">${themeLabel}</div>
    <div class="radios">${themeRadios}</div>
  </div>

  <div class="section">
    <div class="section-label">${soundLabel}</div>
    <label class="checkbox"><input type="checkbox" id="sound-enabled" /><span>${soundToggleLabel}</span></label>
    <div class="volume" id="volume-row" hidden>
      <span>${volumeLabel}</span>
      <input type="range" id="volume" min="0" max="100" step="1" />
      <span class="value" id="volume-value">-</span>
    </div>
  </div>

  <div class="section">
    <div class="section-label">${shortcutLabel}</div>
    <button class="shortcut" id="shortcut" type="button">-</button>
    <div class="hint">${shortcutHint}</div>
    <div class="error" id="shortcut-error"></div>
  </div>

  <div class="actions">
    <button class="primary" id="close" type="button">${closeLabel}</button>
  </div>
<script>
  var CAPTURING_TEXT = ${JSON.stringify(capturingText)};
  var themeRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="theme"]'));
  var soundToggle = document.getElementById('sound-enabled');
  var volumeRow = document.getElementById('volume-row');
  var volume = document.getElementById('volume');
  var volumeValue = document.getElementById('volume-value');
  var shortcutField = document.getElementById('shortcut');
  var shortcutError = document.getElementById('shortcut-error');

  function volumePercent(value) {
    return Math.round(Math.min(1, Math.max(0, value)) * 100);
  }

  function render(state) {
    if (!state) return;
    themeRadios.forEach(function (radio) {
      radio.checked = radio.value === state.theme;
    });
    soundToggle.checked = !!state.soundEnabled;
    // 勾选提示音才显示音量条；音量条本身在调整期间由用户拖动，不在这里回写
    volumeRow.hidden = !state.soundEnabled;
    if (document.activeElement !== volume) {
      volume.value = String(volumePercent(state.soundVolume));
    }
    volumeValue.textContent = volumePercent(state.soundVolume) + '%';
    shortcutField.textContent = state.shortcutCapturing ? CAPTURING_TEXT : state.shortcutDisplay;
    shortcutField.classList.toggle('capturing', !!state.shortcutCapturing);
    shortcutError.textContent = state.shortcutError || '';
  }

  window.preferenceAPI.onState(render);
  window.preferenceAPI.getState().then(render);

  themeRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      if (radio.checked) window.preferenceAPI.setTheme(radio.value);
    });
  });

  soundToggle.addEventListener('change', function () {
    window.preferenceAPI.setSoundEnabled(soundToggle.checked);
  });

  // 拖动过程中只更新数值显示；松手（change）才落盘并试听一次
  volume.addEventListener('input', function () {
    volumeValue.textContent = volumePercent(Number(volume.value) / 100) + '%';
  });
  volume.addEventListener('change', function () {
    window.preferenceAPI.setSoundVolume(Number(volume.value) / 100);
  });

  shortcutField.addEventListener('click', function () {
    window.preferenceAPI.captureShortcut();
  });

  document.getElementById('close').addEventListener('click', function () {
    window.preferenceAPI.close();
  });
</script>
</body>
</html>`;
}
