/**
 * 内联 `<script>` 字面量工具（`src/shared/utils/inlineScript.ts`）。
 *
 * 这是两个预览页共用的唯一实现（specs/defects/preview-html-script-close-injection.md）：
 * `JSON.stringify` 只保证合法 JS，HTML 解析器在脚本元素内还会在 `</script` 处提前闭合，
 * 因此 `<` / `>` / `&` / U+2028 / U+2029 必须转成 `\uXXXX`。
 *
 * 断言口径：
 * - 转义后不含任何能改变 HTML 元素边界的字符；
 * - `JSON.parse` 反解后与入参逐字相同（只改表示法，不改内容）；
 * - 普通内容不被改写（不做无谓的字符替换）。
 *
 * 运行方式：npm run test:unit -- inline-script
 */

import { toInlineScriptJson } from '../shared/utils/inlineScript';
import { createChecker, runTests } from './helpers/harness';

function run(): void {
  const { check, finish } = createChecker();

  const payload = 'a</script><img src=x onerror=alert(1)>b';
  const encoded = toInlineScriptJson(payload);
  check('RT-1 尖括号被转义，字面量里不再出现标记边界',
    !encoded.includes('<') && !encoded.includes('>'));
  check('RT-1 反解回原文（转义不改内容）', JSON.parse(encoded) === payload);

  check('RT-2 & 与 U+2028 / U+2029 一并转义',
    !toInlineScriptJson('a&b').includes('&')
    && !toInlineScriptJson('a\u2028b').includes('\u2028')
    && !toInlineScriptJson('a\u2029b').includes('\u2029'));

  check('RT-3 非 ASCII 与引号保持可读（不做无谓转义）',
    toInlineScriptJson('中文 "q"') === '"中文 \\"q\\""');

  check('RT-4 对象 / 数组 / null 与非字符串值走同一出口',
    JSON.stringify(JSON.parse(toInlineScriptJson({ a: ['</script>', 1, true, null] })))
      === JSON.stringify({ a: ['</script>', 1, true, null] })
    && toInlineScriptJson(null) === 'null');

  finish();
}

runTests('inline-script', run);
