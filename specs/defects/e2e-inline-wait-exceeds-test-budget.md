---
status: 已修
---

# 缺陷：e2e 用例体内的等待预算超过 project 单用例上限，超时只能报成 60s

`all` 的失败面（run `45177031308` 的 `e2e-ssh` 车道）落在
`e2e/electron/overlayMountProxyRemote.spec.ts` 的
`AC-31 隔离会话的 Write 不落真实磁盘，会话关闭后 mountinfo 无泄漏`：

```
Test timeout of 60000ms exceeded.
Error: expect(locator).toBeVisible() failed
  Locator: getByText('OVERLAY-WRITE-DONE').first()
  Call log:
    - Expect "toBeVisible" ... with timeout 120000ms
      | await expect(chatPage.getByText('OVERLAY-WRITE-DONE').first()).toBeVisible({ timeout: 120_000 });
```

这条断言声明了 120s 预算，而 `electron-ssh` project 的单用例上限是 60s
（`e2e/playwright.config.ts` 的 `SSH_TEST_TIMEOUT_MS`）。两个数字互相矛盾：断言永远等不满
自己声明的时限，用例先被 project 上限杀掉，日志里留下的是「断言在 120s 内没等到」——
排查者会去找「元素为什么没出现」，而真正的事实是「这条用例只有 60s」。

同一形态在真实 SSH 四个 spec 里普遍存在：把每条用例体内 `timeout:` 的最大值与它真正
能用的预算（project 上限，或用例体内 `test.setTimeout()` 的放宽值）逐条对照，**22 条用例
的等待预算大于可用预算**，其中 `overlayMountProxyRemote` 占 10 条、`remoteSshExecution`
占 9 条。整应用（`electron-app`）也有 4 条（`e2e/electron/completionTab.spec.ts` /
`e2e/electron/subagentExplorer.spec.ts` / `e2e/electron/subagentInheritance.spec.ts` 各 1 条
+ `remoteChangeList` 1 条），它们的 90–120s 断言同样永远等不满。

## 现状

- `e2e/playwright.config.ts` 给 `electron-app` / `electron-ssh` 都是 60s 单用例上限
  （`ELECTRON_APP_TEST_TIMEOUT_MS` / `SSH_TEST_TIMEOUT_MS`），前端三车道与 `tui-installer` /
  `pycharm-plugin` 各有档位。
- 用例体内的断言与轮询普遍写 `timeout: 90_000` / `120_000` / `180_000` / `240_000`，
  只有少数长任务用例用 `test.setTimeout()` 显式放宽了用例预算。
- 两者没有任何一致性检查：`src/test/e2eCiLane.test.ts` 只锁了「每处 `test.setTimeout` 前面
  3 行内有注释」（RT-13），不比较「体内等待」与「可用预算」。
- 结果：`overlayMountProxyRemote` 的 17 条用例在八轮绿 run 里稳定 6–7s 通过
  （run `45140464709` / `45119412592` / `45106804812` / `45089008241` / `45082902643` /
  `45047284736` / `45046252618` / `45082033033`），说明这些 120s 断言不是「真的需要 120s」，
  而是照抄了文件级 600s 放宽时代的写法（那行放宽已随单用例分档上限一起删除，
  用例体内的等待没有一起收口）。它们今天是「够用」的，但一旦某次抖动让等待真的拉长，
  日志报出来的成因是错的。

## 期望

- 每条用例的**身体里声明的等待预算**不超过它的**可用预算**：可用预算 = 用例体内
  `test.setTimeout()` 的值，否则 = 所属 project 的单用例上限。
  等待预算包含 `await expect(...).toBeVisible({ timeout })`、`expect.poll(..., { timeout })`、
  `page.waitForSelector(..., { timeout })`、`locator.waitFor({ timeout })` 等带 `timeout:`
  的调用，也包含 `pollRemote(..., ms, ...)` 这类脚手架轮询。
- 上限关系通过静态守卫固定：`src/test/e2eCiLane.test.ts` 逐用例对照两个数字，超了就红。
  守卫覆盖 `e2e/webview` / `remoteWorkspace` / `terminal` / `electron` / `tui` / `pycharm`
  六个目录，project 上限从 `e2e/playwright.config.ts` 读，不手抄。
- 真正需要长等待的用例按既有口径在**用例体内** `test.setTimeout()` 放宽，并写明实测值
  （`remoteTaskSurvival` 已如此）；不需要的就收到档内。

## 不变量

- 单用例上限的取值不变：`electron-app` / `electron-ssh` 仍 60s、前端三车道仍 30s、
  `tui-installer` / `pycharm-plugin` 仍 5min。
- `remoteTaskSurvival` 的三条长任务用例（180s / 300s / 420s）与 `remoteSshExecution` 的
  冷部署 / 空闲退出 / 重连三条（180s / 120s / 240s）继续用 `test.setTimeout()` 放宽，
  取值与实测值的对应关系不变。
- 整轮上限 15 分钟、失败 5 条早停、`retries: 0` 不变。
- 用例的断言判据不变：只收窄等待数字，不删断言、不放宽判据（不把「等 120s 才失败」
  变成「等 30s 就放弃」而让真缺陷更容易漏过——收窄的前提是对照实测值留足余量）。

## 回归测试

- **RT-1**：`src/test/e2eCiLane.test.ts` 新增「每条用例体内的最大等待不超过可用预算」
  守卫，逐文件逐用例对照，红时点名 `文件:行` 与两个数字。修复前它会列出 22 条超预算用例。
- **RT-2**：`remoteSshExecution` 的重连用例（`test.setTimeout(240_000)`）不被误判：
  守卫必须认用例体内放宽，而不是拿 project 上限一律比对。
- **RT-3**：`e2e/electron/overlayMountProxyRemote.spec.ts` 的 AC-31 在本机对真远端跑通，
  且用例体内最大等待 ≤ 60s（不再出现「声明 120s、实际 60s」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run test:unit -- e2e ciLane` | 红 | 守卫首次运行列出 28 处「体内等待 > 可用预算」，点名 `文件:用例行（等待行）` |
| 守卫自检：用例体切分 | 同上 | 红 | 第一版把 `test.setTimeout(` 当成新用例起点，放宽值读不到而漏报 `remoteSshExecution` 的重连用例；切分改为「声明后紧跟标题字符串」后才报到它 |
| 等待收窄（RT-1 / RT-2） | `npm run test:unit -- e2e ciLane` | 绿 | 43 通过 / 0 失败，扫 354 条用例、0 处超预算；放宽档用例（`test.setTimeout(180_000)` 的 240s 轮询收到 120s）不再越界 |
| overlay 全文件对本机真远端（RT-3） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh e2e/electron/overlayMountProxyRemote.spec.ts` | 绿 | 连跑两轮：`17 passed (2.1m)` / `17 passed (2.2m)`；AC-31 单跑 `1 passed (15.4s)` |
| 整应用车道全量（等待收窄后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app` | 绿 | 本机 124 passed（7.8m）；收窄后的等待没有让任何用例变成偶发红 |
| e2e 类型检查 | `npm run check-types:e2e` | 绿 | `tsc --noEmit -p e2e/tsconfig.json` 无输出 |
| lint | `npm run lint` | 绿 | 无输出 |
| CI 实证（修复后） | 下一轮 `all` 的 `e2e-ssh` 车道 | not-run | 需推送后由整点车道或手动 dispatch 验证；本机无托管 runner 与 secrets，跑不了这条链路 |
