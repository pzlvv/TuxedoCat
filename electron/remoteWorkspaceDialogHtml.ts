/**
 * 「打开远程 Workspace」对话框的 HTML（`docs/core-daemon.md` 第 12 节）。
 *
 * 与唤醒快捷键对话框同构：主进程把 HTML 作为 data URL 载入 BrowserWindow，页面只负责显示。
 * 两步流程：
 *   1. 连接：输入远端 `IP:端口` 与 token；
 *   2. 目录选择：连接成功后**立刻**进入远端目录选择（列子目录 / 进上级 / 打开当前目录）。
 *
 * 页面通过 preload 暴露的 `window.remoteWorkspaceAPI` 与主进程通信：
 *   connect({host, port, token}) → { ok, listing } | { ok: false, error }
 *   list(path)                  → { ok, listing } | { ok: false, error }
 *   open(path)                  选定目录并打开工作区
 *   cancel()                    关闭对话框
 */

export interface RemoteWorkspaceDialogHtmlOptions {
  isDark: boolean;
  locale: 'zh' | 'en';
}

export function getRemoteWorkspaceDialogHtml(options: RemoteWorkspaceDialogHtmlOptions): string {
  const zh = options.locale === 'zh';
  const title = zh ? '打开远程 Workspace' : 'Open Remote Workspace';
  const connectHint = zh
    ? '在远端机器上执行 tuxedo-cat-core start，把打印的 IP、端口与 token 填到下面。'
    : 'Run `tuxedo-cat-core start` on the remote machine, then enter the printed IP, port and token.';
  const hostLabel = zh ? 'IP / 主机' : 'IP / Host';
  const portLabel = zh ? '端口' : 'Port';
  const tokenLabel = zh ? 'Token' : 'Token';
  const connectLabel = zh ? '连接' : 'Connect';
  const cancelLabel = zh ? '取消' : 'Cancel';
  const pickerHint = zh
    ? '已连接。选择远端目录后打开工作区。'
    : 'Connected. Pick a remote folder to open as a workspace.';
  const upLabel = zh ? '上级目录' : 'Parent';
  const openLabel = zh ? '打开此目录' : 'Open this folder';
  const emptyLabel = zh ? '（没有子目录）' : '(no subdirectories)';

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
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { color: ${muted}; font-size: 12px; }
  input {
    font: inherit;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid ${border};
    background: ${boxBg};
    color: ${fg};
    outline: none;
  }
  input:focus { border-color: ${accent}; }
  .row { display: flex; gap: 8px; }
  .row .field { flex: 1; }
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
  button:disabled { opacity: 0.5; cursor: default; }
  .path {
    padding: 6px 8px;
    border: 1px solid ${border};
    border-radius: 6px;
    background: ${boxBg};
    font-family: Consolas, "Courier New", monospace;
    word-break: break-all;
  }
  .list {
    flex: 1;
    min-height: 160px;
    overflow: auto;
    border: 1px solid ${border};
    border-radius: 6px;
    background: ${boxBg};
  }
  .entry {
    padding: 6px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .entry:hover { background: ${options.isDark ? '#33333d' : '#e9e9ef'}; }
  .empty { padding: 10px; color: ${muted}; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="title">${title}</div>

  <div id="connectView">
    <div class="hint">${connectHint}</div>
    <div class="field">
      <label for="host">${hostLabel}</label>
      <input id="host" type="text" spellcheck="false" autocomplete="off" />
    </div>
    <div class="row">
      <div class="field">
        <label for="port">${portLabel}</label>
        <input id="port" type="text" inputmode="numeric" spellcheck="false" autocomplete="off" />
      </div>
    </div>
    <div class="field">
      <label for="token">${tokenLabel}</label>
      <input id="token" type="text" spellcheck="false" autocomplete="off" />
    </div>
    <div class="error" id="connectError"></div>
    <div class="actions">
      <button id="cancelConnect" type="button">${cancelLabel}</button>
      <button id="connect" class="primary" type="button">${connectLabel}</button>
    </div>
  </div>

  <div id="pickerView" class="hidden">
    <div class="hint">${pickerHint}</div>
    <div class="path" id="currentPath"></div>
    <div class="list" id="entries"></div>
    <div class="error" id="pickerError"></div>
    <div class="actions">
      <button id="cancelPicker" type="button">${cancelLabel}</button>
      <button id="up" type="button">${upLabel}</button>
      <button id="open" class="primary" type="button">${openLabel}</button>
    </div>
  </div>

<script>
  var connectView = document.getElementById('connectView');
  var pickerView = document.getElementById('pickerView');
  var connectError = document.getElementById('connectError');
  var pickerError = document.getElementById('pickerError');
  var currentPathEl = document.getElementById('currentPath');
  var entriesEl = document.getElementById('entries');
  var hostEl = document.getElementById('host');
  var portEl = document.getElementById('port');
  var tokenEl = document.getElementById('token');
  var listing = null;
  var endpoint = null;
  var busy = false;

  function setBusy(value) {
    busy = value;
    document.getElementById('connect').disabled = value;
    document.getElementById('open').disabled = value;
    document.getElementById('up').disabled = value || !(listing && listing.parent);
  }

  function showConnectError(message) {
    connectError.textContent = message || '';
  }

  function showPickerError(message) {
    pickerError.textContent = message || '';
  }

  function renderPicker(next) {
    listing = next;
    currentPathEl.textContent = next.path;
    entriesEl.textContent = '';
    if (!next.entries.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '${emptyLabel}';
      entriesEl.appendChild(empty);
    } else {
      next.entries.forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'entry';
        row.textContent = entry.name;
        row.title = entry.path;
        row.addEventListener('click', function () { enter(entry.path); });
        entriesEl.appendChild(row);
      });
    }
    setBusy(false);
  }

  function enter(path) {
    if (busy) return;
    showPickerError('');
    setBusy(true);
    window.remoteWorkspaceAPI.list(path).then(function (result) {
      if (result && result.ok) {
        renderPicker(result.listing);
      } else {
        setBusy(false);
        showPickerError((result && result.error) || 'list failed');
      }
    });
  }

  document.getElementById('connect').addEventListener('click', function () {
    if (busy) return;
    showConnectError('');
    var host = hostEl.value.trim();
    var port = parseInt(portEl.value.trim(), 10);
    var token = tokenEl.value.trim();
    if (!host) { showConnectError('${zh ? '请填写 IP / 主机' : 'Host is required'}'); return; }
    if (!port || port <= 0 || port > 65535) { showConnectError('${zh ? '请填写 1-65535 的端口' : 'Port must be 1-65535'}'); return; }
    if (!token) { showConnectError('${zh ? '请填写 token' : 'Token is required'}'); return; }
    setBusy(true);
    window.remoteWorkspaceAPI.connect({ host: host, port: port, token: token }).then(function (result) {
      if (result && result.ok) {
        endpoint = result.endpoint || { host: host, port: port, token: token };
        connectView.classList.add('hidden');
        pickerView.classList.remove('hidden');
        renderPicker(result.listing);
      } else {
        setBusy(false);
        showConnectError((result && result.error) || 'connect failed');
      }
    });
  });

  document.getElementById('up').addEventListener('click', function () {
    if (listing && listing.parent) enter(listing.parent);
  });

  document.getElementById('open').addEventListener('click', function () {
    if (busy || !listing || !endpoint) return;
    setBusy(true);
    window.remoteWorkspaceAPI.open(listing.path);
  });

  document.getElementById('cancelConnect').addEventListener('click', function () {
    window.remoteWorkspaceAPI.cancel();
  });
  document.getElementById('cancelPicker').addEventListener('click', function () {
    window.remoteWorkspaceAPI.cancel();
  });

  hostEl.focus();
</script>
</body>
</html>`;
}
