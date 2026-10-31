---
status: 已修
---

# 缺陷：fakeHost thinking 流的 `streamMessage.accumulated` 只带当前块，违反 wire 契约的累计全文语义

e2e 假宿主（`e2e/helpers/fakeHost.ts`）播放 thinking 流时，每条 `streamMessage` 的
`accumulated` 字段填的是**当前块**而不是累计全文。wire 契约（`src/host/webviewMessages.ts`
的 `streamMessage` 载荷注释「当前累积的完整文本」）与 core 的真实实现
（`core-rs/src/engine.rs` thinking delta 事件 `accumulated: streamed_thinking`）都要求累计全文；
webview 的流式处理（`src/webview/hooks/handlers/streamHandlers.ts`）按契约把
`msg.accumulated` 直接当消息全文写入。两边对不上时，thinking 的最终内容取决于
「rAF 冲刷最后一块」与「streamEnd 到达」的竞争：冲刷先到则内容落到
`streamEnd.accumulated`（全文），否则落到缓冲里最后一块的 `accumulated`（仅一个块）。
`e2e/webview/conversation.spec.ts` 的 US-4「展开的 thinking 内容限高并在框内滚动」
在 CI 上因此稳定挂红（2026-10-31 run 41184108430 两连挂）：最后一块 1400 字在
1280 视口全宽下约 15 行（< 345px 限高），内容不溢出，溢出断言恒 false。

## 现状

- `e2e/helpers/fakeHost.ts` `playTurn()` 的 thinking 分支：
  `send({ type: 'streamMessage', sessionId, role: 'thinking', delta: chunk, accumulated: chunk, streamId })`
  ——`accumulated` 只带当前块。同一函数的 assistant 分支是正确写法
  （`acc += chunk` 后发 `accumulated: acc`）。
- webview 按契约消费：`streamHandlers.ts` 把 `msg.accumulated` 写入消息 `content`
  （流式 rAF 冲刷与 `streamEnd` 收尾两处）；`streamEnd` 收尾优先取缓冲里最后一条
  streamMessage 的 `accumulated`，仅当缓冲已被冲刷为空时才回退到 `streamEnd.accumulated`。
- 因此 thinking 最终内容 = 最后一块（竞态一侧）或全文（另一侧），随机器负载漂移。
- 证据（CI run 41184108430，webview-ui 车道两连挂 + trace）：
  - 失败断言：`expect.poll(... scrollHeight > clientHeight).toBe(true)` 30s 超时恒 false；
  - trace 内 live locator 预览显示 `.thinking-content` 文本以「段展开，这里是第若干句推理。」开头
    （全文应以「思考过程需要成」开头——首块被丢弃，内容是最后一块）；
  - trace 内流式统计一度显示 `Decode: 1.4K chars`——恰为最后一块的长度
    （种子 8400 字 ÷ 6 块 = 1400），而非全文。

## 期望

- thinking 流的每条 `streamMessage.accumulated` = 从流开始到该条的累计全文，
  与 assistant 分支、`src/host/webviewMessages.ts` 的载荷注释、
  `core-rs/src/engine.rs` 的真实 delta 事件三方一致。
- 修复后 webview 收到的 thinking 最终内容与 rAF / streamEnd 到达顺序无关，恒为全文；
  US-4 限高滚动用例在任意负载下确定通过（全文 8400 字远超 345px 限高）。

## 不变量

- assistant 分支的累计语义与 `delta` 字段照旧（本就正确）。
- `streamEnd.accumulated` = 完整文本，照旧。
- 块切分（`chunkText`：ceil(len/6) 等分）与 `chunkDelayMs` 节奏照旧。
- abort 即停（`active.has(sessionId)` 检查后直接 return，不补 idle / queryEnd）照旧。
- 流式统计（`updateStreamChars` 按 `accumulated.length` 计）随累计全文增长，与真实 core 一致。

## 回归测试

- **RT-1**：US-4 展开的 thinking 内容限高并在框内滚动——展开后
  `scrollHeight > clientHeight` 必须为真（落点：`e2e/webview/conversation.spec.ts` 的
  「US-4 展开的 thinking 内容限高并在框内滚动」，第 104 行起）。CI 红证据：
  run 41184108430 两连挂（本地快机竞态偏向全文一侧，无法本地稳定复红，红证据以 CI 为准）。
- **RT-2**：thinking 流结束后内容必须等于种子全文——`chunkDelayMs: 0` 让全部块与
  `streamEnd` 在同一批任务里到达（rAF 冲刷必然晚于 `streamEnd`，命中竞态的
  「最后一块」一侧），展开后断言 `.thinking-content` 文本 === 种子 thinking
  （落点：`e2e/webview/conversation.spec.ts` 新增用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-2（修复前，本地复红） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "种子全文"` | 红 | 期望 147 字种子全文，实际收到最后一个块「。思考过程需要成段展开，这里是第若干句推理。」（22 字，从句中截断） |
| RT-1（修复前） | CI run 41184108430 的 `npm run test:e2e:local`（webview-ui 车道） | 红 | US-4 限高滚动两连挂；trace 显示 `.thinking-content` 文本以「段展开，」开头、流式统计 `Decode: 1.4K chars`（= 单块 1400 字）。本地快机竞态偏向全文一侧，无法本地稳定复红，红证据以 CI 为准 |
| RT-2（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui -g "种子全文"` | 绿 | thinking 内容 === 147 字种子全文，与块 / streamEnd 到达顺序无关 |
| RT-1（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui e2e/webview/conversation.spec.ts` | 绿 | 含 US-4 限高滚动在内的 conversation 全部用例通过 |
| 既有回归（webview 车道全量） | `npx playwright test -c e2e/playwright.config.ts --project=webview-ui` | 绿 | 125 用例通过（首轮 124 通过 + 1 例 `abort 按钮三态` 偶发挂、单跑与复跑均绿；该用例不用 thinking 流，与本缺陷改动无关） |
