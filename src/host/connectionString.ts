/**
 * 远程接入输入的解析（宿主侧，纯函数）。
 *
 * 两种接入方式（`docs/core-daemon.md` 第 12 节）：
 * - 连接串：由 Standalone Core 的 `start` 产出（`core-rs/src/remote.rs::connection_string`），
 *   形如 `<IP>:<端口>#<token>`，用户从终端整行复制粘贴；
 * - SSH 表单：IP / 端口 / 用户 / 口令，目标只开放 SSH 端口时用。
 *
 * 两种输入都在这里收敛成 `WorkspaceEndpoint`（`buildRemoteEndpoint`）。
 * 不依赖 electron：可在单测里直接使用。
 */

import type { WorkspaceEndpoint } from './workspaceRef.js';

/** 解析成功的连接信息 */
export interface RemoteConnection {
  host: string;
  port: number;
  token: string;
}

/**
 * 解析连接串。格式不符时返回 `null`，由调用方给出提示——
 * 这里不做「只填了 IP 就先连上」之类的降级：连不上远端的原因会被误报成网络问题。
 */
export function parseConnectionString(raw: string): RemoteConnection | null {
  const text = raw.trim();
  // token 不含 `#`：从最后一个 `#` 切开，token 里出现 `#` 时按「格式不对」处理
  const separator = text.indexOf('#');
  if (separator <= 0) return null;
  const address = text.slice(0, separator);
  const token = text.slice(separator + 1);
  if (token.length === 0 || token.includes('#')) return null;

  // 端口取最后一个 `:`：主机部分按原样保留（IPv4 / 主机名）
  const colon = address.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = address.slice(0, colon);
  const portText = address.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port <= 0 || port > 65535) return null;
  if (host.length === 0) return null;

  return { host, port, token };
}

/** SSH 表单输入（`docs/core-daemon.md` 第 12 节）：IP + 端口 + 用户 + 口令 */
export interface SshConnectionInput {
  host: string;
  /** SSH 端口（默认 22） */
  port: number;
  user: string;
  password: string;
}

/** SSH 表单里哪一项不合格；主进程据此给出对应文案 */
export type SshInputError = 'host' | 'port' | 'user' | 'password';

/**
 * 校验 SSH 表单输入。
 *
 * 只校验「填全了、端口是数字」这一层：口令**不 trim**（首尾空格是合法口令的一部分），
 * 主机 / 用户 trim 掉首尾空白（表单里粘贴进来的常见噪声）。密码学层面的事（主机密钥、
 * 认证失败）留给 `SshClient`，不在这里猜。
 */
export function parseSshConnectionInput(raw: {
  host: unknown;
  port: unknown;
  user: unknown;
  password: unknown;
}): { ok: true; value: SshConnectionInput } | { ok: false; error: SshInputError } {
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (host.length === 0) return { ok: false, error: 'host' };

  const portText = typeof raw.port === 'number'
    ? String(raw.port)
    : typeof raw.port === 'string'
      ? raw.port.trim()
      : '';
  if (!/^\d+$/.test(portText)) return { ok: false, error: 'port' };
  const port = Number(portText);
  if (port <= 0 || port > 65535) return { ok: false, error: 'port' };

  const user = typeof raw.user === 'string' ? raw.user.trim() : '';
  if (user.length === 0) return { ok: false, error: 'user' };

  const password = typeof raw.password === 'string' ? raw.password : '';
  if (password.length === 0) return { ok: false, error: 'password' };

  return { ok: true, value: { host, port, user, password } };
}

/**
 * 远程工作区接入请求（`docs/core-daemon.md` 第 12 节）。
 *
 * - `connectionString`：daemon 端口可达时，粘贴 `start` 打印的连接串；
 * - `ssh`：目标只开放 SSH 端口时，填 SSH 的 IP / 端口 / 用户 / 口令，
 *   部署、启动与后续全部通信都走这条 SSH 连接。
 */
export type RemoteConnectRequest =
  | { kind: 'connectionString'; value: string }
  /** `port` 原样带表单里的字符串，校验在本模块 */
  | { kind: 'ssh'; host: string; port: string; user: string; password: string };

/** 接入请求不合法时的原因码；宿主据此给出本地化文案（i18n 不进本模块） */
export type RemoteConnectError = 'request' | 'connectionString' | SshInputError;

/**
 * 把页面传来的接入请求收敛成 `WorkspaceEndpoint`。
 *
 * 两种接入方式在这里合流：凭证种类决定后续怎么建链（`auth.kind` → `scheme`）。
 * 入参是 IPC 来的 `unknown`，形状不对一律报 `request`，不做「缺字段就用默认值」的降级。
 */
export function buildRemoteEndpoint(
  raw: unknown,
): { ok: true; value: WorkspaceEndpoint } | { ok: false; error: RemoteConnectError } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'request' };
  const request = raw as Record<string, unknown>;
  if (request.kind === 'connectionString') {
    const value = typeof request.value === 'string' ? request.value : '';
    const parsed = parseConnectionString(value);
    if (!parsed) return { ok: false, error: 'connectionString' };
    return {
      ok: true,
      value: {
        host: parsed.host,
        port: parsed.port,
        user: null,
        auth: { kind: 'token', token: parsed.token },
      },
    };
  }
  if (request.kind === 'ssh') {
    const parsed = parseSshConnectionInput({
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
    });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return {
      ok: true,
      value: {
        host: parsed.value.host,
        port: parsed.value.port,
        user: parsed.value.user,
        auth: { kind: 'sshPassword', password: parsed.value.password },
      },
    };
  }
  return { ok: false, error: 'request' };
}
