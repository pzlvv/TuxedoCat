/**
 * 单测：SSH 远端引导（`src/host/standalone/sshDaemonBootstrap.ts`）。
 *
 * 覆盖 `docs/core-daemon.md` 第 12.8 节按指纹落位后的三条分支与失败路径：
 * - 该指纹的 daemon 在跑 → 直接复用，不重启、不覆盖（缺可执行文件或共享位缺
 *   ripgrep 时仍补传——「在跑」不等于产物齐全）；
 * - 已部署未启动 → 只跑 `start --idle-exit 30`，产物在就不重传（指纹槽位
 *   存在即视为同版本，不做字节比对——「不无脑覆盖」）；
 * - 未部署 → 上传产物（客户端唯一暂存名 + `mv` 原子换名）+ `start --idle-exit 30`；
 * - `start` 失败 / 状态文件读不出 / 本机产物缺指纹或缺自带 ripgrep → 报错，不静默降级；
 * - 上传失败时清掉自己的暂存文件，不在远端槽位留半截产物。
 *
 * 多版本各占一个指纹槽位：新版本天然落在新槽位，旧 daemon 原样留给旧版本的客户端。
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
  REMOTE_DEPLOY_ROOT,
  detectRemoteTarget,
  ensureRemoteDaemon,
  splitEndpoint,
  type RemoteSsh,
} from '../host/standalone/sshDaemonBootstrap';
import { coreBinaryFileName, coreDeployDirPath, coreDeployRipgrepPath } from '../host/standalone/coreBinary';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';
import type { SshExecResult, SshFileInfo } from '../host/standalone/sshClient';

const HOME = '/home/dev';
/** 构建指纹：64 位小写 hex，与 `build-core.mjs` 的产物同构 */
const FINGERPRINT = 'f'.repeat(64);
/** 远端指纹槽位目录：`share/<core.deployPrefix>/<指纹>`（与实现共用同一份派生纯函数） */
const DEPLOY_DIR = coreDeployDirPath(FINGERPRINT);
/** 远端共享 ripgrep 路径：`share/<core.deployPrefix>/ripgrep`（同一份派生纯函数） */
const RIPGREP_DIR = coreDeployRipgrepPath();
const STATE_PATH = `${HOME}/${CONFIG_DIR_NAME}/run/core-daemon-${FINGERPRINT}.json`;
const BINARY_PATH = `${HOME}/${REMOTE_DEPLOY_ROOT}/${DEPLOY_DIR}/${coreBinaryFileName('linux')}`;
/** Core 自带的 ripgrep：产品目录根的共享位，全部指纹槽位共用（`docs/standalone-core.md` 第 4 节） */
const RIPGREP_PATH = `${HOME}/${REMOTE_DEPLOY_ROOT}/${RIPGREP_DIR}/rg`;
/**
 * 引导执行的启动命令：daemon 恒绑回环（转发连接从远端本机发起，端口不出机器）；
 * 端口交给内核分配——多版本 daemon 并存互不抢固定端口，实际端口随状态文件读回；
 * `--idle-exit 30` 让 daemon 在最后一条连接断开后自行退出（客户端 crash 不留常驻
 * 进程），见 `docs/core-daemon.md` 第 12.2 / 12.5 / 12.8 节。
 */
const START_COMMAND = `'${BINARY_PATH}' start --idle-exit 30`;

/**
 * 暂存名判定：上传落到「目标路径 + 客户端唯一后缀」的暂存文件上（pid + 随机数），
 * 不再是固定 `.new`——两台机器的客户端并发部署同一槽位时各写各的暂存，不交错损坏。
 */
function isUniqueStagingOf(staging: string | undefined, target: string): boolean {
  return staging !== undefined
    && staging.startsWith(`${target}.`)
    && staging.endsWith('.new')
    && staging !== `${target}.new`;
}

/** 暂存 → 目标的 `mv` 原子换名命令 */
function mvCommand(staging: string | undefined, target: string): string | undefined {
  return staging === undefined ? undefined : `mv -f '${staging}' '${target}'`;
}

