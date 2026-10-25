/**
 * 文档视图的数据逻辑（specs/030 FR-003 / FR-004）。
 *
 * 解析与组装是纯函数；git 命令执行器抽成接口（本地实现 `localGitRunner` 在此，
 * 远程实现由 `electron/main.ts` 用 SSH exec 组装），可在单测里直接驱动
 * （`src/test/sidebarDocView.test.ts` 假 runner + `sidebarDocViewGit.test.ts` 真实
 * 临时 git 仓）。排序复用 `sidebarFiles.ts` 的唯一一份比较器。
 */

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { sortSidebarEntries } from './sidebarFiles.js';

/** 文档视图条目：path 是工作区根相对路径（'/' 分隔）；行数仅 git 口径有值（记录口径 null） */
export interface DocEntry {
  path: string;
  plus: number | null;
  minus: number | null;
}

export type DocListResult =
  | { ok: true; mode: 'git' | 'record'; entries: DocEntry[] }
  | { ok: false; error: string };

/** git 子命令执行器（args 不含 `git` 与 `-C root`，由实现补齐）。spawn 失败 / 超时抛错 */
export interface GitCommandRunner {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** 读工作区内相对路径的文本内容（未跟踪文件计行用）；读不到返回 null */
  readFile(rel: string): Promise<string | null>;
  /** 存在性检查（已删除文件剔除用） */
  exists(rel: string): Promise<boolean>;
}

