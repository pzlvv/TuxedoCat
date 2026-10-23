/**
 * 工作区代理身份（specs/022 FR-001）。
 *
 * 身份 = `机器名 + 工作区路径`，逐字用于 `@` 候选、`Agent` 的 `target` 与 reminder：
 * - 本地工作区：机器名取运行宿主的机器名（Windows `COMPUTERNAME` / Linux `HOSTNAME`，
 *   缺失回退操作系统主机名）；
 * - 远程（SSH）工作区：机器名取 SSH 目标主机字符串（`WorkspaceRef.endpoint.host`），
 *   不含端口与登录用户。
 *
 * 纯函数、无宿主 API：Electron 主进程与单测共用同一份口径
 * （`docs/hosts/electron-multi-workspace.md` 第 2 节）。
 */

import { normalizeWorkspacePath } from './workspacePaths.js';
import { sameWorkspaceRef, type WorkspaceRef } from './workspaceRef.js';

/** 取机器名的平台分支（Node `process.platform` 的取值） */
export type MachinePlatform = 'win32' | 'linux' | 'darwin' | string;

/**
 * 解析本机机器名。
 *
 * Windows 与 Linux 各有一条显式取法（即使宿主暂不支持 Linux）；两者都缺失时回退
 * 操作系统主机名。结果为空视为接线错误直接抛错——身份不能是空串。
 */
export function resolveMachineName(
  platform: MachinePlatform,
  env: Readonly<Record<string, string | undefined>>,
  osHostname: string,
): string {
  const envKey = platform === 'win32' ? 'COMPUTERNAME' : platform === 'linux' ? 'HOSTNAME' : null;
  const fromEnv = envKey ? (env[envKey] ?? '').trim() : '';
  const resolved = fromEnv || osHostname.trim();
  if (!resolved) {
    throw new Error('Cannot resolve machine name: hostname is empty.');
  }
  return resolved;
}

/**
 * 工作区代理身份：`<机器名>:<工作区路径>`。
 *
 * 本地路径按宿主口径规范化（大小写 / 尾分隔符）；远程路径是目标机器上的字符串，
 * 原样保留（对 `/home/pz/a` 跑本地规范化会得到 `D:\home\pz\a`）。
 */
export function workspaceAgentId(ref: WorkspaceRef, machineName: string): string {
  const host = ref.endpoint ? ref.endpoint.host : machineName;
  const path = ref.endpoint ? ref.path : normalizeWorkspacePath(ref.path);
  return `${host}:${path}`;
}

/** 候选菜单的展示名：路径最后一级目录名；空路径回退完整身份 */
export function workspaceAgentDisplayName(ref: WorkspaceRef): string {
  const path = ref.endpoint ? ref.path : normalizeWorkspacePath(ref.path);
  const trimmed = path.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  return base || path;
}

/** 按身份解析工作区引用的结果（互斥：命中唯一 / 未命中 / 歧义） */
export type WorkspaceIdentityResolution =
  | { kind: 'match'; ref: WorkspaceRef }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

/**
 * 按身份解析打开集合中的工作区。
 *
 * 不同引用可能派生出相同身份（同 host + 同路径、不同 SSH 用户或端口）：
 * 命中多项返回 `ambiguous`，不取第一项（specs/022 FR-001）。
 */
export function resolveWorkspaceByIdentity(
  refs: readonly WorkspaceRef[],
  identity: string,
  machineName: string,
): WorkspaceIdentityResolution {
  const matched = refs.filter((ref) => workspaceAgentId(ref, machineName) === identity);
  if (matched.length === 0) return { kind: 'missing' };
  if (matched.length > 1) return { kind: 'ambiguous' };
  return { kind: 'match', ref: matched[0] as WorkspaceRef };
}

/** `@` 补全候选（宿主下发给 webview 的形态） */
export interface WorkspaceMentionCandidate {
  id: string;
  path: string;
  displayName: string;
}

/**
 * `@` 工作区补全候选（specs/022 FR-007）：已打开工作区里排除**来源视图所属工作区**。
 *
 * 过滤按工作区引用判等（不是身份字符串）：同一身份的另一工作区仍可出现。
 * `current` 为空（解析不出来源工作区）时返回空候选——不猜、不用活动标签页顶替。
 */
export function workspaceMentionCandidates(
  refs: readonly WorkspaceRef[],
  current: WorkspaceRef | undefined,
  machineName: string,
): WorkspaceMentionCandidate[] {
  if (!current) return [];
  return refs
    .filter((ref) => !sameWorkspaceRef(ref, current))
    .map((ref) => ({
      id: workspaceAgentId(ref, machineName),
      path: ref.path,
      displayName: workspaceAgentDisplayName(ref),
    }));
}
