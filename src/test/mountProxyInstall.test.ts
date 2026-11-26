/**
 * 挂载代理的部署编排（specs/051 FR-004 / FR-005 / FR-009）。
 *
 * 本组用例锁的是**宿主侧编排**的契约面：提权顺序、密码只走 stdin、失败可换路（不限次数）。
 * 真实落字节在代理的 `--install`（`mount-proxy-rs/src/privilege.rs`），真实安装落点在
 * `electron-ssh` 车道；这里用假 shell 驱动，不接触任何特权。
 *
 * 运行方式：npm run test:unit -- mount-proxy-install
 */

import assert from 'node:assert/strict';
import { CORE_MOUNT_PROXY_NAME } from '../config/project.js';
import { test } from 'node:test';

import {
  MOUNT_PROXY_INSTALL_PATH,
  passwordlessInstallCommand,
  passwordlessProbeCommand,
  deployWithCredential,
  deployWithPasswordlessSudo,
  manualInstallCommand,
  sha256Hex,
  verifyInstalledDigest,
  parseInstallReport,
  auditLine,
  type MountProxyDeployOptions,
  type MountProxyTarget,
  type MountProxyExecResult,
  type MountProxyShell,
} from '../host/mountProxyInstall.js';

const PAYLOAD = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff]);
const BUNDLED = `/opt/app/${CORE_MOUNT_PROXY_NAME}`;

/** 记录每次调用的假 shell：命令、stdin 的快照（解码后）与是否含 pty */
interface RecordedCall {
  command: string;
  stdin: string;
}

function fakeShell(
  responder: (call: { command: string; stdin: Uint8Array | undefined }) => MountProxyExecResult,
): { shell: MountProxyShell; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const shell: MountProxyShell = {
    targetHost: null,
    async run(command, options) {
      calls.push({
        command,
        // 快照：真实现会清零缓冲，断言必须看调用当时的值
        stdin: options.stdin ? new TextDecoder().decode(options.stdin) : '',
      });
      return responder({ command, stdin: options.stdin });
    },
  };
  return { shell, calls };
}

function target(
  shell: MountProxyShell,
  overrides: Partial<MountProxyTarget> = {},
): MountProxyTarget {
  return {
    shell,
    host: null,
    installSourcePath: BUNDLED,
    readProxyBytes: async () => PAYLOAD,
    isInstalled: async () => true,
    manualCommand: () => manualInstallCommand(BUNDLED),
    ...overrides,
  };
}

function options(
  shell: MountProxyShell,
  overrides: Partial<MountProxyDeployOptions> = {},
): MountProxyDeployOptions {
  return {
    target: target(shell),
    ...overrides,
  };
}

/** 目标机上执行安装的账号 uid（代理 `installer-uid=` 行的值） */
const INSTALLER_UID = 1002;

/** 假 shell 按「命令里有没有自举脚本」区分探测与安装：自举脚本含 `--install` */
function isInstallCommand(command: string): boolean {
  return command.includes('--install');
}

/**
 * 代理 `--install` 成功时的 stdout：sha256 一行 + `installer-uid=<n>` 一行。
 *
 * 两行都由代理在 root 侧算出（`mount-proxy-rs` 的 `install_from_stdin`）；宿主侧不猜
 * 安装者身份，只读这两行（FR-005 / FR-012）。
 */
function installStdout(payload: Uint8Array = PAYLOAD, uid: number | null = INSTALLER_UID): string {
  const lines = [sha256Hex(payload)];
  if (uid !== null) lines.push(`installer-uid=${uid}`);
  return `${lines.join('\n')}\n`;
}

// ────────────────────────── FR-004 第 1 条：免密优先 ──────────────────────────

test('免密 sudo 可用时直接装上，不进入凭据通道', async () => {
  // 代理 --install 成功时在 stdout 回显 sha256（FR-005 按内容比对）
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'installed');
  // 先探免密可达性、再安装（两个事实分开取，见缺陷规格）
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, passwordlessProbeCommand());
  const install = calls[1];
  // 命令固定为 `sudo -n`：不带密码，不可用就立刻失败
  assert.equal(install.command, passwordlessInstallCommand());
  assert.ok(install.command.includes('sudo -n'));
  // FR-005 第 1 条：源路径不参与安装命令（内容只经 stdin）
  assert.ok(!install.command.includes(BUNDLED), '安装命令不得含源路径');
  assert.ok(!install.command.includes(MOUNT_PROXY_INSTALL_PATH), '安装命令不得含落点');
  // 内容经 stdin 进 root 侧（FR-005 第 1 条），不进 argv
  assert.equal(install.stdin, new TextDecoder().decode(PAYLOAD));
  assert.ok(!install.command.includes('7f45'), '代理内容不出现在命令行里');
});

