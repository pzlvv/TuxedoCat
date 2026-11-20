---
status: 已修
---

# 缺陷：流式统计的 decode 分母用整轮时长，思考段速率被稀释

思考块的流式性能统计（`Decode: N tok in X s (R tok/s)`）里，分子取的是本轮的
`reasoning_tokens`，分母却取「首个 thinking delta → **整轮结束**」的时长。结果是
正文输出与思考/正文之间的空档一并计入 thinking 的分母，显示的速率明显低于思考段
的真实解码速率（实测：真实 ~50 tok/s 显示成 27.6 tok/s；线上真实会话实测显示
60 tok/s 而思考段实测 100–175 tok/s）。

## 现状

Core 对同一个 thinking 块发**两条** `streamEnd`，带同一个 `streamId`：

1. `BlockStop` —— 思考块真正结束。`core-rs/src/engine.rs` 的 `LlmEvent::BlockStop`
   分支发出，`data` 里**不带 `usage`**。
2. `MessageDelta` —— 整轮结束。同文件的 `LlmEvent::MessageDelta` 分支发出，
   `data` 带本轮 `usage`（含 `reasoning_tokens`）。

webview 侧 `src/webview/hooks/handlers/streamHandlers.ts` 的
`handleStreamStreamEnd` 对两条都调 `endStream(streamId, usage)`；`endStream` 无条件
调 `freeze(entry)`：

```ts
function freeze(entry: Entry): void {
  entry.isStreaming = false;
  entry.frozenDecodeMs = entry.firstTokenAt !== null
    ? Math.max(1, Date.now() - entry.firstTokenAt)
    : 1;
}
```

`freeze` 不判重入，所以第二条 `streamEnd`（整轮结束）用当时的 `Date.now()` 覆盖了
第一条算出的「思考块结束时刻」。`computeStats` 随后用 `frozenDecodeMs` 作分母，
而 `count` 优先取 `reasoningTokens` —— 分子是思考段的，分母是整轮的。

复现（e2e）：`e2e/electron/streamStatsRate.spec.ts` 用已知节奏的 mock LLM
（thinking 20 帧 × 5 token / 100ms = 50 tok/s，之后 1s 空档 + 正文 10 帧 / 50ms，
`reasoning_tokens` 上报 100）。UI 实际显示 `Decode: 100 tok in 3.6s (27.6 tok/s)`：
3.6s 是整轮时长，而思考段只占约 2.0s。

单测复现：`src/test/streamStatsDecodeWindow.test.ts` 按同一事件序直接驱动 store，
`BlockStop` 后 `decodeMs` 为 3000ms（正确），随后 `MessageDelta` 到达使其变成
12000ms（错误）。

## 期望

1. thinking 统计的 decode 分母是**思考段自身的时长**：从首个 thinking delta 到
   **最后一个 thinking delta 到达**。不用 `streamEnd` 的时刻——Core 的思考块结束
   由「角色切换」合成（首个正文 delta 到达时才发 `BlockStop`），按它计时会把
   思考结束后的空档算进去。
2. 第二条 `streamEnd`（整轮结束）只补 `usage` 的 token 数，**不改**已冻结的分母。
3. 流尚未结束时（正常流式过程中）分母随 token 到达增长，ticker 每秒刷新行为不变。
4. abort / 会话结束时仍冻结在最后一次的值，不因未收到 `usage` 而丢失统计。

## 不变量

- 分子口径不变：结束后优先 `reasoning_tokens`，缺失时回退 `output_tokens`，再缺失
  则沿用字符数；流式期间仍按字符数显示（US-4 验收标准 2）。
- `Prefill`（`ttftMs`）语义不变：首个 token 相对上一活动时刻的耗时。
- `streamEnd` 的 wire 形状、Core 发出的事件条数与 `usage` 内容不变（只改 UI 侧
  如何使用这两个时间点）。
- 只含正文、无 thinking 的轮次行为不变（该轮不登记 thinking 统计）。
- 多个 thinking 块（思考→工具→思考…）各自独立统计，互不覆盖。

## 回归测试

- **RT-1**：`BlockStop` 冻结的 `decodeMs` 不被随后的 `MessageDelta` 覆盖；结束后
  `rate` 按思考段时长计算，`unit` 为 tokens 且取 `reasoningTokens`
  （落点：`src/test/streamStatsDecodeWindow.test.ts`，`run` 内四条 `check`）。
- **RT-2**：整应用链路上，已知 50 tok/s 的思考节奏在 UI 上显示为 40–65 tok/s 区间，
  且 token 计数取 `reasoning_tokens`（落点：`e2e/electron/streamStatsRate.spec.ts`，
  `US-4 思考段速率不被正文与空档稀释`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npm run test:unit -- streamStatsDecodeWindow` | 红 | `整轮结束不覆盖思考块的 decodeMs` 等 3 条断言失败：`decodeMs` 由 3000 变 12000 |
| RT-2（修复前） | `npx playwright test --config=e2e/playwright.config.ts --project=electron-app streamStatsRate` | 红 | 实际 27.6 tok/s（期望 >40），标签 `Decode: 100 tok in 3.6s` |
| RT-1（修复后） | `npm run test:unit -- streamStatsDecodeWindow` | 绿 | 5 通过 / 0 失败 |
| RT-2（修复后） | `npx playwright test --config=e2e/playwright.config.ts --project=electron-app streamStatsRate` | 绿 | 1 passed；显示速率进入 40–65 区间 |
| 类型检查 | `npm run check-types` | 绿 | 三份 tsconfig 均无错 |
| Lint | `npm run lint` | 绿 | — |
| 既有单元回归 | `npm run test:unit` | 绿 | 120 个文件全通过 |

### 修复备注（不改「现状 / 期望」，只记实现取捨）

初版修法是「`BlockStop` 冻结分母」，E2E 实测只从 27.6 升到 32.2 —— 因为 Core 的
思考块结束是**合成的**（首个正文 delta 到达时才发 `BlockStop`），思考结束到正文首帧
之间的空档仍被计入分母。最终改为记录**末个 thinking delta 的到达时刻**
（`Entry.lastTokenAt`，在 `updateStreamChars` 里更新），分母取「首 token → 末 token」
的到达跨度，空档彻底排除。此时 mock 的 `gapMs: 1000` 仍保留，正好验证了这一点。
