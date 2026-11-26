---
status: 已修
---

# 缺陷：US-49 中止用例用 title 定位按钮，转黄后 title 消失导致用例必红

`e2e/electron/subagentConcurrency.spec.ts` 的「US-49 前台中止：排队中的 2 个调用取消、
不创建子代理会话」用 `button[title="终止"]` 定位 abort 按钮，点击之后再用同一个定位器断言
`toBeEnabled()`。点击使会话从前台运行转入「只剩后台子代理」态，按钮随之转黄；而
[docs/features/abort-button.md 第 2 节](../../docs/features/abort-button.md#fr-004悬停运行明细specs019specs054)
规定有悬停明细时**不设 native `title`**（悬停明细浮层取代），该属性被移除。定位器在点击后即匹配
不到任何元素，断言报 `element(s) not found`。

`all.yml` 的 `e2e-electron` 车道因此整条红（123 passed / 1 failed），产品行为本身正确。

## 现状

- 用例位点（`e2e/electron/subagentConcurrency.spec.ts`）：

  ```text 示意（点击后同一个 title 定位器继续用来断言）
  const abortButton = chatPage.locator('button[title="终止"]');
  await abortButton.click();

  // 按钮仍可点（前台停了，但 4 个子代理还在跑，按钮转黄）
  await expect(abortButton).toBeEnabled({ timeout: 15_000 });
  ```

- 按钮渲染（`src/webview/InputArea.tsx`）：`title={abortTipEnabled ? undefined : t('inputArea.abort')}`。
  有明细可弹浮层时该属性为 `undefined`，DOM 上不出现 `title`。
- 规格依据（`docs/features/abort-button.md` FR-004）：『有明细时按钮不设 `title`（浮层取代），
  灰态与无明细维持「终止」文案』——实现符合规格，用例的定位方式不符合。
- 本地实测（临时探针，跑完已还原）：点击后每 500ms 采样 3s，按钮稳定为
  `data-abort-state=background`、`title=null`、`button[title="终止"]` 匹配数 `0`，
  随后的 `toBeEnabled()` 报 `element(s) not found`。
- CI 现场：run `45512523867` 的 `e2e-electron` job：

  ```
  ✘  103 [electron-app] › e2e/electron/subagentConcurrency.spec.ts:216:5 › US-49 前台中止：…
      Error: expect(locator).toBeEnabled() failed
      Expected: enabled / Error: element(s) not found
      Locator: locator('button[title="终止"]')
      at e2e/electron/subagentConcurrency.spec.ts:265:29
  ```

- 同一文件里的另一条用例、以及 `e2e/webview/conversation.spec.ts` 的按钮三态用例都用
  `button[data-abort-state]` 定位，只有本用例沾了会消失的 `title`。

## 期望

- 中止按钮的定位只依赖**三态都在**的属性：`button[data-abort-state]`（红 / 黄 / 灰恒在），
  不依赖随状态增删的 `title`。
- 断言强度不降，且要显式表达用例真正要锁的语义：点击之后按钮处于 `background`（黄）态
  且可点——「前台已停、后台子代理仍在跑」。只留 `toBeEnabled()` 会漏掉「为什么会可点」。
- 与定位器解耦：后续新增三态或调整 `title` 文案不该再让本用例红。

## 不变量

- 产品行为不变：abort 按钮的三态推导（`src/host/abortButtonState.ts`）、有明细时无 native
  `title`、悬停明细浮层（`docs/features/abort-button.md` FR-004）全部不改。
- 本用例原有的产品断言全部保留且不得放宽：侧栏稳定 5 条（父 1 + 子 4）、
  `subFirstRequests([1..6])` 恒为 4、「排队者不补位启动」的 3s 等待窗口、
  收尾时侧栏仍为 5 条。
- 前一条用例（`US-49 并发上限 4：…`）与 `e2e/webview/conversation.spec.ts` 的三态用例不受影响。

## 回归测试

- **RT-1**：点击中止后按钮处于 `background` 态且可点——定位改用
  `button[data-abort-state]`，断言 `data-abort-state=background` + `toBeEnabled()`
  （落点：`e2e/electron/subagentConcurrency.spec.ts` 的
  `US-49 前台中止：排队中的 2 个调用取消、不创建子代理会话`）。
- **RT-2**：该用例的产品断言原样保留——4 个子代理首请求、3s 窗口内不补位、侧栏恒 5 条
  （落点：同上用例后半段）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency -g "前台中止"` | 红 | 先等按钮落到 `background` 再断言可点后稳定复现：`toBeEnabled` 报 `element(s) not found`（定位器 `button[title="终止"]` 匹配数为 0），与 CI run `45512523867` 的 `e2e-electron` 现场一致 |
| 时序探针（修复前） | 同上，点击后每 500ms 采样 3s | 红 | 按钮稳定为 `data-abort-state=background`、`title=null`、`button[title="终止"]` 匹配数恒为 0；证明 `title` 是随状态消失的属性，不能用作跨态定位器 |
| 回归用例（修复后，RT-1 / RT-2） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app subagentConcurrency` | 绿 | 2 passed（22.6s）：定位改用 `button[data-abort-state]`，并显式断言「点击前 `query`、点击后 `background`」+ 可点 |
| 断言强度未降 | 同上 | 绿 | 后半段产品断言原样保留：`subFirstRequests([1..6])` 恒为 4、3s 等待窗口内不补位、侧栏恒 5 条 |
| 静态检查 | `npm run check-types:e2e` / `npm run lint` | 绿 | e2e tsconfig 与 eslint 均无输出 |
| 整条车道复核 | `npm run test:e2e:electron` | not-run | 本机整车道约 13 分钟，由 CI 的 `e2e-electron` 车道复核；本文件只改该用例的定位与状态断言 |
