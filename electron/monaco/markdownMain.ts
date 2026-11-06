/**
 * Markdown 预览窗口入口（US-42 验收 6 / US-38 验收 1）
 *
 * 与 Monaco 查看窗口同一 vite 工程的多入口（共享一份 Monaco bundle 与装配，见
 * monacoSetup.ts）。数据流：main 进程渲染并净化 HTML（`src/host/markdownHtml.ts`）
 * 后经 preload 桥接发 markdown-init / markdown-refresh，本页维护两个视图：
 * - 渲染视图：`article.markdown-body`，innerHTML 注入（内容在生成侧零信任，
 *   页面 CSP 拦内联脚本兜底）；
 * - 文本视图：页内只读 Monaco（markdown 语法着色）只读展示原始源文——旧的
 *   `<pre>` 源文视图废弃。
 *
 * 自绘标题栏由本页绘制（非 macOS 去系统边框）：「渲染 / 文本」切换按钮与
 * 最小化-最大化-关闭按钮，窗口控制经 window message → preload →
 * `markdown-window-control` 回主进程执行（发送方校验在主进程）；macOS 保留系统
 * 红绿灯，只注入切换按钮。初始模式：带 selectedLines（聊天链接定位行号）落文本
 * 视图并定位——渲染视图对应不了源行号；否则默认渲染视图。
 */

import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import {
  UNICODE_HIGHLIGHT_OFF,
  currentTheme,
  followSystemEditorTheme,
  revealLines,
} from './monacoSetup';

type ViewMode = 'rendered' | 'text';
type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

interface LabelSet {
  rendered: string;
  text: string;
  /** 源文侧两组开关（specs/040 FR-002） */
  full: string;
  changes: string;
  minimize: string;
  maximize: string;
  close: string;
}

/** 主进程对 diff 请求的应答（specs/040 FR-001） */
type DiffReply =
  | { type: 'diff'; requestId: string | null; kind: 'diff'; payload: { before: string; after: string } }
  | { type: 'diff'; requestId: string | null; kind: 'empty' }
  | { type: 'diff'; requestId: string | null; kind: 'error'; message: string };

interface MarkdownInitData {
  title?: unknown;
  bodyHtml?: unknown;
  text?: unknown;
  selectedLines?: unknown;
  windowControls?: unknown;
  labels?: Partial<Record<keyof LabelSet, unknown>>;
  /** 初始源文档（specs/040 FR-003 / AC-8） */
  initialSourceMode?: unknown;
  /** 是否可切换变更视图（非 git 工作区为 false，AC-9） */
  canDiff?: unknown;
}

// ==================== 状态 ====================

const DEFAULT_LABELS: LabelSet = {
  rendered: '渲染',
  text: '文本',
  full: '全文',
  changes: '变更',
  minimize: 'Minimize',
  maximize: 'Maximize',
  close: 'Close',
};

/** 源文侧开关（specs/040 FR-002）：全文 / 相对 HEAD 的变更对比。只在文本视图下生效 */
type SourceMode = 'full' | 'changes';

const state = {
  mode: 'rendered' as ViewMode,
  /** 源文侧的正交开关（spec FR-002）：渲染态忽略它，切回文本时取值保留（AC-4） */
  sourceMode: 'full' as SourceMode,
  /** 是否可切换变更视图（非 git 工作区为 false，按钮置灰；AC-9） */
  canDiff: false,
  sourceText: '',
  bodyHtml: '',
  selectedLines: null as { start: number; end: number } | null,
  windowControls: false,
  labels: DEFAULT_LABELS,
  /** 最近一次 diff 应答（切回变更档不必重新请求） */
  lastDiff: null as { kind: string; payload?: { before: string; after: string }; message?: string } | null,
  /** 进行中的 diff 请求 id（过期回包丢弃） */
  pendingDiffRequest: null as string | null,
};

const article = document.querySelector('article.markdown-body') as HTMLElement;
const editorContainer = document.getElementById('markdown-source-view') as HTMLElement;
const titlebar = document.getElementById('markdown-titlebar') as HTMLElement;
const docTitle = titlebar.querySelector('.doc-title') as HTMLElement;
const controls = titlebar.querySelector('.controls') as HTMLElement;

let toggleButton: HTMLButtonElement | null = null;
let fullToggleButton: HTMLButtonElement | null = null;
let changesToggleButton: HTMLButtonElement | null = null;
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

// ==================== 视图切换 ====================

