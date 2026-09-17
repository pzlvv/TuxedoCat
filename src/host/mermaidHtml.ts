/**
 * Mermaid 预览 HTML 模板（纯函数，无宿主依赖）
 * 由 UIHost.openMermaidPreview 调用
 */

function escapeHtml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 渲染失败的错误展示页 */
export function getMermaidErrorHtml(code: string, errorMsg: string): string {
  const escapedCode = escapeHtml(code);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: system-ui; padding: 24px; background: #1a1a1f; color: #c1c1c6; }
  h2 { color: #ef4444; margin-bottom: 8px; }
  pre { background: #1e1e24; padding: 16px; border-radius: 6px; overflow: auto; font-size: 12px; }
</style></head><body>
  <h2>Failed to render Mermaid diagram</h2>
  <pre>${errorMsg}</pre>
  <h3 style="margin-top:20px">Source code:</h3>
  <pre>${escapedCode}</pre>
</body></html>`;
}

/** Mermaid 交互式预览页（支持缩放/平移/复制/重试） */
export function getMermaidPreviewHtml(code: string, mermaidSrc: string, isDark: boolean): string {
  const escapedCode = escapeHtml(code);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mermaid Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: ${isDark ? '#1a1a1f' : '#ffffff'};
      color: ${isDark ? '#c1c1c6' : '#18181b'};
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      border-bottom: 1px solid ${isDark ? '#52525b' : '#d4d4d8'};
      background: ${isDark ? '#2a2a30' : '#f4f4f5'};
      flex-shrink: 0;
    }
    #toolbar .title {
      font-size: 13px;
      font-weight: 600;
    }
    #toolbar .btn {
      padding: 4px 12px;
      border: 1px solid ${isDark ? '#52525b' : '#d4d4d8'};
      border-radius: 4px;
      background: ${isDark ? '#3a3a42' : '#e4e4e7'};
      color: ${isDark ? '#c1c1c6' : '#18181b'};
      font-size: 12px;
      cursor: pointer;
    }
    #toolbar .btn:hover {
      background: ${isDark ? '#4a4a52' : '#d4d4d8'};
    }
    #viewport {
      flex: 1;
      overflow: hidden;
      cursor: grab;
      position: relative;
    }
    #container {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      padding: 24px;
    }
    #container svg {
      max-width: none;
      height: auto;
      display: block;
    }
    /* Loading spinner */
    #loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 48px;
      color: #6366f1;
    }
    #loading .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid ${isDark ? '#52525b' : '#d4d4d8'};
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    #loading .label {
      font-size: 13px;
      color: ${isDark ? '#9f9fa9' : '#71717a'};
    }
    #loading.hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <span class="title">Mermaid Preview</span>
    <div style="display:flex;gap:6px;align-items:center;">
      <span id="zoom-level" style="font-size:11px;color:${isDark ? '#9f9fa9' : '#71717a'};min-width:36px;text-align:center;">100%</span>
      <button class="btn" onclick="zoomIn()">+</button>
      <button class="btn" onclick="zoomOut()">-</button>
      <button class="btn" onclick="resetZoom()">Reset</button>
      <span style="width:1px;height:16px;background:${isDark ? '#52525b' : '#d4d4d8'};margin:0 4px;"></span>
      <button class="btn" onclick="copyCode()">Copy Code</button>
      <button class="btn" onclick="retry()">Retry</button>
    </div>
  </div>
  <div id="loading">
    <div class="spinner"></div>
    <div class="label">Rendering diagram...</div>
  </div>
  <div id="viewport">
    <div id="container" style="display:none;"><div class="mermaid">${escapedCode}</div></div>
  </div>
  <div id="error" style="display:none;color:#ef4444;font-size:13px;padding:16px;text-align:center;"></div>
  <script src="${mermaidSrc}"></script>
  <script>
    let lastCode = ${JSON.stringify(code)};
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let isPanning = false;
    let startX, startY;
    let startPanX, startPanY;

    const MIN_SCALE = 0.1;
    const MAX_SCALE = 5;

    function applyTransform() {
      const container = document.getElementById('container');
      container.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
      document.getElementById('zoom-level').textContent = Math.round(scale * 100) + '%';
    }

    function zoomIn() {
      scale = Math.min(MAX_SCALE, scale * 1.2);
      applyTransform();
    }

    function zoomOut() {
      scale = Math.max(MIN_SCALE, scale / 1.2);
      applyTransform();
    }

    function resetZoom() {
      scale = 1;
      panX = 0;
      panY = 0;
      applyTransform();
    }

    function render(code) {
      lastCode = code;
      const container = document.getElementById('container');
      const errorDiv = document.getElementById('error');
      const loading = document.getElementById('loading');

      scale = 1; panX = 0; panY = 0;

      loading.classList.remove('hidden');
      container.style.display = 'none';
      errorDiv.style.display = 'none';

      container.innerHTML = '<div class="mermaid"></div>';
      mermaid.initialize({
        startOnLoad: false,
        theme: '${isDark ? 'dark' : 'default'}',
      });

      mermaid.render('mermaid-svg', code)
        .then(function(result) {
          container.innerHTML = result.svg;
          loading.classList.add('hidden');
          container.style.display = 'block';
          applyTransform();
        })
        .catch(function(e) {
          loading.classList.add('hidden');
          container.innerHTML = '<pre style="margin:0;font-size:12px;white-space:pre-wrap;word-break:break-word;">' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
          container.style.display = 'block';
          errorDiv.style.display = 'block';
          errorDiv.innerHTML = '<strong>Failed to render diagram:</strong><pre>' + (e.message || e) + '</pre>';
        });
    }

    function copyCode() {
      navigator.clipboard.writeText(lastCode).catch(function() {});
    }

    function retry() {
      render(lastCode);
    }

    // Wheel zoom
    document.addEventListener('wheel', function(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * delta));
      const rect = document.getElementById('viewport').getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      panX = mx - (mx - panX) * (newScale / scale);
      panY = my - (my - panY) * (newScale / scale);
      scale = newScale;
      applyTransform();
    }, { passive: false });

    // Pan with mouse drag
    document.addEventListener('mousedown', function(e) {
      if (e.target.closest('#toolbar')) return;
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = panX;
      startPanY = panY;
      document.getElementById('viewport').style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', function(e) {
      if (!isPanning) return;
      panX = startPanX + (e.clientX - startX);
      panY = startPanY + (e.clientY - startY);
      applyTransform();
    });

    document.addEventListener('mouseup', function() {
      isPanning = false;
      document.getElementById('viewport').style.cursor = 'grab';
    });

    render(lastCode);
  </script>
</body>
</html>`;
}
