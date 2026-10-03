/**
 * SSH 客户端封装（`docs/core-daemon.md` 第 12 节）。
 *
 * 用 `ssh2` 这个纯 JS 库实现，**不依赖系统 OpenSSH**：目标环境只有 SSH 端口时，
 * 控制通道、远端引导（部署 / 启动）与远端目录选择全部走这一条 SSH 连接。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`，两个宿主都能用。
 *
 * 主机密钥校验（TOFU）：首次连接把指纹记进 `~/<configDir>/known-hosts.json`，
 * 之后指纹不一致直接失败——不做「忽略校验」的静默降级（`DEVELOPMENT.md` 第 12 章）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import { CONFIG_DIR_NAME } from '../../config/project.js';

/** SSH 连接目标 */
export interface SshTarget {
  host: string;
  /** SSH 端口（默认 22） */
  port: number;
  user: string;
  password: string;
}

/** 一次远端命令的执行结果 */
export interface SshExecResult {
  /** 退出码；通道未给出退出码时为 null */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 远端路径的存在性与权限位 */
export interface SshFileInfo {
  exists: boolean;
  /** 字节数；不存在时为 0 */
  size: number;
  /** 权限位；不存在时为 0 */
  mode: number;
}

/** 建立 SSH 连接的超时（毫秒） */
export const SSH_CONNECT_TIMEOUT_MS = 20_000;
/** 单条远端命令的超时（毫秒）：命令挂死时给出明确错误，不静默挂起 */
export const SSH_EXEC_TIMEOUT_MS = 120_000;

/** 主机密钥指纹文件（与 `settings.json` 同目录） */
function knownHostsPath(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, 'known-hosts.json');
}

/** 读主机密钥表；文件不存在时返回空表，内容损坏时报错（不静默丢弃已有记录） */
function readKnownHosts(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`malformed known-hosts file: ${file}`);
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`malformed known-hosts file: ${file}`);
    entries[key] = value;
  }
  return entries;
}

/** 写主机密钥表（目录不存在时一并创建） */
function writeKnownHosts(file: string, entries: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** 主机密钥不匹配：错误信息里带上比对结论，用户据此判断是不是换了机器 */
export class SshHostKeyError extends Error {
  constructor(readonly host: string, readonly port: number) {
    super(
      `SSH host key for ${host}:${port} does not match the recorded fingerprint; `
      + 'remove the entry from known-hosts.json only if the host was rebuilt on purpose.',
    );
    this.name = 'SshHostKeyError';
  }
}

/** SSH 连接已断开：后续操作直接报错，不排队等待 */
export class SshDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshDisconnectedError';
  }
}

/**
 * 一条 SSH 连接上的操作集合。
 *
 * 连接建立后 exec / sftp / 端口转发共用同一个 `ssh2.Client`；一个 endpoint 一个实例。
 */
export class SshClient {
  private client: Client | null = null;
  private sftpSession: SFTPWrapper | null = null;
  private connected = false;
  /** 主机密钥不匹配的结论（`hostVerifier` 只能返回布尔，结论记在这里供报错用） */
  private hostKeyMismatch: SshHostKeyError | null = null;

