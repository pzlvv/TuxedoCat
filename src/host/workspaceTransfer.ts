/**
 * 跨工作区文件传输的执行器（specs/028 FR-003）。
 *
 * 纯逻辑、无宿主 API：本地端用 node:fs，远程端的 SFTP 适配器由
 * `sshClient.ts` 的 `transferEndpoint()` 提供（ssh2 类型不进本模块）。
 * 语义：递归整棵复制（含点文件、无排除）、同名文件覆盖、同名目录合并、
 * 不删除目标端多余项；逐文件「暂存名 + 改名」落盘，中止 / 失败不产生半写文件；
 * 符号链接不跟随、不复制，计入跳过数。SSH↔SSH 由调用方各建一个端点、
 * 本引擎逐文件流式中继（`pipeline` 背压搬运），不经第三台机器。
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 目录项（readdir 的原始形态：符号链接不跟随、单列一类） */
export interface TransferDirEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
}

/** 端点上的路径信息；`null` = 不存在。lstat 语义（符号链接本身是 symlink） */
export interface TransferStat {
  kind: 'file' | 'directory';
  symlink: boolean;
  size: number;
}

/**
 * 传输端点：本地 fs 与远程 SFTP 的最小面。
 * `rename` 提供覆盖语义（失败时先 unlink 目标再试一次——SFTP 的
 * SSH_FXP_RENAME 在部分服务端对已存在目标报错，Node 的 rename 在
 * Windows 上也有历史差异）。
 */
export interface TransferEndpoint {
  isAbsolutePath(p: string): boolean;
  stat(p: string): Promise<TransferStat | null>;
  readdir(p: string): Promise<TransferDirEntry[]>;
  mkdirp(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  readStream(p: string): Readable;
  writeStream(p: string): Writable;
  join(dir: string, name: string): string;
  dirname(p: string): string;
}

/** 传输统计（结果文本与 `crossWorkspaceTransferRequested` 结果载荷同形） */
export interface TransferCounts {
  files: number;
  bytes: number;
  skippedSymlinks: number;
}

/** 逐文件落盘的暂存名后缀：完成搬运后 rename 到目标，中止 / 失败不残留半写文件 */
const TEMP_SUFFIX = '.tuxedo-transfer-tmp';

/** 类型冲突（源是目录而目标已存在同名文件、或反之） */
export class TransferTypeConflictError extends Error {
  constructor(sourcePath: string, destPath: string, sourceKind: string, destKind: string) {
    super(
      `transfer type conflict: "${sourcePath}" is a ${sourceKind} but "${destPath}" already exists as a ${destKind}`,
    );
  }
}

/** 本地端点（宿主平台语义的 fs / path） */
export function fsEndpoint(): TransferEndpoint {
  return {
    isAbsolutePath: (p) => path.isAbsolute(p),
    async stat(p) {
      const stats = await fsp.lstat(p).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      });
      if (!stats) return null;
      return {
        kind: stats.isDirectory() ? 'directory' : 'file',
        symlink: stats.isSymbolicLink(),
        size: stats.size,
      };
    },
    async readdir(p) {
      const names = await fsp.readdir(p);
      const entries: TransferDirEntry[] = [];
      for (const name of names) {
        const child = await fsp.lstat(path.join(p, name));
        entries.push({
          name,
          kind: child.isSymbolicLink()
            ? 'symlink'
            : child.isDirectory()
              ? 'directory'
              : 'file',
        });
      }
      return entries;
    },
    async mkdirp(p) {
      await fsp.mkdir(p, { recursive: true });
    },
    async rename(from, to) {
      try {
        await fsp.rename(from, to);
      } catch {
        await fsp.unlink(to).catch(() => undefined);
        await fsp.rename(from, to);
      }
    },
    async unlink(p) {
      await fsp.unlink(p);
    },
    readStream: (p) => createReadStream(p),
    writeStream: (p) => createWriteStream(p),
    join: (dir, name) => path.join(dir, name),
    dirname: (p) => path.dirname(p),
  };
}

