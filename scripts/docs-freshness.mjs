#!/usr/bin/env node
/**
 * 文档新鲜度报告：对比「规格文档的最后提交」与「它行内代码引用的仓库路径的最后提交」。
 *
 * 为什么需要
 * ----------
 * 规格没有 owner 与最后核对时间时，无法判断一份规格是否还有人负责、是否已落后于代码。
 * frontmatter（owner / last_reviewed，由 docsLint 校验字段齐全）回答「谁在管、何时核过」；
 * 本脚本回答「引用的源码是否在文档最后一次提交之后又动了」——领先越多，文档过时的
 * 可能性越大。
 *
 * 口径
 * ----
 * - 覆盖范围与 docsLint 的 frontmatter 组一致：docs/ 顶层规格（README.md 地图除外），
 *   外加 DEVELOPMENT.md（架构总纲，无 frontmatter，同样参与对比）。
 * - 引用提取与 docsLint 的「行内代码里的仓库路径必须存在」同口径：只取行内反引号里
 *   的仓库前缀路径，通配 / 占位符不取；markdown 链接指向的多是其他文档，不参与。
 * - 时间一律取 git 最后提交时间（文件 mtime 在 clone / rebase 后不可信）。
 * - **只出报告**：退出码恒为 0，不进 CI 门禁（ADR-0004：先观察误报率再决定是否升格）。
 *
 * 用法：npm run docs:freshness
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DOC_RELPATHS = [
  ...fs.readdirSync(path.join(ROOT, 'docs'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => `docs/${e.name}`)
    .sort(),
  'DEVELOPMENT.md',
];

/** 与 docsLint 第 9 组同一份前缀集合；docsLint 若扩前缀，这里同步 */
const REPO_PATH_PREFIX = /^(?:src|docs|specs|core-rs|electron|tui-rs|scripts|e2e|installer-rs|assets|resources)\//;

/** path → 最后提交时间（epoch ms）；路径无提交历史（未提交 / .gitignore）返回 null */
const commitTimeCache = new Map();
function lastCommitMs(relPath) {
  const cached = commitTimeCache.get(relPath);
  if (cached !== undefined) return cached;
  let out;
  try {
    out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relPath], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
  } catch {
    commitTimeCache.set(relPath, null);
    return null;
  }
  const ms = out === '' ? null : Number(out) * 1000;
  commitTimeCache.set(relPath, ms);
  return ms;
}

function fmtDate(ms) {
  if (ms === null) return '未提交';
  return new Date(ms).toISOString().slice(0, 10);
}

const rows = [];
for (const rel of DOC_RELPATHS) {
  const full = path.join(ROOT, rel);
  const text = fs.readFileSync(full, 'utf-8');
  const reviewed = /^last_reviewed:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(text)?.[1] ?? '—';

  const refs = new Set();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1] ?? '';
    if (!token.includes('/') || !REPO_PATH_PREFIX.test(token)) continue;
    if (/[<>*[\]\s]/.test(token) || token.includes('...')) continue;
    const filePart = token.split('::')[0].split('#')[0].replace(/\/+$/, '');
    if (filePart === '' || !fs.existsSync(path.join(ROOT, filePart))) continue;
    refs.add(filePart);
  }

  const docMs = lastCommitMs(rel);
  let maxRefMs = null;
  for (const ref of refs) {
    const t = lastCommitMs(ref);
    if (t !== null && (maxRefMs === null || t > maxRefMs)) maxRefMs = t;
  }

  // 文档未提交时按「现在」计，避免把新文档判成严重过时
  const base = docMs ?? Date.now();
  const staleDays = maxRefMs === null ? null : Math.round((maxRefMs - base) / 86400000);
  rows.push({ rel, docMs, reviewed, maxRefMs, staleDays, refs: refs.size });
}

rows.sort((a, b) => (b.staleDays ?? -1) - (a.staleDays ?? -1));

console.log('文档新鲜度报告（只出报告，不进门禁）：「引用源码最新提交」晚于「文档最后提交」的天数为正即可能过时\n');
console.log('| 文档 | 文档最后提交 | last_reviewed | 引用源码最新提交 | 领先天数 | 引用数 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const stale = r.staleDays === null ? '—' : String(r.staleDays);
  console.log(`| ${r.rel} | ${fmtDate(r.docMs)} | ${r.reviewed} | ${fmtDate(r.maxRefMs)} | ${stale} | ${r.refs} |`);
}
const stale = rows.filter((r) => (r.staleDays ?? 0) > 0);
console.log(`\n可能过时（领先 > 0 天）：${stale.length} / ${rows.length} 篇。以各篇 last_reviewed 与人工核对为准，本报告不作为门禁。`);
