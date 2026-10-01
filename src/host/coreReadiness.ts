/**
 * 宿主侧的 Core 就绪状态（`docs/core-ui-separation.md` 第 7 节）。
 *
 * 就绪判据是「Core 已处理 `hostEnvironmentProvided`」——Core 处理完发一次
 * `CoreEvent.coreReady`。每次重新推送配置快照后都会再收到一次，因此这里的
 * 状态是**闩锁**：第一次就绪后不会退回未就绪（Core 崩溃重启走的是
 * `StandaloneCoreBus` 自己的握手状态，与配置快照无关）。
 *
 * 与 `StandaloneCoreBus.isReady()` 的区别：那个是**传输层**握手（Core 进程
 * 已启动、帧通道已建立）；这里是**配置层**就绪（Core 已拿到宿主环境与快照）。
 */

import { logger } from '../core/Logger.js';

let ready = false;
let readyCount = 0;

/** Core 报告就绪（`CoreEvent.coreReady` 的处理入口） */
export function markCoreReady(): void {
  readyCount += 1;
  if (ready) return; // 快照重新推送导致的重复就绪：只计数，不重复打日志
  ready = true;
  logger.info('coreReadiness', 'Core is ready (host environment applied)');
}

/** 配置层是否已就绪 */
export function isCoreReady(): boolean {
  return ready;
}

/** 本次会话收到的就绪次数（首次 + 每次快照重新推送；诊断用） */
export function coreReadyCount(): number {
  return readyCount;
}

