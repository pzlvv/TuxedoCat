#!/usr/bin/env node
/**
 * 远端部署的真机验证（specs/051 FR-009 / specs/defects/mount-proxy-local-host-platform-gated.md）。
 *
 * 这不是「再测一遍代理二进制」——那部分（`--install` / `--serve` / 入口自检）已由
 * `scripts/verify-mount-proxy-remote.mjs` 覆盖。本脚本验证的是**本轮新增的宿主侧代码
 * 路径**：`resolveTarget` → `remoteTarget` → `beginDeploy` / `deployWithCredential`，
 * 即「Windows 宿主 + 远端 Linux 工作区」这一整条分流与编排。
 *
 * 与单测的区别：单测用假 SSH 端口断言命令形状；这里用**真实 ssh2 连接**跑同一份实现，
 * 断言装进去的字节、落点形态、就位判据与卸载回收。
 *
 * 用法：
 *   node scripts/verify-mount-proxy-target-remote.mjs
 *
 * 前置：`npm run build:core:linux-x64`（要上传的代理产物）。
 * 副作用：在远端安装 / 卸载一个 setuid root 程序；脚本结束会卸载并确认无残留。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

import {
  MOUNT_PROXY_INSTALL_PATH,
  auditLine,
  beginDeploy,
  deployWithCredential,
} from '../out/src/host/mountProxyInstall.js';
import { remoteTarget, resolveTarget } from '../out/src/host/mountProxyTarget.js';
import {
  CORE_BINARY_NAME,
  CORE_DEPLOY_PREFIX,
  CORE_MOUNT_PROXY_NAME,
} from '../out/src/config/project.js';

const env = JSON.parse(readFileSync('e2e/environments.json', 'utf8')).ssh;
// 与 Core 同目录、同名于落点（不手抄产品名：`core.mountProxyName` 唯一给出）
const PROXY_LOCAL = `resources/core/x64-linux/${CORE_MOUNT_PROXY_NAME}`;

/** 断言记录（与其它 verify 脚本同一形状：红项累计后统一退出非零） */
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `（${detail}）` : ''}`);
  }
}

/** 把 ssh2 包成 `RemoteExecPort`（与 Electron 侧 `sharedClientFor` 同构的执行面） */
function remotePort(client) {
  return {
    execWithStdin(command, stdin, timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`SSH 执行超时 ${timeoutMs}ms：${command}`));
        }, timeoutMs);
        client.exec(command, (error, channel) => {
          if (error) {
            clearTimeout(timer);
            reject(new Error(`SSH exec 失败：${error.message}`));
            return;
          }
          let stdout = '';
          let stderr = '';
          channel.setEncoding('utf8');
          channel.stderr.setEncoding('utf8');
          channel.on('data', (chunk) => {
            stdout += chunk;
          });
          channel.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          channel.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? null, stdout, stderr });
          });
          channel.on('error', (channelError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`SSH 通道失败：${channelError.message}`));
          });
          // 写完立刻关闭：与真实 SshClient.execWithStdin 同口径
          channel.end(Buffer.from(stdin));
        });
      });
    },
    homeDir() {
      return new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) {
            reject(new Error(error.message));
            return;
          }
          sftp.realpath('.', (pathError, resolved) => {
            if (pathError) reject(new Error(pathError.message));
            else resolve(resolved);
          });
        });
      });
    },
  };
}

const proxyBytes = new Uint8Array(readFileSync(PROXY_LOCAL));
const proxyDigest = createHash('sha256').update(proxyBytes).digest('hex');

const client = new Client();
client.on('ready', () => {
  void run();
});
client.on('error', (error) => {
  console.error(`SSH 连接失败：${error.message}`);
  process.exit(1);
});
client.connect({
  host: env.host,
  port: env.port,
  username: env.user,
  password: env.password,
  readyTimeout: 20_000,
});

async function run() {
  const port = remotePort(client);
  // 构造与 Electron 宿主相同的解析进参：会话工作区是远端 SSH
  const deps = {
    workspaceRef: {
      scheme: 'ssh',
      path: '/home/pz',
      endpoint: { host: env.host, port: env.port, user: env.user, auth: null },
    },
    extensionPath: process.cwd(),
    bundledProxyPath: PROXY_LOCAL,
    readBundledBytes: async () => proxyBytes,
    isInstalledLocally: async () => false,
    remoteExec: async () => port,
  };

  try {
    // ── 1. 分流：远端工作区必须解析出远端目标（缺陷正面回归） ──
    console.log('\n── 1. 目标分流（resolveTarget）──');
    const target = await resolveTarget(deps);
    check('远端工作区解析出目标', target !== null);
    if (!target) return;
    check('目标主机名点名远端', target.host === `${env.user}@${env.host}`, target.host ?? 'null');

    // ── 2. 远端路径不混本机路径 ──
    console.log('\n── 2. 零密码命令（remoteTarget.manualCommand）──');
    const manual = target.manualCommand();
    // 落点与 Core **同槽位**（FR-009「随 Core 一起上传」）：指纹目录由 Core 的
    // `fingerprint` 决定，这里按同一派生规则取期望路径
    const slotDir = `${await port.homeDir()}/.local/share/${CORE_DEPLOY_PREFIX}/${readFileSync(
      'resources/core/x64-linux/fingerprint',
      'utf8',
    ).trim()}`;
    const expectedStaging = `${slotDir}/${CORE_MOUNT_PROXY_NAME}`;
    check('命令用远端 Core 同槽位路径', manual.includes(expectedStaging), expectedStaging);
    check('命令不含 Windows 盘符', !/[A-Za-z]:\\/.test(manual));
    check('命令不含宿主随包路径', !manual.includes(PROXY_LOCAL));

    // ── 3. 上传：字节经 stdin，sha256 核对 ──
    console.log('\n── 3. 上传与清理 ──');
    const staged = await port.execWithStdin(
      `sha256sum "${expectedStaging}" 2>/dev/null | cut -d' ' -f1`,
      new Uint8Array(),
      15_000,
    );
    check('暂存位已上传且 sha256 一致', staged.stdout.trim() === proxyDigest, staged.stdout.trim() || 'ABSENT');

    // ── 4. 免密通道：真实远端不可用（已知 sudo -n 需要口令） ──
    console.log('\n── 4. 免密通道（beginDeploy）──');
    const first = await beginDeploy({ target });
    check('免密不可用转三选一', first.kind === 'needsCredential', first.kind);
    check('三选一带完整命令', first.kind === 'needsCredential' && first.manualCommand.length > 0);

    // ── 5. 凭据通道：sudo -S 装机 ──
    console.log('\n── 5. 凭据通道（deployWithCredential）──');
    const second = await deployWithCredential({ target }, 'sudoPassword', env.password);
    check('sudo -S 安装成功', second.kind === 'installed', second.kind === 'failed' ? second.failure : second.kind);

    // ── 6. 落点形态：root:root 04755 + 内容一致 ──
    console.log('\n── 6. 落点形态（FR-005b / AC-15）──');
    const stat = await port.execWithStdin(
      `stat -c '%U %G %a' "${MOUNT_PROXY_INSTALL_PATH}" 2>&1 || echo ABSENT`,
      new Uint8Array(),
      15_000,
    );
    check('落点 root root 4755', stat.stdout.trim() === 'root root 4755', stat.stdout.trim());
    const installedDigest = await port.execWithStdin(
      `sha256sum "${MOUNT_PROXY_INSTALL_PATH}" | cut -d' ' -f1`,
      new Uint8Array(),
      15_000,
    );
    check('落点内容与源一致', installedDigest.stdout.trim() === proxyDigest);

    // ── 7. 就位判据（isInstalled，宿主侧真实走过的那条） ──
    console.log('\n── 7. 就位判据（target.isInstalled）──');
    check('isInstalled() 认得出已装', (await target.isInstalled()) === true);

    // ── 8. 审计行形状（FR-012） ──
    console.log('\n── 8. 审计行（FR-012）──');
    const line = auditLine({
      targetHost: target.host,
      installPath: MOUNT_PROXY_INSTALL_PATH,
      digest: proxyDigest,
      uid: 1001,
    });
    check('审计行点名主机', line.includes(`host=${env.user}@${env.host}`), line);
    check('审计行含 sha256 与落点', line.includes(proxyDigest) && line.includes(MOUNT_PROXY_INSTALL_PATH));

    // ── 9. 幂等重装：内容相同不重写 ──
    console.log('\n── 9. 幂等重装 ──');
    const before = await port.execWithStdin(
      `stat -c '%i %Y' "${MOUNT_PROXY_INSTALL_PATH}"`,
      new Uint8Array(),
      15_000,
    );
    const again = await deployWithCredential({ target }, 'sudoPassword', env.password);
    const after = await port.execWithStdin(
      `stat -c '%i %Y' "${MOUNT_PROXY_INSTALL_PATH}"`,
      new Uint8Array(),
      15_000,
    );
    check('重装成功', again.kind === 'installed');
    // 内容相同→root 侧不重写（FR-005「升级：按内容比对」），inode 与 mtime 都不变
    check('同内容重装不重写落点', before.stdout.trim() === after.stdout.trim(), `${before.stdout.trim()} → ${after.stdout.trim()}`);
  } finally {
    // ── 10. 卸载与回收 ──
    console.log('\n── 10. 卸载与残留检查 ──');
    const uninstall = await port.execWithStdin(
      `echo '${env.password}' | sudo -S -p '' rm -f "${MOUNT_PROXY_INSTALL_PATH}" "${MOUNT_PROXY_INSTALL_PATH}.uids" 2>&1; ` +
        `echo done`,
      new Uint8Array(),
      30_000,
    );
    check('卸载命令执行', uninstall.stdout.includes('done'));
    const leftover = await port.execWithStdin(
      `test -e "${MOUNT_PROXY_INSTALL_PATH}" && echo PRESENT || echo ABSENT; ` +
        `test -e "${MOUNT_PROXY_INSTALL_PATH}.uids" && echo UIDS_PRESENT || echo UIDS_ABSENT; ` +
        `test -e "${expectedStaging}" && echo STAGING_PRESENT || echo STAGING_ABSENT`,
      new Uint8Array(),
      15_000,
    );
    check('落点已清除', leftover.stdout.includes('ABSENT') && !leftover.stdout.includes('PRESENT'));
    check('允许列表已清除', leftover.stdout.includes('UIDS_ABSENT'));
    check('暂存目录已清除', leftover.stdout.includes('STAGING_ABSENT'));

    console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`);
    client.end();
    process.exit(failures.length === 0 ? 0 : 1);
  }
}
