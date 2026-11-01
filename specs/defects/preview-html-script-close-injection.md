---
status: 已修
---

# 缺陷：预览页把模型 / 磁盘文本直接拼进内联脚本，`</script>` 提前闭合元素

Mermaid 预览页（`src/host/mermaidHtml.ts`）与 Spin 设计器页
（`src/host/ui/spinDesignHtml.ts`）都把来自对话或磁盘的事实拼进内联 `<script>`：
前者是模型输出的图源代码（`let lastCode = ${JSON.stringify(code)}`），后者是
`spin.json` 的任务描述（`const initialData = ${JSON.stringify(existingData)}`）。

`JSON.stringify` 只保证产出的字面量是合法**JS**，不保证它在 `<script>` 元素里安全：
HTML 解析器在脚本元素内只认 `</script` 这七个字符，命中即结束脚本元素、把后续文本
当标记解析。于是图源里出现 `</script>` 就会：脚本被截断成语法错误的片段（图表不渲染、
页面空白），紧随其后的内容被当成 HTML 执行——VS Code 面板以 `enableScripts: true`
打开（`src/VSCodeUIHost.ts` 的 `openMermaidPreview`），Electron 预览窗口同样执行页面
脚本。

## 现状

- `src/host/mermaidHtml.ts` 的 `getMermaidPreviewHtml`：

  ```ts
  let lastCode = ${JSON.stringify(code)};
  ```

- `src/host/ui/spinDesignHtml.ts` 的 `getSpinDesignHtml`：

  ```ts
  const initialData = existingData ? JSON.stringify(existingData) : 'null';
  ...
  const initialData = ${initialData};
  ```

- 同文件另有 `__spinDict` / `__spinFallbackDict` / `__spinAvailableSkills` 三处
  `JSON.stringify` 直插（取值来自仓库内的翻译表与技能名，不是外部文本，本次一并走同一出口）。

- `getMermaidErrorHtml` 的两段 `<pre>` 里，`errorMsg` 完全未转义（源码那一段走了
  `escapeHtml`）。`errorMsg` 来自 `String(err)` 或 mermaid 的解析错误，可能含图源片段。

- 复现（`getMermaidPreviewHtml('graph TD\n  A[</script><img src=x onerror=alert(1)>] --> B', ...)`）：

  ```
  let lastCode = "graph TD\n  A[</script><img src=x onerror=alert(1)>] --> B";
  ```

  页面的 `<script` 计数（2）与 `</script>` 计数（3）不再相等；`<img src=x onerror=...>`
  以标记形式出现在 HTML 里。

- 复现（`getSpinDesignHtml`，节点任务含同样的负载）：

  ```
  const initialData = {"nodes":[{"id":1,...,"task":"zz </script><script>alert(1)</script> yy",...}]};
  ```

## 期望

1. **内联脚本里的字符串字面量不可提前闭合脚本元素**：凡拼进 `<script>` 的
   `JSON.stringify` 结果，`<` / `>` / `&` / U+2028 / U+2029 都转成 `\uXXXX` 转义
   （JS 语义等价，HTML 里不再出现标记边界）。
2. **反解后内容逐字不变**：转义只改表示法，`JSON.parse` 得到的值与入参 `deepStrictEqual`。
3. **页面的 `<script` 与 `</script>` 数量一致**，注入负载不进标记。
4. `getMermaidErrorHtml` 的错误文案同样按字面转义（与源码那一段同口径）。

## 不变量

- 页面结构与样式不变：仍是单文件 HTML，Mermaid 页仍从外部 `mermaid.min.js` 加载
  （`docs/hosts/host-matrix.md` 的 `openMermaidPreview` 一行），不引入打包步骤。
- 转义在**生成侧**完成，两个宿主（VS Code `WebviewPanel` / Electron `data:` URL）零改动。
- 画面内容不变：Mermaid 图源与 Spin 任务描述反解后与原值逐字相同，渲染结果不受影响。
- 既有的 `escapedCode`（`<pre>` 里的源码）继续走 `escapeHtml`，不改用脚本转义。

## 回归测试

- **RT-1**：Mermaid 预览页在图源含 `</script><img ...>` 时，`<script` 与 `</script>`
  数量一致、负载不进标记，且 `lastCode` 反解回原文。
  （落点：`src/test/previewHtmlScriptSafety.test.ts`）
- **RT-2**：Spin 设计器页在任务描述含同样负载时，脚本数量一致、负载不进标记，
  `initialData` 反解后与入参 `deepStrictEqual`。
- **RT-3**：Mermaid 错误页的错误文案与源码都按字面转义（负载不进标记）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 ~ RT-3（修复前） | `node scripts/run-tests.mjs preview-html-script-safety` | 红 | 7 项断言全红：两个页面的 `<script` / `</script>` 计数不等、注入负载以标记形式出现、错误页的 `</script>` 未转义 |
| RT-1 ~ RT-3（修复后） | `node scripts/run-tests.mjs preview-html-script-safety` | 绿 | 7 通过 / 0 失败：脚本元素不再提前闭合，字面量反解后与原值逐字相同 |
| 既有回归 | `node scripts/run-tests.mjs spin-design-core` | 绿 | 设计器页的既有结构断言（`spinDesignError` / 初始禁保存 / 可保存分支）全过 |
| 全量单测 | `npm run test:unit` | 绿 | 100 通过 / 0 失败 |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 含 webview / electron 三份配置 |
