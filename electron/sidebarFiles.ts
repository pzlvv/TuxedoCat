/**
 * 侧栏文件浏览器的宿主侧路径 / 读盘逻辑（Electron 专属，US-42 / US-43）。
 *
 * 刻意不 import electron：剪贴板（clipboard）、资源管理器定位（shell）、
 * 回收站（shell.trashItem）与删除确认框都在 `electron/main.ts` 的 IPC 处理器里做，
 * 本模块只提供「路径校验 + 目录读取 + 路径格式化」这些纯 fs 逻辑，可在单测中直接使用。
 *
 * 安全面（DEVELOPMENT.md 第 12.1 节：接线缺失直接报错，不静默降级）：
 * - 渲染层传来的 `rel` 是「'/' 分隔的相对路径」这一约定格式（Windows 上 path API
 *   同样接受 '/'，无需翻译分隔符）；所有操作先经 `resolveWithinRoot` 解析，
 *   越界（`..` 上跳、绝对路径、指向根目录本身）一律返回 null，调用方整单拒绝。
 * - root 由调用方按「打开集合中的本地工作区」解析成规范化路径后再传入，
 *   渲染层原样回传的字符串不可信。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 目录项（侧栏文件树的一行）：kind 决定图标与可展开性 */
export interface SidebarFileEntry {
  name: string;
  kind: 'file' | 'directory';
}

/**
 * 把 '/' 分隔的相对路径解析到 root 内的绝对路径。
 *
 * - `rel === ''` 表示根目录本身：只有列目录（allowRoot）允许，删除 / 定位 /
 *   复制等「作用到条目」的操作没有根目录这一行，传 true 是调用方的 bug。
 * - 判越界用 `path.relative` 的回跳结果而不是前缀比较：后者在 Windows 上会被
 *   盘符大小写（`C:\` vs `c:\`）与尾分隔符差异绕过，前者是路径包含关系的标准判定。
 * - `posix: true` 用于远程（SSH）工作区：root 是远端机器上的 POSIX 绝对路径，
 *   按 win32 语义解析会把 `/home/pz` 变成 `D:\home\pz`（远程路径必须原样保留，
 *   与 `electron/main.ts` 的 canonicalWorkspacePath 同一结论）。
 */
export function resolveWithinRoot(
  root: string,
  rel: string,
  options: { allowRoot?: boolean; posix?: boolean } = {},
): string | null {
  if (typeof root !== 'string' || root.length === 0) return null;
  if (typeof rel !== 'string') return null;
  const p = options.posix ? path.posix : path;
  const abs = p.resolve(root, rel);
  const back = p.relative(root, abs);
  // back === '' → rel 指向 root 自身；'..' 开头或绝对路径 → 落在 root 之外
  if (back === '') return options.allowRoot ? abs : null;
  if (back.startsWith('..') || p.isAbsolute(back)) return null;
  return abs;
}

/** 排序用的比较器：目录在前，名称按本地语言、数字感知（file2 < file10）、不区分大小写 */
const entryCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function compareEntries(a: SidebarFileEntry, b: SidebarFileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return entryCollator.compare(a.name, b.name);
}

/**
 * 读取目录内容并排序（目录在前、名称升序）。
 *
 * - 符号链接按 `withFileTypes` 拿到的是链接本身，分类需要 stat 跟随目标；
 *   断链（目标已不存在）无法归类，跳过该条目。
 * - 读盘失败（ENOENT / EACCES 等）原样抛给调用方：由 IPC 层转成
 *   `{ ok: false, error }` 回给渲染层显示，不做静默空列表。
 */
export async function listDirectory(absDir: string): Promise<SidebarFileEntry[]> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const entries: SidebarFileEntry[] = [];
  for (const d of dirents) {
    if (d.isSymbolicLink()) {
      try {
        const target = await fs.promises.stat(path.join(absDir, d.name));
        entries.push({ name: d.name, kind: target.isDirectory() ? 'directory' : 'file' });
      } catch {
        // 断链：无法分类的条目不进树（渲染层没有「未知类型」的图标位）
      }
      continue;
    }
    entries.push({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' });
  }
  return entries.sort(compareEntries);
}

/** rel 数组 → root 内的绝对路径数组（原生分隔符）；任一项越界即整单返回 null */
export function resolveAllWithinRoot(
  root: string,
  rels: readonly string[],
  options: { allowRoot?: boolean; posix?: boolean } = {},
): string[] | null {
  const out: string[] = [];
  for (const rel of rels) {
    const abs = resolveWithinRoot(root, rel, options);
    if (abs === null) return null;
    out.push(abs);
  }
  return out;
}

/** 排序入口：本地与远程目录列表共用同一份「目录优先 + 名称排序」（唯一一份派生逻辑） */
export function sortSidebarEntries(entries: SidebarFileEntry[]): SidebarFileEntry[] {
  return entries.sort(compareEntries);
}

/**
 * rel 数组 → 相对路径数组（原生分隔符）。
 *
 * 输入是约定格式（'/' 分隔），输出用 `path` 的平台分隔符：复制的相对路径要能在
 * 本机工具链（shell / 资源管理器地址栏）里直接粘贴使用，与「复制完整路径」同一口径。
 */
export function formatRelativePaths(root: string, rels: readonly string[]): string[] {
  return rels.map((rel) => path.relative(root, path.resolve(root, rel)));
}