function applyMode(): void {
  if (!toggleButton) return;
  const textMode = state.mode === 'text';
  article.hidden = textMode;
  editorContainer.hidden = !textMode;
  // 按钮标签是**切换目标**（当前在渲染视图 → 显示「文本」），点按即到达
  toggleButton.textContent = textMode ? state.labels.rendered : state.labels.text;
  toggleButton.setAttribute(
    'aria-label',
    textMode ? `${state.labels.rendered} view` : `${state.labels.text} view`,
  );
  // 源文侧开关（specs/040 FR-002）：渲染态下按钮仍在但变更档不参与显示（AC-4：
  // 「渲染」忽略变更开关，切回「文本」时取值仍保留）
  updateSourceToggle();
  if (textMode) {
    if (state.sourceMode === 'changes') {
      showChangesView();
    } else {
      ensureEditor();
    }
  }
}

function toggleMode(): void {
  state.mode = state.mode === 'rendered' ? 'text' : 'rendered';
  applyMode();
}

/** 源文侧「全文 / 变更」按钮的状态（标签是切换目标；`canDiff` 为假时置灰） */
function updateSourceToggle(): void {
  if (!fullToggleButton || !changesToggleButton) return;
  fullToggleButton.classList.toggle('active', state.sourceMode === 'full');
  fullToggleButton.setAttribute('aria-pressed', state.sourceMode === 'full' ? 'true' : 'false');
  changesToggleButton.classList.toggle('active', state.sourceMode === 'changes');
  changesToggleButton.setAttribute('aria-pressed', state.sourceMode === 'changes' ? 'true' : 'false');
  // 可点性只由 canDiff 决定（AC-3 / AC-4）：渲染态下点「变更」会自动切到文本视图
  // 看 diff，而不是把按钮禁掉（禁掉会让用户以为「这个文件没法看变更」）
  fullToggleButton.disabled = !state.canDiff;
  changesToggleButton.disabled = !state.canDiff;
  const reason = state.canDiff ? '切换全文 / 变更' : '不在 git 仓库内，无法显示变更';
  fullToggleButton.title = reason;
  changesToggleButton.title = reason;
}

/** 切到「全文」：回到只读全文编辑器 */
function showFullView(): void {
  state.sourceMode = 'full';
  disposeSourceEditor();
  ensureEditor();
  applyMode();
}

/** 切到「变更」：按需索取两侧原文（首次进入才请求）。
 *
 * 变更档只存在于文本视图（spec FR-002）：点「变更」时自动切到文本视图，否则渲染视图
 * 会把 diff 容器藏起来（用户看到的是「点了没反应」）。 */
function showChangesView(): void {
  state.sourceMode = 'changes';
  state.mode = 'text';
  if (state.lastDiff) {
    renderDiffReply(state.lastDiff);
    updateSourceToggle();
    return;
  }
  requestDiff();
}

/** 变更档的编辑器容器：与全文共用同一个容器（渲染实现只有一份 DiffEditor） */
function renderDiffReply(reply: { kind: string; payload?: { before: string; after: string }; message?: string }): void {
  disposeSourceEditor();
  editorContainer.hidden = false;
  article.hidden = true;
  if (reply.kind === 'error') {
    editorContainer.textContent = '无法读取变更，请重试';
    return;
  }
  if (reply.kind === 'empty') {
    editorContainer.textContent = '没有改动';
    return;
  }
  const payload = reply.payload ?? { before: '', after: '' };
  diffEditor = monaco.editor.createDiffEditor(editorContainer, {
    theme: currentTheme(),
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: false },
    renderSideBySide: true,
    readOnly: true,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    unicodeHighlight: UNICODE_HIGHLIGHT_OFF,
  });
  diffEditor.setModel({
    original: monaco.editor.createModel(payload.before, 'markdown'),
    modified: monaco.editor.createModel(payload.after, 'markdown'),
  });
}

/** 释放源文侧编辑器（全文 / diff 两档共用这一处清理）。
 *
 * 同时清空容器的文字内容：空态 / 错误态往容器里写过提示行，不清会在切回全文后
 * 与编辑器 DOM 叠加（表现为「没有改动」和正文同时出现）。 */
function disposeSourceEditor(): void {
  editorContainer.textContent = '';
  if (editor) {
    editor.getModel()?.dispose?.();
    editor.dispose();
    editor = null;
  }
  if (diffEditor) {
    diffEditor.getOriginalEditor?.()?.getModel()?.dispose?.();
    diffEditor.getModifiedEditor?.()?.getModel()?.dispose?.();
    diffEditor.dispose();
    diffEditor = null;
  }
}

