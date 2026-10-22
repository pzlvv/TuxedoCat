/**
 * Markdown 预览 HTML 模板（纯函数风格，无宿主依赖），由
 * `ElectronUIHost.openMarkdownPreviewWindow` 调用：侧栏双击 `.md` 文件时把
 * 渲染好的只读 HTML 经 data URL 装进沙箱窗口（与 `mermaidHtml.ts` 同一模式）。
 *
 * 内容对渲染器零信任（md 文件可能来自任意仓库）：
 * - 原生 HTML 片段按字面转义展示，不执行脚本、不保留内联事件——与 VS Code
 *   内置 Markdown 预览的净化立场一致；
 * - 链接只放行 http(s) / mailto / 页内锚点，其余协议（javascript:、file: 等）
 *   降级为纯文本。相对链接在 data: 页面里无处可去，同样按纯文本渲染。
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

interface PreviewPalette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  codeBg: string;
  preBg: string;
  accent: string;
  quoteBorder: string;
}

/** 深浅色两套配色（暗色与 Monaco 查看窗的 #1e1e1e 底色一致，避免加载期闪色） */
function palette(isDark: boolean): PreviewPalette {
  return isDark
    ? {
        bg: '#1e1e1e', fg: '#d4d4d8', muted: '#9f9fa9', border: '#3f3f46',
        codeBg: 'rgba(255,255,255,0.09)', preBg: '#26262b', accent: '#6cb6ff',
        quoteBorder: '#52525b',
      }
    : {
        bg: '#ffffff', fg: '#1f2328', muted: '#59636e', border: '#d1d9e0',
        codeBg: 'rgba(129,139,152,0.14)', preBg: '#f6f8fa', accent: '#0969da',
        quoteBorder: '#d1d9e0',
      };
}

/** Markdown → 只读预览正文 HTML（刷新时只替换 `.markdown-body` 的内容，保留滚动） */
export async function getMarkdownPreviewBodyHtml(markdown: string): Promise<string> {
  const marked = await loadRenderer();
  return String(marked.parse(markdown ?? ''));
}

/** Markdown → 只读预览 HTML（GFM：表格 / 任务列表 / 删除线；语法高亮不在 v1 范围） */
export async function getMarkdownPreviewHtml(
  markdown: string,
  opts: { title: string; isDark: boolean },
): Promise<string> {
  const body = await getMarkdownPreviewBodyHtml(markdown);
  const c = palette(opts.isDark);
  const title = escapeHtml(opts.title);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: ${c.bg}; }
    body {
      color: ${c.fg};
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 15px;
      line-height: 1.65;
    }
    .markdown-body { max-width: 980px; margin: 0 auto; padding: 32px 28px 64px; }
    h1, h2, h3, h4, h5, h6 { margin: 24px 0 12px; font-weight: 600; line-height: 1.3; }
    h1, h2 { padding-bottom: 8px; border-bottom: 1px solid ${c.border}; }
    h1 { font-size: 26px; } h2 { font-size: 22px; } h3 { font-size: 18px; }
    h4 { font-size: 16px; } h5, h6 { font-size: 14px; }
    p { margin: 12px 0; }
    a { color: ${c.accent}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
      font-size: 13px;
      background: ${c.codeBg};
      border-radius: 4px;
      padding: 2px 6px;
    }
    pre { margin: 12px 0; padding: 14px 16px; background: ${c.preBg}; border-radius: 8px; overflow: auto; }
    pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; }
    blockquote {
      margin: 12px 0; padding: 4px 16px;
      border-left: 4px solid ${c.quoteBorder};
      color: ${c.muted};
    }
    table { border-collapse: collapse; margin: 12px 0; display: block; overflow: auto; }
    th, td { border: 1px solid ${c.border}; padding: 6px 13px; }
    th { background: ${c.preBg}; font-weight: 600; }
    img { max-width: 100%; }
    hr { height: 1px; border: none; background: ${c.border}; margin: 24px 0; }
    ul, ol { padding-left: 28px; }
    li { margin: 4px 0; }
    li input[type="checkbox"] { margin-right: 6px; }
  </style>
</head>
<body>
  <article class="markdown-body">${body}</article>
</body>
</html>`;
}
