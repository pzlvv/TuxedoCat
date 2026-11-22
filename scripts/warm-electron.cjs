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
 * 口径：`require('electron')` 返回的是可执行文件路径；解析成功即视为就绪。失败直接
 * 非零退出——静默跳过会让第一条用例再吃一次这笔时延，正是要消除的形态。
 */
const fs = require('node:fs');

const startedAt = Date.now();
const electronPath = require('electron');
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.error(`[warm-electron] require('electron') 没有给出可执行文件：${String(electronPath)}`);
  process.exit(1);
}
console.log(`[warm-electron] ${electronPath}（${Date.now() - startedAt}ms）`);
