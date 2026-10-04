/**
 * 宿主本地状态文件（`workspace-state.json`）里工作区引用的序列化 / 反序列化。
 *
 * 纯函数，无宿主依赖：Electron 主进程与单测共用同一份口径
 * （见 `docs/client-connection.md` 第 4 节、第 9 节）。
 *
 * 本地项与远程项同格式：本地项的 `endpoint` 为 `null`，远程项带 host / port / user 与
 * **凭证**（SSH 口令，明文落盘，重启后据此恢复连接）。旧版本只写本地路径字符串，
 * 读取时按本地引用迁移。
 */

import {
  localWorkspaceRef,
  type WorkspaceAuth,
  type WorkspaceEndpoint,
  type WorkspaceRef,
} from './workspaceRef.js';

/** 落盘的工作区引用（`WorkspaceRef` 的序列化形态） */
export interface SerializedWorkspaceRef {
  scheme: string;
  path: string;
  endpoint: WorkspaceEndpoint | null;
}

/** 序列化：原样写出 scheme / path / endpoint（含凭证） */
export function serializeWorkspaceRef(ref: WorkspaceRef): SerializedWorkspaceRef {
  return { scheme: ref.scheme, path: ref.path, endpoint: ref.endpoint };
}

/**
 * 反序列化一条落盘项。
 *
 * - 字符串：旧版本的本地路径，按本地引用迁移（目录已不存在时丢弃）；
 * - 对象：本地项（`endpoint` 为 null）同样要求目录仍存在；远程项不检查本地是否存在
 *   （路径在目标机器上），但 endpoint 与凭证必须形状合法。
 *
 * 形状不合法即整项丢弃，不猜、不补默认值（`DEVELOPMENT.md` 第 12 章）。
 */
export function parseWorkspaceEntry(
  entry: unknown,
  localDirExists: (target: string) => boolean,
): WorkspaceRef | null {
  if (typeof entry === 'string') {
    return localDirExists(entry) ? localWorkspaceRef(entry) : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { scheme, path: refPath, endpoint } = entry as Partial<SerializedWorkspaceRef>;
  if (typeof scheme !== 'string' || scheme.length === 0) return null;
  if (typeof refPath !== 'string' || refPath.length === 0) return null;
  if (endpoint === null || endpoint === undefined) {
    return localDirExists(refPath) ? localWorkspaceRef(refPath) : null;
  }
  const parsed = parseSerializedEndpoint(endpoint);
  if (!parsed) return null;
  return { scheme, path: refPath, endpoint: parsed };
}

/** 校验落盘的 endpoint（含凭证） */
export function parseSerializedEndpoint(value: unknown): WorkspaceEndpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { host, port, user, auth } = value as Partial<WorkspaceEndpoint>;
  if (typeof host !== 'string' || host.length === 0) return null;
  if (port !== null && !(typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535)) {
    return null;
  }
  if (user !== null && typeof user !== 'string') return null;
  const parsedAuth = parseSerializedAuth(auth);
  if (!parsedAuth) return null;
  return { host, port: port ?? null, user: user ?? null, auth: parsedAuth };
}

/** 校验落盘的凭证；认不出的 `kind` 一律丢弃（不做「有就用」的降级） */
export function parseSerializedAuth(value: unknown): WorkspaceAuth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const auth = value as { kind?: unknown; password?: unknown };
  if (auth.kind !== 'sshPassword') return null;
  return typeof auth.password === 'string' && auth.password.length > 0
    ? { kind: 'sshPassword', password: auth.password }
    : null;
}
