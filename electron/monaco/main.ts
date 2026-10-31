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
}

let editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null = null;
/** 当前页面模式：刷新只对 view 模式生效（specs/018 FR-004） */
let currentMode: MonacoInitData['mode'] = 'view';
const container = document.getElementById('container')!;

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
  // 清理旧的编辑器实例
  if (editor) {
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
  if (data.mode === 'diff') {
    initDiff(data);
  } else if (data.mode === 'content') {
    initContent(data);
  } else {
    initView(data);
  }
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/** 刷新 view 模式的内容：保留滚动位置与光标（specs/018 FR-004）。 */
function onRefresh(content: string): void {
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
    | { type: 'title'; title: string };
  if (!data || typeof data !== 'object') return;
  if (data.type === 'title') {
    if (typeof data.title === 'string' && data.title) document.title = data.title;
    return;
  }
  if (data.type === 'refresh') {
    if (typeof data.content === 'string') onRefresh(data.content);
    return;
  }
  if (data.type === 'init' && typeof data.mode === 'string') {
    onInit(data);
  }
});
