/**
 * 侧栏文件浏览器的远程（SSH）实现（US-42 / US-43）。
 *
 * 复用 `src/host/standalone/sshClient.ts` 的 SFTP 会话列目录 / 删除，与本地实现
 * （`electron/sidebarFiles.ts` + main.ts 的 fs 分支）输出同一份条目契约；路径全程用
 * 远端机器上的 POSIX 绝对路径（`resolveWithinRoot` 的 posix 分支负责越界校验，
 * 远程路径不能按本地 win32 语义解析）。
 *
 * 连接策略：一个 endpoint 一条 SSH 连接，按目标（含凭证，`sshTargetKey` 派生）缓存
 * 复用——侧栏展开 / 逐层展开 / 删除都是短促操作，每次重连（TCP + 鉴权 + 主机密钥）
 * 开销不可接受；SshClient 自带 keepalive 探活。
 *
 * 生命周期按**打开的工作区**引用计数（lease）：`retainRemoteFilesClient` 随工作区
 * 加入打开集合登记一次，`releaseRemoteFilesClient` 随工作区关闭释放一次，计数归零
 * 才真正断开——同一台远端机开多个目录时，关掉一个不能拆掉另一个仍在用的连接。
 * 连接在最后一个工作区关闭与应用退出时释放。
 */

import { SshClient, type DirectoryEntry, type SshTarget } from '../src/host/standalone/sshClient.js';
import { sshTargetFor, sshTargetKey } from '../src/host/sshTarget.js';
import type { WorkspaceEndpoint } from '../src/host/workspaceRef.js';
import { sharedInFlight } from '../src/core/utils/asyncUtils.js';
import { deleteEachPath, resolveWithinRoot, sortSidebarEntries } from './sidebarFiles.js';

export { sshTargetFor };

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
/** 正在使用该 endpoint 连接的打开工作区数：归零才释放底层连接 */
const leases = new Map<string, number>();

/** 取（或建立）该 endpoint 的 SSH 客户端并确保已连接 */
async function clientFor(endpoint: WorkspaceEndpoint, log: (...args: unknown[]) => void): Promise<SshClient> {
  const key = sshTargetKey(sshTargetFor(endpoint));
  let client = clients.get(key);
  if (!client) {
    client = new SshClient(sshTargetFor(endpoint), log);
    clients.set(key, client);
  }
  const inFlight = connecting.get(key);
  if (inFlight) {
    await inFlight;
    // 等待期间连接可能已被释放（最后一个工作区关闭）并被新调用重建：
    // 旧实例已 dispose，递归取当前实例（connect 幂等，新实例未连上会补连）
    if (clients.get(key) !== client) return clientFor(endpoint, log);
    return client;
  }
  const connect = sharedInFlight(connecting, key, () => client!.connect());
  try {
    await connect;
  } catch (err) {
    // 连接失败：半死实例移出缓存并释放，下次调用重建（dispose 幂等）
    if (clients.get(key) === client) {
      clients.delete(key);
      client.dispose();
    }
    throw err;
  }
  return client;
}

/**
 * 工作区加入打开集合时登记一次连接共享（远程项；本地项无凭证，忽略）。
 * 与 `releaseRemoteFilesClient` 配对：同一 endpoint 的多个工作区各记一次。
 */
export function retainRemoteFilesClient(endpoint: WorkspaceEndpoint | null): void {
  if (!endpoint || endpoint.auth === null) return;
  let key: string;
  try {
    key = sshTargetKey(sshTargetFor(endpoint));
  } catch {
    return; // 无凭证的 endpoint 不会建连接
  }
  leases.set(key, (leases.get(key) ?? 0) + 1);
}

/**
 * 工作区关闭时释放一次共享；计数归零才真正断开——
 * 同一 endpoint 的其它工作区可能还在用这条连接。
 */
export function releaseRemoteFilesClient(endpoint: WorkspaceEndpoint | null): void {
  if (!endpoint || endpoint.auth === null) return;
  let key: string;
  try {
    key = sshTargetKey(sshTargetFor(endpoint));
  } catch {
    return; // 无凭证的 endpoint 从未建过连接
  }
  const remaining = (leases.get(key) ?? 1) - 1;
  if (remaining > 0) {
    leases.set(key, remaining);
    return;
  }
  leases.delete(key);
  const client = clients.get(key);
  if (client) {
    clients.delete(key);
    client.dispose();
  }
  // 连接进行中被释放（最后一个工作区在首次列目录完成前关闭）：
  // 一并清掉 in-flight，等待者经 clientFor 的实例身份检查走重建路径
  connecting.delete(key);
}

/** 释放全部 SSH 连接与计数（应用退出时调用） */
export function disposeAllRemoteFilesClients(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
  connecting.clear();
  leases.clear();
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
): Promise<DirectoryEntry[]> {
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

/** 测试用：清空全部模块级状态（进程级缓存的连接与计数） */
export function resetRemoteFilesClientsForTest(): void {
  disposeAllRemoteFilesClients();
}