/** 假的远端 SSH：文件系统、可执行文件与转发可达性都可控 */
class FakeSsh implements RemoteSsh {
  readonly commands: string[] = [];
  readonly uploads: Array<{ local: string; remote: string; mode: number }> = [];
  /** 按发生顺序记录的动作（`upload:<路径>` / `exec:<命令>`），用于断言先后 */
  readonly events: string[] = [];
  /** 远端普通文件：路径 → 内容 */
  readonly files = new Map<string, string>();
  /** 远端存在的可执行文件 */
  readonly executables = new Set<string>();
  /** 可转发的 `host:port` */
  readonly reachable = new Set<string>();
  uname = 'Linux x86_64';
  startExit = 0;
  startStderr = '';
  /** 上传一律失败（模拟 SFTP 传输中断，验证暂存清理） */
  uploadFails = false;
  /** `start` 之后不落状态文件（模拟 daemon 没起来） */
  skipState = false;
  private endpoint = '127.0.0.1:10975';
  /** 每次 `start` 换一个端口：用来区分「复用旧 daemon」与「新起了 daemon」 */
  startCount = 0;

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
    // 先记尝试再抛错：失败用例要能拿到暂存路径，去断言清理命令
    this.uploads.push({ local: localPath, remote: remotePath, mode });
    this.events.push(`upload:${remotePath}`);
    if (this.uploadFails) throw new Error('sftp upload failed: connection lost');
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
    this.events.push(`exec:${command}`);
    if (command === 'uname -sm') return { code: 0, stdout: `${this.uname}\n`, stderr: '' };
    if (command.startsWith('mkdir -p ')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('mv -f ')) return { code: 0, stdout: '', stderr: '' };
    if (command.startsWith('rm -f ')) return { code: 0, stdout: '', stderr: '' };
    if (command === START_COMMAND) {
      if (this.startExit === 0 && !this.skipState) {
        this.startCount += 1;
        this.writeState(`127.0.0.1:${10975 + this.startCount}`);
      }
      return { code: this.startExit, stdout: '', stderr: this.startStderr };
    }
    throw new Error(`unexpected remote command: ${command}`);
  }

  writeState(endpoint: string): void {
    this.endpoint = endpoint;
    this.files.set(STATE_PATH, JSON.stringify({ endpoint }));
  }
}