test('免密不可用时转三选一（这不是一次失败）', async () => {
  const { shell } = fakeShell(() => ({
    code: 1,
    stdout: '',
    stderr: 'sudo: a password is required',
  }));

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'needsCredential');
  if (outcome.kind !== 'needsCredential') return;
  // 零密码通道给完整命令（AC-12）
  assert.equal(outcome.manualCommand, manualInstallCommand(BUNDLED));
  assert.ok(outcome.manualCommand.startsWith('sudo '));
  // 零密码命令不带密码、也不含用户输入（FR-009 末句）
  assert.ok(!outcome.manualCommand.includes('password'));
});

test('安装命令返回 0 但落点没有代理时报错，不静默放过', async () => {
  const { shell } = fakeShell(() => ({ code: 0, stdout: installStdout(), stderr: '' }));

  const outcome = await deployWithPasswordlessSudo({
    target: target(shell, { isInstalled: async () => false }),
  });

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.match(outcome.failure, /没有可用的代理/);
});

// ────────────────────── FR-004 第 3 条：密码只走 stdin ──────────────────────

test('sudo 密码只走 stdin：凭据校验与安装是两条流', async () => {
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithCredential(options(shell), 'sudoPassword', 'hunter2');

  assert.equal(outcome.kind, 'installed');
  assert.equal(calls.length, 2);
  // 不进 argv（AC-13）
  assert.ok(!calls[0].command.includes('hunter2'), '密码不得出现在命令行');
  // 密码单独一条 stdin：恰好一行、写完即关（FR-004 第 3 条）
  assert.equal(calls[0].stdin, 'hunter2\n');
  assert.ok(calls[0].command.includes('sudo -S'));
  // 安装流里没有密码：否则免密 / 时间戳命中时它会成为载荷前缀
  assert.equal(calls[1].stdin, new TextDecoder().decode(PAYLOAD));
  assert.ok(!calls[1].stdin.includes('hunter2'));
});

test('root 密码走 su -c，同样只经 stdin', async () => {
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithCredential(options(shell), 'rootPassword', 'rootpw');

  assert.equal(outcome.kind, 'installed');
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].command.includes('rootpw'), '密码不得出现在命令行');
  assert.equal(calls[0].stdin, 'rootpw\n');
  assert.ok(calls[0].command.startsWith('su -c'));
  // su 从 /dev/tty 读密码，安装 stdin 只有载荷
  assert.equal(calls[1].stdin, new TextDecoder().decode(PAYLOAD));
});

test('认证失败无限次可重试：失败只带原因，不带次数', async () => {
  const { shell } = fakeShell(() => ({ code: 1, stdout: '', stderr: 'Sorry, try again.' }));

  // 连试 5 次都失败——宿主不设上限，能试几次由服务端策略（pam_faillock 等）决定
  for (let i = 0; i < 5; i += 1) {
    const outcome = await deployWithCredential(options(shell), 'sudoPassword', `wrong-${i}`);

    assert.equal(outcome.kind, 'failed');
    if (outcome.kind !== 'failed') return;
    assert.equal(outcome.failure, 'Sorry, try again.');
    assert.ok(!('attemptsLeft' in outcome), '结果里不再有剩余次数');
  }
});

test('失败原因里若含密码原文则被剔除（防御性不外泄）', async () => {
  const { shell } = fakeShell(() => ({
    code: 1,
    stdout: '',
    stderr: 'sudo: password hunter2 rejected',
  }));

  const outcome = await deployWithCredential(options(shell), 'sudoPassword', 'hunter2');

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.ok(!outcome.failure.includes('hunter2'), '失败原因不得回显密码');
});

// ─────────────────────────────── 落点与命令 ───────────────────────────────

