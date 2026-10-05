/**
 * 侧栏文件浏览器的远程（SSH）实现（US-42 / US-43）。
 *
 * 复用 `src/host/standalone/sshClient.ts` 的 SFTP 会话列目录 / 删除，与本地实现
 * （`electron/sidebarFiles.ts` + main.ts 的 fs 分支）输出同一份 `SidebarFileEntry`
 * 契约；路径全程用远端机器上的 POSIX 绝对路径（`resolveWithinRoot` 的 posix 分支
 * 负责越界校验，远程路径不能按本地 win32 语义解析）。
 *
 * 连接策略：一个 endpoint 一条 SSH 连接，按目标（含凭证）缓存复用——侧栏展开
 * / 逐层展开 / 删除都是短促操作，每次重连（TCP + 鉴权 + 主机密钥）开销不可接受；
 * SshClient 自带 keepalive 探活。连接在 workspace 关闭与应用退出时释放。
 */

import { SshClient, type SshDirEntry, type SshTarget } from '../src/host/standalone/sshClient.js';
import type { WorkspaceEndpoint } from '../src/host/workspaceRef.js';
import { resolveWithinRoot, sortSidebarEntries } from './sidebarFiles.js';

/** endpoint → 已建立的 SSH 客户端（跨侧栏多次操作复用） */
const clients = new Map<string, SshClient>();
/**
 * 进行中的连接（按同一键去重）。
 *
 * `SshClient.connect()` 在「连接已建立」时幂等，但**连接进行中**再调会抛
 * （构造期防重入）；侧栏首次展开会立刻并发请求根目录与已展开子目录，
 * 不去重的话第二个请求直接失败。
 */
const connecting = new Map<string, Promise<void>>();

/** endpoint → SshClient 连接缓存键：完整连接目标（含凭证——换凭证必须换连接） */
function clientKey(endpoint: WorkspaceEndpoint): string {
  return JSON.stringify(sshTargetFor(endpoint));
}

/** 从打开集合的远程引用取 SSH 连接目标（口令凭证，缺即抛错——不静默降级） */
export function sshTargetFor(endpoint: WorkspaceEndpoint): SshTarget {
  const auth = endpoint.auth;
  if (!auth || auth.kind !== 'sshPassword' || !endpoint.user) {
    throw new Error(`sidebar remote files: endpoint ${endpoint.host} has no SSH password credential.`);
  }
  return { host: endpoint.host, port: endpoint.port ?? 22, user: endpoint.user, password: auth.password };
}

/** 取（或建立）该 endpoint 的 SSH 客户端并确保已连接 */
async function clientFor(endpoint: WorkspaceEndpoint, log: (...args: unknown[]) => void): Promise<SshClient> {
  const key = clientKey(endpoint);
  let client = clients.get(key);
  if (!client) {
    client = new SshClient(sshTargetFor(endpoint), log);
    clients.set(key, client);
  }
  const inFlight = connecting.get(key);
  if (inFlight) {
    await inFlight;
    return client;
  }
  const connect = client.connect().finally(() => {
    connecting.delete(key);
  });
  connecting.set(key, connect);
  await connect;
  return client;
}

/**
 * 列出远端工作目录内容（rel 为 '/' 分隔相对路径，'' 为根）。
 *
 * 越界（`..` 上跳 / 绝对路径）直接抛错：IPC 层把它转成 `{ ok: false, error }`，
 * 渲染层显示「读取失败，点击重试」，不猜空列表。
 */
export async function listRemoteDirectory(
  endpoint: WorkspaceEndpoint,
  root: string,
  rel: string,
  log: (...args: unknown[]) => void,
): Promise<SshDirEntry[]> {
  const abs = resolveWithinRoot(root, rel, { allowRoot: true, posix: true });
  if (!abs) throw new Error(`remote path escapes the workspace root: ${rel}`);
  const client = await clientFor(endpoint, log);
  return sortSidebarEntries(await client.listDirectory(abs));
}

/**
 * 删除远端工作目录内的一组路径。
 *
 * 目录连同内容递归删除（远端无回收站，确认框文案由调用方标明「无法撤销」）；
 * 逐项执行，失败项收集进抛出的错误消息——渲染层收到失败仍会刷新树，残留项如实显现。
 */
export async function deleteRemotePaths(
  endpoint: WorkspaceEndpoint,
  root: string,
  rels: readonly string[],
  log: (...args: unknown[]) => void,
): Promise<void> {
  const client = await clientFor(endpoint, log);
  const failures: string[] = [];
  for (const rel of rels) {
    const abs = resolveWithinRoot(root, rel, { posix: true });
    if (!abs) {
      failures.push(`${rel}: path escapes the workspace root`);
      continue;
    }
    try {
      await client.removePath(abs);
    } catch (err) {
      failures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

/** 释放一个 endpoint 的 SSH 连接（工作区关闭时调用；未建立过连接是 no-op） */
export function disposeRemoteFilesClient(endpoint: WorkspaceEndpoint | null): void {
  if (!endpoint || endpoint.auth === null) return;
  let key: string;
  try {
    key = clientKey(endpoint);
  } catch {
    return; // 无凭证的 endpoint 从未建过连接
  }
  const client = clients.get(key);
  if (client) {
    clients.delete(key);
    client.dispose();
  }
}

/** 释放全部 SSH 连接（应用退出时调用） */
export function disposeAllRemoteFilesClients(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
}
