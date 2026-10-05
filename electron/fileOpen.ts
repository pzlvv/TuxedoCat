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
import { classifyFileForOpen, imageMimeFor, REMOTE_BINARY_UNSUPPORTED } from './fileTypes.js';

export { classifyFileForOpen, imageMimeFor, REMOTE_BINARY_UNSUPPORTED } from './fileTypes.js';
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

/** 宿主能力注入口：窗口打开与系统调用都由 main.ts 提供（本模块不 import electron） */
export interface FileOpenBridge {
  /** 内置 Markdown 预览窗口（渲染后的只读 HTML，`src/host/markdownHtml.ts` 生成） */
  openMarkdownViewer(init: { title: string; content: string }): void | Promise<void>;
  /** 内置图片查看器（滚轮缩放；US-38 图片预览窗口） */
  openImageViewer(init: { title: string; dataUrl: string }): void | Promise<void>;
  /** 内置文本查看器（Monaco view 模式；filePath 只用于语言推断，不读盘） */
  openTextViewer(init: { title: string; content: string; filePath?: string }): void | Promise<void>;
  /** 本地文件走既有 openFile 路径（Monaco 主进程读盘，与「Edit 预览」完全同一入口） */
  openLocalFile(filePath: string): void | Promise<void>;
  /** 调系统默认应用打开本地文件；失败时 reject（错误消息来自 shell.openPath 回串） */
  openWithSystemApp(filePath: string): Promise<void>;
}

/** 远端文件读取原语（`electron/sidebarFilesRemote.ts` 提供，SFTP 实现） */
export interface RemoteFileReader {
  readHead(absPath: string, maxBytes: number): Promise<Buffer>;
  readBytes(absPath: string): Promise<Buffer>;
  readText(absPath: string): Promise<string>;
}

/** 本地工作区双击打开：rel 是 '/' 分隔相对路径（约定格式，见 sidebarFiles.ts） */
export async function openLocalWorkspaceFile(
  bridge: FileOpenBridge,
  root: string,
  rel: string,
): Promise<void> {
  // 越界（.. 上跳 / 绝对路径）拒绝：与列目录 / 删除同一份校验实现
  const abs = resolveWithinRoot(root, rel);
  if (!abs) throw new Error(`path escapes the workspace root: ${rel}`);
  const kind = classifyFileForOpen(path.posix.basename(rel));
  if (kind === 'image') {
    const bytes = await fs.promises.readFile(abs);
    await bridge.openImageViewer({
      title: path.posix.basename(rel),
      dataUrl: `data:${imageMimeFor(rel)};base64,${bytes.toString('base64')}`,
    });
    return;
  }
  if (kind === 'markdown') {
    await bridge.openMarkdownViewer({
      title: path.posix.basename(rel),
      content: await fs.promises.readFile(abs, 'utf-8'),
    });
    return;
  }
  if (kind === 'text') {
    await bridge.openLocalFile(abs);
    return;
  }
  // 未知扩展名：嗅探前 8KB，判成文本才进内置查看器；二进制（压缩包 / 可执行等）调系统应用
  const head = await readFileHead(abs, SNIFF_BYTES);
  if (await bytesLookBinary(head)) {
    await bridge.openWithSystemApp(abs);
    return;
  }
  await bridge.openLocalFile(abs);
}

/** 远程（SSH）工作区双击打开：文本 / Markdown / 图片经 SFTP 读出进内置窗口；二进制不支持打开 */
export async function openRemoteWorkspaceFile(
  bridge: FileOpenBridge,
  reader: RemoteFileReader,
  root: string,
  rel: string,
): Promise<void> {
  const abs = resolveWithinRoot(root, rel, { posix: true });
  if (!abs) throw new Error(`path escapes the workspace root: ${rel}`);
  const name = path.posix.basename(rel);
  const kind = classifyFileForOpen(name);
  if (kind === 'binary') {
    throw new Error(REMOTE_BINARY_UNSUPPORTED);
  }
  if (kind === 'image') {
    const bytes = await reader.readBytes(abs);
    await bridge.openImageViewer({
      title: name,
      dataUrl: `data:${imageMimeFor(rel)};base64,${bytes.toString('base64')}`,
    });
    return;
  }
  if (kind === 'markdown') {
    await bridge.openMarkdownViewer({ title: name, content: await reader.readText(abs) });
    return;
  }
  if (kind === 'text') {
    await bridge.openTextViewer({ title: name, content: await reader.readText(abs), filePath: name });
    return;
  }
  // 未知扩展名：嗅探前 8KB 判二进制；远程二进制不支持打开（本地才调系统应用）
  const head = await reader.readHead(abs, SNIFF_BYTES);
  if (await bytesLookBinary(head)) {
    throw new Error(REMOTE_BINARY_UNSUPPORTED);
  }
  await bridge.openTextViewer({ title: name, content: await reader.readText(abs), filePath: name });
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
