/**
 * SSH 认证来源与认证链的推导（`docs/core/core-remote.md` 第 2.8 节，specs/052）。
 *
 * 「打开远程工作区」点「连接」时按固定顺序尝试：默认私钥 → ssh-agent → 已保存的口令 →
 * 询问用户。本模块只做**纯推导**：来源清单、失败分类、凭证身份描述；真正的尝试由
 * `sshConnectChain.ts` 编排、由建链器执行。
 *
 * 两条不可动摇的口径（specs/052 FR-007）：
 * - 私钥正文与 passphrase 永不进凭证对象，只在建链那一刻从磁盘读；
 * - 认证顺序只在这里定义一次，其余位置一律引用 `sshAuthChain`。
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 一次建链要用的认证来源（`SshTarget.auth`）。
 *
 * - `password`：口令本身；
 * - `keyFile`：本机私钥文件路径（内容在建链时读；加密或损坏的私钥视为该来源不可用）；
 * - `agent`：ssh-agent（socket 从 `SSH_AUTH_SOCK` 取）。
 */
export type SshAuthSource =
  | { kind: 'password'; password: string }
  | { kind: 'keyFile'; keyPath: string }
  | { kind: 'agent' };

/**
 * 默认私钥文件名，按尝试顺序排列。
 *
 * 与 OpenSSH 客户端的偏好顺序一致：先新算法，再兼容老部署。
 */
export const DEFAULT_PRIVATE_KEY_NAMES: readonly string[] = [
  'id_ed25519',
  'id_ecdsa',
  'id_rsa',
  'id_dsa',
];

/**
 * 本机 `~/.ssh` 下实际存在的默认私钥（保持 `DEFAULT_PRIVATE_KEY_NAMES` 的顺序）。
 *
 * 只收普通文件：不存在、是目录、没权限读都按「该来源不可用」处理——认证链继续往下走
 * （FR-003），不在这里报错。
 */
export function discoverDefaultPrivateKeys(sshDir: string): string[] {
  const found: string[] = [];
  for (const name of DEFAULT_PRIVATE_KEY_NAMES) {
    const candidate = path.join(sshDir, name);
    try {
      if (fs.statSync(candidate).isFile()) found.push(candidate);
    } catch {
      // 不可用即跳过：这不是错误，只是这份来源不存在
    }
  }
  return found;
}

/** ssh-agent 是否可用：`SSH_AUTH_SOCK` 非空即认为可用（Windows 上是命名管道） */
export function agentSocketAvailable(env: { SSH_AUTH_SOCK?: string | undefined }): boolean {
  const socket = env.SSH_AUTH_SOCK;
  return typeof socket === 'string' && socket.length > 0;
}

/**
 * 本次「连接」要依次尝试的认证来源——**顺序的唯一一处定义**（FR-002）。
 *
 * `savedPassword` 为 `null` 表示没有可用口令，此时清单里不带口令项：要不要询问用户
 * 由调用方按「清单耗尽」判定，这里不猜。
 */
export function sshAuthChain(options: {
  /** 本机 `~/.ssh` 目录（测试可注入临时目录） */
  sshDir: string;
  /** 环境（`SSH_AUTH_SOCK`；测试可注入） */
  env: { SSH_AUTH_SOCK?: string | undefined };
  /** 已知口令（连接历史里保存的）；没有为 `null` */
  savedPassword: string | null;
}): SshAuthSource[] {
  const sources: SshAuthSource[] = discoverDefaultPrivateKeys(options.sshDir).map((keyPath) => ({
    kind: 'keyFile',
    keyPath,
  }));
  if (agentSocketAvailable(options.env)) sources.push({ kind: 'agent' });
  const saved = options.savedPassword;
  if (saved !== null && saved.length > 0) sources.push({ kind: 'password', password: saved });
  return sources;
}

/** SSH 失败的两类结论：`auth` 推进认证链，`fatal` 直接报错停在表单（FR-009） */
export type SshFailureKind = 'auth' | 'fatal';

/**
 * ssh2 在「所有配置的认证方式都失败」时给的原文。
 *
 * 这条是**认证不成立**的判据：主机是通的，只是这份凭证不被接受。
 */
const AUTH_REJECTED_PATTERN = /all configured authentication methods failed|no auth methods available|permission denied/i;

/**
 * 把一次建链异常分成「认证不成立」与「终止性失败」（FR-009）。
 *
 * 只有认证不成立才值得继续兜底（换成别的来源、最后问口令）；不可达、超时、主机密钥变更
 * 都直接报错——把它们混进兜底链会让用户为了一个拼错的主机名去输口令。
 *
 * 私钥自身的问题（加密、损坏、不可读）判为 `auth`：它只说明**这份来源**不可用，与目标
 * 主机是否可达无关（FR-003）。
 */
export function classifySshFailure(error: unknown): SshFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  // 主机密钥变更：`SshHostKeyError` 的原文，必须原样呈现给用户去比对指纹
  if (/does not match the fingerprint/i.test(message)) return 'fatal';
  // 传输层就没建起来：换凭证也解决不了
  if (/timed out|timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|getaddrinfo|connection closed/i.test(message)) {
    return 'fatal';
  }
  // 这份来源本身不可用（加密私钥 / 损坏 / 读不到 / agent 没起来）
  if (/encrypted|passphrase|unable to parse|cannot be parsed|no key|not readable|ssh-agent is not available/i.test(message)) {
    return 'auth';
  }
  if (AUTH_REJECTED_PATTERN.test(message)) return 'auth';
  // 认不出的错误按终止性处理：兜底链只吃「认证不成立」这一种确定结论（不过度 fallback）
  return 'fatal';
}

/** 私钥文件内容哈希的进程内缓存（按 path + mtime + size 失效） */
const keyFingerprintCache = new Map<string, { mtimeMs: number; size: number; fingerprint: string }>();

/**
 * 凭证身份的公开描述——进 `sshTargetKey`，永不进日志与用户界面。
 *
 * - 口令：`password:<sha256 前 16 位>`（沿用既有口径：锁定「换口令即换目标」而不留明文）；
 * - 私钥：`keyFile:<文件内容 sha256 前 16 位>`（换掉密钥文件即换身份）；读不到时退到
 *   路径哈希，键仍然稳定；
 * - agent：固定串 `agent`（身份集合由 agent 自己决定）。
 */
export function sshAuthIdentity(auth: SshAuthSource): string {
  if (auth.kind === 'password') {
    return `password:${createHash('sha256').update(auth.password).digest('hex').slice(0, 16)}`;
  }
  if (auth.kind === 'agent') return 'agent';
  const cached = keyFingerprintCache.get(auth.keyPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(auth.keyPath);
  } catch {
    return `keyFile:${createHash('sha256').update(auth.keyPath).digest('hex').slice(0, 16)}`;
  }
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.fingerprint;
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(auth.keyPath);
  } catch {
    // 路径在但读不出来（权限变了）：身份键退到路径，不把目标判成「没有凭证」
    return `keyFile:${createHash('sha256').update(auth.keyPath).digest('hex').slice(0, 16)}`;
  }
  const fingerprint = `keyFile:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  keyFingerprintCache.set(auth.keyPath, { mtimeMs: stat.mtimeMs, size: stat.size, fingerprint });
  return fingerprint;
}
