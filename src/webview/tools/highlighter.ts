import { createHighlighter, type Highlighter } from 'shiki';

/**
 * 全局共享的 Shiki highlighter 单例。
 *
 * EditFile / WriteFile 等工具以前各自 createHighlighter（WriteFile 还加载了
 * 36 种语言 + 独立主题），每次新建实例都会重新初始化 WASM 与全部语言/主题，
 * 在渲染路径上造成明显卡顿。这里统一为一个单例：只初始化一次，之后所有
 * 组件共享，避免重复加载。
 *
 * 注意：language 集合取 EditFile 与 WriteFile 的并集；主题统一使用
 * 'github-dark' / 'github-light'（shiki v4 内置主题名）。
 */
let highlighterSingleton: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (highlighterSingleton) return Promise.resolve(highlighterSingleton);
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [
        'javascript', 'jsx', 'typescript', 'tsx', 'python', 'java', 'c', 'cpp',
        'csharp', 'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'dart',
        'scala', 'haskell', 'lua', 'perl', 'r', 'sql', 'html', 'css', 'scss',
        'sass', 'less', 'json', 'yaml', 'toml', 'xml', 'markdown', 'bash',
        'shell', 'powershell', 'dockerfile', 'makefile', 'plaintext',
      ],
    }).then((h) => {
      highlighterSingleton = h;
      return h;
    }).catch((err) => {
      highlighterPromise = null; // reset on failure so next caller retries
      throw err;
    });
  }
  return highlighterPromise;
}

/** 同步获取已初始化的单例（未初始化时返回 null，调用方需降级为纯文本）。 */
export function getHighlighterSync(): Highlighter | null {
  return highlighterSingleton;
}
