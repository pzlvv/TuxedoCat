/**
 * MEMTEST 桩：替代 shiki 全量 bundle。
 * 目的：测量 shiki（全部语法 + wasm 引擎 + 主题）在 webview 中的内存占用。
 * API 面与 highlighter.ts / EditFile / WriteFile 实际用到的最小集合保持一致。
 */
const NOOP_HTML = (text) => `<pre><code>${String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;

function makeStubHighlighter() {
  return {
    codeToHtml: (code) => NOOP_HTML(code),
    codeToTokens: () => ({ tokens: [] }),
    getLoadedLanguages: () => [],
    getLoadedThemes: () => [],
    loadLanguage: async () => {},
    loadTheme: async () => {},
    dispose: () => {},
  };
}

export function createHighlighter() { return Promise.resolve(makeStubHighlighter()); }
export function createHighlighterCore() { return Promise.resolve(makeStubHighlighter()); }
export function getSingletonHighlighter() { return Promise.resolve(makeStubHighlighter()); }
export function createJavaScriptRegexEngine() { return {}; }
export function createOnigurumaEngine() { return Promise.resolve({}); }
export async function loadWasm() { return {}; }
export function codeToHtml(code) { return NOOP_HTML(code); }
export function codeToTokens() { return { tokens: [] }; }
export const bundledLanguages = {};
export const bundledThemes = {};
export const bundledLanguagesInfo = [];
export default { createHighlighter, getSingletonHighlighter };
