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
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import 'monaco-editor/min/vs/editor/editor.main.css';

// ── Monaco worker 配置 ──
(self as any).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json': return new jsonWorker();
      case 'css': case 'scss': case 'less': return new cssWorker();
      case 'html': case 'handlebars': case 'razor': return new htmlWorker();
      case 'typescript': case 'javascript': return new tsWorker();
      default: return new editorWorker();
    }
  },
};

// ── 语言推断 ──
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.md': 'markdown', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell', '.bash': 'shell',
  '.sql': 'sql', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.cs': 'csharp',
};

function detectLanguage(filePath?: string, content?: string): string {
  if (filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  if (content && content.trimStart().startsWith('{')) return 'json';
  return 'plaintext';
}

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
const container = document.getElementById('container')!;

function applyTheme(): void {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
}

function revealLines(e: monaco.editor.IStandaloneCodeEditor, lines?: { start: number; end: number }): void {
  if (!lines) return;
  const startLine = Math.max(1, lines.start);
  const endLine = Math.max(startLine, lines.end);
  e.revealLineInCenter(startLine);
  e.setSelection(new monaco.Range(startLine, 1, endLine, 1));
}

function initView(data: MonacoInitData): void {
  const lang = detectLanguage(data.filePath);
  const model = monaco.editor.createModel(data.content || '', lang);
  editor = monaco.editor.create(container, {
    model,
    theme: 'vs-dark',
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    readOnly: false,
    tabSize: 2,
    wordWrap: 'on',
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
    theme: 'vs-dark',
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: false },
    renderSideBySide: true,
    readOnly: true,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
  });
  (editor as monaco.editor.IStandaloneDiffEditor).setModel({ original, modified });
}

function initContent(data: MonacoInitData): void {
  const lang = detectLanguage(data.filePath, data.content);
  const model = monaco.editor.createModel(data.content || '', lang);
  editor = monaco.editor.create(container, {
    model,
    theme: 'vs-dark',
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    readOnly: true,
    wordWrap: 'on',
  });
}

function onInit(data: MonacoInitData): void {
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

// 接收 main 进程初始化数据（经 preload 桥接为 window message）
window.addEventListener('message', (event) => {
  const data = event.data as MonacoInitData;
  if (data && typeof data.mode === 'string') {
    onInit(data);
  }
});
