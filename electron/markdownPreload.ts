/**
 * Electron preload - Markdown 预览窗口专用（specs/018 FR-004）。
 *
 * Markdown 预览页是主进程生成的静态 data URL，没有内联脚本。刷新只替换
 * `.markdown-body` 的 innerHTML，并恢复滚动位置；标题消息用于「文件已删除 /
 * 读取失败 / 自动刷新不可用」标记。
 *
 * 自绘标题栏也由本 preload 注入（页面 CSP 禁脚本，DOM 只能在这里动）：
 * 「渲染 / 文本」切换按钮紧邻最小化按钮左侧，窗口控制经
 * `markdown-window-control` 回主进程执行（发送方校验在主进程）。初始源文与
 * 文案随 `markdown-source` 下发——沙箱 preload 只有 ipcRenderer 与 DOM，
 * 不感知宿主环境。
 *
 * 本 preload 只使用 `ipcRenderer` 与 DOM，不向页面暴露任何 Node 能力；窗口保持
 * `sandbox: true`，内容仍在生成侧净化。
 */

import { ipcRenderer } from 'electron';

// ==================== 状态 ====================

type ViewMode = 'rendered' | 'text';

interface SourcePayload {
  text?: unknown;
  dark?: unknown;
  windowControls?: unknown;
  labels?: {
    rendered?: unknown;
    text?: unknown;
    minimize?: unknown;
    maximize?: unknown;
    close?: unknown;
  };
}

const BAR_HEIGHT_PX = 40;

const state = {
  mode: 'rendered' as ViewMode,
  sourceText: '',
  dark: false,
  windowControls: false,
  labels: {
    rendered: '渲染',
    text: '文本',
    minimize: 'Minimize',
    maximize: 'Maximize',
    close: 'Close',
  },
};

let article: HTMLElement | null = null;
let sourceView: HTMLElement | null = null;
let toggleButton: HTMLButtonElement | null = null;

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

// ==================== 视图切换 ====================

function applyMode(): void {
  if (!article || !sourceView || !toggleButton) return;
  article.style.display = state.mode === 'rendered' ? '' : 'none';
  sourceView.style.display = state.mode === 'rendered' ? 'none' : '';
  // 按钮标签是**切换目标**（当前在渲染视图 → 显示「文本」），点按即到达
  toggleButton.textContent = state.mode === 'rendered' ? state.labels.text : state.labels.rendered;
  toggleButton.setAttribute(
    'aria-label',
    state.mode === 'rendered'
      ? `${state.labels.text} view`
      : `${state.labels.rendered} view`,
  );
}

function toggleMode(): void {
  state.mode = state.mode === 'rendered' ? 'text' : 'rendered';
  applyMode();
}

function ensureSourceView(): HTMLElement {
  if (sourceView) return sourceView;
  const pre = document.createElement('pre');
  pre.id = 'markdown-source-view';
  pre.textContent = state.sourceText;
  document.body.appendChild(pre);
  sourceView = pre;
  return pre;
}

function syncContent(): void {
  ensureSourceView();
  if (sourceView) sourceView.textContent = state.sourceText;
  applyMode();
}

// ==================== 自绘标题栏 ====================

/** 与主窗口标题栏同款 10×10 stroke 图形（electron/titlebar/index.html） */
function svgGlyph(paths: string): string {
  return `<svg viewBox="0 0 10 10" aria-hidden="true">${paths}</svg>`;
}

const GLYPH_MINIMIZE = svgGlyph('<path d="M0 5h10" />');
const GLYPH_MAXIMIZE = svgGlyph('<rect x="0.5" y="0.5" width="9" height="9" rx="1" />');
const GLYPH_CLOSE = svgGlyph('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />');

function injectStyles(dark: boolean): void {
  const fg = dark ? '#d4d4d8' : '#1f2328';
  const bg = dark ? '#1e1e1e' : '#ffffff';
  const border = dark ? '#3f3f46' : '#d1d9e0';
  const hover = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.055)';
  const muted = dark ? '#9f9fa9' : '#59636e';
  const style = document.createElement('style');
  style.textContent = `
    body { padding-top: ${BAR_HEIGHT_PX}px; }
    #markdown-titlebar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      height: ${BAR_HEIGHT_PX}px;
      display: flex; align-items: stretch;
      background: ${bg}; color: ${fg};
      border-bottom: 1px solid ${border};
      -webkit-app-region: drag; -webkit-user-select: none; user-select: none;
    }
    #markdown-titlebar .doc-title {
      align-self: center; margin-left: ${state.windowControls ? 12 : 80}px; margin-right: 8px;
      font-size: 12.5px; line-height: 1;
      color: ${muted};
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 45%;
      pointer-events: none;
    }
    #markdown-titlebar .drag-filler { flex: 1; }
    #markdown-titlebar .controls {
      display: flex; align-items: stretch; flex-shrink: 0;
      -webkit-app-region: no-drag;
    }
    #markdown-titlebar button {
      appearance: none; border: none; background: transparent; color: ${fg};
      font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      height: 100%; display: flex; align-items: center; justify-content: center;
      cursor: default; transition: background-color 0.12s ease, color 0.12s ease;
    }
    #markdown-titlebar .view-toggle {
      padding: 0 12px; font-size: 12.5px; line-height: 1;
      border-left: 1px solid ${border};
    }
    #markdown-titlebar .view-toggle:hover { background: ${hover}; }
    #markdown-titlebar .wc { width: 46px; }
    #markdown-titlebar .wc svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
    #markdown-titlebar .wc:hover { background: ${hover}; }
    #markdown-titlebar .wc-close:hover { background: #e81123; color: #ffffff; }
    #markdown-titlebar .wc-close:active { background: #c50f1f; color: #ffffff; }
    #markdown-source-view {
      max-width: 980px; margin: 0 auto; padding: 32px 28px 64px;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
      font-size: 13px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word; tab-size: 4;
    }
  `;
  document.head.appendChild(style);
}