/** 单端或双端传输的执行入口（守卫已由调用方完成，这里只搬运） */
export async function runTransfer(options: {
  source: TransferEndpoint;
  sourcePath: string;
  dest: TransferEndpoint;
  destPath: string;
  signal: AbortSignal;
}): Promise<TransferCounts> {
  const { source, sourcePath, dest, destPath, signal } = options;
  const counts: TransferCounts = { files: 0, bytes: 0, skippedSymlinks: 0 };

  const sourceStat = await source.stat(sourcePath);
  if (sourceStat === null) {
    throw new Error(`source path does not exist: ${sourcePath}`);
  }
  if (sourceStat.symlink) {
    // 根就是符号链接：不跟随、不复制，如实计入跳过数（FR-003）
    return { files: 0, bytes: 0, skippedSymlinks: 1 };
  }

  const destStat = await dest.stat(destPath);
  if (sourceStat.kind === 'file') {
    if (destStat?.kind === 'directory') {
      throw new TransferTypeConflictError(sourcePath, destPath, 'file', 'directory');
    }
    if (destStat === null) {
      await dest.mkdirp(dest.dirname(destPath));
    }
    await copyFile(source, sourcePath, dest, destPath, signal, counts);
    return counts;
  }

  if (destStat?.kind === 'file') {
    throw new TransferTypeConflictError(sourcePath, destPath, 'directory', 'file');
  }
  await copyDirectory(source, sourcePath, dest, destPath, signal, counts);
  return counts;
}

/** 逐文件流式搬运 + 暂存改名；字节数按实际流过量计（跨端 stat 尺寸不可靠） */
async function copyFile(
  source: TransferEndpoint,
  sourcePath: string,
  dest: TransferEndpoint,
  destPath: string,
  signal: AbortSignal,
  counts: TransferCounts,
): Promise<void> {
  signal.throwIfAborted();
  const tempPath = `${destPath}${TEMP_SUFFIX}`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source.readStream(sourcePath), counter, dest.writeStream(tempPath));
    await dest.rename(tempPath, destPath);
  } catch (error) {
    // 半写的暂存文件不留在目标端（rename 之前失败即此形态）
    await dest.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  counts.files += 1;
  counts.bytes += bytes;
}

/** 目录递归：同名目录合并、同名文件覆盖、符号链接跳过、多余项不删除 */
async function copyDirectory(
  source: TransferEndpoint,
  sourcePath: string,
  dest: TransferEndpoint,
  destPath: string,
  signal: AbortSignal,
  counts: TransferCounts,
): Promise<void> {
  signal.throwIfAborted();
  await dest.mkdirp(destPath);
  for (const entry of await source.readdir(sourcePath)) {
    if (entry.kind === 'symlink') {
      counts.skippedSymlinks += 1;
      continue;
    }
    const childSource = source.join(sourcePath, entry.name);
    const childDest = dest.join(destPath, entry.name);
    if (entry.kind === 'file') {
      const childDestStat = await dest.stat(childDest);
      if (childDestStat?.kind === 'directory') {
        throw new TransferTypeConflictError(childSource, childDest, 'file', 'directory');
      }
      await copyFile(source, childSource, dest, childDest, signal, counts);
      continue;
    }
    const childDestStat = await dest.stat(childDest);
    if (childDestStat?.kind === 'file') {
      throw new TransferTypeConflictError(childSource, childDest, 'directory', 'file');
    }
    await copyDirectory(source, childSource, dest, childDest, signal, counts);
  }
}

// ===================== 会话取消注册表（specs/028 FR-007）=====================

/** sessionId → 进行中传输的 AbortController 集合 */
const activeControllers = new Map<string, Set<AbortController>>();

/** 按会话执行传输：注册取消句柄，收尾时注销 */
export async function runSessionTransfer(options: {
  sessionId: string;
  source: TransferEndpoint;
  sourcePath: string;
  dest: TransferEndpoint;
  destPath: string;
}): Promise<TransferCounts> {
  const controller = new AbortController();
  let registry = activeControllers.get(options.sessionId);
  if (!registry) {
    registry = new Set();
    activeControllers.set(options.sessionId, registry);
  }
  registry.add(controller);
  try {
    return await runTransfer({ ...options, signal: controller.signal });
  } finally {
    registry.delete(controller);
    if (registry.size === 0) activeControllers.delete(options.sessionId);
  }
}

/** 取消该会话全部进行中的传输（abort 经宿主中转时调用，FR-007） */
export function cancelTransfersForSession(sessionId: string): void {
  const registry = activeControllers.get(sessionId);
  if (!registry) return;
  for (const controller of registry) controller.abort();
}
