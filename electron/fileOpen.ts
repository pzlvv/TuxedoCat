/**
 * 侧栏文件浏览器「双击打开」的宿主侧编排（US-42）。
 *
 * 打开方式按文件类型分流（类型判定与侧栏图标共用同一份扩展名集合，
 * 根在 `electron/fileTypes.ts`）：
 * - Markdown（.md / .markdown）→ 内置 Markdown 预览窗口（渲染后的只读 HTML，
 *   本地 / 远程同样支持，US-42 验收 6）；
 * - 文本（代码 / 配置 / 文本，以及嗅探不出二进制的未知扩展名）→ 内置文本查看器
 *   （Monaco 窗口，与工具卡片点「Edit」预览同一窗口、同一效果）；
 * - 图片 → 内置图片查看器（滚轮缩放，US-38 图片预览窗口的新实现）；
 * - 其它（压缩包 / 可执行文件 / 嗅探出二进制的未知类型）→ 调系统默认应用打开。
 *
 * 本模块刻意不 import electron：`shell.openPath` 与窗口打开由调用方（main.ts）
 * 经 `FileOpenBridge` 注入，纯逻辑部分（分流 / 临时落盘）可在单测中直接使用。
 * 与 `electron/sidebarFiles.ts` 的分工：那边是「列目录 / 删除」的纯 fs 逻辑，
 * 这边是「读单个文件并决定怎么打开」的编排。
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from './sidebarFiles.js';
import {
  classifyFileForOpen,
  imageMimeFor,
  OVERLAY_BINARY_UNSUPPORTED,
  REMOTE_BINARY_UNSUPPORTED,
} from './fileTypes.js';
import type { ViewerWatchTarget } from './viewerWatch.js';
import type { WorkspaceEndpoint } from '../src/host/workspaceRef.js';

export {
  classifyFileForOpen,
  imageMimeFor,
  OVERLAY_BINARY_UNSUPPORTED,
  REMOTE_BINARY_UNSUPPORTED,
} from './fileTypes.js';
export type { FileOpenKind } from './fileTypes.js';

/** 嗅探窗口：未知扩展名只读前 8KB 判二进制（isbinaryfile 与 core Read 工具同一实现） */
const SNIFF_BYTES = 8192;

/** 字节流是否二进制（UTF-16 文本含 NUL 字节也会判二进制：交给系统应用更合适） */
export async function bytesLookBinary(bytes: Buffer): Promise<boolean> {
  if (bytes.length === 0) return false;
  // isbinaryfile 是 ESM-only，Node16 解析下只能动态 import（与 core Read 工具同一用法）
  const { isBinaryFile } = await import('isbinaryfile');
  return isBinaryFile(bytes, { size: bytes.length });
}

// ── 打开编排 ──

/**
 * 打开来源（specs/040 FR-003）：决定查看器先落在全文还是变更视图。
 *
 * - `tree`：目录树 / 文档视图双击（用户在看文件清单，想看内容）；
 * - `changes`：「全部变更」视图双击（用户本就在看变更，想看差异）；
 * - `toolLink`：工具卡片里的文件链接（同理，来意是看这次改动）。
 */
export type OpenSource = 'tree' | 'changes' | 'toolLink';

/** 打开后的初始视图（specs/040 FR-003 的映射表） */
export type InitialView = 'full' | 'changes';

/**
 * 来源 + 文件是否新增 → 初始视图（specs/040 FR-003）。
 *
 * 判定「新增」的判据由调用方按 git 口径给出（未跟踪 / 无 HEAD 版本）：新增文件没有
 * 可对比的旧版本，任何来源都落全文。纯函数，单测直接驱动。
 */
export function resolveInitialView(source: OpenSource, isNewFile: boolean): InitialView {
  if (source === 'tree') return 'full';
  return isNewFile ? 'full' : 'changes';
}

/** 宿主能力注入口：窗口打开与系统调用都由 main.ts 提供（本模块不 import electron） */
export interface FileOpenBridge {
  /** 内置 Markdown 预览窗口（渲染后的只读 HTML，`src/host/markdownHtml.ts` 生成） */
  openMarkdownViewer(init: {
    title: string;
    content: string;
    watchTarget: ViewerWatchTarget | null;
    /** 初始视图（specs/040 FR-003 / AC-8）：`full` 落渲染，`changes` 落变更视图 */
    initialView: InitialView;
    /** 变更视图的取数来源（`changes` 时用）：工作区根 + 相对路径 */
    diffSource: DiffSource | null;
  }): void | Promise<void>;
  /** 内置图片查看器（滚轮缩放；US-38 图片预览窗口） */
  openImageViewer(init: {
    title: string;
    dataUrl: string;
    watchTarget: ViewerWatchTarget | null;
  }): void | Promise<void>;
  /** 内置文本查看器（Monaco；filePath 只用于语言推断，不读盘） */
  openTextViewer(init: {
    title: string;
    content?: string;
    filePath?: string;
    watchTarget: ViewerWatchTarget | null;
    /** 初始视图（specs/040 FR-003 / AC-1 / AC-5 ～ AC-7） */
    initialView: InitialView;
    /** 变更视图的取数来源（`changes` 时用） */
    diffSource: DiffSource | null;
  }): void | Promise<void>;
  /** 本地文件走既有 openFile 路径（Monaco 主进程读盘，与「Edit 预览」完全同一入口） */
  openLocalFile(filePath: string): void | Promise<void>;
  /** 调系统默认应用打开本地文件；失败时 reject（错误消息来自 shell.openPath 回串） */
  openWithSystemApp(filePath: string): Promise<void>;
}

