---
status: 已修
---

# 缺陷：对话标题截断切开代理对，落盘与帧通道各自修补、显示成替换字符

`src/shared/utils/contentBlocks.ts` 的 `buildConversationTitle` 用裸
`trimmedText.substring(0, 50)` 截标题。`substring` 按 **UTF-16 code unit** 切，第 50 个
单元落在代理对中间时会留下孤立代理项（如 `\ud83d`）。

这与 `src/shared/utils/stringUtils.ts` 模块注释里记的真实事故同一类：`JSON.stringify`
把孤立代理项写成语法合法但语义非法的 `"\ud83d"`。标题因此有两个后果：

1. **落盘值与显示值不一致**：Core 读 `meta.json` 走 `util::sanitize_json_surrogates`
   （`core-rs/src/history.rs` 的多处 `serde_json::from_str`）、宿主帧通道走
   `stringifyJsonSafe`——两处都把孤立代理项换成 U+FFFD，用户看到的是标题末尾多一个
   「�」。
2. **两侧口径已经漂了**：Core 侧的 `history::derive_title` 用 `util::utf16_take(text, 50)`
   （放不下就停，得到 49 个单元），TS 侧 `substring` 得到 50 个单元——同一条首消息在两侧
   会派生出不同标题。

## 现状

- `buildConversationTitle`（`src/shared/utils/contentBlocks.ts`）：`return trimmedText.substring(0, 50)`。
- 复现（Linux，仓库根）：

  ```
  node -e "const {buildConversationTitle}=require('./out/src/shared/utils/contentBlocks.js');
           const {hasLoneSurrogate}=require('./out/src/shared/utils/stringUtils.js');
           const t=buildConversationTitle('a'.repeat(49)+'😀 tail');
           console.log(t.length, hasLoneSurrogate(t), JSON.stringify({title:t}))"
  ```

  实测输出 `title len 50 lone? true "aaa…\ud83d"`：50 个 code unit、含孤立高代理、
  JSON 里是 `"\ud83d"`。Core 侧同一输入经 `utf16_take` 得到 49 个单元（无孤立项）。
- 调用点不止一处：`webview/hooks/useAppHandlers.ts` 的乐观列表项标题与
  `shared/history/Conversation.ts` 的 `titleFromUserMessage` 都用它，两边都会写出坏标题。

## 期望

1. **截断按代理对边界对齐**：标题不含孤立代理项。用同文件族已有的
   `surrogateSafeHeadEnd`（`src/shared/utils/stringUtils.ts`），与
   `EndTruncatingAccumulator` / `generateHeadTailPreview` 同一口径。
2. **与 Core 同口径**：第 50 个 code unit 是高代理时少取 1 个单元（得到 49 个），与
   `util::utf16_take` 逐字符一致——两侧对同一条首消息派生同一标题。
3. **既有标题语义不变**：trim、文本优先于图片、`Image[<w>*<h>]` 与 `Image` 兜底、空文本
   返回空串都不变。

## 不变量

- 标题长度上限仍是 50 个 UTF-16 code unit（不改成字符数 / 字节数）。
- `buildConversationTitle` 的签名与返回类型不变。
- 纯文本（无代理对）输入结果逐字节不变：49 个 ASCII → 49 个，50 个 → 50 个，
  51 个 → 前 50 个。
- 图片标题分支（`Image[800*600]` / `Image`）与「文本优先于图片」不变。
- `contentBlocks.ts` 保持 webview 可 import（不得引入 Node 类型链）。

## 回归测试

- **RT-1**：49 个 ASCII + emoji + 尾巴 → 标题不含孤立代理项、等于 49 个 ASCII（与
  `utf16_take` 同口径）、`JSON.stringify` 结果不含 `\ud` 转义。（落点：
  `src/test/conversationTitle.test.ts` 的「截断边界不切出孤立代理项」三条）
- **RT-2**：48 个 ASCII + emoji（整对放得下）→ 完整保留 emoji；30 个 emoji → 保留 25 个
  完整字符、无孤立代理项。（落点：同上「整对放得下 / 纯 emoji」两条）
- **RT-3**：既有标题语义（trim / 50-51 边界 / 空文本 / 图片兜底 / 文本优先）逐条不变。
  （落点：同上「既有行为不变」段）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- conversationTitle` | 红 | 3 项断言失败：`截断边界不切出孤立代理项`、`与 Core 的 utf16_take 同口径`、`结果是合法 Unicode` |
| 回归用例（修复后） | `npm run test:unit -- conversationTitle` | 绿 | 14 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测（含 conversationListManifest / conversationPayload 等标题相关链路） |
| 静态检查 | `npm run check-types`（含 webview / electron 三份配置）+ `npm run lint` | 绿 | 修 `contentBlocks` 引入 Node 类型链时同步把 `EndTruncatingAccumulator.append` 的 `Buffer` 改成结构化类型 |