/** 建一份带 Linux 产物目录（含构建指纹）的临时 extensionPath，并返回产物路径 */
function makeExtensionPath(): { root: string; binary: string; ripgrep: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-'));
  const binary = path.join(
    root, 'dist', 'resources', CORE_RESOURCE_DIR, 'x64-linux', coreBinaryFileName('linux'),
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fake-core-binary');
  // 构建指纹与可执行文件同级（`npm run build:core` 的落位，docs/standalone-core.md 第 4.4 节）
  fs.writeFileSync(path.join(path.dirname(binary), 'fingerprint'), `${FINGERPRINT}\n`);
  // Core 自带的 ripgrep 与可执行文件同级
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

  check('解析主机', splitEndpoint('127.0.0.1:10975')?.host === '127.0.0.1');
  check('主机名原样保留', splitEndpoint('build-box:10975')?.host === 'build-box');
  check('端口解析正确', splitEndpoint('127.0.0.1:10975')?.port === 10975);
  check('缺端口返回 null', splitEndpoint('127.0.0.1') === null);
  check('缺主机返回 null', splitEndpoint(':10975') === null);
  check('端口非法返回 null', splitEndpoint('127.0.0.1:abc') === null);
  check('端口越界返回 null', splitEndpoint('127.0.0.1:70000') === null);
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

  // ---------- 该指纹的 daemon 在跑：直接复用 ----------

  {
    const fake = new FakeSsh();
    fake.writeState('127.0.0.1:10975');
    fake.reachable.add('127.0.0.1:10975');
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('复用运行中的 daemon（回环地址）', daemon.host === '127.0.0.1' && daemon.port === 10975);
    check('复用运行中的 daemon（端口取自状态文件）', daemon.port === 10975);
    check('复用时不重启 daemon', !fake.commands.includes(START_COMMAND));
    check('复用时不部署产物', fake.uploads.length === 0);
  }

  // ---------- 在跑但缺自带 ripgrep：补 rg，不重启 daemon ----------

  {
    const fake = new FakeSsh();
    fake.writeState('127.0.0.1:10975');
    fake.reachable.add('127.0.0.1:10975');
    fake.executables.add(BINARY_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('补 rg 后仍复用同一个 daemon', daemon.port === 10975 && fake.startCount === 0);
    const rgStaging = fake.uploads[0]?.remote;
    const rgMv = mvCommand(rgStaging, RIPGREP_PATH);
    check('已在跑时补传自带 ripgrep（经唯一暂存名 + mv）', fake.uploads.length === 1
      && isUniqueStagingOf(rgStaging, RIPGREP_PATH) && fake.uploads[0]?.local === ripgrep
      && rgMv !== undefined && fake.commands.includes(rgMv));
    check('已在跑时不重跑 start', !fake.commands.includes(START_COMMAND));
  }

  // ---------- 在跑但指纹槽位被清过：补可执行文件，不重启 daemon ----------

  {
    const fake = new FakeSsh();
    fake.writeState('127.0.0.1:10975');
    fake.reachable.add('127.0.0.1:10975');
    const daemon = await ensureRemoteDaemon(fake, options);
    const binaryStaging = fake.uploads.find((upload) => upload.local === binary)?.remote;
    const binaryMv = mvCommand(binaryStaging, BINARY_PATH);
    const rgStaging = fake.uploads.find((upload) => upload.local === ripgrep)?.remote;
    const rgMv = mvCommand(rgStaging, RIPGREP_PATH);
    check('槽位被清时补传可执行文件（经唯一暂存名 + mv）',
      isUniqueStagingOf(binaryStaging, BINARY_PATH) && binaryMv !== undefined
      && fake.commands.includes(binaryMv));
    check('补传的自带 ripgrep 落在产品共享位（最终路径由 mv 到位）',
      isUniqueStagingOf(rgStaging, RIPGREP_PATH) && rgMv !== undefined
      && fake.commands.includes(rgMv));
    check('补传后仍复用运行中的 daemon', daemon.port === 10975
      && !fake.commands.includes(START_COMMAND));
    check('目标文件本身永不直接覆盖写（执行中的 daemon 是 ETXTBSY）',
      !fake.uploads.some((upload) => upload.remote === BINARY_PATH));
  }

  // ---------- 已部署未启动：只跑 start，产物在就不重传 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('已部署时返回状态文件里的端口', daemon.port === 10976);
    check('指纹槽位存在时不重新上传（不做字节比对）', fake.uploads.length === 0);
    check('已部署时执行 start（绑回环）', fake.commands.includes(START_COMMAND));
    // 远端可执行文件名要先问 `uname`，因此这一步一定会发生
    check('先问远端平台', fake.commands.includes('uname -sm'));
  }

  // ---------- 未部署：上传 + start ----------

  {
    const fake = new FakeSsh();
    const daemon = await ensureRemoteDaemon(fake, options);
    const binaryStaging = fake.uploads[0]?.remote;
    const binaryMv = mvCommand(binaryStaging, BINARY_PATH);
    const rgStaging = fake.uploads[1]?.remote;
    const rgMv = mvCommand(rgStaging, RIPGREP_PATH);
    check('未部署时上传到 ~/.local/share/<产品名>/<指纹>/（经唯一暂存名 + mv 原子换名）', fake.uploads.length === 2
      && isUniqueStagingOf(binaryStaging, BINARY_PATH)
      && binaryMv !== undefined && fake.commands.includes(binaryMv));
    check('上传的是本机携带的对应平台产物', fake.uploads[0]?.local === binary);
    check('上传后置可执行权限', fake.uploads[0]?.mode === 0o755);
    check('未部署时一并上传自带 ripgrep 到共享位（同样经唯一暂存名 + mv）',
      isUniqueStagingOf(rgStaging, RIPGREP_PATH) && fake.uploads[1]?.local === ripgrep
      && rgMv !== undefined && fake.commands.includes(rgMv));
    check('上传前建好指纹槽位目录', fake.commands.includes(`mkdir -p '${HOME}/${REMOTE_DEPLOY_ROOT}/${DEPLOY_DIR}'`));
    check('上传前建好 ripgrep 共享位目录', fake.commands.includes(`mkdir -p '${HOME}/${REMOTE_DEPLOY_ROOT}/${RIPGREP_DIR}'`));
    check('上传后执行 start（绑回环，端口交给内核分配）', fake.commands.includes(START_COMMAND));
    check('返回 daemon endpoint', daemon.host === '127.0.0.1' && daemon.port === 10976);
  }

  // ---------- 部署失败：清掉自己的暂存，不在远端留半截产物 ----------

  {
    const fake = new FakeSsh();
    fake.uploadFails = true;
    let message = '';
    try {
      await ensureRemoteDaemon(fake, options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('上传失败时引导报错（不静默降级）', message.includes('sftp upload failed'));
    const staging = fake.uploads[0]?.remote;
    check('上传失败时清掉自己的暂存文件', staging !== undefined
      && fake.commands.includes(`rm -f '${staging}'`));
  }

  // ---------- 状态文件在但连不上：按「没在跑」处理 ----------

  {
    const fake = new FakeSsh();
    fake.writeState('127.0.0.1:10975');
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('探测失败后重新启动', fake.commands.includes(START_COMMAND));
    check('重新启动后返回新端口', daemon.port === 10976);
  }

  // ---------- 状态文件损坏：按「没在跑」处理 ----------

  {
    const fake = new FakeSsh();
    fake.files.set(STATE_PATH, '{ not json');
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    const daemon = await ensureRemoteDaemon(fake, options);
    check('损坏的状态文件被忽略', fake.commands.includes(START_COMMAND));
    check('损坏的状态文件不阻止接入', daemon.port === 10976);
  }

  // ---------- start 失败：把远端 stderr 带回来 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    fake.startExit = 1;
    fake.startStderr = 'cannot bind 127.0.0.1';
    let message = '';
    try {
      await ensureRemoteDaemon(fake, options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('start 失败时报错', message.includes('start') && message.includes('exit 1'));
    check('start 失败时带上远端 stderr', message.includes('cannot bind 127.0.0.1'));
  }

  // ---------- start 成功但没落状态文件：报错 ----------

  {
    const fake = new FakeSsh();
    fake.executables.add(BINARY_PATH);
    fake.executables.add(RIPGREP_PATH);
    fake.skipState = true;
    let message = '';
    try {
      await ensureRemoteDaemon(fake, options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('没有状态文件时报错', message.includes(`core-daemon-${FINGERPRINT}.json`));
  }

  // ---------- 本机产物缺构建指纹：报错，不静默降级 ----------

  {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-bare-'));
    const bareBinary = path.join(
      bare, 'dist', 'resources', CORE_RESOURCE_DIR, 'x64-linux', coreBinaryFileName('linux'),
    );
    fs.mkdirSync(path.dirname(bareBinary), { recursive: true });
    fs.writeFileSync(bareBinary, 'fake-core-binary');
    const fake = new FakeSsh();
    let message = '';
    try {
      await ensureRemoteDaemon(fake, { extensionPath: bare, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('缺构建指纹时报错', message.includes('fingerprint file not found'));
    check('缺指纹时不启动远端 daemon', !fake.commands.includes(START_COMMAND));
    cleanup(bare);
  }

  // ---------- 本机构建指纹损坏：报错，不静默降级 ----------

  {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-broken-'));
    const brokenBinary = path.join(
      broken, 'dist', 'resources', CORE_RESOURCE_DIR, 'x64-linux', coreBinaryFileName('linux'),
    );
    fs.mkdirSync(path.dirname(brokenBinary), { recursive: true });
    fs.writeFileSync(brokenBinary, 'fake-core-binary');
    fs.writeFileSync(path.join(path.dirname(brokenBinary), 'fingerprint'), 'not-a-fingerprint');
    const fake = new FakeSsh();
    let message = '';
    try {
      await ensureRemoteDaemon(fake, { extensionPath: broken, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('指纹格式非法时报错', message.includes('malformed'));
    check('指纹非法时不启动远端 daemon', !fake.commands.includes(START_COMMAND));
    cleanup(broken);
  }

  // ---------- 本机产物缺自带 ripgrep：报错，不静默降级 ----------

  {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-bootstrap-bare-'));
    const bareBinary = path.join(
      bare, 'dist', 'resources', CORE_RESOURCE_DIR, 'x64-linux', coreBinaryFileName('linux'),
    );
    fs.mkdirSync(path.dirname(bareBinary), { recursive: true });
    fs.writeFileSync(bareBinary, 'fake-core-binary');
    fs.writeFileSync(path.join(path.dirname(bareBinary), 'fingerprint'), `${FINGERPRINT}\n`);
    const fake = new FakeSsh();
    let message = '';
    try {
      await ensureRemoteDaemon(fake, { extensionPath: bare, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check('本机产物缺自带 ripgrep 时报错', message.includes('bundled ripgrep'));
    check('缺 ripgrep 时不启动远端 daemon', !fake.commands.includes(START_COMMAND));
    cleanup(bare);
  }

  cleanup(root);
  finish();
});
