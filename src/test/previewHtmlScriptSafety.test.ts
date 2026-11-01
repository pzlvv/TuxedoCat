/**
 * 预览页 HTML 内联脚本的转义（`src/host/mermaidHtml.ts` / `src/host/ui/spinDesignHtml.ts`）。
 *
 * 两个页面都把「来自模型 / 磁盘的事实」直接拼进内联 `<script>`：Mermaid 图源是
 * 模型输出的代码块，Spin 设计数据是 `spin.json` 里的任务描述。HTML 解析器在
 * `<script>` 元素内只认 `</script`，所以正文里出现这七个字符就会提前结束脚本元素、
 * 其后的内容被当成 HTML 标记解析——图表不渲染（页面空白）+ 注入的标记被执行
 * （VS Code 面板 `enableScripts: true`，Electron 预览窗口同样执行页面脚本）。
 *
 * 断言口径：
 * - 页面里的 `<script` 与 `</script>` 数量一致（没有提前闭合 / 没有被吞掉）；
 * - 正文里的标记形态不出现在 HTML 里；
 * - 从页面里取出的 JS 字面量反解后与入参逐字相同（转义不改变内容）。
 *
 * 运行方式：npm run test:all -- preview-html-script-safety
 */

import { getMermaidErrorHtml, getMermaidPreviewHtml } from '../host/mermaidHtml';
import { getSpinDesignHtml } from '../host/ui/spinDesignHtml';
import { createChecker, runTests } from './helpers/harness';

/** 能提前闭合内联脚本的样本（同时带一个可执行的注入负载） */
const PAYLOAD = 'graph TD\n  A[</script><img src=x onerror=alert(1)>] --> B';

/** 取页面里第一个内联 `<script>` 的原文（`<script src=...>` 是外链，跳过） */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
}

/**
 * 注入负载是否以**标记**形态出现。
 *
 * 只查字面的 `<img src=x`：负载里的 `<` 一旦按 `\u003c` 转义，页面里就不再有这个
 * 标记；`onerror=alert(1)` 本身留在脚本字符串里是正常的（那是 JS 字面量，不是标记）。
 */
function hasMarkupInjection(html: string): boolean {
  return html.includes('<img src=x');
}

/** 从内联脚本里取出某个字面量赋值右侧的原文；取不到时返回 null（由调用方断言） */
function literalOf(script: string, declaration: RegExp): string | null {
  const match = declaration.exec(script);
  return match ? (match[1] ?? '').trim() : null;
}

function run(): void {
  const { check, finish } = createChecker();

  // ---------------- RT-1：Mermaid 预览页 ----------------

  const previewHtml = getMermaidPreviewHtml(PAYLOAD, 'mermaid.min.js', true);
  const previewScripts = inlineScripts(previewHtml);
  check(
    'RT-1 Mermaid 预览页：`<script` 与 `</script>` 数量一致（正文里的闭合标签不提前结束脚本元素）',
    (previewHtml.match(/<script/g) ?? []).length === (previewHtml.match(/<\/script>/g) ?? []).length,
  );
  check(
    'RT-1 Mermaid 预览页：注入负载不进入标记',
    !hasMarkupInjection(previewHtml),
  );

  const lastCode = literalOf(previewScripts.join('\n'), /let lastCode = ([\s\S]*?);\n/);
  check('RT-1 Mermaid 预览页：lastCode 字面量反解回原文（转义不改内容）',
    lastCode !== null && JSON.parse(lastCode) === PAYLOAD);

  // ---------------- RT-2：Spin 设计器页 ----------------

  const spinData = {
    nodes: [{ id: 1, x: 0, y: 0, task: `节点 </script><img src=x onerror=alert(1)>`, criteria: [] }],
    edges: [],
    meta: {},
  };
  const spinHtml = getSpinDesignHtml(spinData, true, 'en');
  check(
    'RT-2 Spin 设计器页：`<script` 与 `</script>` 数量一致',
    (spinHtml.match(/<script/g) ?? []).length === (spinHtml.match(/<\/script>/g) ?? []).length,
  );
  check(
    'RT-2 Spin 设计器页：注入负载不进入标记',
    !hasMarkupInjection(spinHtml),
  );
  const initialData = literalOf(inlineScripts(spinHtml).join('\n'), /const initialData = ([\s\S]*?);\n/);
  check('RT-2 Spin 设计器页：initialData 字面量反解回原数据',
    initialData !== null
    && JSON.stringify(JSON.parse(initialData)) === JSON.stringify(spinData));

  // ---------------- RT-3：Mermaid 错误页 ----------------

  const errorHtml = getMermaidErrorHtml(PAYLOAD, 'Parse error near </script><img src=x onerror=alert(1)>');
  check(
    'RT-3 Mermaid 错误页：错误文案与源码都按字面转义',
    !errorHtml.includes('<img src=x') && errorHtml.includes('&lt;/script&gt;'),
  );

  finish();
}

runTests('preview-html-script-safety', run);
