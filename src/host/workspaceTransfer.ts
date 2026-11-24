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
import { Readable, Transform, Writable } from 'node:stream';
import type { Readable as ReadableStream } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkViewFileIoPayload, WorkViewFileIoResult } from '../shared/AssistantEventBus.js';

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
  readStream(p: string): ReadableStream;
  writeStream(p: string): Writable;
  join(dir: string, name: string): string;
  dirname(p: string): string;
}

/** 传输统计（结果文本与 `crossWorkspaceTransferRequested` 结果载荷同形） */
export interface TransferCounts {
  files: number;
  bytes: number;
  skippedSymlinks: number;
  /**
   * 已搬运文件的展示路径（POSIX 分隔符）：相对被传输子树的根——目录传输是
   * `a.txt` / `sub/b.txt`，单文件传输是目标文件名。事实源是执行器本身，
   * 卡片只渲染，不自己去读目录（specs/042 FR-001 / FR-005）。
   */
  paths: string[];
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

/** 视图端点的单次读写块大小（specs/056 FR-003）：远小于代理 8 MiB 单帧上限 */
export const WORK_VIEW_IO_CHUNK = 1024 * 1024;

/**
 * 叠加视图端点（specs/056 FR-002 / FR-003）：把 `TransferEndpoint` 映射到
 * `UiRequest.workViewFileIoRequested`。
 *
 * 视图挂在 Core 的私有挂载命名空间里（`docs/core/conversation-work-view.md` 第 4 节），
 * 宿主读挂载点得到空目录，因此这里只发请求、不碰文件系统。路径一律是**工作区相对**的
 * `'/'` 分隔路径：`root` 是该端在发起会话工作区里的真实路径，本模块把它换算成相对路径，
 * 于是执行器的其余代码（递归、覆盖合并、暂存改名）继续按绝对路径工作，一行不改。
 *
 * `request` 由调用方注入（生产是 `requestWorkViewFileIo`，单测是同形桩）：本模块保持
 * 「纯逻辑、不 import 宿主 API」的既有性质。
 */
export function viewEndpoint(options: {
  /** 该端在发起会话工作区里的绝对根路径（真实路径，不是视图内部路径） */
  root: string;
  request: (payload: WorkViewFileIoPayload) => Promise<WorkViewFileIoResult>;
}): TransferEndpoint {
  const { root, request } = options;
  const posix = (p: string): string => p.replace(/\\/g, '/');
  const trimmedRoot = posix(root).replace(/\/+$/, '');

  /**
   * 真实路径 → 工作区相对路径（`''` = 根）。
   *
   * 越界一律抛错：叠加只覆盖工作区子树，工作区之外在视图里就是真实磁盘，静默放行会让
   * 传输读到视图之外的东西（specs/056 FR-004，`docs/architecture/principles.md` 铁律 4.1）。
   * Core 侧也会拒一次（`check_view_relative`），这里先拒是为了让错误在发起端就点名路径。
   */
  const relative = (p: string): string => {
    const full = posix(p);
    if (full === trimmedRoot) return '';
    const prefix = `${trimmedRoot}/`;
    if (!full.startsWith(prefix)) {
      throw new Error(`path is outside the conversation workspace: ${p}`);
    }
    return full.slice(prefix.length);
  };

  /** 发一条请求并把失败侧翻成异常（执行器靠异常收尾与清理暂存件） */
  const call = async <T extends WorkViewFileIoResult>(
    payload: Parameters<typeof request>[0],
  ): Promise<T> => {
    const result = await request(payload);
    if (!result.ok) throw new Error(result.error);
    return result as T;
  };

  return {
    // 视图端不自己判绝对路径：端点的语义是「一定在工作区内」，越界由 `relative` 拒
    isAbsolutePath: (p) => p.startsWith('/'),
    async stat(p) {
      const result = await request({ op: 'stat', path: relative(p) });
      if (!result.ok) throw new Error(result.error);
      if (!('exists' in result) || !result.exists) return null;
      return {
        kind: result.isDir ? 'directory' : 'file',
        symlink: result.isSymlink,
        size: result.size,
      };
    },
    async readdir(p) {
      const result = await request({ op: 'list', path: relative(p) });
      if (!result.ok) throw new Error(result.error);
      if (!('entries' in result)) {
        throw new Error(`view list returned an unexpected payload for ${p}`);
      }
      return result.entries.map((entry) => ({
        name: entry.name,
        // 代理的 listDir 单列 `isSymlink`，但契约只回 file / directory：符号链接在这里
        // 按「不是目录就是文件」处理，与 `fsEndpoint` 的 lstat 语义有差异——视图端不复制
        // 符号链接（既有非目标），因此这一项不会改变搬运结果
        kind: entry.kind,
      }));
    },
    async mkdirp(p) {
      await call({ op: 'mkdirAll', path: relative(p) });
    },
    async rename(from, to) {
      await call({ op: 'rename', path: relative(from), to: relative(to) });
    },
    async unlink(p) {
      await call({ op: 'unlink', path: relative(p) });
    },
    readStream(p) {
      const rel = relative(p);
      let offset = 0;
      let done = false;
      return new Readable({
        async read() {
          if (done) return;
          try {
            const result = await request({ op: 'read', path: rel, offset, length: WORK_VIEW_IO_CHUNK });
            if (!result.ok) throw new Error(result.error);
            if (!('bytes' in result)) {
              throw new Error(`view read returned an unexpected payload for ${p}`);
            }
            if (result.bytes.length > 0) {
              offset += result.bytes.length;
              this.push(Buffer.from(result.bytes));
            }
            if (result.eof || result.bytes.length === 0) {
              done = true;
              this.push(null);
            }
          } catch (error) {
            done = true;
            this.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    },
    writeStream(p) {
      const rel = relative(p);
      let offset = 0;
      return new Writable({
        async write(chunk: Buffer, _encoding, callback) {
          try {
            const result = await request({ op: 'write', path: rel, offset, bytes: [...chunk] });
            if (!result.ok) throw new Error(result.error);
            offset += chunk.length;
            callback();
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    },
    join: (dir, name) => `${dir.replace(/[\\/]+$/, '')}/${name}`,
    dirname: (p) => {
      const parts = p.split(/[\\/]/).filter((part) => part !== '');
      parts.pop();
      const base = p.startsWith('/') ? '/' : '';
      return base + parts.join('/');
    },
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
  const counts: TransferCounts = { files: 0, bytes: 0, skippedSymlinks: 0, paths: [] };

  const sourceStat = await source.stat(sourcePath);
  if (sourceStat === null) {
    throw new Error(`source path does not exist: ${sourcePath}`);
  }
  if (sourceStat.symlink) {
    // 根就是符号链接：不跟随、不复制，如实计入跳过数（FR-003）
    return { files: 0, bytes: 0, skippedSymlinks: 1, paths: [] };
  }

  const destStat = await dest.stat(destPath);
  if (sourceStat.kind === 'file') {
    if (destStat?.kind === 'directory') {
      throw new TransferTypeConflictError(sourcePath, destPath, 'file', 'directory');
    }
    if (destStat === null) {
      await dest.mkdirp(dest.dirname(destPath));
    }
    await copyFile(source, sourcePath, dest, destPath, signal, counts, baseName(destPath));
    return counts;
  }

  if (destStat?.kind === 'file') {
    throw new TransferTypeConflictError(sourcePath, destPath, 'directory', 'file');
  }
  await copyDirectory(source, sourcePath, dest, destPath, signal, counts, '');
  return counts;
}

/** 去掉目录部分后的文件名（端点抽象没有 basename，本地 / 远程两种分隔符都要认） */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

/** 逐文件流式搬运 + 暂存改名；字节数按实际流过量计（跨端 stat 尺寸不可靠） */
async function copyFile(
  source: TransferEndpoint,
  sourcePath: string,
  dest: TransferEndpoint,
  destPath: string,
  signal: AbortSignal,
  counts: TransferCounts,
  /** 相对**被传输子树的根**的展示路径（POSIX 分隔符，跨端一致） */
  relPath: string,
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
  counts.paths.push(relPath);
}

/** 目录递归：同名目录合并、同名文件覆盖、符号链接跳过、多余项不删除 */
async function copyDirectory(
  source: TransferEndpoint,
  sourcePath: string,
  dest: TransferEndpoint,
  destPath: string,
  signal: AbortSignal,
  counts: TransferCounts,
  /** 当前目录相对**传输子树根**的展示路径（空串 = 子树根本身） */
  relPrefix: string,
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
    const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      const childDestStat = await dest.stat(childDest);
      if (childDestStat?.kind === 'directory') {
        throw new TransferTypeConflictError(childSource, childDest, 'file', 'directory');
      }
      await copyFile(source, childSource, dest, childDest, signal, counts, childRel);
      continue;
    }
    const childDestStat = await dest.stat(childDest);
    if (childDestStat?.kind === 'file') {
      throw new TransferTypeConflictError(childSource, childDest, 'directory', 'file');
    }
    await copyDirectory(source, childSource, dest, childDest, signal, counts, childRel);
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
