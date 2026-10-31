/**
 * 宿主本地状态文件（`workspace-state.json`）里工作区引用的序列化 / 反序列化。
 *
 * 纯函数，无宿主依赖：Electron 主进程与单测共用同一份口径
 * （见 `docs/core/client-connection.md` 第 4 / 9 节）。
 *
 * 本地项与远程项同格式：本地项的 `endpoint` 为 `null`，远程项带 host / port / user 与
 * **凭证**（SSH 口令，明文落盘，重启后据此恢复连接）。旧版本只写本地路径字符串，
 * 读取时按本地引用迁移。
 */

import {
  localWorkspaceRef,
  normalizeRemoteWorkspacePath,
  type WorkspaceAuth,
  type WorkspaceEndpoint,
  type WorkspaceRef,
} from './workspaceRef.js';
import {
  dedupeWorkspacePaths,
  normalizeWorkspacePath,
  sameWorkspace,
} from './workspacePaths.js';

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
 * 形状不合法即整项丢弃，不猜、不补默认值（``docs/architecture/principles.md`）。
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
  // 远程路径与构造处同一份归一（`normalizeRemoteWorkspacePath`）：旧状态文件里带尾分隔符
  // 的项恢复后必须与新建项同一个身份键，否则 OpenWorkspace 会为同一目录再建一条 Connection
  // （specs/defects/remote-workspace-trailing-slash-splits-identity.md）
  return { scheme, path: normalizeRemoteWorkspacePath(refPath), endpoint: parsed };
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

/** 旧版本状态文件里与工作目录有关的字段（新版本读的是 `openWorkspaces` / `activeWorkspaceKey`） */
export interface LegacyWorkspaceFields {
  lastWorkspace?: unknown;
  openWorkspaces?: unknown;
  activeWorkspace?: unknown;
}

/** 迁移结果：新格式的打开集合（本地路径，规范化后）与活动项路径 */
export interface MigratedWorkspaceFields {
  openWorkspaces: string[];
  activeWorkspace: string | null;
}

/**
 * 把旧版本状态文件的工作目录字段迁移到新格式（纯函数，`electron/main.ts` 负责落盘）。
 *
 * - 打开集合：优先取旧版的 `openWorkspaces`（本地路径字符串数组），否则取单个
 *   `lastWorkspace`；都取不到时是空集合（该用户确实没有打开过工作目录）。
 * - **只做形状过滤，不按「目录存在」过滤**：目录已不存在的本地项由读取路径标记为
 *   不可用（红点 + 禁选），在这里丢弃会让老用户升级后打开集合静默变空、启动即空态。
 * - 活动项：旧版 `activeWorkspace` 能在打开集合里找到时取它，否则取集合最后一项。
 *
 * 入参不是对象时返回 `null`（调用方据此跳过该候选文件）。
 */
export function migrateLegacyWorkspaceFields(raw: unknown): MigratedWorkspaceFields | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { lastWorkspace, openWorkspaces, activeWorkspace } = raw as LegacyWorkspaceFields;
  const legacyOpen = Array.isArray(openWorkspaces)
    ? openWorkspaces.filter((ws): ws is string => typeof ws === 'string' && ws.trim().length > 0)
    : [];
  // 空串不能进 normalizeWorkspacePath：`path.resolve('')` 会变成宿主进程的当前目录
  const legacyLast = typeof lastWorkspace === 'string' && lastWorkspace.trim().length > 0
    ? normalizeWorkspacePath(lastWorkspace)
    : undefined;
  const open = dedupeWorkspacePaths(
    legacyOpen.length > 0 ? legacyOpen : legacyLast ? [legacyLast] : [],
  );
  const legacyActive = typeof activeWorkspace === 'string' && activeWorkspace
    ? activeWorkspace
    : undefined;
  const fallbackActive = legacyLast ?? (open.length > 0 ? open[open.length - 1] : undefined);
  const active = legacyActive
    ? open.find((w) => sameWorkspace(w, legacyActive)) ?? fallbackActive
    : fallbackActive;
  return { openWorkspaces: open, activeWorkspace: active ?? null };
}
