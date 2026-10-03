/**
 * 单测：SSH 远端引导（`src/host/standalone/sshDaemonBootstrap.ts`）。
 *
 * 覆盖 `docs/core-daemon.md` 第 12 节的三条分支与它们的失败路径：
 * - 已经在跑 → 可执行文件与本机携带产物一致时直接复用，不重启 daemon
 *   （缺 Core 自带的 `ripgrep/` 时仍补传它）；
 * - 已经在跑但远端可执行文件是**旧版本产物**（哈希不一致 / 读不出）→ kill + 覆盖上传
 *   + start：daemon 是常驻进程，旧版本应用留下的 daemon 会一直拉起旧 Core
 *   （协议不变、行为缺失——新增的 CoreEvent 事件不发），必须换血；
 * - 已部署未启动 → 只跑 `start`（缺自带 `ripgrep/` 时补传它）；
 * - 未部署 → 上传产物（Core 可执行文件 + 同级的自带 `ripgrep/`）+ `start`；
 * - `start` 失败 / 状态文件读不出来 / 本机产物缺自带 ripgrep → 报错，不静默降级。
 *
 * 用假 SSH 实现（`RemoteSsh`）跑，不需要真实机器；真实链路由 `sshClient` 的
 * 端到端用例（手工 / Electron）覆盖。
 *
 * 运行方式：npm run test:all -- ssh-daemon-bootstrap
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import {
  detectRemoteTarget,
  ensureRemoteDaemon,
  splitEndpoint,
  type RemoteSsh,
} from '../host/standalone/sshDaemonBootstrap';
import type { SshExecResult, SshFileInfo } from '../host/standalone/sshClient';

const HOME = '/home/dev';
const STATE_PATH = `${HOME}/.tuxedo-cat/core-daemon.json`;
const BINARY_PATH = `${HOME}/.local/bin/tuxedo-cat-core`;
/** Core 自带的 ripgrep：与远端可执行文件同级（`docs/standalone-core.md` 第 4 节） */
const RIPGREP_PATH = `${HOME}/.local/bin/ripgrep/rg`;

/** 假的远端 SSH：文件系统、可执行文件与转发可达性都可控 */
class FakeSsh implements RemoteSsh {
  readonly commands: string[] = [];
  readonly uploads: Array<{ local: string; remote: string; mode: number }> = [];
  /** 远端普通文件：路径 → 内容 */
  readonly files = new Map<string, string>();
  /** 远端存在的可执行文件 */
  readonly executables = new Set<string>();
  /** 可转发的 `host:port` */
  readonly reachable = new Set<string>();
  uname = 'Linux x86_64';
  startExit = 0;
  startStderr = '';
  /** `sha256sum <远端可执行文件>` 的应答；null 表示命令不可用（返回非 0） */
  remoteBinarySha256: string | null = null;
  /** 执行过的 `kill` 次数 */
  killCount = 0;
  /** `start` 之后不落状态文件（模拟 daemon 没起来） */
  skipState = false;
  private endpoint = '0.0.0.0:10975';
  /** 每次 `start` 换一个 token：用来区分「复用旧 daemon」与「新起了 daemon」 */
  private startCount = 0;

  async homeDir(): Promise<string> {
    return HOME;
  }

  async stat(target: string): Promise<SshFileInfo> {
    const text = this.files.get(target);
    if (text !== undefined) return { exists: true, size: text.length, mode: 0o644 };
    if (this.executables.has(target)) return { exists: true, size: 1024, mode: 0o755 };
    return { exists: false, size: 0, mode: 0 };
  }

  async readText(target: string): Promise<string> {
    const text = this.files.get(target);
    if (text === undefined) throw new Error(`no such file: ${target}`);
    return text;
  }

  async upload(localPath: string, remotePath: string, mode: number): Promise<void> {
    this.uploads.push({ local: localPath, remote: remotePath, mode });
    this.executables.add(remotePath);
  }

  async openTcpForward(host: string, port: number): Promise<{ destroy(): void }> {
    if (!this.reachable.has(`${host}:${port}`)) {
      throw new Error(`connect refused: ${host}:${port}`);
    }
    return { destroy: () => undefined };
  }

