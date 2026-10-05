/**
 * 单测：SSH 建链器的引导去重（`src/host/standalone/sshTransport.ts`）。
 *
 * 背景（实测回归）：启动期「可达性探测」与「正式连接」同时为同一 endpoint 各跑一遍
 * `ensureRemoteDaemon`——没有去重时两边都全量上传产物（把探测的建链预算挤爆），
 * 两条 `start` 还会各拉起一个 daemon，多出来的那个成孤儿常驻。本组用例锁定
 * `ensureRemoteDaemonShared` 的共享语义：同目标的并发调用复用同一次引导（后到者的
 * SSH 连接完全不参与），settle 之后的新调用走自己的常规路径（成功或失败都不残留）。
 *
 * 用假 SSH 实现（`RemoteSsh`）跑，不需要真实机器。
 *
 * 运行方式：npm run test:all -- ssh-transport
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createChecker, runTests } from './helpers/harness';
import { ensureRemoteDaemonShared } from '../host/standalone/sshTransport';
import type { SshExecResult, SshFileInfo } from '../host/standalone/sshClient';
import type { RemoteSsh } from '../host/standalone/sshDaemonBootstrap';
import { REMOTE_BIN_DIR } from '../host/standalone/sshDaemonBootstrap';
import { coreBinaryFileName, coreDeployDirName } from '../host/standalone/coreBinary';
import { CONFIG_DIR_NAME, CORE_RESOURCE_DIR } from '../config/project';

const HOME = '/home/dev';
const FINGERPRINT = 'a'.repeat(64);
/** 远端部署目录名：`<core.deployPrefix>_<指纹前一半>`（与实现共用同一份派生纯函数） */
const DEPLOY_DIR = coreDeployDirName(FINGERPRINT);
const STATE_PATH = `${HOME}/${CONFIG_DIR_NAME}/core-daemon-${FINGERPRINT}.json`;
const BINARY_PATH = `${HOME}/${REMOTE_BIN_DIR}/${DEPLOY_DIR}/${coreBinaryFileName('linux')}`;
const RIPGREP_PATH = `${HOME}/${REMOTE_BIN_DIR}/${DEPLOY_DIR}/ripgrep/rg`;
const START_COMMAND = `'${BINARY_PATH}' start --idle-exit 30`;
const TARGET = { host: '203.0.113.7', port: 22, user: 'dev', password: 'secret' };

/** 假的远端 SSH：文件系统、可执行文件与转发可达性都可控；记录 start / 上传次数 */
class FakeSsh implements RemoteSsh {
  readonly files = new Map<string, string>();
  readonly executables = new Set<string>();
  readonly reachable = new Set<string>();
  /** `start` 执行次数（去重断言的核心：共享引导只该有一次） */
  startCount = 0;
  /** 上传次数 */
  uploadCount = 0;
  /** `start` 的退出码与 stderr（默认成功） */
  startExit = 0;
  startStderr = '';

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

  async upload(_localPath: string, remotePath: string, _mode: number): Promise<void> {
    this.uploadCount += 1;
    this.executables.add(remotePath);
  }

  async openTcpForward(host: string, port: number): Promise<{ destroy(): void }> {
    if (!this.reachable.has(`${host}:${port}`)) {
      throw new Error(`connect refused: ${host}:${port}`);
    }
    return { destroy: () => undefined };
  }