function buildTitlebar(): void {
  const bar = document.createElement('div');
  bar.id = 'markdown-titlebar';
  const title = document.createElement('span');
  title.className = 'doc-title';
  title.textContent = document.title;
  bar.appendChild(title);
  const filler = document.createElement('div');
  filler.className = 'drag-filler';
  bar.appendChild(filler);
  const controls = document.createElement('div');
  controls.className = 'controls';
  if (state.windowControls) {
    // 切换按钮在最小化左侧（需求定位：窗口控制行内、紧邻最小化）
    toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'view-toggle';
    toggleButton.addEventListener('click', toggleMode);
    controls.appendChild(toggleButton);
    const minimize = document.createElement('button');
    minimize.type = 'button';
    minimize.className = 'wc';
    minimize.title = state.labels.minimize;
    minimize.setAttribute('aria-label', state.labels.minimize);
    minimize.innerHTML = GLYPH_MINIMIZE;
    minimize.addEventListener('click', () => {
      ipcRenderer.send('markdown-window-control', { action: 'minimize' });
    });
    controls.appendChild(minimize);
    const maximize = document.createElement('button');
    maximize.type = 'button';
    maximize.className = 'wc';
    maximize.title = state.labels.maximize;
    maximize.setAttribute('aria-label', state.labels.maximize);
    maximize.innerHTML = GLYPH_MAXIMIZE;
    maximize.addEventListener('click', () => {
      ipcRenderer.send('markdown-window-control', { action: 'toggle-maximize' });
    });
    controls.appendChild(maximize);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wc wc-close';
    close.title = state.labels.close;
    close.setAttribute('aria-label', state.labels.close);
    close.innerHTML = GLYPH_CLOSE;
    close.addEventListener('click', () => {
      ipcRenderer.send('markdown-window-control', { action: 'close' });
    });
    controls.appendChild(close);
    // Windows 惯例：标题栏空白区双击切换最大化
    bar.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('.controls')) return;
      ipcRenderer.send('markdown-window-control', { action: 'toggle-maximize' });
    });
  } else {
    // macOS：系统红绿灯承担窗口控制，只注入切换按钮（右侧、无边框分栏）
    toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'view-toggle';
    toggleButton.addEventListener('click', toggleMode);
    controls.appendChild(toggleButton);
  }
  bar.appendChild(controls);
  document.body.appendChild(bar);
}

function withDocument(run: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

// ==================== 消息 ====================

ipcRenderer.on('markdown-source', (_event, data: SourcePayload) => {
  if (typeof data?.text !== 'string') return;
  state.sourceText = data.text;
  state.dark = data?.dark === true;
  state.windowControls = data?.windowControls === true;
  state.labels = {
    rendered: asString(data?.labels?.rendered, state.labels.rendered),
    text: asString(data?.labels?.text, state.labels.text),
    minimize: asString(data?.labels?.minimize, state.labels.minimize),
    maximize: asString(data?.labels?.maximize, state.labels.maximize),
    close: asString(data?.labels?.close, state.labels.close),
  };
  withDocument(() => {
    article = document.querySelector('.markdown-body');
    injectStyles(state.dark);
    buildTitlebar();
    syncContent();
  });
});

ipcRenderer.on('markdown-refresh', (_event, data: { bodyHtml?: unknown; text?: unknown }) => {
  if (typeof data?.bodyHtml !== 'string') return;
  if (typeof data.text === 'string') state.sourceText = data.text;
  withDocument(() => {
    article ??= document.querySelector('.markdown-body');
    if (state.mode === 'rendered' && article) {
      // 滚动位置只在渲染视图恢复（文本视图跟着源文长度变化，强保位置无意义）
      const scrolling = document.scrollingElement;
      const scrollTop = scrolling?.scrollTop ?? window.scrollY;
      article.innerHTML = data.bodyHtml as string;
      if (scrolling) scrolling.scrollTop = scrollTop;
      else window.scrollTo(0, scrollTop);
    } else {
      syncContent();
    }
  });
});

ipcRenderer.on('viewer-title', (_event, data: { title?: unknown }) => {
  if (typeof data?.title === 'string' && data.title) {
    document.title = data.title;
    const docTitle = document.querySelector('#markdown-titlebar .doc-title');
    if (docTitle) docTitle.textContent = data.title;
  }
});