/**
 * 变更视图的取数来源（specs/040 FR-001）：主进程按 root + rel 跑 `git show HEAD:<rel>`
 * 与读盘，页面只渲染两侧原文。`null` = 没有 git 上下文（虚拟文档 / 非 git 工作区）。
 */
export interface DiffSource {
  root: string;
  rel: string;
}

/** 远端文件读取原语（`electron/sidebarFilesRemote.ts` 提供，SFTP 实现） */
export interface RemoteFileReader {
  readHead(absPath: string, maxBytes: number): Promise<Buffer>;
  readBytes(absPath: string): Promise<Buffer>;
  readText(absPath: string): Promise<string>;
}

/**
 * Overlay 对话的文件读取原语（specs/044 FR-003）。
 *
 * 由调用方（`electron/main.ts`）注入：内容经 Core 的 `UiRequest.workViewFileReadRequested`
 * 取，宿主读不到 Core 私有挂载命名空间里的视图。`rel` 是 '/' 分隔的相对路径。
 */
export interface WorkViewReader {
  sessionId: string;
  readText(rel: string): Promise<string>;
}


/**
 * 打开前的 git 上下文（specs/040 FR-003 / FR-004）：判定「是否新增」与「能否显示变更」。
 *
 * `inGit` 为假（非 git 工作区）时下游不给 `diffSource`，查看器的变更按钮置灰（AC-9）；
 * `hasHeadVersion` 只在 `inGit` 为真时有意义——非 git 里没有 HEAD 这个概念。
 * 调用方（`main.ts`）按本地 / 远程各用一份 `FileContentRunner` 提供，判定只做一次。
 */
export type GitFileContext = (rel: string) => Promise<{ inGit: boolean; hasHeadVersion: boolean }>;

/** 本地工作区双击打开：rel 是 '/' 分隔相对路径（约定格式，见 sidebarFiles.ts）。
 *
 * `source` 决定初始视图（specs/040 FR-003）：需要 `changes` 时先查 `hasHeadVersion`，
 * 新增文件落全文（没有可对比的旧版本）。 */
export async function openLocalWorkspaceFile(
  bridge: FileOpenBridge,
  root: string,
  rel: string,
  source: OpenSource,
  gitContext: GitFileContext,
): Promise<void> {
  // 越界（.. 上跳 / 绝对路径）拒绝：与列目录 / 删除同一份校验实现
  const abs = resolveWithinRoot(root, rel);
  if (!abs) throw new Error(`path escapes the workspace root: ${rel}`);
  const kind = classifyFileForOpen(path.posix.basename(rel));
  const textual = kind === 'text' || kind === 'markdown' || kind === 'sniff';
  const git = textual ? await gitContext(rel) : { inGit: false, hasHeadVersion: false };
  const initialView = resolveInitialView(source, textual ? !git.hasHeadVersion : false);
  // 非 git 工作区没有可对比的 HEAD（AC-9）：不传 diffSource，按钮在页面里置灰
  const diffSource: DiffSource | null = git.inGit ? { root, rel } : null;
  if (kind === 'image') {
    const bytes = await fs.promises.readFile(abs);
    await bridge.openImageViewer({
      title: path.posix.basename(rel),
      dataUrl: `data:${imageMimeFor(rel)};base64,${bytes.toString('base64')}`,
      watchTarget: { kind: 'local', filePath: abs },
    });
    return;
  }
  if (kind === 'markdown') {
    await bridge.openMarkdownViewer({
      title: path.posix.basename(rel),
      content: await fs.promises.readFile(abs, 'utf-8'),
      watchTarget: { kind: 'local', filePath: abs },
      initialView,
      diffSource,
    });
    return;
  }
  if (kind === 'text') {
    await bridge.openTextViewer({
      filePath: abs,
      title: path.posix.basename(rel),
      watchTarget: { kind: 'local', filePath: abs },
      initialView,
      diffSource,
    });
    return;
  }
  // 未知扩展名：嗅探前 8KB，判成文本才进内置查看器；二进制（压缩包 / 可执行等）调系统应用
  const head = await readFileHead(abs, SNIFF_BYTES);
  if (await bytesLookBinary(head)) {
    await bridge.openWithSystemApp(abs);
    return;
  }
  await bridge.openTextViewer({
    filePath: abs,
    title: path.posix.basename(rel),
    watchTarget: { kind: 'local', filePath: abs },
    initialView,
    diffSource,
  });
}

