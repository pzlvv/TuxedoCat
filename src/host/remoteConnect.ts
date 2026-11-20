/**
 * 远程接入输入的解析（宿主侧，纯函数）。
 *
 * 接入方式只有 SSH（`docs/core/core-remote.md` 第 2.8 节）：目标只开放 SSH 端口时，填 SSH 的
 * IP / 端口 / 用户，部署、启动与后续全部通信都走这条 SSH 连接。
 *
 * 口令**不是表单必填项**（specs/053 FR-001）：用哪种凭证由认证链（`sshAuth.ts`）在连接时
 * 决定，本模块只校验「形状填全了」并把用户显式输入的口令原样带出。
 * 不依赖 electron：可在单测里直接使用。
 */

import type { WorkspaceEndpoint } from './workspaceRef.js';

/** SSH 表单里的连接目标（`docs/core/core-remote.md` 第 2.8 节）：IP + 端口 + 用户 */
export interface SshConnectionTarget {
  host: string;
  /** SSH 端口（默认 22） */
  port: number;
  user: string;
}

/** SSH 表单里哪一项不合格；主进程据此给出对应文案 */
export type SshInputError = 'host' | 'port' | 'user';

/**
 * 校验 SSH 表单输入。
 *
 * 只校验「填全了、端口是数字」这一层：主机 / 用户 trim 掉首尾空白（表单里粘贴进来的
 * 常见噪声）。密码学层面的事（主机密钥、认证失败）留给建链器与认证链，不在这里猜。
 */
export function parseSshConnectionInput(raw: {
  host: unknown;
  port: unknown;
  user: unknown;
}): { ok: true; value: SshConnectionTarget } | { ok: false; error: SshInputError } {
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

  return { ok: true, value: { host, port, user } };
}

/**
 * 远程工作区接入请求（`docs/core/core-remote.md` 第 2.8 节）：SSH 表单。
 *
 * `port` 原样带表单里的字符串，校验在本模块；`password` 只在用户经「口令浮层」显式提交时
 * 有值，表单「连接」恒传 `null`（specs/053 FR-001 / FR-004）。
 */
export interface RemoteConnectRequest {
  host: string;
  port: string;
  user: string;
  password: string | null;
}

/** 接入请求不合法时的原因码；宿主据此给出本地化文案（i18n 不进本模块） */
export type RemoteConnectError = 'request' | SshInputError;

/**
 * 把页面传来的接入请求收敛成**不带凭证**的 `WorkspaceEndpoint`。
 *
 * 返回的 `auth` 恒为 `null`：凭证由认证链在连接时决定；用户显式输入的口令作为
 * `password` 单独带回（`null` 表示这一次没有用户输入的口令）。
 * 入参是 IPC 来的 `unknown`，形状不对一律报 `request`，不做「缺字段就用默认值」的降级。
 */
export function buildRemoteEndpoint(
  raw: unknown,
): { ok: true; value: WorkspaceEndpoint; password: string | null }
  | { ok: false; error: RemoteConnectError } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'request' };
  const request = raw as Record<string, unknown>;
  const parsed = parseSshConnectionInput({
    host: request.host,
    port: request.port,
    user: request.user,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // 口令不 trim：首尾空格是合法口令的一部分；空串归一到「没有输入」
  const password = typeof request.password === 'string' && request.password.length > 0
    ? request.password
    : null;
  return {
    ok: true,
    value: {
      host: parsed.value.host,
      port: parsed.value.port,
      user: parsed.value.user,
      auth: null,
    },
    password,
  };
}
