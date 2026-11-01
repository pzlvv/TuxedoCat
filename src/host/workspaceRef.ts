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
 * 远程凭证（`docs/core/core-remote.md` 第 2 节）。
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
 * SSH 接入（`docs/core/core-remote.md` 第 2 节）：全部通信走 SSH 端口，
 * 不要求目标机器把 daemon 端口映射出来。
 */
export const SSH_WORKSPACE_SCHEME = 'ssh';

/**
 * 远程路径归一到「无尾分隔符」形态（根路径保持 `/`）。
 *
 * 远程路径是目标机器上的字符串，**不能**跑本地规范化（Windows 上
 * `path.resolve('/home/pz/a')` 会变成 `D:\home\pz\a`）；但尾分隔符必须抹平，否则
 * 同一个目录会以两种写法各自成为一个工作区：目录选择器交给宿主的目录**恒带尾分隔符**
 * （`electron/remoteWorkspace/pathInput.ts` 的 `ensureTrailingSeparator`，
 * `docs/core/core-remote.md` 第 2.6 节），daemon 回显的 `listing.path` 保留用户输入的
 * 原样（`core-rs/src/remote.rs` 的 `list_directories`）；而 Core 的对话空间目录按
 * `encodeURIComponent(path)` 派生（`core-rs/src/config.rs` 的
 * `project_conversation_dir`），带尾斜杠与不带是两个空间。
 *
 * 归一**只有这一份**：构造（`remoteWorkspaceRef`）、反序列化（`workspaceState.ts`）、
 * 身份键（`workspaceRefKey`）与判等（`sameRemotePath` / `sameWorkspaceRef`）全部走它，
 * 否则「一处归一、一处逐字」会让 Identity 与判等互相矛盾。
 */
export function normalizeRemoteWorkspacePath(path: string): string {
  // 根不能剥成空串：`/` 是唯一的单分隔符路径
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/** 远程工作区引用：接入方式恒为 SSH；路径在构造处即归一（见 `normalizeRemoteWorkspacePath`） */
export function remoteWorkspaceRef(
  endpoint: WorkspaceEndpoint,
  path: string,
): WorkspaceRef {
  return { scheme: SSH_WORKSPACE_SCHEME, path: normalizeRemoteWorkspacePath(path), endpoint };
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
 *
 * 空引用（`emptyWorkspaceRef`：未打开工作目录时的占位）没有路径，只以连接目标作身份：
 * 它不能进本地规范化——`path.resolve('')` 会得到宿主进程的当前目录，与「当前目录恰好
 * 被当作工作区打开」撞键，占位 Connection 会被误当成那个工作区的 Connection。
 */
export function workspaceRefKey(ref: WorkspaceRef): string {
  const endpoint = ref.endpoint;
  const target = endpoint
    ? `${endpoint.user ?? ''}@${endpoint.host}:${endpoint.port ?? ''}`
    : 'local';
  if (!ref.path) return `${ref.scheme}//${target}`;
  const path = ref.scheme === 'file'
    ? normalizeWorkspacePath(ref.path)
    : normalizeRemoteWorkspacePath(ref.path);
  return `${ref.scheme}//${target}${path}`;
}

/**
 * 落盘的 `activeWorkspaceKey` 是否指向该引用。
 *
 * 除当前键外还兼容归一之前写下的远程键：当时选择器交给宿主的目录恒带尾分隔符
 * （`docs/core/core-remote.md` 第 2.6 节），落盘的键末尾因此多一个 `/`。升级后打开集合里
 * 的路径已归一，逐字比较会失配、活动标签页回落到最后一项——这里只兼容「远程键末尾多一个
 * `/`」这一种历史写法，不做前缀匹配
 * （`specs/defects/remote-workspace-trailing-slash-splits-identity.md`）。
 */
export function workspaceRefKeyMatches(ref: WorkspaceRef, persistedKey: string): boolean {
  const key = workspaceRefKey(ref);
  if (key === persistedKey) return true;
  return ref.scheme !== 'file' && ref.path !== '' && ref.path !== '/' && `${key}/` === persistedKey;
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
    : normalizeRemoteWorkspacePath(a.path) === normalizeRemoteWorkspacePath(b.path);
}

/**
 * 远程路径判等：目标机器上的字符串逐字比较，只抹平末尾分隔符差异。
 *
 * 远程路径不能跑本地规范化（Windows 上 `path.resolve('/home/pz/a')` 会变成
 * `D:\home\pz\a`）；但工作区引用与对话元数据可能一个带尾斜杠、一个不带，
 * 逐字比较会把同一个目录判成两个。归一口径是 `normalizeRemoteWorkspacePath`（唯一一份）。
 */
export function sameRemotePath(a: string, b: string): boolean {
  return normalizeRemoteWorkspacePath(a) === normalizeRemoteWorkspacePath(b);
}

/** 工作目录路径是否属于该引用（本地按宿主口径判等，远程逐字比较、忽略末尾分隔符差异） */
export function workspacePathMatches(ref: WorkspaceRef, target: string): boolean {
  return ref.endpoint ? sameRemotePath(ref.path, target) : sameWorkspace(ref.path, target);
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