test('安装落点是 <core.mountProxyDir>/<core.mountProxyName>', () => {
  // FR-005：/usr/libexec + 产品名派生的中性二进制名
  assert.match(MOUNT_PROXY_INSTALL_PATH, /^\/usr\/libexec\//);
  // 落点是装完后的位置，源由目标给；这里只锁落点常量本身
  assert.ok(MOUNT_PROXY_INSTALL_PATH.startsWith('/usr/libexec/'));
});

test('安装命令不含任何用户可控字符串', () => {
  // FR-009 末句：命令拼装只用常量
  // 固定自举脚本：源与落点都不进命令行
  assert.ok(passwordlessInstallCommand().includes('sudo -n sh -c'));
  assert.ok(!passwordlessInstallCommand().includes('/src/path'));
  // 代理 --install 从 stdin 读内容，零密码命令要把产物喂给它自己
  assert.equal(manualInstallCommand(BUNDLED), `sudo "${BUNDLED}" --install < "${BUNDLED}"`);
});

// ─────────────────── FR-005 按内容比对 / FR-012 审计行 ───────────────────

test('回显的 sha256 与源内容一致时判定通过', () => {
  const digest = verifyInstalledDigest(`installed\n${sha256Hex(PAYLOAD)}\n`, PAYLOAD);

  assert.equal(digest.ok, true);
  assert.equal(digest.digest, sha256Hex(PAYLOAD));
});

test('回显的 sha256 与源内容不一致时判失败（内容被替换 / 截断）', () => {
  const other = new Uint8Array([1, 2, 3]);
  const digest = verifyInstalledDigest(sha256Hex(other), PAYLOAD);

  assert.equal(digest.ok, false);
});

test('没有回显 sha256 时判失败，不默认成功', () => {
  const digest = verifyInstalledDigest('installed ok\n', PAYLOAD);

  assert.equal(digest.ok, false);
  assert.equal(digest.digest, '');
});

test('sha256 不一致时不报 installed，而是 failed 并点名原因', async () => {
  // 装了个别的东西：回显是其它内容的 sha256
  const { shell } = fakeShell(() => ({ code: 0, stdout: sha256Hex(new Uint8Array([9])), stderr: '' }));

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.match(outcome.failure, /sha256/);
});

// ────────────── FR-012 安装者 uid 来自目标机（specs/defects 的口径） ──────────────

test('RT-1 解析 stdout 取出 sha256 与安装者 uid，两行顺序无关', () => {
  const digest = sha256Hex(PAYLOAD);
  const forward = parseInstallReport(`${digest}\ninstaller-uid=1002\n`, PAYLOAD);
  const reversed = parseInstallReport(`installer-uid=1002\n${digest}\n`, PAYLOAD);

  for (const report of [forward, reversed]) {
    assert.equal(report.digest, digest);
    assert.equal(report.installerUid, 1002);
  }
});

test('RT-1 夹杂其它输出时仍能取到两行（按行匹配，不做位置假设）', () => {
  const report = parseInstallReport(
    `noise\n${sha256Hex(PAYLOAD)}\nmore noise\ninstaller-uid=0\n`,
    PAYLOAD,
  );

  assert.equal(report.digest, sha256Hex(PAYLOAD));
  assert.equal(report.installerUid, 0, 'root 直装时安装者 uid 就是 0，不能被当成缺失');
});

test('RT-1 缺 installer-uid 行时该字段为 null（调用方据此判失败）', () => {
  const report = parseInstallReport(`${sha256Hex(PAYLOAD)}\n`, PAYLOAD);

  assert.equal(report.digest, sha256Hex(PAYLOAD));
  assert.equal(report.installerUid, null);
});

test('RT-1 缺 installer-uid 行时部署判 failed，不写占位值', async () => {
  // 修复前的实现会把宿主进程 uid（Windows 上根本没有）写进审计行，最终落成 uid=unknown
  const { shell } = fakeShell(() => ({ code: 0, stdout: installStdout(PAYLOAD, null), stderr: '' }));

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.match(outcome.failure, /安装者 uid/);
});

test('installed 结果带上目标机的安装者 uid（供审计行使用）', async () => {
  const { shell } = fakeShell(() => ({ code: 0, stdout: installStdout(), stderr: '' }));

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'installed');
  if (outcome.kind !== 'installed') return;
  assert.equal(outcome.installerUid, INSTALLER_UID);
});

test('审计行含主机名 / 落点 / sha256 / uid 四要素（FR-012）', () => {
  const line = auditLine({
    targetHost: 'user@remote-host',
    installPath: MOUNT_PROXY_INSTALL_PATH,
    digest: 'a'.repeat(64),
    uid: 1001,
  });

  assert.ok(line.includes('host=user@remote-host'));
  assert.ok(line.includes(`path=${MOUNT_PROXY_INSTALL_PATH}`));
  assert.ok(line.includes(`sha256=${'a'.repeat(64)}`));
  assert.ok(line.includes('uid=1001'));
});

test('本机审计行用 localhost 占位，不留空', () => {
  const line = auditLine({
    targetHost: null,
    installPath: MOUNT_PROXY_INSTALL_PATH,
    digest: 'b'.repeat(64),
    uid: 0,
  });

  assert.ok(line.includes('host=localhost'));
});

