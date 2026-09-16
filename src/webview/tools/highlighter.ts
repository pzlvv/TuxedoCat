import type { Highlighter } from 'shiki';
import { getPreloadedHighlightLanguages, postMessage } from '../webviewEnv';
import { profileLog } from '../debug';

/**
 * 全局共享的 Shiki highlighter 单例（按需加载语言）。
 *
 * 设计要点：
 *
 * 1. **启动时不加载任何语法**：createHighlighter 只初始化主题与 WASM 引擎，
 *    语言语法（TextMate 语法 + 正则编译）全部等到真正需要时再加载。
 *    实测 38 种语言全量加载约 9.7MB 堆内存，而"引擎 + 0 语言"仅约 2.5MB；
 *    只加载实际用到的 1~2 种语言即可覆盖绝大多数会话。
 *
 * 2. **按需加载 + 并发去重**：同一语言被多个工具卡片同时请求时只加载一次，
 *    加载中的 Promise 会被复用（避免重复 import 与重复编译正则）。
 *
 * 3. **使用记录回写 settings.json**：语言首次加载成功后上报宿主，
 *    宿主写入 settings.json 的 highlightLanguages 字段；下次启动时宿主
 *    注入 window.__highlightLanguages，这里在后台顺序预热，
 *    让"常用语言"第二次起就无需等待。
 *
 * 4. **同步降级路径保留**：语言尚未加载完成时 getHighlighterSync() 仍返回
 *    highlighter 实例，但 codeToHtml 会因语言未加载抛错，调用方 catch 后
 *    先按纯文本渲染，等 ensureLanguage 完成后再重渲染为高亮。
 */

/** 与 EditFile / WriteFile 的主题保持一致（shiki v4 内置主题名） */
const THEMES = ['github-dark', 'github-light'] as const;

/** 内置语言：无需加载语法即可高亮（shiki 对 plaintext 有特殊处理） */
const BUILTIN_LANGUAGES = new Set(['plaintext', 'text', 'txt']);

let highlighterSingleton: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

/** 加载中的语言：language -> Promise，用于并发去重 */
const pendingLanguages = new Map<string, Promise<void>>();
/** 已成功加载的语言 */
const loadedLanguages = new Set<string>();
/** 本次会话已上报过的语言（避免重复 postMessage） */
const reportedLanguages = new Set<string>();
/** 宿主注入的历史语言集合（这些已记录过，无需再上报） */
let preloadedSet: Set<string> | null = null;

function getPreloadedSet(): Set<string> {
  if (preloadedSet === null) {
    preloadedSet = new Set(getPreloadedHighlightLanguages());
  }
  return preloadedSet;
}

/**
 * 获取（必要时创建）highlighter 单例。
 * 创建过程不含任何语言语法，因此非常轻量。
 *
 * 注意：这里用动态 import('shiki') 而不是顶层静态 import。
 * shiki 及其全部语法被 vite 的 manualChunks 合并成一个 chunk（约 9.2MB），
 * 静态导入会让浏览器在启动时必须下载 + 解析 + 编译这 9.2MB 才能执行主代码
 * （实测该 chunk 单独加载约 159ms，且编译开销体现在 profile 的 (program) 里）。
 * 改成动态导入后，它只在第一次真正需要高亮时才加载，完全不阻塞首屏；
 * 没有代码块的会话则永远不加载。
 */
export function getHighlighter(): Promise<Highlighter> {
  if (highlighterSingleton) return Promise.resolve(highlighterSingleton);
  if (!highlighterPromise) {
    const _t0 = performance.now();
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: [...THEMES],
        // 启动时不加载任何语法，全部按需加载
        langs: [],
      }),
    ).then((h) => {
      highlighterSingleton = h;
      profileLog(`[Profile] Shiki highlighter 初始化（0 语言） | 耗时=${(performance.now() - _t0).toFixed(2)}ms`);
      // 后台预热上次记录过的语言（不阻塞首帧）
      schedulePreload();
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

/**
 * 判断某语言当前是否可以直接用于 codeToHtml。
 * 内置语言恒为可用；其余需要已加载完成。
 */
export function isLanguageReady(language: string): boolean {
  if (BUILTIN_LANGUAGES.has(language)) return true;
  const h = highlighterSingleton;
  if (!h) return false;
  if (loadedLanguages.has(language)) return true;
  try {
    return h.getLoadedLanguages().includes(language);
  } catch {
    return false;
  }
}

/**
 * 语言首次加载成功后的本地记录。
 * 高亮语言预热集合改由 core 维护（DEVELOPMENT.md 第 7.3 节 2.6）：
 * core 在消息落盘时扫描围栏代码块语言写入 settings.json，
 * webview 不再上报（recordHighlightLanguage 协议消息已删除）。
 */
function reportLanguageUsed(language: string): void {
  if (reportedLanguages.has(language)) return;
  reportedLanguages.add(language);
}

/**
 * 按需加载语言语法。并发调用同一语言时复用同一个 Promise。
 * 语言不存在（宿主语言映射表里有、但 shiki 未内置，如 objc/matlab 的别名差异）
 * 时静默失败，调用方按纯文本降级。
 */
export function ensureLanguage(language: string): Promise<void> {
  if (!language || isLanguageReady(language)) return Promise.resolve();

  const existing = pendingLanguages.get(language);
  if (existing) return existing;

  const task = getHighlighter()
    .then((h) => h.loadLanguage(language as Parameters<Highlighter['loadLanguage']>[0]))
    .then(() => {
      loadedLanguages.add(language);
      reportLanguageUsed(language);
    })
    .catch((err) => {
      // 未知语言或加载失败：保持纯文本降级，不向上抛出中断渲染
      profileLog(`[Shiki] 语言按需加载失败 lang=${language} err=${err}`);
    })
    .finally(() => {
      pendingLanguages.delete(language);
    });

  pendingLanguages.set(language, task);
  return task;
}

/**
 * 后台预热宿主注入的"上次已使用语言"。
 * 顺序加载（而非并发）以避免多份语法同时编译正则造成主线程长任务。
 */
function schedulePreload(): void {
  const list = getPreloadedHighlightLanguages();
  if (list.length === 0) return;

  const _t0 = performance.now();
  void (async () => {
    let loadedCount = 0;
    for (const lang of list) {
      if (isLanguageReady(lang)) continue;
      const before = loadedLanguages.size;
      await ensureLanguage(lang);
      if (loadedLanguages.size > before) loadedCount++;
    }
    profileLog(`[Profile] Shiki 预热完成 | 请求=${list.length} 新加载=${loadedCount} 耗时=${(performance.now() - _t0).toFixed(2)}ms`);
  })();
}

/**
 * 清空预热状态缓存（仅测试/宿主切换语言配置时使用）。
 */
export function resetHighlightLanguageCache(): void {
  preloadedSet = null;
}
