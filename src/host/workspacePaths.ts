/**
 * 工作目录路径工具（宿主侧，纯函数 + 一个规范化缓存）。
 *
 * 「同一目录的不同表示」在真实使用里很常见：尾部分隔符、相对路径、`/` 与 `\` 混用、
 * Windows 盘符大小写、符号链接 / 目录联接、Windows 8.3 短名。打开集合与最近工作目录
 * 都按「去重键」判等，避免同一个目录出现两张标签页 / 两条最近记录。
 *
 * 不依赖 electron：可在单测里直接使用。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 规范化工作目录路径（解析相对路径、去掉尾部分隔符、统一分隔符） */
export function normalizeWorkspacePath(p: string): string {
  return path.resolve(p);
}

/** 原始路径 → 去重键 的缓存（realpath 是文件系统调用，避免重复） */
const workspaceKeyCache = new Map<string, string>();
/**
 * 缓存上限：键是调用方传入的原始字符串（同一目录的不同写法各占一条），
 * 长时间运行 + 频繁切换目录时无上限会缓慢增长。超过上限整体清空即可 ——
 * 缓存只影响性能，清空后重算结果不变。
 */
const WORKSPACE_KEY_CACHE_LIMIT = 1000;

/** 去掉 Windows 长路径前缀（`\\?\` / `\\?\UNC\`） */
function stripLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

/**
 * 工作目录的去重键：同一目录的不同表示归一到同一个键。
 *
 * 先 `path.resolve`，再解析符号链接 / 目录联接与文件系统的规范名
 * （目录不存在或不可访问时退回 `path.resolve` 的结果），
 * 最后在 Windows 上按大小写不敏感归一。
 */
export function workspaceKey(p: string): string {
  const cached = workspaceKeyCache.get(p);
  if (cached !== undefined) return cached;
  let resolved = path.resolve(p);
  try {
    resolved = stripLongPathPrefix(fs.realpathSync.native(resolved));
  } catch {
    // 目录不存在 / 无权限：退回 path.resolve 的结果
  }
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (workspaceKeyCache.size >= WORKSPACE_KEY_CACHE_LIMIT) {
    workspaceKeyCache.clear();
  }
  workspaceKeyCache.set(p, key);
  return key;
}

/** 两个路径是否指向同一个工作目录 */
export function sameWorkspace(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return workspaceKey(a) === workspaceKey(b);
}

/**
 * 规范化 + 去重（按去重键），保持输入顺序。
 * 不存在的目录由调用方先过滤（本函数只做路径归一，不访问磁盘判断存在性）。
 */
export function dedupeWorkspacePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim().length === 0) continue;
    const normalized = normalizeWorkspacePath(p);
    const key = workspaceKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * 按去重键校验并归一「打开集合的完整排列」（拖拽排序提交用）。
 *
 * `next` 必须是 `current` 的一组目录的完整排列：长度一致、不含未知目录、无重复。
 * 校验通过返回按 `next` 顺序排列的**规范化路径**（取 `current` 中的表示）；
 * 不满足时返回 `null`，调用方应整次忽略提交。
 */
export function applyWorkspaceOrder(
  current: readonly string[],
  next: readonly string[],
): string[] | null {
  if (next.length !== current.length) return null;
  const byKey = new Map(current.map((p) => [workspaceKey(p), p]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of next) {
    const key = workspaceKey(p);
    const canonical = byKey.get(key);
    if (!canonical || seen.has(key)) return null;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

/** 清空去重键缓存（测试用；目录被替换 / 重建后也可调用） */
export function resetWorkspaceKeyCache(): void {
  workspaceKeyCache.clear();
}
