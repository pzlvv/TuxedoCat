/**
 * Markdown 预览正文渲染（纯函数风格，无宿主依赖），由
 * `ElectronUIHost.openMarkdownPreviewWindow` 调用：渲染结果经 `markdown-init` /
 * `markdown-refresh` 下发给 `dist/monaco/markdown.html` 页面注入 `.markdown-body`
 * （页面自带标题栏 / 文本视图 / 深浅色样式——`electron/monaco/markdown.css`）。
 *
 * 内容对渲染器零信任（md 文件可能来自任意仓库）：
 * - 原生 HTML 片段按字面转义展示，不执行脚本、不保留内联事件——与 VS Code
 *   内置 Markdown 预览的净化立场一致；
 * - 链接只放行 http(s) / mailto / 页内锚点，其余协议（javascript:、file: 等）
 *   降级为纯文本。相对链接没有可解析的根，同样按纯文本渲染。
 */

/** 最小渲染器接口（结构化：不把 marked 的泛型与重载漏给调用方；默认同步，返回按 string 收窄） */
interface SyncMarkdownRenderer {
  parse(src: string, options?: unknown): string | Promise<string>;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 允许成链的协议（页内锚点给标题跳转留口；其余按纯文本渲染） */
const SAFE_LINK_HREF = /^(https?:|mailto:|#)/i;

/**
 * 渲染器实例是模块级单例：净化规则只装配一次。
 * marked 是 ESM-only，Node16 解析下只能动态 import（与 core Read 工具的
 * isbinaryfile 同一用法）；renderer 参数与 this 均靠 `marked.use` 的上下文类型
 * 推断，不显式引用 marked 的类型（静态 type-only import 在 CJS 下被 TS 拒绝）。
 */
let rendererSingleton: Promise<SyncMarkdownRenderer> | undefined;

function loadRenderer(): Promise<SyncMarkdownRenderer> {
  rendererSingleton ??= (async () => {
    const { Marked } = await import('marked');
    const marked = new Marked({ gfm: true });
    marked.use({
      renderer: {
        // 块级 HTML 与内联标签（Tag）都走这里：按字面转义，不进 DOM
        html(token) {
          return escapeHtml(token.text ?? token.raw ?? '');
        },
        link(token) {
          const inner = this.parser.parseInline(token.tokens);
          const href = token.href ?? '';
          if (!SAFE_LINK_HREF.test(href)) return String(inner);
          const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
          return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
        },
      },
    });
    return marked;
  })();
  return rendererSingleton;
}

/** Markdown → 预览正文 HTML（GFM：表格 / 任务列表 / 删除线；页面注入 `.markdown-body`） */
export async function getMarkdownPreviewBodyHtml(markdown: string): Promise<string> {
  const marked = await loadRenderer();
  return String(marked.parse(markdown ?? ''));
}
