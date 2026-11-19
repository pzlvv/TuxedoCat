/**
 * 部署目标的分流（specs/051 FR-004 / FR-009）。
 *
 * 锁两件事：
 * 1. **目标按会话判定，不按宿主平台**——`specs/defects/mount-proxy-local-host-platform-gated.md`
 *    的回归：Windows 宿主 + 远端 Linux 工作区必须解析出远端目标，不能因为
 *    `process.platform === 'win32'` 就判成「不支持部署」；
 * 2. 远端路径不混本地路径——零密码通道的命令必须能在远端终端直接跑。
 *
 * 运行方式：npm run test:unit -- mount-proxy-target
 */

import assert from 'node:assert/strict';
import {
  CORE_BINARY_NAME,
  CORE_DEPLOY_PREFIX,
  CORE_MOUNT_PROXY_NAME,
} from '../config/project.js';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  bundledProxyPathFor,
  remoteTarget,
  resolveTarget,
  type RemoteExecPort,
} from '../host/mountProxyTarget.js';
import { localWorkspaceRef, type WorkspaceRef } from '../host/workspaceRef.js';

const PAYLOAD = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff]);
const LOCAL_BUNDLED = `/opt/app/resources/core/x64-linux/${CORE_MOUNT_PROXY_NAME}`;

/** 远端工作区引用（SSH） */
function sshRef(): WorkspaceRef {
  return {
    scheme: 'ssh',
    path: '/home/pz/project',
    endpoint: { host: '8.136.22.171', port: 22, user: 'pz', auth: null },
  };
}

