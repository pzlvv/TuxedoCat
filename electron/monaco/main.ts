/**
 * Monaco 编辑器窗口入口
 *
 * 由 ElectronUI 打开，通过 preload 桥接接收初始化参数：
 *   - mode: 'view'    打开文件并定位到行（openFile）
 *   - mode: 'diff'    左右对比 before/after（showDiff）
 *   - mode: 'content' 展示纯文本内容（showVirtualDocument）
 *
 * 数据流：main 进程读取文件内容后 webContents.send('monaco-init', data)，
 * preload 转发到页面（window message），本页监听并渲染。
 */

import * as monaco from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import {
  UNICODE_HIGHLIGHT_OFF,
  currentTheme,
  detectLanguage,
  revealLines,
} from './monacoSetup';

interface MonacoInitData {
  mode: 'view' | 'diff' | 'content';
  filePath?: string;
  selectedLines?: { start: number; end: number };
  content?: string;
  title?: string;
  beforeContent?: string;
  afterContent?: string;
  /** 初始视图（specs/040 FR-003）：`changes` 且非新增时打开即落变更视图 */
  initialView?: 'full' | 'changes';
  /** 是否可切换变更视图（非 git 工作区 / 虚拟文档为 false；AC-9） */
  canDiff?: boolean;
}

/** 主进程对 diff 请求的应答（specs/040 FR-001） */
type DiffReply =
  | { type: 'diff'; requestId: string | null; kind: 'diff'; payload: { before: string; after: string } }
  | { type: 'diff'; requestId: string | null; kind: 'empty' }
  | { type: 'diff'; requestId: string | null; kind: 'error'; message: string };

let editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null = null;
/** 当前页面模式：刷新只对 view 模式生效（specs/018 FR-004） */
let currentMode: MonacoInitData['mode'] = 'view';
const container = document.getElementById('container')!;
const titlebar = document.getElementById('editor-titlebar') as HTMLElement;
const docTitle = titlebar.querySelector('.doc-title') as HTMLElement;
const controls = titlebar.querySelector('.controls') as HTMLElement;
const emptyState = document.getElementById('empty-state') as HTMLElement;

/** 变更视图状态（specs/040 FR-001）：`view` 全文 / `diff` 相对 HEAD 的对比 / `empty` 无改动 */
type SourceView = 'view' | 'diff' | 'empty' | 'error';
const state = {
  /** 全文内容（view 档；刷新时整份替换） */
  fullText: '',
  sourceView: 'view' as SourceView,
  canDiff: false,
  /** 最近一次 init 的原始载荷：切回全文时用它重建编辑器 */
  initData: null as MonacoInitData | null,
  /** 两档各自的视图状态，切来切去不丢滚动位置（specs/040 FR-002 第 3 段同款要求）。
   * 全文档是普通编辑器状态、变更档是 diff 编辑器状态，两套形状不同 */
  viewStates: new Map<'view', monaco.editor.ICodeEditorViewState | null>(),
  diffViewState: null as monaco.editor.IDiffEditorViewState | null,
  /** 进行中的 diff 请求 id：应答回来时对不上就丢弃（连点切换的过期回包） */
  pendingDiffRequest: null as string | null,
  /** 最近一次 diff 应答（切回变更档时不必重新请求） */
  lastDiff: null as DiffReply | null,
};

let sourceToggleButton: HTMLButtonElement | null = null;

// 主题跟随 prefers-color-scheme 的实现在 monacoSetup.ts（两入口共享）
function applyTheme(): void {
  monaco.editor.setTheme(currentTheme());
}

function initView(data: MonacoInitData): void {
  const lang = detectLanguage(data.filePath);
  const model = monaco.editor.createModel(data.content || '', lang);
  editor = monaco.editor.create(container, {
    model,
    theme: currentTheme(),
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    readOnly: false,
    tabSize: 2,
    wordWrap: 'on',
    unicodeHighlight: UNICODE_HIGHLIGHT_OFF,
  });
  if (data.selectedLines) {
    requestAnimationFrame(() => revealLines(editor as monaco.editor.IStandaloneCodeEditor, data.selectedLines));
  }
  window.setTimeout(() => editor?.focus(), 100);
}

