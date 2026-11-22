---
status: 已修
---

# 缺陷：warm-electron 读不到 `.npmrc` 镜像且不感知代理，Electron 二进制下载退化成 GitHub 直连

`scripts/warm-electron.cjs` 用 `require('electron')` 触发 `@electron/get` 下载 Electron
运行时（~100MB）。该下载**不读** `.npmrc` 的 `electron_mirror`，也**不感知** `https_proxy`，
于是回落到 GitHub Releases——自托管 runner 上实测 30KB/s，100MB 要一小时，
`e2e-ssh` 的 job 撞穿 18 分钟上限。

## 现状

- 触发链：CI 各 Electron 车道在跑用例前执行 `node scripts/warm-electron.cjs`；
  脚本 `require('electron')` → `node_modules/electron/index.js` 发现 `dist/` 缺失 →
 同步 spawn `install.js` → `@electron/get` 的 downloadArtifact。
- `@electron/get@4.x` 的 `dist/artifact-utils.js` 里 `mirrorVar()` 依次读
  npm_config_electron_mirror（大小写两种写法）/ npm_package_config_electron_mirror /
  `ELECTRON_MIRROR`，最后回落到内置 GitHub Releases 地址。
  它**不读 `.npmrc` 文件本身**——是 npm 在 `npm run` 时把 `.npmrc` 转成
  npm_config_* 环境变量。直接 `node scripts/warm-electron.cjs` 没有这层转换。
- `@electron/get` 的 `dist/proxy.js`：`initializeProxy()` 只在
  `ELECTRON_GET_USE_PROXY=true` 时被调用；它用 undici 的 EnvHttpProxyAgent，
  **不会**自动跟随 `https_proxy`。
- 实证（run `45042250492`，`e2e-ssh` 的 `remoteTaskSurvival` job）：

  ```text 示意
  Run node scripts/warm-electron.cjs
  Downloading Electron binary...
  （此后静默 10 分钟以上，最终 job 撞 18 分钟上限）
  ```

  同一 run 的 `remoteChangeList` job 在 `warm-electron` 步骤报
  `TypeError: fetch failed` → `Error: Electron failed to install correctly`。
- DEBUG 日志证明它用的是 GitHub 地址：
  `Downloading https://github.com/electron/electron/releases/download/v44.3.0/electron-v44.3.0-linux-x64.zip`。
- 本机（ubuntu-e2e）实测同一份资产的三条通道：
  - GitHub Releases 直连 30KB/s、经 banana 代理 3.5MB/s；
  - `npmmirror.com/mirrors/electron/` 直连 13.4MB/s；
  - **`cdn.npmmirror.com/binaries/electron/` 直连 14.0MB/s、经代理仍 14.1MB/s**。
  即机器网络没问题，慢的是「从 GitHub 单连接拉 100MB」。
- 直接验证修法：`@electron/get` 在 `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`
  ＋ `ELECTRON_GET_USE_PROXY=true` 下 **117.1MB / 10.2s = 11.7MB/s**；只注入代理、不给镜像时
  60 秒仍未下完。

## 期望

- 预热脚本在 `require('electron')` **之前**把镜像写进 `@electron/get` 认的变量
  （`npm_config_electron_mirror` 与 `ELECTRON_MIRROR`），镜像值从 `.npmrc` 解析——
  `.npmrc` 是构建期镜像配置的唯一来源，脚本里不写死 URL。
- 环境里确实配了代理（`https_proxy` / `HTTPS_PROXY` / `http_proxy`）时自动置
  `ELECTRON_GET_USE_PROXY=true`；没配代理的机器（本地开发）不被塞这个开关。
- 预热仍保持幂等：`dist/` 已就位时不重复下载，毫秒级返回。
- 下载失败仍以非零退出（不静默跳过）。

## 不变量

- `warm-electron.cjs` 的调用点不变：`all.yml` 的 electron / ssh 两处与 `e2e-debug.yml`
  仍在跑用例前调用它；`test:e2e*` 系列 npm 脚本仍先预热（RT-14 的断言保持）。
- `.npmrc` 的 `electron_builder_binaries_mirror` 与 `electron_mirror` 两个键名不变
  （前者给 electron-builder 读）。
- 打包与分发的产物不受影响：这里只改「运行时二进制的获取路径」。
- 有缓存 / 已就位的机器行为不变（不产生额外网络请求）。

## 回归测试

- **RT-1**：预热脚本自己解析 `.npmrc`——`npm run test:unit -- e2e-ci-lane`，断言脚本源码
  含 `.npmrc` 与 `electron_mirror`（落点：`src/test/e2eCiLane.test.ts` 的
  「预热脚本自己解析 .npmrc 的 electron_mirror」）。
- **RT-2**：代理开关——同测试，断言源码含 `ELECTRON_GET_USE_PROXY`（落点：同文件的
  「预热脚本按环境代理开 ELECTRON_GET_USE_PROXY」）。
- **RT-3**：`.npmrc` 指向镜像而非 GitHub——同测试，断言 `electron_mirror` 不是
  `github.com` 域名（落点：同文件的「.npmrc 的 electron_mirror 指向镜像而不是 GitHub Releases」）。
- **RT-4**：runner 上端到端——清掉 `node_modules/electron/dist` 后带 CI 同款代理环境跑
  `node scripts/warm-electron.cjs`，期望数十秒内完成；复跑一次毫秒级（幂等）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1/2/3） | `npm run test:unit -- e2e-ci-lane` | 红 | 加断言后首跑报三条 FAIL：脚本不含 `.npmrc` 解析、不含 `ELECTRON_GET_USE_PROXY` |
| 通道实测（GitHub 直连 / 代理） | runner 上 `curl` 5s 计时 | 红 | 30KB/s（直连）/ 3.5MB/s（代理）——100MB 直连要一小时 |
| 通道实测（npmmirror 两个域名） | 同上 | 绿 | `npmmirror.com/mirrors/electron/` 13.4MB/s；`cdn.npmmirror.com/binaries/electron/` 14.0MB/s（代理下 14.1MB/s） |
| 修法验证（`@electron/get` 真实下载） | `ELECTRON_MIRROR=<cdn> ELECTRON_GET_USE_PROXY=true` 跑 downloadArtifact | 绿 | 117.1MB / 10.2s = 11.7MB/s；对照：只给代理不给镜像 60s 仍未下完 |
| 回归用例（修复后，RT-1/2/3） | `npm run test:unit -- e2e-ci-lane` | 绿 | 42 通过 / 0 失败 |
| runner 端到端（RT-4，严格版） | runner 上清 `node_modules/electron/dist` ＋ `~/.cache/electron`（缓存不清理会命中缓存秒过、量不到真实下载），带 CI 同款代理跑 `node scripts/warm-electron.cjs` | 绿 | 首次 **12s**（117MB，约 10MB/s）；二次 0.0s（幂等）；`env -u https_proxy...` 无代理环境同样 12s 且不被塞 `ELECTRON_GET_USE_PROXY` |
| CI 实证（修复前） | run `45042250492` 的 `e2e-ssh` | 红 | `remoteChangeList` job 在 `warm-electron` 步骤 `fetch failed`；`remoteTaskSurvival` job 该步骤挂 10 分钟以上后撞 18 分钟上限 |
| CI 实证（修复后） | run `45046252618` 的 `e2e-ssh` | 绿 | 两条 job 的 `warm-electron` 各 1.8s / 1.9s（命中缓存，镜像日志可见），随后用例跑完（`8 passed (49.4s)` / `14 passed (2.4m)`）；不再出现 `fetch failed` 或长时间静默 |