  async exec(command: string): Promise<SshExecResult> {
    this.commands.push(command);
    if (command === 'uname -sm') return { code: 0, stdout: `${this.uname}\n`, stderr: '' };
    if (command.startsWith('mkdir -p ')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('mv -f ')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('sha256sum ')) {
      if (this.remoteBinarySha256 === null) {
        return { code: 1, stdout: '', stderr: 'sha256sum: command not found' };
      }
      const target = command.slice('sha256sum '.length).replace(/^'/, '').replace(/'$/, '');
      return { code: 0, stdout: `${this.remoteBinarySha256}  ${target}
`, stderr: '' };
    }
    if (command.endsWith(' kill')) {
      this.killCount += 1;
      return { code: 0, stdout: 'daemon stopped', stderr: '' };
    }
    if (command.endsWith(' start')) {
      if (this.startExit === 0 && !this.skipState) {
        this.startCount += 1;
        this.writeState(this.endpoint, `tok-${this.startCount}`);
      }
      return { code: this.startExit, stdout: '', stderr: this.startStderr };
    }
    throw new Error(`unexpected remote command: ${command}`);
  }

  writeState(endpoint: string, token: string): void {
    this.endpoint = endpoint;
    this.files.set(
      STATE_PATH,
      JSON.stringify({ requested: '0.0.0.0:10975', endpoint, token }),
    );
  }
}

