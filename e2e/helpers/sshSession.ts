/**
 * e2e 远端 SSH 执行面（连接复用）。
 *
 * 为什么要有这一层：四个真实 SSH 的 spec 各自实现了一份 `sshExec`，每执行一条命令就
 * **新建一条 SSH 连接**（`const client = sshConnect()`），用完即断。实测这四个文件共 122
 * 处调用，一次完整车道会建立上百条连接，远端 `sshd` 的连接数随之堆到 39 条，超过
 * `MaxStartups 10:30:100` 的阈值后新连接被丢弃，表现为：
 *
 *     Connection lost before handshake
 *     远程连接超时（3 秒）
 *
 * 而这类错误落在用例的关键路径上就是「偶发失败」——独占跑能过、整条车道跑就红
 * （`specs/defects/e2e-ssh-per-command-connections-exhaust-sshd.md`）。
 *
 * 因此这里把连接复用起来：一个 spec 文件用一条连接跑完所有命令。同时必须处理三种
 * 真实存在的破坏：
 *
 * 1. **用例故意强杀客户端**（`remoteTaskSurvival` 的「客户端强杀」）：连接会失效，
 *    下一条命令要能透明重连；
 * 2. **远端 daemon 被清场**（`resetRemoteDaemon` 的 pkill）：同一条 SSH 连接仍在，
 *    只是对端进程没了——命令本身会失败，这是被测语义，不能重试掩盖；
 * 3. **通道并发**：`ssh2` 允许一条连接上并行开多个 exec 通道，但本车全部是串行调用；
 *    这里仍按「一条命令一个通道」实现，不共享通道状态。
 *
 * 与既有口径一致（`e2e/README.md` 已知坑 10）：**只在命令还没被远端受理时重试**
 * （连接还没 ready / exec 通道没打开），已开始执行的命令不跑第二遍——重试会掩盖缺陷。
 */

import { Client, type ConnectConfig } from 'ssh2';

/** 一次远端命令的结果（与各 spec 里既有的形状一致） */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 连接目标（`e2e/environments.json` 的 ssh 段子集） */
export interface SshTarget {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * 复用的 SSH 执行面。
 *
 * 用法：每个 spec 文件建一个实例（`const ssh = createSshSession(SSH)`），
 * `afterAll` 里 `ssh.close()`。
 */
export interface SshSession {
  /** 执行一条命令；连接失效时自动重连一次（仅当命令尚未被受理） */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  /** 经 stdin 喂数据后执行（sudo -S 提交口令等） */
  execWithStdin(command: string, stdin: string, timeoutMs?: number): Promise<ExecResult>;
  /** 经 SFTP 读文件；不存在返回 `null`（与既有用例的「不存在不算错」口径一致） */
  readFile(remotePath: string, timeoutMs?: number): Promise<string | null>;
  /** 关闭底层连接（幂等） */
  close(): void;
}

/** 默认命令超时（与既有实现一致） */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 连接就绪等待上限 */
const READY_TIMEOUT_MS = 20_000;
/** 未受理时的重试次数（含首次） */
const MAX_ATTEMPTS = 3;
/** 重试间隔 */
const RETRY_DELAY_MS = 500;

/**
 * 一条可复用的 SSH 连接。
 *
 * 状态机：`idle`（未建）→ `connecting`（握手中）→ `ready`；任何错误 → `dead`。
 * 下一条命令遇到 `dead` 就重建，因此「用例把客户端杀了」与「网络抖动断了」都能自愈。
 */
class Session implements SshSession {
  private client: Client | null = null;
  private state: 'idle' | 'connecting' | 'ready' | 'dead' = 'idle';
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly target: SshTarget) {}

