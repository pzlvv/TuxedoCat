/**
 * 收尾时 thinking 是否熄灭的纯判定（docs/hosts/webview-ui.md 第 6 节）。
 *
 * 一次查询由多个 LLM 轮次组成，轮次之间夹着工具批次与压缩；这两处收尾写在各自的
 * handler 里，如果各自「无条件熄灭」，工具卡片风车熄灭之后到下一轮 `aiBegin` 之间
 * 就会出现没有任何进行中指示的窗口。判定抽成纯函数后可以直接单测。
 *
 * 运行方式：npm run test:unit -- thinkingVisibility
 */

import { shouldShowThinkingAfterCompact } from '../webview/thinkingVisibility';
import { createChecker, runTests } from './helpers/harness';

runTests('thinkingVisibility', () => {
  const { check, finish } = createChecker();

  // ── RT-1：自动压缩收尾（压缩前查询仍在进行）后保持点亮 ──
  check(
    '自动压缩收尾（压缩前有活跃查询）→ 保持 thinking'
      + `（实际：${shouldShowThinkingAfterCompact(true)}）`,
    shouldShowThinkingAfterCompact(true) === true,
  );

  // ── RT-2：手动压缩（压缩前没有活跃查询）收尾后必须熄灭 ──
  check(
    '手动压缩收尾（压缩前无活跃查询）→ 熄灭 thinking'
      + `（实际：${shouldShowThinkingAfterCompact(false)}）`,
    shouldShowThinkingAfterCompact(false) === false,
  );

  finish();
});