  constructor(
    private readonly target: SshTarget,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  /** 建立连接；已连接时幂等 */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.client) throw new SshDisconnectedError('SSH client is connecting or closed.');
    const client = new Client();
    this.client = client;
    const { host, port, user } = this.target;
    /** 失败原因统一带上目标：ssh2 的原文（如「认证方式全部失败」）看不出连的是谁 */
    const describe = (error: Error): Error => this.hostKeyMismatch ?? new Error(
      `SSH connection to ${user}@${host}:${port} failed: ${error.message}`,
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      client
        .on('ready', () => {
          this.connected = true;
          finish(null);
        })
        .on('error', (error: Error) => {
          if (settled) {
            // 已就绪后的错误：连接随后会 close，这里只留诊断
            this.log(`[ssh] error: ${error.message}`);
            return;
          }
          finish(describe(error));
        })
        .on('close', () => {
          this.connected = false;
          this.sftpSession = null;
          this.client = null;
          // 连接已在 ready 之前结束：等待者不能永远挂着
          finish(describe(new SshDisconnectedError('connection closed.')));
        })
        .connect({
          host,
          port,
          username: this.target.user,
          password: this.target.password,
          readyTimeout: SSH_CONNECT_TIMEOUT_MS,
          // 空闲时探活：容器网络丢包时链路不会假死
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostHash: 'sha256',
          hostVerifier: (fingerprint: string) => this.verifyHostKey(fingerprint),
        });
    });
  }

  /** 在远端执行一条命令；退出码非 0 由调用方判断（本方法不抛错） */
  async exec(command: string, timeoutMs = SSH_EXEC_TIMEOUT_MS): Promise<SshExecResult> {
    const client = this.requireClient();
    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SSH command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      timer.unref();
      const finish = (result: SshExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // ssh2 的通道打开失败只有一句「Failure」：不带命令名，日志里完全无法定位
          reject(new Error(`SSH exec failed (${command}): ${error.message}`));
          return;
        }
        let stdout = '';
        let stderr = '';
        channel.setEncoding('utf8');
        channel.stderr.setEncoding('utf8');
        channel.on('data', (chunk: string) => {
          stdout += chunk;
        });
        channel.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        channel.on('close', (code: number | null) => finish({ code: code ?? null, stdout, stderr }));
        channel.on('error', (channelError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`SSH exec failed (${command}): ${channelError.message}`));
        });
      });
    });
  }

  /** 远端主目录（SFTP 会话的起始目录就是它） */
  async homeDir(): Promise<string> {
    const sftp = await this.requireSftp();
    return new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (error, absPath) => {
        if (error) reject(new Error(`SFTP realpath failed: ${error.message}`));
        else resolve(absPath);
      });
    });
  }

  /** 远端路径信息；不存在返回 `exists: false`（其它错误照常抛出） */
  async stat(target: string): Promise<SshFileInfo> {
    const sftp = await this.requireSftp();
    return new Promise<SshFileInfo>((resolve, reject) => {
      sftp.stat(target, (error, stats) => {
        if (error) {
          // ssh2 的 SFTP 错误码是 SFTP 状态码（2 = NO_SUCH_FILE），类型上只声明了 string
          const code: unknown = (error as { code?: unknown }).code;
          if (code === 2 || code === '2' || code === 'ENOENT' || /no such file/i.test(error.message)) {
            resolve({ exists: false, size: 0, mode: 0 });
            return;
          }
          reject(error);
          return;
        }
        resolve({ exists: true, size: stats.size, mode: stats.mode });
      });
    });
  }

  /** 读一个远端文本文件（内容缺失由调用方按 `stat` 判断） */
  async readText(target: string): Promise<string> {
    const sftp = await this.requireSftp();
    return new Promise<string>((resolve, reject) => {
      sftp.readFile(target, { encoding: 'utf8' }, (error, data) => {
        if (error) reject(new Error(`SFTP read failed (${target}): ${error.message}`));
        else resolve(String(data));
      });
    });
  }

  /** 上传一个本地文件到远端，并按 `mode` 设定权限位 */
  async upload(localPath: string, remotePath: string, mode: number): Promise<void> {
    const sftp = await this.requireSftp();
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { mode }, (error) => {
        // 目标正被执行（ETXTBSY）、权限不足等都折叠成 SFTP 的「Failure」：
        // 带上两端路径才定位得了
        if (error) {
          reject(new Error(`SFTP upload ${localPath} -> ${remotePath} failed: ${error.message}`));
        } else resolve();
      });
    });
  }

  /**
   * 打开一条 `direct-tcpip` 通道（等价于 `ssh -W host:port`）。
   *
   * 目标地址由**远端 sshd** 解析：传回环地址即「远端本机上的端口」。目标端口没人
   * 听（如 daemon 已死）时 sshd 拒绝开通道，ssh2 只报一句「Failure」——带上目标。
   */
  async openTcpForward(host: string, port: number): Promise<ClientChannel> {
    const client = this.requireClient();
    return new Promise<ClientChannel>((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
        if (error) {
          reject(new Error(`SSH port forward to ${host}:${port} failed: ${error.message}`));
        } else resolve(channel);
      });
    });
  }

  /** 关闭连接（幂等）：断开后所有通道一起结束 */
  dispose(): void {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.sftpSession = null;
    if (client) client.end();
  }

  /** 主机密钥比对：首次记录（TOFU），之后不一致即失败 */
  private verifyHostKey(fingerprint: string): boolean {
    const { host, port } = this.target;
    const file = knownHostsPath();
    const entries = readKnownHosts(file);
    const key = `${host}:${port}`;
    const known = entries[key];
    if (known === undefined) {
      entries[key] = fingerprint;
      writeKnownHosts(file, entries);
      this.log(`[ssh] recorded host key for ${key}`);
      return true;
    }
    if (known !== fingerprint) {
      this.hostKeyMismatch = new SshHostKeyError(host, port);
      return false;
    }
    return true;
  }

  private requireClient(): Client {
    const client = this.client;
    if (!client || !this.connected) {
      throw new SshDisconnectedError(`SSH connection to ${this.target.host} is not established.`);
    }
    return client;
  }

  private async requireSftp(): Promise<SFTPWrapper> {
    const client = this.requireClient();
    if (this.sftpSession) return this.sftpSession;
    const session = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) reject(new Error(`SFTP subsystem open failed: ${error.message}`));
        else resolve(sftp);
      });
    });
    session.on('close', () => {
      if (this.sftpSession === session) this.sftpSession = null;
    });
    this.sftpSession = session;
    return session;
  }
}
