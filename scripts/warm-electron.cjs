#!/usr/bin/env node
/**
 * 预热 Electron 运行时（把「Downloading Electron binary...」从用例墙钟里摘出去）。
 *
 * 为什么需要：`node_modules/electron/index.js` 在**第一次 `require('electron')`** 时
 * 才检查 `dist/` 是否就位，缺就同步 spawn `install.js` 现下载一份（~100MB）。这个包
 * 没有 `postinstall` 钩子，所以 `npm ci` 结束时它并不存在。
 *
 * 后果在 CI 上实测（run `44998731954` 的 `e2e-ssh` 两个 job）：
 * - `npm ci` 之后直接跑用例，第一个用例内部触发下载，日志里出现
 *   `Downloading Electron binary...`，那条用例整轮被推到 1.2 分钟；
 * - 该车道已经把单用例上限收到 60s，于是**前 5 条用例全部因下载期间的等待超时**
 *   （`Test timeout of 60000ms exceeded`），失败早停把整条车道掐掉——看起来像
 *   「远端链路全红」，实际是测试脚手架的安装时延吃掉了单用例预算。
 *
 * 修法：CI 在每个跑 Electron 的车道里、跑用例**之前**显式执行本脚本，把下载落在
 * 「job 的准备时间」里（job 上限 18 分钟，扣掉这 90 秒仍有余量），而不是某条用例的
 * 60 秒里。已就位时是纯读一次 `path.txt`，毫秒级、幂等。
 *
 * 镜像与代理（`@electron/get` 的两个独立坑，run `45042250492` 实证）：
 * - **`.npmrc` 的 `electron_mirror` 只在 `npm run` 下生效**：npm 会把它转成
 *   `npm_config_electron_mirror` 注入子进程环境，`@electron/get` 读的正是那组变量。
 *   直接 `node scripts/warm-electron.cjs` 时没有这层转换，于是回落到 GitHub Releases
 *   ——自托管机器上实测 30KB/s，100MB 要一小时，job 撞 18 分钟上限。
 * - **`@electron/get` 默认不感知代理**：它用 undici，`https_proxy` 不会自动生效，
 *   必须显式开 `ELECTRON_GET_USE_PROXY=true`（见其 `dist/proxy.js`）。
 *
 * 两层都兜住：镜像从 `.npmrc` 解析（唯一来源，不在脚本里写死 URL），代理开关按
 * 「环境里有 http(s)_proxy 才开」推导。本机实测 117MB / 10.2s = 11.7MB/s。
 *
 * 口径：`require('electron')` 返回的是可执行文件路径；解析成功即视为就绪。失败直接
 * 非零退出——静默跳过会让第一条用例再吃一次这笔时延，正是要消除的形态。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 从 `.npmrc` 读 `electron_mirror`（构建期配置的唯一来源）。
 *
 * 为什么不用 `require('electron/install.js')` 那套：镜像变量要在**下载发生前**就进
 * 环境，而 `require('electron')` 一旦触发现有逻辑，下载已经按 GitHub 地址开始了。
 */
function mirrorFromNpmrc() {
  const npmrcPath = path.resolve(__dirname, '..', '.npmrc');
  if (!fs.existsSync(npmrcPath)) return null;
  for (const line of fs.readFileSync(npmrcPath, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*electron_mirror\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

const mirror = process.env.npm_config_electron_mirror ?? process.env.ELECTRON_MIRROR ?? mirrorFromNpmrc();
if (mirror !== null && mirror !== undefined && mirror !== '') {
  // 补齐 npm run 才会注入的那组变量名，让直接 `node` 调用与 `npm run` 行为一致
  process.env.npm_config_electron_mirror = mirror;
  process.env.ELECTRON_MIRROR = mirror;
}

// 代理只在环境里确实配了代理时才开：没配代理的机器（本地开发）不该被塞一个开关
const hasProxy = Boolean(process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy);
if (hasProxy && process.env.ELECTRON_GET_USE_PROXY === undefined) {
  process.env.ELECTRON_GET_USE_PROXY = 'true';
}

const startedAt = Date.now();
const electronPath = require('electron');
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.error(`[warm-electron] require('electron') 没有给出可执行文件：${String(electronPath)}`);
  process.exit(1);
}
const seconds = (Date.now() - startedAt) / 1000;
console.log(`[warm-electron] ${electronPath}（${seconds.toFixed(1)}s${mirror ? `，镜像 ${mirror}` : ''}）`);