/** 建一份带 Linux 产物目录的临时 extensionPath，并返回产物路径 */
function makeExtensionPath(): { root: string; binary: string; ripgrep: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-'));
  const binary = path.join(root, 'dist', 'resources', 'core', 'x64-linux', 'tuxedo-cat-core');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fake-core-binary');
  // Core 自带的 ripgrep 与可执行文件同级（`npm run build:core` 的落位）
  const ripgrep = path.join(path.dirname(binary), 'ripgrep', 'rg');
  fs.mkdirSync(path.dirname(ripgrep), { recursive: true });
  fs.writeFileSync(ripgrep, 'fake-rg-binary');
  return { root, binary, ripgrep };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

runTests('sshDaemonBootstrap', async () => {
  const { check, finish } = createChecker();
  const { root, binary, ripgrep } = makeExtensionPath();
  const options = { extensionPath: root, log: () => undefined };

  // ---------- endpoint 解析 ----------

  check('通配地址换成回环', splitEndpoint('0.0.0.0:10975')?.host === '127.0.0.1');
  check('IPv6 通配地址换成回环', splitEndpoint('[::]:10975')?.host === '127.0.0.1');
  check('具体地址原样保留', splitEndpoint('192.168.1.5:10975')?.host === '192.168.1.5');
  check('端口解析正确', splitEndpoint('192.168.1.5:10975')?.port === 10975);
  check('缺端口返回 null', splitEndpoint('192.168.1.5') === null);
  check('端口非法返回 null', splitEndpoint('192.168.1.5:abc') === null);
  check('空串返回 null', splitEndpoint('') === null);

  // ---------- 远端平台识别 ----------

  {
    const fake = new FakeSsh();
    const target = await detectRemoteTarget(fake);
    check('Linux x86_64 识别为 linux/x64', target.platform === 'linux' && target.arch === 'x64');
  }
  {
    const fake = new FakeSsh();
    fake.uname = 'Linux aarch64';
    const target = await detectRemoteTarget(fake);
    check('Linux aarch64 识别为 linux/arm64', target.platform === 'linux' && target.arch === 'arm64');
  }
  {
    const fake = new FakeSsh();
    fake.uname = 'Darwin arm64';
    let message = '';
    try {
      await detectRemoteTarget(fake);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('不支持的平台报错', message.includes('Darwin'));
  }
  {
    const fake = new FakeSsh();
    fake.uname = 'Linux riscv64';
    let message = '';
    try {
      await detectRemoteTarget(fake);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('不支持的架构报错', message.includes('riscv64'));
  }

  // ---------- 已经在跑：直接复用 ----------

  {
    const fake = new FakeSsh();
    fake.writeState('0.0.0.0:10975', 'tok-running');
    fake.reachable.add('127.0.0.1:10975');
    fake.executables.add(RIPGREP_PATH);
    fake.executables.add(BINARY_PATH);
    fake.remoteBinarySha256 = 'bc35ec7bb516df0febed3638f841da8073f2563a7ddc2d35debed9f3e3ffc320';
    const daemon = await ensureRemoteDaemon(fake, options);
    check('复用运行中的 daemon（回环地址）', daemon.host === '127.0.0.1' && daemon.port === 10975);
    check('复用运行中的 daemon（token）', daemon.token === 'tok-running');
    check('复用时不重启 daemon', fake.killCount === 0 && !fake.commands.some((command) => command.endsWith(' start')));
    check('复用时不部署产物', fake.uploads.length === 0);
  }

  // ---------- 已经在跑但远端是旧版本产物：kill + 覆盖上传 + start ----------

  {
    const fake = new FakeSsh();
    fake.writeState('0.0.0.0:10975', 'tok-old');
    fake.reachable.add('127.0.0.1:10975');
    fake.executables.add(RIPGREP_PATH);
    fake.remoteBinarySha256 = 'deadbeef-previous-build';
    const daemon = await ensureRemoteDaemon(fake, options);
    check('旧版本 daemon 被结束', fake.killCount === 1);
    check('旧版本产物经临时名换血（不直接写执行中的文件）', fake.uploads.some(
      (upload) => upload.remote === `${BINARY_PATH}.new` && upload.local === binary,
    ) && fake.commands.includes(`mv -f '${BINARY_PATH}.new' '${BINARY_PATH}'`));
    check('换血后重新 start', fake.commands.includes(`'${BINARY_PATH}' start`));
    check('换血后返回新 daemon 的 token', daemon.token === 'tok-1');
  }

  // ---------- 已经在跑但远端读不出哈希：按过期处理（安全方向） ----------

  {
    const fake = new FakeSsh();
    fake.writeState('0.0.0.0:10975', 'tok-old');
    fake.reachable.add('127.0.0.1:10975');
    fake.executables.add(RIPGREP_PATH);
    fake.remoteBinarySha256 = null;
    const daemon = await ensureRemoteDaemon(fake, options);
    check('哈希读不出时同样换血', fake.killCount === 1 && daemon.token === 'tok-1');
  }

  // ---------- 已在跑但缺自带 ripgrep：补 rg，不重启 daemon ----------

  {
    const fake = new FakeSsh();
    fake.writeState('0.0.0.0:10975', 'tok-running');
    fake.reachable.add('127.0.0.1:10975');
    fake.remoteBinarySha256 = 'bc35ec7bb516df0febed3638f841da8073f2563a7ddc2d35debed9f3e3ffc320';
    const daemon = await ensureRemoteDaemon(fake, options);
    check('补 rg 后仍复用同一个 daemon', daemon.token === 'tok-running');
    check('已在跑时补传自带 ripgrep', fake.uploads.length === 1
      && fake.uploads[0]?.remote === RIPGREP_PATH && fake.uploads[0]?.local === ripgrep);
    check('已在跑时不重跑 start', !fake.commands.some((command) => command.endsWith(' start')));
  }

  // ---------- 已部署未启动：只跑 start ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    fake.remoteBinarySha256 = 'bc35ec7bb516df0febed3638f841da8073f2563a7ddc2d35debed9f3e3ffc320';
    const daemon = await ensureRemoteDaemon(fake, options);
    check('已部署时返回状态文件里的 token', daemon.token === 'tok-1');
    check('产物一致时不重新上传', fake.uploads.length === 0);
    check('已部署时执行 start', fake.commands.includes(`'${BINARY_PATH}' start`));
    // 远端可执行文件名的平台后缀要先问 `uname`，因此这一步一定会发生
    check('先问远端平台', fake.commands.includes('uname -sm'));
  }

  // ---------- 已部署未启动但产物过期：覆盖上传后 start ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    fake.remoteBinarySha256 = 'deadbeef-previous-build';
    const daemon = await ensureRemoteDaemon(fake, options);
    check('未启动的过期产物同样经临时名覆盖', fake.uploads.some(
      (upload) => upload.remote === `${BINARY_PATH}.new` && upload.local === binary,
    ) && fake.commands.includes(`mv -f '${BINARY_PATH}.new' '${BINARY_PATH}'`));
    check('覆盖上传后执行 start', fake.commands.includes(`'${BINARY_PATH}' start`));
    check('返回新 daemon 的 token', daemon.token === 'tok-1');
  }

  // ---------- 旧部署缺自带 ripgrep：只补 rg，不重传可执行文件 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    await ensureRemoteDaemon(fake, options);
    // 哈希读不出（本测试桩没给 sha256sum 应答）按「产物未知」处理：连可执行文件一起覆盖
    check('哈希读不出时连可执行文件一起覆盖', fake.uploads.some(
      (upload) => upload.remote === `${BINARY_PATH}.new` && upload.local === binary,
    ));
    check('缺自带 ripgrep 时补传', fake.uploads.some(
      (upload) => upload.remote === RIPGREP_PATH && upload.local === ripgrep,
    ));
    check('补传的 rg 置可执行权限', fake.uploads.find((upload) => upload.remote === RIPGREP_PATH)?.mode === 0o755);
    check('补传前建好目录', fake.commands.includes(`mkdir -p '${HOME}/.local/bin/ripgrep'`));
  }

  // ---------- 未部署：上传 + start ----------

  {
    const fake = new FakeSsh();
    const daemon = await ensureRemoteDaemon(fake, options);
    check('未部署时上传到 ~/.local/bin（经临时名 + mv 原子换名）', fake.uploads.length === 2
      && fake.uploads[0]?.remote === `${BINARY_PATH}.new`
      && fake.commands.includes(`mv -f '${BINARY_PATH}.new' '${BINARY_PATH}'`));
    check('上传的是本机携带的对应平台产物', fake.uploads[0]?.local === binary);
    check('目标文件本身永不直接覆盖写（执行中的 daemon 是 ETXTBSY）',
      !fake.uploads.some((upload) => upload.remote === BINARY_PATH));
    check('上传后置可执行权限', fake.uploads[0]?.mode === 0o755);
    check('未部署时一并上传自带 ripgrep', fake.uploads[1]?.remote === RIPGREP_PATH
      && fake.uploads[1]?.local === ripgrep);
    check('上传前建好目录', fake.commands.includes(`mkdir -p '${HOME}/.local/bin'`));
    check('上传后执行 start', fake.commands.includes(`'${BINARY_PATH}' start`));
    check('返回 daemon endpoint', daemon.host === '127.0.0.1' && daemon.port === 10975);
  }

  // ---------- 状态文件在但连不上：按「没在跑」处理 ----------

  {
    const fake = new FakeSsh();
    fake.writeState('0.0.0.0:10975', 'tok-stale');
    fake.executables.add(BINARY_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('探测失败后重新启动', fake.commands.includes(`'${BINARY_PATH}' start`));
    check('重新启动后返回新 token', daemon.token === 'tok-1');
  }

  // ---------- 状态文件损坏：按「没在跑」处理 ----------

  {
    const fake = new FakeSsh();
    fake.files.set(STATE_PATH, '{ not json');
    fake.executables.add(BINARY_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('损坏的状态文件被忽略', fake.commands.includes(`'${BINARY_PATH}' start`));
    check('损坏的状态文件不阻止接入', daemon.token === 'tok-1');
  }

  // ---------- start 失败：把远端 stderr 带回来 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.startExit = 1;
    fake.startStderr = 'port already in use';
    let message = '';
    try {
      await ensureRemoteDaemon(fake, options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('start 失败时报错', message.includes('start') && message.includes('exit 1'));
    check('start 失败时带上远端 stderr', message.includes('port already in use'));
  }

  // ---------- start 成功但没落状态文件：报错 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.skipState = true;
    let message = '';
    try {
      await ensureRemoteDaemon(fake, options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('没有状态文件时报错', message.includes('core-daemon.json'));
  }

  // ---------- 本机产物缺自带 ripgrep：报错，不静默降级 ----------

  {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-bare-'));
    const bareBinary = path.join(bare, 'dist', 'resources', 'core', 'x64-linux', 'tuxedo-cat-core');
    fs.mkdirSync(path.dirname(bareBinary), { recursive: true });
    fs.writeFileSync(bareBinary, 'fake-core-binary');
    const fake = new FakeSsh();
    let message = '';
    try {
      await ensureRemoteDaemon(fake, { extensionPath: bare, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('本机产物缺自带 ripgrep 时报错', message.includes('bundled ripgrep'));
    check('缺 ripgrep 时不启动远端 daemon', !fake.commands.includes(`'${BINARY_PATH}' start`));
    cleanup(bare);
  }

  cleanup(root);
  finish();
});