  async exec(command: string): Promise<SshExecResult> {
    if (command === 'uname -sm') return { code: 0, stdout: 'Linux x86_64\n', stderr: '' };
    if (command.startsWith('mkdir -p ') || command.startsWith('mv -f ')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === START_COMMAND) {
      this.startCount += 1;
      if (this.startExit !== 0) {
        return { code: this.startExit, stdout: '', stderr: this.startStderr };
      }
      this.writeState(`127.0.0.1:${10975 + this.startCount}`);
      this.reachable.add(`127.0.0.1:${10975 + this.startCount}`);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected remote command: ${command}`);
  }

  private writeState(endpoint: string): void {
    this.files.set(STATE_PATH, JSON.stringify({ endpoint }));
  }
}

/** 建一份带 Linux 产物目录（含构建指纹与自带 ripgrep）的临时 extensionPath */
function makeExtensionPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuxedo-ssh-transport-'));
  const productDir = path.join(root, 'dist', 'resources', CORE_RESOURCE_DIR, 'x64-linux');
  fs.mkdirSync(path.join(productDir, 'ripgrep'), { recursive: true });
  fs.writeFileSync(path.join(productDir, coreBinaryFileName('linux')), 'fake-core-binary');
  fs.writeFileSync(path.join(productDir, 'fingerprint'), `${FINGERPRINT}\n`);
  fs.writeFileSync(path.join(productDir, 'ripgrep', 'rg'), 'fake-rg-binary');
  return root;
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

runTests('sshTransport', async () => {
  const { check, finish } = createChecker();
  const extensionPath = makeExtensionPath();
  const options = { extensionPath, log: () => undefined };

  // ---------- 并发去重：同目标的两次并发引导只执行一次 ----------

  {
    const first = new FakeSsh();
    const second = new FakeSsh();
    const [a, b] = await Promise.all([
      ensureRemoteDaemonShared(TARGET, first, options),
      ensureRemoteDaemonShared(TARGET, second, options),
    ]);
    check('两个并发调用拿到同一个 daemon endpoint', a.host === b.host && a.port === b.port);
    check('引导只在第一个调用者的 SSH 上执行（start 一次）', first.startCount === 1);
    check('后到者的 SSH 连接完全不参与（零上传、零命令）', second.uploadCount === 0);
  }

  // ---------- settle 之后：新调用走自己的常规路径（warm 复用） ----------

  {
    const warm = new FakeSsh();
    // 预置「已部署且在跑」的远端：状态文件 + 可达 endpoint + 齐全产物
    warm.files.set(
      STATE_PATH,
      JSON.stringify({ endpoint: '127.0.0.1:10999' }),
    );
    warm.reachable.add('127.0.0.1:10999');
    warm.executables.add(BINARY_PATH);
    warm.executables.add(RIPGREP_PATH);
    const daemon = await ensureRemoteDaemonShared(TARGET, warm, options);
    check('settle 后的新调用复用在跑的 daemon', daemon.host === '127.0.0.1' && daemon.port === 10999);
    check('warm 路径不重复部署（零上传、零 start）', warm.uploadCount === 0 && warm.startCount === 0);
  }

  // ---------- 失败也移除：失败引导不残留，后续调用重试 ----------

  {
    const failing = new FakeSsh();
    failing.startExit = 1;
    failing.startStderr = 'boom';
    const firstAttempt = ensureRemoteDaemonShared(
      { ...TARGET, user: 'failing' },
      failing,
      options,
    );
    const secondAttempt = ensureRemoteDaemonShared(
      { ...TARGET, user: 'failing' },
      failing,
      options,
    );
    let firstMessage = '';
    let secondMessage = '';
    await firstAttempt.catch((error: unknown) => {
      firstMessage = error instanceof Error ? error.message : String(error);
    });
    await secondAttempt.catch((error: unknown) => {
      secondMessage = error instanceof Error ? error.message : String(error);
    });
    check('共享的失败传播给两个等待者', firstMessage.includes('start') && secondMessage === firstMessage);
    check('失败引导只执行一次', failing.startCount === 1);

    // 失败 settle 后，in-flight 表已移除：新调用重新尝试（这次成功）
    const retry = new FakeSsh();
    const daemon = await ensureRemoteDaemonShared({ ...TARGET, user: 'failing' }, retry, options);
    check('失败后的新调用重新引导并成功', daemon.port === 10976 && retry.startCount === 1);
  }

  cleanup(extensionPath);
  finish();
});
