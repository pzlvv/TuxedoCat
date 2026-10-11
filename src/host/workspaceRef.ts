/**
 * 工作区引用（`docs/core/client-connection.md` 第 4 节）。
 *
 * 三元组 `{ scheme, path, endpoint }` 同时表达本地与远程工作区：
 * - `scheme`：这类工作区怎么接（本地为 `file`，远程为 `ssh` / `wsl` / `container`，预留）；
 * - `endpoint`：接哪台机器、用什么凭证（本地为 `null`）；
 * - `path`：Core 的会话工作目录。
 *
 * **Core 只见 `path`**：endpoint 与凭证不下发到 Core，也不进入配置快照。
 * 本模块只做取值与判等，不依赖任何宿主 API（VS Code / Electron 各自把 URI / 路径
 * 转成 `WorkspaceRef`）。
 */

import { normalizeWorkspacePath, sameWorkspace } from './workspacePaths.js';

/**
 * 远程凭证（`docs/core/core-daemon.md` 第 12 节）。
 *
 * 只有 SSH 口令一种：SSH 完成机器级鉴权，daemon 的 token 由引导流程从远端状态文件
 * 取得、只在控制通道第一帧使用。`kind` 判别字段保留，便于后续新增凭证种类。
 * 凭证不进总线载荷、不下发 Core；宿主侧的落盘与恢复见 `workspaceState.ts`。
 */
export type WorkspaceAuth = { kind: 'sshPassword'; password: string };

/** 远程 endpoint（本地为 null） */
export interface WorkspaceEndpoint {
  /** 主机名 / 容器名；`ssh` 下是 SSH 主机 */
  host: string;
  /** 端口；`ssh` 下是 SSH 端口，未指定为 null */
  port: number | null;
  /** 登录用户；`ssh` 下必填，未指定为 null */
  user: string | null;
  /** 凭证；本地为 null（传输层实现细节，见 `WorkspaceAuth`） */
  auth: WorkspaceAuth | null;
}

/** 工作区引用（本地 / 远程同构） */
export interface WorkspaceRef {
  /** 接入方式：`file` / `ssh` / `wsl` / `container` */
  scheme: string;
  /** 那台机器上的目录；无工作区时为空串 */
  path: string;
  /** 目标机器与凭证；本地为 null */
  endpoint: WorkspaceEndpoint | null;
}

/** 本地工作区引用（路径按宿主的规范化口径处理） */
export function localWorkspaceRef(path: string): WorkspaceRef {
  return {
    scheme: 'file',
    path: normalizeWorkspacePath(path),
    endpoint: null,
  };
}

/**
 * SSH 接入（`docs/core/core-daemon.md` 第 12 节）：全部通信走 SSH 端口，
 * 不要求目标机器把 daemon 端口映射出来。
 */
export const SSH_WORKSPACE_SCHEME = 'ssh';

/** 远程工作区引用：接入方式恒为 SSH */
export function remoteWorkspaceRef(
  endpoint: WorkspaceEndpoint,
  path: string,
): WorkspaceRef {
  return { scheme: SSH_WORKSPACE_SCHEME, path, endpoint };
}

/**
 * 连接目标键：`(scheme, endpoint)` 相同的多个工作区共用一个 daemon
 * （`docs/core/core-daemon.md`：一个 endpoint 一个 daemon）。本地恒为 `local`。
 */
export function workspaceEndpointKey(ref: WorkspaceRef): string {
  const endpoint = ref.endpoint;
  if (!endpoint) return 'local';
  const target = `${endpoint.user ?? ''}@${endpoint.host}:${endpoint.port ?? ''}`;
  return `${ref.scheme}//${target}`;
}

/**
 * 工作区引用的去重键。
 *
 * `(scheme, endpoint)` 决定连接目标，`path` 是目标机器上的目录；三者一起唯一确定
 * 一个 Connection。路径按宿主规范化口径处理（大小写 / 尾分隔符差异视为同一目录）。
 */
export function workspaceRefKey(ref: WorkspaceRef): string {
  const endpoint = ref.endpoint;
  const target = endpoint
    ? `${endpoint.user ?? ''}@${endpoint.host}:${endpoint.port ?? ''}`
    : 'local';
  const path = ref.scheme === 'file' ? normalizeWorkspacePath(ref.path) : ref.path;
  return `${ref.scheme}//${target}${path}`;
}

/** 两个工作区引用是否指向同一个连接目标与目录 */
export function sameWorkspaceRef(a: WorkspaceRef, b: WorkspaceRef): boolean {
  if (a.scheme !== b.scheme) return false;
  const aEndpoint = a.endpoint;
  const bEndpoint = b.endpoint;
  if ((aEndpoint === null) !== (bEndpoint === null)) return false;
  if (aEndpoint && bEndpoint) {
    if (
      aEndpoint.host !== bEndpoint.host
      || aEndpoint.port !== bEndpoint.port
      || aEndpoint.user !== bEndpoint.user
    ) {
      return false;
    }
  }
  return a.scheme === 'file'
    ? sameWorkspace(a.path, b.path)
    : a.path === b.path;
}

/** 展示用路径：远程带上 `scheme://[user@]host` 前缀，本地就是路径本身 */
export function workspaceRefDisplayPath(ref: WorkspaceRef): string {
  if (!ref.endpoint) return ref.path;
  const { host, user } = ref.endpoint;
  const authority = user ? `${user}@${host}` : host;
  return `${ref.scheme}://${authority}${ref.path}`;
}

/** 空工作区引用（宿主未打开任何目录时的占位；path 为空串） */
export function emptyWorkspaceRef(scheme = 'file'): WorkspaceRef {
  return { scheme, path: '', endpoint: null };
}

/** 是否为「未打开工作区」的占位引用 */
export function isEmptyWorkspaceRef(ref: WorkspaceRef): boolean {
  return ref.path === '' && ref.endpoint === null;
}