/** 本地工作区的 git 执行器：spawn `git -C <root>`，不经 shell（args 数组直传，无注入面） */
export function localGitRunner(root: string): GitCommandRunner {
  const run = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', root, ...args],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
        (err, stdout, stderr) => {
          const exitCode = (err as null | { code?: number })?.code;
          if (err && typeof exitCode !== 'number') {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve({ code: exitCode ?? 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  return {
    run,
    readFile: async (rel) => {
      try {
        return await fsp.readFile(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    exists: async (rel) => {
      try {
        await fsp.stat(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** git 探测：`yes`（在仓内）/ `no`（不在仓内，分流到记录口径）/ 失败（显式错误） */
export type GitProbe = 'yes' | 'no' | { error: string };

export async function probeGitWorkspace(runner: GitCommandRunner): Promise<GitProbe> {
  let out: { code: number; stdout: string; stderr: string };
  try {
    out = await runner.run(['rev-parse', '--is-inside-work-tree']);
  } catch (err) {
    return { error: `git 执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (out.code === 0 && out.stdout.trim() === 'true') return 'yes';
  if (out.code !== 0 && /not a git repository/i.test(out.stderr)) return 'no';
  return { error: `git 探测失败（code ${out.code}）: ${out.stderr.trim()}` };
}

/** 重命名路径形态归一到新名：`old => new` 取 new；目录重命名 `a/{o => n}b` 取 `a/nb` */
export function normalizeRenamedPath(raw: string): string | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    cleaned = cleaned.slice(1, -1);
  }
  const brace = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(cleaned);
  if (brace) cleaned = `${brace[1]}${brace[3]}${brace[4]}`;
  const whole = /^(.*) => (.*)$/.exec(cleaned);
  if (whole) cleaned = whole[2];
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 解析 `git diff --numstat -M` 输出（制表符分隔 `add<TAB>del<TAB>path`）。
 * 跳过二进制行（`-` 计数）与 `0/0` 行——`-M` 下纯重命名 / 仅位置变更呈现为 `0 0`，
 * 正好由这条规则剔除；带修改的重命名行归一到新路径。
 */
export function parseNumstat(text: string): DocEntry[] {
  const entries: DocEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addText, delText, ...restPath] = parts;
    const rawPath = restPath.join('\t');
    if (addText === '-' || delText === '-') continue; // 二进制
    const plus = Number(addText);
    const minus = Number(delText);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    if (plus === 0 && minus === 0) continue; // 纯重命名 / 仅位置变更
    const normalized = normalizeRenamedPath(rawPath);
    if (normalized === null) continue;
    entries.push({ path: normalized, plus, minus });
  }
  return entries;
}

/** 解析 `git ls-files` 输出：每行一个路径 */
export function parseLsFiles(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 计行（git 口径）：末尾换行不另计一行；空文件 0 行 */
export function countLines(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

const GIT_COMMON_ARGS = ['-c', 'core.quotepath=false'];

/** git 口径取数：与 HEAD 比较（含已暂存与未暂存）+ 未跟踪全文计行，过滤已删除文件 */
export async function collectGitEntries(runner: GitCommandRunner): Promise<DocListResult> {
  // 无 HEAD 的新仓：索引里的全部按新增计全文行数（相对空树）
  let hasHead: boolean;
  try {
    const head = await runner.run([...GIT_COMMON_ARGS, 'rev-parse', '--verify', '-q', 'HEAD']);
    hasHead = head.code === 0;
  } catch (err) {
    return { ok: false, error: `git 执行失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  const map = new Map<string, DocEntry>();
  if (hasHead) {
    const numstat = await runner.run([
      ...GIT_COMMON_ARGS, 'diff', '--numstat', '-M', 'HEAD', '--', '*.md', '*.markdown',
    ]);
    if (numstat.code !== 0) {
      return { ok: false, error: `git diff 失败: ${numstat.stderr.trim()}` };
    }
    for (const entry of parseNumstat(numstat.stdout)) map.set(entry.path, entry);
  } else {
    const staged = await runner.run([...GIT_COMMON_ARGS, 'ls-files', '--', '*.md', '*.markdown']);
    if (staged.code !== 0) {
      return { ok: false, error: `git ls-files 失败: ${staged.stderr.trim()}` };
    }
    for (const rel of parseLsFiles(staged.stdout)) {
      const content = await runner.readFile(rel);
      const lines = content === null ? 0 : countLines(content);
      map.set(rel, { path: rel, plus: lines, minus: 0 });
    }
  }

  const untracked = await runner.run([
    ...GIT_COMMON_ARGS, 'ls-files', '--others', '--exclude-standard', '--', '*.md', '*.markdown',
  ]);
  if (untracked.code !== 0) {
    return { ok: false, error: `git ls-files --others 失败: ${untracked.stderr.trim()}` };
  }
  for (const rel of parseLsFiles(untracked.stdout)) {
    if (map.has(rel)) continue;
    const content = await runner.readFile(rel);
    const lines = content === null ? 0 : countLines(content);
    map.set(rel, { path: rel, plus: lines, minus: 0 });
  }

  const entries: DocEntry[] = [];
  for (const entry of map.values()) {
    if (await runner.exists(entry.path)) entries.push(entry);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, mode: 'git', entries };
}

/** 记录口径取数：`modifiedDocs` 里的现存文件（不显示行数），已删除的过滤 */
export async function collectRecordEntries(
  paths: readonly string[],
  exists: (rel: string) => Promise<boolean>,
): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];
  for (const rel of paths) {
    if (await exists(rel)) entries.push({ path: rel, plus: null, minus: null });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** 文档视图的渲染行（主进程铺平：目录在前、层级深度已算好，渲染层直接映射） */
export interface DocRow {
  name: string;
  /** 相对路径（'/' 分隔） */
  rel: string;
  kind: 'directory' | 'file';
  depth: number;
  /** 仅文件且 git 口径有值 */
  plus: number | null;
  minus: number | null;
}

/**
 * 扁平条目 → 渲染行：只保留命中文档的路径分支，**全部层级默认展开**（行序即完整
 * 展开序）；目录在前、同类按名称排序（复用 `sortSidebarEntries` 唯一一份比较器）。
 */
export function buildDocRows(entries: readonly DocEntry[]): DocRow[] {
  const dirsByPath = new Map<string, Set<string>>();
  const filesByPath = new Map<string, Array<{ name: string; entry: DocEntry }>>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    const name = parts.pop();
    if (name === undefined || name.length === 0) continue;
    let dir = '';
    for (const part of parts) {
      const parent = dir;
      dir = dir === '' ? part : `${dir}/${part}`;
      if (!dirsByPath.has(parent)) dirsByPath.set(parent, new Set());
      dirsByPath.get(parent)!.add(part);
    }
    if (!filesByPath.has(dir)) filesByPath.set(dir, []);
    filesByPath.get(dir)!.push({ name, entry });
  }

  const rows: DocRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const childDirs = [...(dirsByPath.get(dir) ?? [])];
    const childFiles = filesByPath.get(dir) ?? [];
    const sorted = sortSidebarEntries([
      ...childDirs.map((name) => ({ name, kind: 'directory' as const, mtimeMs: null })),
      ...childFiles.map((file) => ({ name: file.name, kind: 'file' as const, mtimeMs: null })),
    ]);
    for (const item of sorted) {
      const rel = dir === '' ? item.name : `${dir}/${item.name}`;
      const file = item.kind === 'file' ? childFiles.find((f) => f.name === item.name) : undefined;
      rows.push({
        name: item.name,
        rel,
        kind: item.kind,
        depth,
        plus: file?.entry.plus ?? null,
        minus: file?.entry.minus ?? null,
      });
      if (item.kind === 'directory') walk(rel, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}
