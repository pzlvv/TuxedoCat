/**
 * 远程接入输入的解析（宿主侧，纯函数）。
 *
 * 接入方式只有 SSH（`docs/core-daemon.md` 第 12 节）：目标只开放 SSH 端口时，填 SSH 的
 * IP / 端口 / 用户 / 口令，部署、启动与后续全部通信都走这条 SSH 连接。
 * 输入在这里收敛成 `WorkspaceEndpoint`（`buildRemoteEndpoint`）。
 * 不依赖 electron：可在单测里直接使用。
 */

import type { WorkspaceEndpoint } from './workspaceRef.js';

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
 * 远程工作区接入请求（`docs/core-daemon.md` 第 12 节）：SSH 表单。
 *
 * `port` 原样带表单里的字符串，校验在本模块。
 */
export interface RemoteConnectRequest {
  host: string;
  port: string;
  user: string;
  password: string;
}

/** 接入请求不合法时的原因码；宿主据此给出本地化文案（i18n 不进本模块） */
export type RemoteConnectError = 'request' | SshInputError;

/**
 * 把页面传来的接入请求收敛成 `WorkspaceEndpoint`。
 *
 * 入参是 IPC 来的 `unknown`，形状不对一律报 `request`，不做「缺字段就用默认值」的降级。
 */
export function buildRemoteEndpoint(
  raw: unknown,
): { ok: true; value: WorkspaceEndpoint } | { ok: false; error: RemoteConnectError } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'request' };
  const request = raw as Record<string, unknown>;
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
