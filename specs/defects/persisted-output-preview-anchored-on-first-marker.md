---
status: 已修
---

# 缺陷：持久化输出的预览解析按「第一个 Preview 字样」定位，路径或正文命中时整段预览被截成半截

`parsePersistedOutput`（`src/webview/tools/persistedOutput.tsx`）是
`<persisted-output>` 预览消息的**唯一**解析方（Bash 卡片与 assistant 消息共用这一条）。
它用两个「找第一个命中的字符串」定位正文：`body.indexOf('Preview')` 找预览起点、
`output.indexOf('</persisted-output>')` 找结尾。两处都按一阶出现位置定位，
而这两处文本都可能提前出现在**路径或正文内容**里，于是预览被从错误的位置切开。

原始内容来自工具输出，无法约束：「查看器 / 工具的源码」「带 `Preview` 目录的路径」
「讨论这个标签格式的对话」都会命中。表现是预览框里少了正文、多出一行
`Preview (first 2K + last 2K):` 的表头，甚至只剩半个引号——用户对着被截断的内容排查，
却以为工具输出真的只有这些。

## 现状

- `parsePersistedOutput`（`src/webview/tools/persistedOutput.tsx`）：

  ```ts
  const startIdx = output.indexOf(persistedTag);
  const endIdx = output.indexOf(closingTag);
  const body = output.slice(startIdx + persistedTag.length, endIdx).trim();
  const filePathMatch = body.match(/Full output saved to: (.+)$/m);
  // ...
  const previewMarker = 'Preview';
  const previewMarkerIdx = body.indexOf(previewMarker);
  if (previewMarkerIdx !== -1) {
    const previewStart = body.indexOf('\n', previewMarkerIdx);
    if (previewStart !== -1) preview = body.slice(previewStart + 1).trimEnd();
  }
  ```

  上面的 `body.indexOf(previewMarker)` 命中的是 `body` 里**第一个** `Preview`——既可能是表头
  `Preview (first 2K + last 2K):`，也可能是路径里的 `Preview` 目录名，还可能是正文里
  更早出现的同一个词。`endIdx` 同理：正文里出现 `</persisted-output>` 字面量时，
  结尾被提前截断。

- 复现（仓库根，照抄该实现跑三组输入）：

  ```
  node /tmp/fuzz_persisted.cjs
  ```

  实测输出：

  ```
  FAIL 文件路径含 Preview 目录
     preview= "\nPreview (first 2K + last 2K):\none"
     expect = "one"
     path= "/home/u/Preview/a.txt" expect= "/home/u/Preview/a.txt"
  fails 1
  ```

  正文里出现结尾标签时更严重（`node /tmp/probe_persisted3.cjs`，预览内容取自
  `src/webview/persistedOutputParse.ts` 的两行常量声明）：

  ```
  preview in: "...CLOSING_TAG = '</persisted-output>';...TAG = '<persisted-output>';"
  preview out: "...CLOSING_TAG = '"
  match: false
  ```

  第三组输入就是本仓库自己的源码：`cat src/webview/persistedOutputParse.ts`（里面有两个
  标签字面量常量）超过 4K 后落盘、卡片里只显示到第一个 `'` 为止。

- 影响面：`Bash` 卡片（`src/webview/tools/Bash.tsx`）与 assistant 长文本
  （`src/webview/MessagesView.tsx` 的 `PersistedOutputBox`）都走这一条解析。
  正文被截断属于**静默错显**：没有报错、没有日志，预览框看起来只是内容少了一截。

## 期望

1. **按行定位表头**：预览起点取「以 `Preview (first ... + last ...K):` 开头的整行」，
   不在路径或正文里搜这个单词。
2. **尾部标签取最后一个**：正文里出现 `</persisted-output>` 字面量时，结尾仍应是消息
   真正的收尾标签。
3. **路径与正文原样保留**：路径里含 `Preview`、正文里含两个标签字面量时，解析结果
   与写入方（Core 的 `build_large_tool_result_message`）写进去的内容逐字一致。
4. **格式不变**：`<persisted-output>` 消息的生成侧不动（TS 与 Rust 两侧都不改）。

## 不变量

- 消息格式与生成侧不变：`core-rs/src/tools.rs` 的
  `build_large_tool_result_message` 一个字都不改（会话落盘的写入方只有 Core）。
- `parsePersistedOutput` 的返回形状不变（`isPersisted` / `originalSize` / `filePath` / `preview`）。
- 正常输入（路径与正文都不含保留字）的解析结果逐字不变。
- `isPersistedOutput` 的判定口径不变；不含完整标签对的内容仍返回 `null`。

## 回归测试

- **RT-1**：路径含 `Preview` 段（`/home/u/Preview/a.txt`）时预览正文不被表头前缀污染
  （修复前红：preview 变成 `"\nPreview (first 2K + last 2K):\none"`）。
  （落点：`src/test/persistedOutput.test.ts` 的「解析」用例组）
- **RT-2**：正文里出现 `</persisted-output>` 与 `<persisted-output>` 两个字面量时，
  预览完整保留到最后一行（修复前红：预览被截断到 `... = '`）。
- **RT-3**：正文里出现 `Preview of changes:` 时预览从正文首行开始（修复前不红——
  表头在它之前，这条守护「按行定位」不引入新偏差）。
- **RT-4**：正常输入（无保留字）与不含完整标签对的输入，结果与修复前逐字一致。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `node /tmp/fuzz_persisted.cjs` | 红 | 路径含 `Preview` 目录时 preview 变成 `"\nPreview (first 2K + last 2K):\none"` |
| 回归用例（修复前） | `node /tmp/probe_persisted3.cjs` | 红 | 正文含结尾标签字面量时 preview 截断成 `"... = '"` |
| 回归用例（修复前） | `node /tmp/redcheck_persisted.cjs`（照抄旧实现跑同一组断言） | 红 | RT-1 / RT-2 两条红（2 红）；RT-3 / RT-4a 旧实现本来就绿 |
| 回归用例（修复后） | `npm run test:unit -- persisted-output` | 绿 | 7 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测 1809 条 ok |
| 静态检查 | `npm run check-types` | 绿 | 含 webview 配置 |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法 |