  /**
   * 取一条可用连接，必要时新建。
   *
   * 并发调用共用同一个 `readyPromise`：多个命令同时到来时只握手一次。
   */
  private async connection(): Promise<Client> {
    if (this.state === 'ready' && this.client !== null) return this.client;
    if (this.readyPromise !== null) {
      await this.readyPromise;
      if (this.state === 'ready' && this.client !== null) return this.client;
    }

    const client = new Client();
    this.client = client;
    this.state = 'connecting';
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.state = 'dead';
        reject(new Error(`SSH 连接超时（${READY_TIMEOUT_MS}ms）: ${this.target.host}:${this.target.port}`));
      }, READY_TIMEOUT_MS);
      // 连接级错误：标记 dead，让下一条命令重建（不在这一层重试命令本身）
      client.on('error', () => {
        clearTimeout(timer);
        this.state = 'dead';
        this.readyPromise = null;
      });
      client.on('close', () => {
        clearTimeout(timer);
        if (this.state === 'ready') {
          this.state = 'dead';
          this.readyPromise = null;
        }
      });
      client.once('ready', () => {
        clearTimeout(timer);
        this.state = 'ready';
        this.readyPromise = null;
        resolve();
      });
      client.connect(this.connectConfig());
    });

    await this.readyPromise;
    return client;
  }

  private connectConfig(): ConnectConfig {
    return {
      host: this.target.host,
      port: this.target.port,
      username: this.target.user,
      password: this.target.password,
      readyTimeout: READY_TIMEOUT_MS,
      // 长连接要防止中间设备静默断链：30s 一次保活，3 次没响应即判定失效
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
    };
  }

  async exec(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
    return this.run(command, null, timeoutMs);
  }

  async execWithStdin(
    command: string,
    stdin: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ExecResult> {
    return this.run(command, stdin, timeoutMs);
  }

  /**
   * 经 SFTP 读远端文件。
   *
   * 不存在按 `null` 返回（配合 `expect.poll` 等文件出现）；其它错误照常抛出——与既有
   * `sshReadFile` 的口径一致，不把真实故障静默成「文件不存在」。
   */
  async readFile(remotePath: string, timeoutMs = 30_000): Promise<string | null> {
    const client = await this.connection();
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`sftp read 超时: ${remotePath}`));
      }, timeoutMs);

      client.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          this.state = 'dead';
          reject(err);
          return;
        }
        sftp.readFile(remotePath, 'utf8', (readErr, data) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (readErr) {
            // sftp 状态码 2 = NO_SUCH_FILE（不存在按 null 返回，配合 expect.poll 重试）
            const code = (readErr as { code?: unknown }).code;
            if (String(code) === '2' || /No such file/i.test(String(readErr.message))) resolve(null);
            else reject(readErr);
          } else {
            resolve(String(data));
          }
        });
      });
    });
  }

  /**
   * 执行一条命令。
   *
   * `attempt` 只用于「连接层重试」：命令**未被受理**（连接没 ready、exec 报错）时重来；
   * 一旦 `dispatched` 为真就绝不重试（`e2e/README.md` 已知坑 10）。
   */
  private async run(
    command: string,
    stdin: string | null,
    timeoutMs: number,
    attempt = 1,
  ): Promise<ExecResult> {
    let client: Client;
    try {
      client = await this.connection();
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS);
        return this.run(command, stdin, timeoutMs, attempt + 1);
      }
      throw error;
    }

    return new Promise<ExecResult>((resolve, reject) => {
      let dispatched = false;
      let settled = false;
      // 超时后要关掉通道：同一条连接上泄漏的 exec 通道会占用 sshd 的会话配额，
      // 后续命令要么排队、要么直接开不出来（实测表现为下一条用例「等待元素超时」）
      let activeStream: { destroy(): void } | null = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (activeStream !== null) {
          try {
            activeStream.destroy();
          } catch {
            // 通道可能已结束
          }
          activeStream = null;
        }
        // 超时说明这条连接上的通道状态不可信，标记 dead 让下一条命令重连
        this.state = 'dead';
        reject(new Error(`ssh exec 超时: ${command}`));
      }, timeoutMs);

      const finish = (): void => {
        clearTimeout(timer);
      };

      client.exec(command, (err, stream) => {
        if (err) {
          finish();
          if (settled) return;
          settled = true;
          // exec 通道都没打开 = 命令未被受理，可以重连重试
          this.state = 'dead';
          if (attempt < MAX_ATTEMPTS) {
            delay(RETRY_DELAY_MS)
              .then(() => this.run(command, stdin, timeoutMs, attempt + 1))
              .then(resolve, reject);
            return;
          }
          reject(err);
          return;
        }
        dispatched = true;
        activeStream = stream;
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('close', (code: number | null) => {
          finish();
          activeStream = null;
          if (settled) return;
          settled = true;
          resolve({ stdout, stderr, code });
        });
        stream.on('error', (streamErr: Error) => {
          finish();
          activeStream = null;
          if (settled) return;
          settled = true;
          // 已受理的命令出错不重试：那是被测链路的真实行为
          if (!dispatched) this.state = 'dead';
          reject(streamErr);
        });
        if (stdin !== null) stream.end(stdin);
      });
    });
  }

  close(): void {
    const client = this.client;
    this.state = 'dead';
    this.client = null;
    this.readyPromise = null;
    if (client !== null) client.end();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 建一个复用连接的执行面；每个 spec 文件一个实例 */
export function createSshSession(target: SshTarget): SshSession {
  return new Session(target);
}
