/**
 * Shiki 高亮语言的宿主侧记录（`settings.json` 的 `highlightLanguages` 字段）。
 *
 * 这是 **UI 专属**字段：只有 UI 消费（webview 启动时注入预热、webview 上报后合并），
 * Core 不感知、不落盘、不进配置快照（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
 */

/** Shiki 已使用语言在 settings.json 中的字段名 */
export const HIGHLIGHT_LANGUAGES_FIELD = 'highlightLanguages';

/** 记录上限：避免长期使用后字段无限增长（只保留最近使用的语言） */
const HIGHLIGHT_LANGUAGES_MAX = 60;

/**
 * 构造「把 languages 并入 highlightLanguages 字段」的 settings.json 修改器。
 *
 * 去重与上限都在这里，调用方只报告「这一批用到过哪些语言」。
 */
export function highlightLanguagesMutator(
  languages: readonly string[],
): (cfg: Record<string, any>) => void {
  return (cfg) => {
    const current: unknown = cfg[HIGHLIGHT_LANGUAGES_FIELD];
    const list: string[] = Array.isArray(current)
      ? current.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    let changed = false;
    for (const language of languages) {
      if (typeof language !== 'string' || !language) continue;
      if (list.includes(language)) continue;
      list.push(language);
      changed = true;
    }
    if (!changed) return;
    // 超出上限时丢弃最早记录，保持字段体积可控
    cfg[HIGHLIGHT_LANGUAGES_FIELD] = list.length > HIGHLIGHT_LANGUAGES_MAX
      ? list.slice(list.length - HIGHLIGHT_LANGUAGES_MAX)
      : list;
  };
}