// ─────────── specs/defects/mount-proxy-passwordless-probe-uses-exit-code.md ───────────
//
// 免密是否可用与安装是否成功是两个独立事实（FR-004 第 1 / 2 条，AC-10 / AC-11）。

test('RT-1 免密可用但安装失败时回 failed，不误判成需要密码', async () => {
  // 认证通过（探测返回 0），安装被代理的落点判据拒绝——WSL Arch 上 /usr/libexec 缺失的形态
  const { shell } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? {
          code: 3,
          stdout: '',
          stderr: `[${CORE_MOUNT_PROXY_NAME}] 安装失败：安装落点目录 /usr/libexec 不存在`,
        }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'failed', '免密可用时安装失败不能退化成凭据通道');
  if (outcome.kind !== 'failed') return;
  // AC-16 / AC-18：原因要点名可行动的那一条，不概括成「认证失败」
  assert.match(outcome.failure, /\/usr\/libexec/);
});

test('RT-2 免密确实不可用时仍回 needsCredential', async () => {
  // AC-11：stderr 明确回报需要密码——这是唯一该进凭据通道的成因
  const { shell } = fakeShell(() => ({
    code: 1,
    stdout: '',
    stderr: 'sudo: a password is required',
  }));

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'needsCredential');
  if (outcome.kind !== 'needsCredential') return;
  assert.equal(outcome.manualCommand, manualInstallCommand(BUNDLED));
});

test('RT-3 免密探测与安装分成两条命令，探测不携带载荷', async () => {
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithPasswordlessSudo(options(shell));

  assert.equal(outcome.kind, 'installed');
  assert.equal(calls.length, 2, '先探免密可用性，再执行安装');
  // 探测不落字节、不执行安装程序：它只回答「有没有密码要问」
  assert.ok(!isInstallCommand(calls[0].command), '探测命令不得执行安装');
  assert.equal(calls[0].stdin, '', '探测不携带代理字节');
  // 安装仍走固定常量命令，载荷完整且无前缀（FR-005 / FR-009）
  assert.equal(calls[1].command, passwordlessInstallCommand());
  assert.equal(calls[1].stdin, new TextDecoder().decode(PAYLOAD));
});

// ─────────── specs/defects/mount-proxy-credential-line-pollutes-payload.md ───────────
//
// 密码只写一行进**提权校验**子进程的 stdin（FR-004 第 3 条）；安装命令的 stdin 只有载荷。

test('RT-1 sudo 密码与安装载荷分两条流，载荷不带密码前缀', async () => {
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithCredential(options(shell), 'sudoPassword', 'hunter2');

  assert.equal(outcome.kind, 'installed');
  assert.equal(calls.length, 2, '先校验凭据，再执行安装');
  const credential = calls[0];
  // 不进 argv（AC-13）
  assert.ok(!credential.command.includes('hunter2'), '密码不得出现在命令行');
  assert.equal(credential.stdin, 'hunter2\n', '密码恰好一行、写完即关');
  const install = calls[1];
  assert.ok(!install.command.includes('hunter2'), '安装命令不得含密码');
  // 核心断言：载荷从头就是代理字节，没有密码前缀（否则 NOPASSWD 下会被当脚本执行）
  assert.equal(install.stdin, new TextDecoder().decode(PAYLOAD));
  assert.ok(isInstallCommand(install.command));
});

test('RT-2 root 密码通道的安装 stdin 只有载荷', async () => {
  const { shell, calls } = fakeShell(({ command }) =>
    isInstallCommand(command)
      ? { code: 0, stdout: installStdout(), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );

  const outcome = await deployWithCredential(options(shell), 'rootPassword', 'rootpw');

  assert.equal(outcome.kind, 'installed');
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].command.includes('rootpw'), '密码不得出现在命令行');
  assert.equal(calls[0].stdin, 'rootpw\n');
  const install = calls[1];
  assert.ok(!install.command.includes('rootpw'));
  // `su` 从 /dev/tty 读密码，拼进安装 stdin 只会污染载荷
  assert.equal(install.stdin, new TextDecoder().decode(PAYLOAD));
});

test('RT-3 凭据校验失败时不执行安装，失败原因不含密码', async () => {
  const { shell, calls } = fakeShell(() => ({
    code: 1,
    stdout: '',
    stderr: 'sudo: password hunter2 rejected',
  }));

  const outcome = await deployWithCredential(options(shell), 'sudoPassword', 'hunter2');

  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.ok(!outcome.failure.includes('hunter2'), '失败原因不得回显密码');
  // 校验没过就不该让 root 侧落任何字节
  assert.ok(!calls.some((call) => isInstallCommand(call.command)), '校验失败不得执行安装');
});