/** 记录调用的假远端执行面 */
function fakeRemote(options: { installed?: boolean } = {}): {
  port: RemoteExecPort;
  calls: Array<{ command: string; stdinLength: number }>;
} {
  const calls: Array<{ command: string; stdinLength: number }> = [];
  const port: RemoteExecPort = {
    async execWithStdin(command, stdin) {
      calls.push({ command, stdinLength: stdin.length });
      if (command.includes('sha256sum')) {
        // 上传回显：返回与内容匹配的 sha256（用真实实现算，避免手抄）
        const { createHash } = await import('node:crypto');
        const digest = createHash('sha256').update(PAYLOAD).digest('hex');
        return { code: 0, stdout: `${digest}  staged`, stderr: '' };
      }
      if (command.includes('stat -c')) {
        return {
          code: 0,
          stdout: options.installed ? 'root root 4755\n' : 'ABSENT\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async homeDir() {
      return '/home/pz';
    },
  };
  return { port, calls };
}

function deps(overrides: Partial<Parameters<typeof resolveTarget>[0]> = {}) {
  return {
    workspaceRef: localWorkspaceRef('/work/project'),
    extensionPath: '/opt/app',
    resolveBundledProxy: () => LOCAL_BUNDLED,
    readBundledBytes: async () => PAYLOAD,
    isInstalledLocally: async () => false,
    remoteExec: async () => null,
    detectRemoteTarget: async () => ({ platform: 'linux' as const, arch: 'x64' }),
    // 远端槽位与 Core 同目录（FR-009「随 Core 一起上传」）
    remoteCoreDeployDir: (platform: string, arch: string) =>
      `share/${CORE_DEPLOY_PREFIX}/${platform}-${arch}`,
    ...overrides,
  };
}

// ─────────────── 缺陷回归：目标由会话决定，不由宿主平台决定 ───────────────

test('远端 SSH 会话解析出远端目标（与宿主平台无关）', async () => {
  const { port } = fakeRemote();
  const resolved = await resolveTarget(deps({ workspaceRef: sshRef(), remoteExec: async () => port }));

  assert.notEqual(resolved, null, '远端工作区必须能解析出目标');
  // FR-009：确认框点名真实主机
  assert.equal(resolved?.host, 'pz@8.136.22.171');
});

test('本地工作区在非 Linux 宿主上解析不出目标（没有 overlayfs 语义）', async () => {
  const resolved = await resolveTarget(deps());

  if (process.platform === 'linux') {
    assert.notEqual(resolved, null);
  } else {
    assert.equal(resolved, null, '非 Linux 宿主 + 本地工作区应给 null');
  }
});

test('远端连接取不到时给 null，不退回本机', async () => {
  const resolved = await resolveTarget(deps({
    workspaceRef: sshRef(),
    remoteExec: async () => null,
  }));

  // 退回本机会把代理装到错误的机器上——必须显式失败
  assert.equal(resolved, null);
});

test('非 SSH 的远端 scheme（wsl / container）不猜路径', async () => {
  const resolved = await resolveTarget(deps({
    workspaceRef: { scheme: 'wsl', path: '/work', endpoint: sshRef().endpoint },
    remoteExec: async () => fakeRemote().port,
  }));

  assert.equal(resolved, null);
});

// ─────────────────────── 远端路径不混本地路径 ───────────────────────

test('远端目标的零密码命令用 Core 同槽位路径，不含本地路径', async () => {
  const { port } = fakeRemote();
  const resolved = await remoteTarget(deps({ workspaceRef: sshRef() }), port, { platform: 'linux', arch: 'x64' });
  const command = resolved.manualCommand();

  // 落点与 Core **同槽位**（FR-009「随 Core 一起上传」）：一个指纹一个目录，
  // 多版本并存互不覆盖，代理版本天然跟着 Core 版本走。
  assert.ok(
    command.includes(
      `/home/pz/.local/share/${CORE_DEPLOY_PREFIX}/linux-x64/${CORE_MOUNT_PROXY_NAME}`,
    ),
    command,
  );
  // 本地 Windows / 扩展目录路径不得漏进去
  assert.ok(!command.includes(LOCAL_BUNDLED), '零密码命令不得含本地随包路径');
  assert.ok(!/\b[A-Z]:\\/.test(command), '零密码命令不得含 Windows 盘符路径');
  // 代理 --install 从 stdin 读内容，命令要带输入源（FR-005 第 1 条）
  assert.match(command, /<\s+"/);
});

test('上传把字节经 stdin 送过去，并核对 sha256', async () => {
  const { port, calls } = fakeRemote();
  await remoteTarget(deps({ workspaceRef: sshRef() }), port, { platform: 'linux', arch: 'x64' });

  const upload = calls.find((call) => call.command.includes('sha256sum'));
  assert.ok(upload, '上传命令里要有 sha256 校验');
  assert.equal(upload?.stdinLength, PAYLOAD.length, '代理字节必须经 stdin 送，不进 argv');
  assert.ok(!upload?.command.includes('7f45'), '字节内容不得出现在命令行');
});

test('远端就位判据读 root root 04755（与本地同口径，FR-005b）', async () => {
  const installed = await remoteTarget(deps({ workspaceRef: sshRef() }), fakeRemote({ installed: true }).port, { platform: 'linux', arch: 'x64' });
  assert.equal(await installed.isInstalled(), true);

  const missing = await remoteTarget(deps({ workspaceRef: sshRef() }), fakeRemote({ installed: false }).port, { platform: 'linux', arch: 'x64' });
  assert.equal(await missing.isInstalled(), false);
});

test('远端目标的执行面点名主机，供确认框显示', async () => {
  const resolved = await remoteTarget(deps({ workspaceRef: sshRef() }), fakeRemote().port, { platform: 'linux', arch: 'x64' });

  assert.equal(resolved.host, 'pz@8.136.22.171');
  assert.equal(resolved.shell.targetHost, 'pz@8.136.22.171');
});

// ───────────────────────────── 路径工具 ─────────────────────────────

test('随包代理路径与 Core 产物同目录、同名于落点', () => {
  const resolved = bundledProxyPathFor(`/opt/app/resources/core/x64-linux/${CORE_BINARY_NAME}`);

  // 本机路径用宿主分隔符（Windows 上是反斜杠），因此按 basename / dirname 断言
  assert.equal(path.basename(resolved), CORE_MOUNT_PROXY_NAME);
  assert.equal(
    path.dirname(resolved),
    path.dirname(path.join('/opt/app/resources/core/x64-linux', CORE_BINARY_NAME)),
  );
});
