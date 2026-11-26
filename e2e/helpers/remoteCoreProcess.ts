/**
 * SSH 车道的远端 Core 进程口径（`remoteSshExecution` / `remoteTaskSurvival` /
 * `remoteChangeList` / `overlayMountProxyRemote` 共用）。
 *
 * 为什么必须按**构建指纹**收敛，而不只按二进制名：远端是共享机器（CI 里自托管 runner
 * 与 SSH 远端就是同一台，`E2E_SSH_HOST=127.0.0.1`），同一台机器上会同时存在多个部署槽位
 * `~/.local/share/<core.deployPrefix>/<指纹>/`（见 [docs/core/core-remote.md 第 2.3 节](../../docs/core/core-remote.md#23-状态文件)：
 * 一个指纹一个 daemon、一份状态文件，多版本各占一个槽位互不踩踏）。只按
 * `<core.binaryName>` 匹配有两条后果，都在 run 45877287618 上实际发生过：
 *
 * 1. **别人的 Core 被算成自己的残留**：`US-65 离场完成` 等的是「本层孤儿 Core 已被收尾」，
 *    判据是远端没有 ` stdio` 形态的 Core——另一个槽位的 Core 让条件永远不成立，
 *    失败信息里三条残留进程分属两个指纹（`c601…` 与 `2429…`）。
 * 2. **清场时误杀别人的进程**：`pkill -f '<binaryName>'` 是无差别口径，会顺手杀掉同机
 *    另一个槽位正在服务的 daemon / Core。
 *
 * 车道只对自己这轮部署的进程负责，因此模式里带上本机构建指纹（部署槽位名就是它）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { CORE_BINARY_NAME, CORE_DEPLOY_PREFIX } from '../../src/config/project';

/** 仓库根目录（用例进程的 cwd 是 `e2e/`） */
export function repoRoot(cwd = process.cwd()): string {
  return cwd.replace(/[\\/]e2e$/, '');
}

/**
 * 本机构建的 Core 指纹（远端部署槽位名就是它）。
 *
 * 指纹由 Core 产物内容算出（`dist/resources/core/<arch>-<platform>/fingerprint`，
 * 见 `scripts/build-core.mjs` 的 `computeFingerprint`），因此按本机指纹拼出的槽位路径
 * 正好指向这一轮自己部署的那份。产物缺失返回 `null`，由调用方决定是拒绝运行还是跳过。
 */
export function localCoreFingerprint(cwd = process.cwd()): string | null {
  try {
    return fs.readFileSync(
      path.join(repoRoot(cwd), 'dist', 'resources', 'core', 'x64-linux', 'fingerprint'),
      'utf8',
    ).trim();
  } catch {
    return null;
  }
}

/**
 * 本机构建指纹，缺失即抛错。
 *
 * 不静默降级成「按二进制名匹配」：那正是本文件开头记的两条后果。缺产物时前置命令是
 * `npm run build:core:linux-x64`，直接报出来比在断言超时里绕一圈更容易诊断。
 */
export function requireLocalCoreFingerprint(cwd = process.cwd()): string {
  const fingerprint = localCoreFingerprint(cwd);
  if (!fingerprint) {
    throw new Error(
      '缺少本机 Linux Core 产物的指纹（dist/resources/core/x64-linux/fingerprint）。'
      + 'SSH 车道按指纹收敛远端进程，先执行 npm run build:core:linux-x64。',
    );
  }
  return fingerprint;
}

/**
 * `pgrep` / `pkill -f` 的匹配模式：只命中**本指纹部署槽位**里的 Core。
 *
 * 二进制名首字符加 `[]`（`[t]uxedo-cat-core`）：执行 pgrep / pkill 的远端 shell 自身
 * 命令行里带着这串模式原文，不加方括号就会把自己也匹配上（`pkill` 会杀掉半途的清场 shell）。
 */
export function coreProcessPattern(fingerprint: string): string {
  return `${CORE_DEPLOY_PREFIX}/${fingerprint}/[${CORE_BINARY_NAME[0]}]${CORE_BINARY_NAME.slice(1)}`;
}

/**
 * 只要 daemon 进程（`start-daemon`）的模式。
 *
 * 用于 SIGSTOP / SIGCONT / -9 这类针对 daemon 本身的操作：同样带指纹，避免暂停或杀掉
 * 同机另一个槽位的 daemon（`start-daemo[n]` 的方括号沿同样理由防自匹配）。
 */
export function daemonProcessPattern(fingerprint: string): string {
  return `${coreProcessPattern(fingerprint)} start-daemo[n]`;
}
