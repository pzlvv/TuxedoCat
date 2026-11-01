/**
 * 内联 `<script>` 里的 JS 字面量（唯一实现）。
 *
 * 宿主打开的预览页都是「单文件 HTML + 内联脚本」：Mermaid 预览页把模型输出的图源
 * 拼进 `let lastCode = ...`（`src/host/mermaidHtml.ts`），Spin 设计器页把 `spin.json`
 * 拼进 `const initialData = ...`（`src/host/ui/spinDesignHtml.ts`）。
 *
 * `JSON.stringify` 只保证产出合法 **JS**，不保证在 `<script>` 元素里安全：HTML 解析器
 * 在脚本元素内只认 `</script` 这七个字符，正文一旦含它就提前结束脚本元素，其余内容
 * 被当作标记解析——图表不渲染、注入的标记被执行
 * （specs/defects/preview-html-script-close-injection.md）。
 *
 * 因此凡拼进 `<script>` 的字面量都走这里：`<` / `>` / `&` 与 U+2028 / U+2029 转成
 * `\uXXXX`。转义只改表示法，`JSON.parse` 反解后与入参逐字相同。
 *
 * 本模块零依赖（只有 `JSON.stringify`）：宿主与 webview 都能直接 import。
 */

/** 在 `<script>` 内会被 HTML 解析器 / JS 词法器特殊对待的字符 */
const UNSAFE_IN_SCRIPT = /[<>&\u2028\u2029]/g;

/** 值 → 可安全内联进 `<script>` 的 JS 字面量文本（语义等价于 `JSON.stringify`） */
export function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE_IN_SCRIPT,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
