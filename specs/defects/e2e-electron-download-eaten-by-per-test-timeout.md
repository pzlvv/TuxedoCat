---
status: 已修
---

# 缺陷：Electron 二进制在第一条用例里现下，吃满单用例上限后整条车道被早停掐掉

run `44998731954`（收严时间闸门后的第一次全量车道）里 `e2e-ssh` 的四个 job 全部在
5–8 分钟红掉，日志特征完全一致：

```
Downloading Electron binary...
✘  1 [electron-ssh] › … 远程工作区启动恢复 … (1.0m)
✘  2 [electron-ssh] › … Bash 在远端执行 … (1.0m)
✘  3 [electron-ssh] › … Write 写进远端工作区 … (1.0m)
✘  4 [electron-ssh] › … Grep 用自带 ripgrep … (1.0m)
✘  5 [electron-ssh] › … Read 读远端文件 … (1.0m)
Testing stopped early after 5 maximum allowed failures.
…
Test timeout of 60000ms exceeded.   ← 五条失败原因全是这一句
```

失败信息里没有一条来自远端链路（没有 `Connection lost`、没有 `daemon bootstrap timed
out`），却看起来像「远端全红」。`e2e-electron` 车道有同一行 `Downloading Electron
binary...`，只是它用例多、跑得久，最终只红了 1 条真用例（`tabContextMenu.spec.ts:139`，
另一个问题）。

## 现状

`node_modules/electron/package.json` **没有 `script.postinstall`**；
`node_modules/electron/index.js` 在模块求值时检查 `dist/` 是否就位，缺就同步 spawn
`install.js` 现下约 100MB：

```js
// node_modules/electron/index.js（节选）
function downloadElectron() {
  console.log('Downloading Electron binary...');
  spawnSync(process.execPath, [path.join(__dirname, 'install.js')], { stdio: 'inherit' });
}
```

`e2e/helpers/electronApp.ts` 的 `spawnApp` 在 `spawn(require('electron'), …)` 处第一次
求值该模块。因此这份下载的落点由「哪条用例第一个启动应用」决定：

- `npm ci` 之后 `dist/` 不存在（`npm ci` 输出里 `added 1152 packages` 之后没有 electron
  的安装动作）；
- 第一条用例的时间线（run `44998731954` 的 `remoteSshExecution` job）：
  `07:38:43 Running 14 tests` → `07:39:01 Downloading Electron binary...` →
  `07:39:57 ✘ 1 … (1.0m)`；
- 单用例上限 60s（`SSH_TEST_TIMEOUT_MS`）在下载期间耗尽，Playwright 报
  `Test timeout of 60000ms exceeded`；前 5 条连续如此后 `maxFailures: 5` 触发早停。

即：**时间闸门本身工作正常，是安装时延被记进了用例预算**。同一机制在开发机上也存在，
只是 `dist/` 通常早已就位（本机实测 `require('electron')` 5ms）。

## 期望

- Electron 二进制在**跑用例之前**就位：CI 在车道准备期显式预热，失败即整条 job 失败
  （不静默跳过——跳过会让第一条用例再吃一次这笔时延）。
- 本机第一次跑 `npm run test:e2e*` 同样先预热，不把下载算进用例。
- 预热幂等：已就位时只读 `path.txt` 校验，毫秒级。

## 不变量

- 不改 `node_modules` 内容、不加 postinstall 补丁：预热是**调用点**的责任，不是依赖侧
  的假设——依赖升级后行为仍由 `scripts/warm-electron.cjs` 兜住。
- 不改变单用例上限、失败早停、`globalTimeout` 的任何取值（时间闸门按设计工作）。
- 预热只碰 `require('electron')` 的解析结果，不启动应用、不读写产品数据。

## 回归测试

- **RT-1**：`scripts/warm-electron.cjs` 存在且可执行（解析成功退出 0）。
  落点：`src/test/e2eCiLane.test.ts` 的「存在 Electron 预热脚本」。
- **RT-2**：跑 Electron 的四个 npm 脚本都前置预热
  （`test:e2e` / `test:e2e:local` / `test:e2e:electron` / `test:e2e:ssh`）。
  落点：同上「跑 Electron 的 npm 脚本都先预热」。
- **RT-3**：`all.yml`（`electron` + `ssh` 两处）与 `e2e-debug.yml`（一处）都在跑用例的
  步骤**之前**调用预热。落点：同上「都在跑用例前预热 Electron」。少一处就让那条车道
  重演本缺陷。

「第一条用例不再出现 `Downloading Electron binary...`」由 RT-3 在编排层保证：预热步骤
排在用例步骤之前且失败即 job 红。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 缺陷现场（run `44998731954`，`e2e-ssh` 四个 job） | `gh api …/actions/jobs/<id>/logs` | 红 | 前 5 条全 `Test timeout of 60000ms exceeded`，`Testing stopped early after 5` |
| 时间线取证 | 同上日志 | not-run | `Running 14 tests` → 18s 后 `Downloading Electron binary...` → 第一条 1.0m 超时 |
| 本机预热脚本 | `node scripts/warm-electron.cjs` | 绿 | `node_modules/electron/dist/electron.exe（5ms）`，幂等 |
| 本机全量 e2e（预热后） | `CI=1 npm run test:e2e:local` | 绿 | 306 条全绿 11.2 分钟 |
| 本机 SSH 车道 | `CI=1 npx playwright test --project=electron-ssh remoteSshExecution -g …` | 绿 | 3 条 48.4s（含等 30s daemon 空闲退出那条） |
| 守卫 | `npm run test:unit -- e2e ciLane` | 绿 | 36 条断言（RT-1..RT-3 在内） |
| CI 口径 | 下一次 `all` 的 `e2e-ssh` 车道 | not-run | 待推送后由定时 / 手动车道验证；判据是日志里不再出现 `Downloading Electron binary...` |