/** 索取两侧原文（主进程跑 git show + 读盘）。
 *
 * 已有在途请求时不重复发：`applyMode()` 与按钮 handler 都会走到这里，重复发会让
 * 后一个 requestId 覆盖前一个，先回的那份被当成过期丢弃（表现为「点了没反应」）。 */
function requestDiff(): void {
  const bridge = (window as unknown as { monacoDiffBridge?: { request(requestId: string): void } }).monacoDiffBridge;
  if (!bridge) {
    renderDiffReply({ kind: 'error' });
    return;
  }
  const requestId = `md-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.pendingDiffRequest = requestId;
  bridge.request(requestId);
}

// ==================== 文本视图 ====================

/** 只读 Monaco 懒创建：默认渲染视图，不为源文预付编辑器创建成本 */
function ensureEditor(): void {
  if (editor) {
    // 从隐藏切回可见时 automaticLayout 的 ResizeObserver 可能不立即补一帧
    requestAnimationFrame(() => editor?.layout());
    return;
  }
  editor = monaco.editor.create(editorContainer, {
    model: monaco.editor.createModel(state.sourceText, 'markdown'),
    theme: currentTheme(),
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    readOnly: true,
    wordWrap: 'on',
    unicodeHighlight: UNICODE_HIGHLIGHT_OFF,
  });
  // 聊天链接带行号定位（US-38 验收 1）：初始即文本视图时定位到选中行
  const lines = state.selectedLines;
  if (lines) {
    requestAnimationFrame(() => revealLines(editor as monaco.editor.IStandaloneCodeEditor, lines));
  }
}

// ==================== 刷新（specs/018：两种视图都跟随源文件刷新） ====================

function onRefresh(data: { bodyHtml?: unknown; text?: unknown }): void {
  if (typeof data.bodyHtml === 'string') state.bodyHtml = data.bodyHtml;
  if (typeof data.text === 'string') state.sourceText = data.text;
  // 渲染区始终同步（文本模式刷新后切回不看过期内容）；滚动位置只在渲染视图恢复
  // （文本视图由编辑器自己持有光标与滚动）
  const scrolling = document.scrollingElement;
  const scrollTop = scrolling?.scrollTop ?? window.scrollY;
  article.innerHTML = state.bodyHtml;
  if (state.mode === 'rendered') {
    if (scrolling) scrolling.scrollTop = scrollTop;
    else window.scrollTo(0, scrollTop);
  }
  if (state.mode === 'text' && state.sourceMode === 'changes') {
    // 变更档：两侧原文都要重取（spec 边界第 2 条）
    state.lastDiff = null;
    requestDiff();
    return;
  }
  if (editor) {
    const viewState = editor.saveViewState();
    editor.getModel()?.setValue(state.sourceText);
    if (viewState) editor.restoreViewState(viewState);
  }
}

// ==================== 自绘标题栏 ====================

/** 与主窗口标题栏同款 10×10 stroke 图形（electron/titlebar/index.html） */
function svgGlyph(paths: string): string {
  return `<svg viewBox="0 0 10 10" aria-hidden="true">${paths}</svg>`;
}

const GLYPH_MINIMIZE = svgGlyph('<path d="M0 5h10" />');
const GLYPH_MAXIMIZE = svgGlyph('<rect x="0.5" y="0.5" width="9" height="9" rx="1" />');
const GLYPH_CLOSE = svgGlyph('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />');

function sendWindowControl(action: WindowControlAction): void {
  window.postMessage({ type: 'window-control', action }, '*');
}

function windowControlButton(glyph: string, label: string, action: WindowControlAction): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wc';
  if (action === 'close') button.className += ' wc-close';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = glyph;
  button.addEventListener('click', () => sendWindowControl(action));
  return button;
}

/** 只在 init 到达时执行一次；toggleButton 非空即已建过 */
function buildTitlebar(): void {
  if (toggleButton) return;
  docTitle.textContent = document.title;
  const makeToggle = (): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'view-toggle';
    button.addEventListener('click', toggleMode);
    return button;
  };
  /** 源文侧的单选按钮（specs/040 FR-002）：两组正交，各自 aria-pressed */
  const makeSourceToggle = (label: string, mode: SourceMode): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'view-toggle source-toggle';
    button.dataset.sourceMode = mode;
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (state.sourceMode === mode) return;
      if (mode === 'full') showFullView();
      else {
        state.mode = 'text';
        showChangesView();
        applyMode();
      }
    });
    return button;
  };
  // 两组开关的顺序（AC-3）：「全文 / 变更」在「渲染 / 文本」**左侧**
  fullToggleButton = makeSourceToggle(state.labels.full, 'full');
  changesToggleButton = makeSourceToggle(state.labels.changes, 'changes');
  controls.appendChild(fullToggleButton);
  controls.appendChild(changesToggleButton);
  if (state.windowControls) {
    // 切换按钮在最小化左侧（需求定位：窗口控制行内、紧邻最小化）
    toggleButton = makeToggle();
    controls.appendChild(toggleButton);
    controls.appendChild(windowControlButton(GLYPH_MINIMIZE, state.labels.minimize, 'minimize'));
    controls.appendChild(windowControlButton(GLYPH_MAXIMIZE, state.labels.maximize, 'toggle-maximize'));
    controls.appendChild(windowControlButton(GLYPH_CLOSE, state.labels.close, 'close'));
    // Windows 惯例：标题栏空白区双击切换最大化
    titlebar.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('.controls')) return;
      sendWindowControl('toggle-maximize');
    });
  } else {
    // macOS：系统红绿灯承担窗口控制，只注入切换按钮（右侧、无边框分栏）
    toggleButton = makeToggle();
    controls.appendChild(toggleButton);
  }
}

// ==================== 消息 ====================

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function parseSelectedLines(value: unknown): { start: number; end: number } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { start?: unknown; end?: unknown };
  if (typeof v.start !== 'number' || typeof v.end !== 'number') return null;
  return { start: v.start, end: v.end };
}

function onInit(data: MarkdownInitData): void {
  state.windowControls = data.windowControls === true;
  state.labels = {
    rendered: asString(data.labels?.rendered, state.labels.rendered),
    text: asString(data.labels?.text, state.labels.text),
    full: asString(data.labels?.full, state.labels.full),
    changes: asString(data.labels?.changes, state.labels.changes),
    minimize: asString(data.labels?.minimize, state.labels.minimize),
    maximize: asString(data.labels?.maximize, state.labels.maximize),
    close: asString(data.labels?.close, state.labels.close),
  };
  state.sourceText = typeof data.text === 'string' ? data.text : '';
  state.bodyHtml = typeof data.bodyHtml === 'string' ? data.bodyHtml : '';
  state.selectedLines = parseSelectedLines(data.selectedLines);
  state.canDiff = data.canDiff === true;
  // 初始源文档（specs/040 FR-003 / AC-8）：`changes` 且非新增时跳过渲染视图直接落变更；
  // 行号定位优先（聊天链接想看的是那一行的源文）
  state.sourceMode = data.initialSourceMode === 'changes' && state.canDiff && !state.selectedLines
    ? 'changes'
    : 'full';
  // 窗口标题随打开对象变化：构建期 <title> 只是兜底，文档标题在这里落定
  if (typeof data.title === 'string' && data.title) document.title = data.title;
  buildTitlebar();
  article.innerHTML = state.bodyHtml;
  if (state.sourceMode === 'changes') {
    state.mode = 'text';
  } else if (state.selectedLines) {
    state.mode = 'text';
  }
  applyMode();
}

// 经 monacoPreload 桥接：markdown-init / markdown-refresh / viewer-title → window message
window.addEventListener('message', (event) => {
  const data = event.data as
    | (MarkdownInitData & { type: 'init' })
    | { type: 'refresh'; bodyHtml?: unknown; text?: unknown }
    | { type: 'title'; title?: unknown }
    | DiffReply
    | null;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'title') {
    if (typeof (data as { title?: unknown }).title === 'string') {
      const title = (data as { title: string }).title;
      if (title) {
        document.title = title;
        docTitle.textContent = title;
      }
    }
    return;
  }
  if (data.type === 'refresh') {
    onRefresh(data as { bodyHtml?: unknown; text?: unknown });
    return;
  }
  if (data.type === 'diff') {
    applyDiffReply(data);
    return;
  }
  if (data.type === 'init') {
    onInit(data);
  }
});

/** 应用主进程的 diff 应答（specs/040 AC-2 的空态判定在主进程的 buildDiffResult） */
function applyDiffReply(reply: DiffReply): void {
  if (reply.requestId !== null && reply.requestId !== state.pendingDiffRequest) return;
  state.pendingDiffRequest = null;
  state.lastDiff = reply;
  if (state.mode !== 'text' || state.sourceMode !== 'changes') return;
  renderDiffReply(reply);
  updateSourceToggle();
}

followSystemEditorTheme();
