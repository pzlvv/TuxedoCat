/**
 * Monaco 文本查看窗口（`index.html`）与 Markdown 预览窗口（`markdown.html`）共享的
 * 编辑器装配：worker 配置、语言推断、主题跟随、行定位与公共参数。两个入口经 vite
 * 多入口共享同一份 Monaco bundle，这份装配是其唯一写入点。
 */

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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
// 值必须是 monaco-editor 注册的 language id（`esm/vs/basic-languages/<x>/<x>.contribution.js`
// 里的 `id`，别名也能用但 id 更稳）。表里没有的扩展名落到 plaintext：文件仍能打开，
// 只是没有着色，所以新增扩展名时先确认 monaco 有对应 id 再加。
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.md': 'markdown', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less', '.xml': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.bat': 'bat', '.cmd': 'bat', '.ps1': 'powershell',
  '.sql': 'sql', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp',
  '.hpp': 'cpp', '.cc': 'cpp',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp',
  '.lua': 'lua', '.dart': 'dart', '.scala': 'scala', '.clj': 'clojure', '.cljs': 'clojure',
  '.r': 'r', '.pl': 'perl', '.pm': 'perl', '.proto': 'proto', '.graphql': 'graphql',
  '.ex': 'elixir', '.exs': 'elixir',
};

export function detectLanguage(filePath?: string, content?: string): string {
  if (filePath) {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  if (content && content.trimStart().startsWith('{')) return 'json';
  return 'plaintext';
}

// 整体关闭 Monaco 内建的 Unicode 混淆字符高亮：默认会把全角括号（U+FF08「（」）判为与
// ASCII「(」同形而高亮并弹「Adjust settings」悬停提示；中文文案里全角标点是常态，属误报。
export const UNICODE_HIGHLIGHT_OFF: monaco.editor.IUnicodeHighlightOptions = {
  nonBasicASCII: false,
  invisibleCharacters: false,
  ambiguousCharacters: false,
};

// 主题跟随 prefers-color-scheme（主进程 nativeTheme.themeSource 驱动，应用内切换
// 主题会触发 change 事件）。创建编辑器时必须现算主题：全局 setTheme 会被创建
// 参数里硬编码的 theme 覆盖，导致浅色系统下打开的编辑器仍是深色。
export function currentTheme(): string {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
}

/** 应用当前主题并随系统切换持续跟随（两个入口共用同一订阅） */
export function followSystemEditorTheme(onChange?: () => void): void {
  const apply = (): void => {
    monaco.editor.setTheme(currentTheme());
    onChange?.();
  };
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}

/** 定位到选中行并划选（openFile 链接带的行号定位） */
export function revealLines(e: monaco.editor.IStandaloneCodeEditor, lines?: { start: number; end: number }): void {
  if (!lines) return;
  const startLine = Math.max(1, lines.start);
  const endLine = Math.max(startLine, lines.end);
  e.revealLineInCenter(startLine);
  e.setSelection(new monaco.Range(startLine, 1, endLine, 1));
}