/** 远程（SSH）工作区双击打开：文本 / Markdown / 图片经 SFTP 读出进内置窗口；二进制不支持打开 */
export async function openRemoteWorkspaceFile(
  bridge: FileOpenBridge,
  reader: RemoteFileReader,
  endpoint: WorkspaceEndpoint,
  root: string,
  rel: string,
  source: OpenSource,
  gitContext: GitFileContext,
): Promise<void> {
  const abs = resolveWithinRoot(root, rel, { posix: true });
  if (!abs) throw new Error(`path escapes the workspace root: ${rel}`);
  const name = path.posix.basename(rel);
  const kind = classifyFileForOpen(name);
  const watchTarget: ViewerWatchTarget = {
    kind: 'remote',
    endpoint,
    workspacePath: root,
    absPath: abs,
  };
  if (kind === 'binary') {
    throw new Error(REMOTE_BINARY_UNSUPPORTED);
  }
  // 变更视图同样支持远程（specs/040 FR-004 最后一句）：diffSource 只带 root + rel，
  // 主进程按 endpoint 选 SSH exec 的 runner，页面拿到的仍是两侧原文
  const textual = kind === 'text' || kind === 'markdown' || kind === 'sniff';
  const git = textual ? await gitContext(rel) : { inGit: false, hasHeadVersion: false };
  const initialView = resolveInitialView(source, textual ? !git.hasHeadVersion : false);
  const diffSource: DiffSource | null = git.inGit ? { root, rel } : null;
  if (kind === 'image') {
    const bytes = await reader.readBytes(abs);
    await bridge.openImageViewer({
      title: name,
      dataUrl: `data:${imageMimeFor(rel)};base64,${bytes.toString('base64')}`,
      watchTarget,
    });
    return;
  }
  if (kind === 'markdown') {
    await bridge.openMarkdownViewer({
      title: name,
      content: await reader.readText(abs),
      watchTarget,
      initialView,
      diffSource: diffSource,
    });
    return;
  }
  if (kind === 'text') {
    await bridge.openTextViewer({
      title: name,
      content: await reader.readText(abs),
      filePath: name,
      watchTarget,
      initialView,
      diffSource: diffSource,
    });
    return;
  }
  // 未知扩展名：嗅探前 8KB 判二进制；远程二进制不支持打开（本地才调系统应用）
  const head = await reader.readHead(abs, SNIFF_BYTES);
  if (await bytesLookBinary(head)) {
    throw new Error(REMOTE_BINARY_UNSUPPORTED);
  }
  await bridge.openTextViewer({
    title: name,
    content: await reader.readText(abs),
    filePath: name,
    watchTarget,
    initialView,
    diffSource: diffSource,
  });
}

/** 读本地文件前 maxBytes 字节（不足读全量） */
async function readFileHead(abs: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.promises.open(abs, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Overlay 对话里的文件打开（specs/044 FR-003）。
 *
 * 内容经 Core 读视图路径（`WorkViewReader.readText`），宿主不读盘——视图挂在 Core 私有
 * 的挂载命名空间里，宿主读不到。编辑器标签仍以**真实工作区路径**标识，与工具输出的
 * 口径一致（`docs/core/conversation-work-view.md` 第 5 节）。
 *
 * 只支持文本与 Markdown：图片与二进制需要真实文件路径（系统应用打不开视图里的路径），
 * Overlay 对话里明确不支持，回错误而不是打开磁盘上的旧内容。
 *
 * 变更视图（`diffSource`）在 Overlay 对话里不提供：git 的 HEAD 是磁盘事实，与视图内容
 * 对比会产生「视图 vs 磁盘」的伪差异。`initialView` 因此恒为 `full`。
 */
export async function openOverlayWorkspaceFile(
  bridge: FileOpenBridge,
  reader: WorkViewReader,
  root: string,
  rel: string,
  source: OpenSource,
): Promise<void> {
  // 越界校验与本地路径同一份实现：真实工作区路径的包含关系对视图同样成立
  const abs = resolveWithinRoot(root, rel);
  if (!abs) throw new Error(`path escapes the workspace root: ${rel}`);
  const name = path.posix.basename(rel);
  const kind = classifyFileForOpen(name);
  if (kind === 'image' || kind === 'binary') {
    throw new Error(OVERLAY_BINARY_UNSUPPORTED);
  }
  const content = await reader.readText(rel);
  // 初始视图恒为全文：Overlay 对话里没有可对比的磁盘版本（见函数注释）
  const initialView: InitialView = source === 'changes' ? 'full' : 'full';
  if (kind === 'markdown') {
    await bridge.openMarkdownViewer({
      title: name,
      content,
      watchTarget: null,
      initialView,
      diffSource: null,
    });
    return;
  }
  // text 与 sniff 都进文本查看器：嗅探判二进制的活需要真实字节流，视图里不提供
  // （`classifyFileForOpen` 对未知扩展名回 sniff，此处按文本处理——Core 侧
  // `read_to_string` 对非 UTF-8 会报错，错误如实上抛）
  await bridge.openTextViewer({
    title: name,
    content,
    filePath: name,
    watchTarget: null,
    initialView,
    diffSource: null,
  });
}