function initDiff(data: MonacoInitData): void {
  const lang = detectLanguage(data.filePath, data.beforeContent);
  const original = monaco.editor.createModel(data.beforeContent || '', lang);
  const modified = monaco.editor.createModel(data.afterContent || '', lang);
  editor = monaco.editor.createDiffEditor(container, {
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
  (editor as monaco.editor.IStandaloneDiffEditor).setModel({ original, modified });
}

function initContent(data: MonacoInitData): void {
  const lang = detectLanguage(data.filePath, data.content);
  const model = monaco.editor.createModel(data.content || '', lang);
  editor = monaco.editor.create(container, {
    model,
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
}

function onInit(data: MonacoInitData): void {
  currentMode = data.mode;
  // 窗口标题随打开对象变化：调用方传的 title 已是文件名 / 短名（specs/016 FR-001）。
  // 构建期 HTML 的 <title> 只是兜底，页面加载完成会覆盖 BrowserWindow 的 title 选项，
  // 所以标题必须在这里设为 document.title。
  if (typeof data.title === 'string' && data.title) {
    document.title = data.title;
  }
  state.initData = data;
  state.fullText = typeof data.content === 'string' ? data.content : (data.afterContent ?? '');
  state.canDiff = data.canDiff === true && data.mode === 'view';
  state.viewStates.clear();
  state.lastDiff = null;
  buildTitlebar();
  // 打开时的初始视图（specs/040 FR-003）：`changes` 且可切换时直接落变更档
  const startInDiff = state.canDiff && data.initialView === 'changes';
  if (data.mode === 'view' && startInDiff) {
    requestDiff();
    return;
  }
  if (data.mode === 'diff') {
    state.sourceView = 'diff';
    initDiff(data);
  } else if (data.mode === 'content') {
    state.sourceView = 'view';
    initContent(data);
  } else {
    state.sourceView = 'view';
    initView(data);
  }
  applySourceView();
}

/** 清理旧的编辑器实例（切档 / 重新 init 共用；两档的 model 都要释放） */
function disposeEditor(): void {
  if (!editor) return;
  const model = editor.getModel();
  if (model && typeof (model as any).dispose === 'function') {
    (model as any).dispose();
  }
  const diff = editor as monaco.editor.IStandaloneDiffEditor;
  diff.getOriginalEditor?.()?.getModel()?.dispose?.();
  diff.getModifiedEditor?.()?.getModel()?.dispose?.();
  editor.dispose();
  editor = null;
}

// ==================== 变更视图（specs/040 FR-001） ====================

/** 标题栏：文件名 + 「全文 / 变更」切换按钮（标签是切换目标，与 Markdown 预览同款） */
function buildTitlebar(): void {
  docTitle.textContent = document.title;
  if (sourceToggleButton) {
    sourceToggleButton.disabled = !state.canDiff;
    return;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'source-toggle';
  button.addEventListener('click', () => toggleSourceView());
  controls.appendChild(button);
  sourceToggleButton = button;
  button.disabled = !state.canDiff;
  // `canDiff` 为假（非 git 工作区 / 虚拟文档）时按钮置灰并给出原因（AC-9）
  button.title = state.canDiff ? '切换全文 / 变更' : '不在 git 仓库内，无法显示变更';
}

/** 三档状态的 DOM 表现：全文 / diff 共用 `#container`；空态与错误态换成提示行（AC-2） */
function applySourceView(): void {
  if (!sourceToggleButton) return;
  const inDiff = state.sourceView === 'diff' || state.sourceView === 'empty' || state.sourceView === 'error';
  // diff 与全文都渲染在 `#container` 里（渲染实现只有一份编辑器容器），只有空态 / 错误态
  // 把它换成一整块提示
  const showHint = state.sourceView === 'empty' || state.sourceView === 'error';
  container.hidden = showHint;
  emptyState.hidden = !showHint;
  sourceToggleButton.textContent = inDiff ? '全文' : '变更';
  sourceToggleButton.setAttribute('aria-pressed', inDiff ? 'true' : 'false');
  sourceToggleButton.classList.toggle('active', inDiff);
  if (state.sourceView === 'empty') emptyState.textContent = '没有改动';
  if (state.sourceView === 'error') emptyState.textContent = '无法读取变更，请重试';
}

/** 点按钮：全文 ⇄ 变更。变更档首次进入要按需索取两侧原文（不预取） */
function toggleSourceView(): void {
  if (!state.canDiff) return;
  if (state.sourceView === 'view') {
    const viewState = (editor as monaco.editor.IStandaloneCodeEditor | null)?.saveViewState?.() ?? null;
    state.viewStates.set('view', viewState ?? null);
    if (state.lastDiff) {
      applyDiffReply(state.lastDiff);
      return;
    }
    requestDiff();
    return;
  }
  showFullView();
}

/** 回到全文档：用 init 的原始内容重建可编辑编辑器，恢复之前的滚动位置 */
function showFullView(): void {
  const data = state.initData;
  if (!data) return;
  state.sourceView = 'view';
  disposeEditor();
  initView({ ...data, content: state.fullText });
  applySourceView();
  const viewState = state.viewStates.get('view');
  if (viewState) requestAnimationFrame(() => (editor as monaco.editor.IStandaloneCodeEditor | null)?.restoreViewState(viewState));
}

/** 索取两侧原文（主进程跑 git show + 读盘，页面只渲染）。
 *
 * 已有在途请求时不重复发：连点切换会让后一个 requestId 覆盖前一个，先回的那份被当成
 * 过期丢弃（表现为「点了没反应」）。 */
function requestDiff(): void {
  const bridge = (window as unknown as { monacoDiffBridge?: { request(requestId: string): void } }).monacoDiffBridge;
  if (!bridge) {
    state.sourceView = 'error';
    applySourceView();
    return;
  }
  const requestId = `diff-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.pendingDiffRequest = requestId;
  bridge.request(requestId);
}

/** 应用主进程的 diff 应答（specs/040 AC-2 的空态判定在主进程的 buildDiffResult） */
function applyDiffReply(reply: DiffReply): void {
  if (reply.requestId !== null && reply.requestId !== state.pendingDiffRequest) return;
  state.pendingDiffRequest = null;
  state.lastDiff = reply;
  disposeEditor();
  if (reply.kind === 'error') {
    state.sourceView = 'error';
    emptyState.title = reply.message;
    applySourceView();
    return;
  }
  if (reply.kind === 'empty') {
    state.sourceView = 'empty';
    emptyState.removeAttribute('title');
    applySourceView();
    return;
  }
  state.sourceView = 'diff';
  initDiff({
    mode: 'diff',
    filePath: state.initData?.filePath,
    beforeContent: reply.payload.before,
    afterContent: reply.payload.after,
  });
  applySourceView();
  const diffViewState = state.diffViewState;
  if (diffViewState) {
    requestAnimationFrame(() => (editor as monaco.editor.IStandaloneDiffEditor | null)?.restoreViewState(diffViewState));
  }
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/** 刷新 view 模式的内容：保留滚动位置与光标（specs/018 FR-004）。
 *
 * 变更档下源文件被改动时，两侧原文都要重取（spec 边界第 2 条）：作废旧应答、
 * 重新索取，`lastDiff` 一并清掉，避免切回变更档时看到过期对比。 */
function onRefresh(content: string): void {
  state.fullText = content;
  if (state.sourceView !== 'view') {
    state.lastDiff = null;
    state.diffViewState = null;
    requestDiff();
    return;
  }
  if (currentMode !== 'view' || !editor) return;
  const codeEditor = editor as monaco.editor.IStandaloneCodeEditor;
  const model = codeEditor.getModel();
  if (!model) return;
  const viewState = codeEditor.saveViewState();
  model.setValue(content);
  if (viewState) codeEditor.restoreViewState(viewState);
}

// 接收 main 进程初始化 / 刷新 / 标题消息（经 preload 桥接为 window message）
window.addEventListener('message', (event) => {
  const data = event.data as
    | (MonacoInitData & { type: 'init' })
    | { type: 'refresh'; content: string }
    | { type: 'title'; title: string }
    | DiffReply;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'title') {
    if (typeof data.title === 'string' && data.title) {
      document.title = data.title;
      docTitle.textContent = data.title;
    }
    return;
  }
  if (data.type === 'refresh') {
    if (typeof data.content === 'string') onRefresh(data.content);
    return;
  }
  if (data.type === 'diff') {
    applyDiffReply(data);
    return;
  }
  if (data.type === 'init' && typeof data.mode === 'string') {
    onInit(data);
  }
});
