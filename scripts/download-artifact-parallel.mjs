#!/usr/bin/env node
/**
 * 并行分片下载 GitHub Actions artifact（自托管 runner 专用）。
 *
 * 为什么需要它：`actions/download-artifact@v4` 用**单条连接**拉 blob，而自托管
 * Ubuntu 测试机到 `*.blob.core.windows.net` 的单连接吞吐只有 ~25KB/s（实测直连
 * 25–31KB/s，banana 代理各节点 4–35KB/s 更差，加代理无效）。30MB 的 `e2e-artifacts`
 * 于是要 20 分钟，直接撞穿 e2e-ssh 的 18 分钟 job 上限——四个 job 全部红在
 * `download-artifact` 这一步，产物目录根本没落出来（`chmod` 报 No such file）。
 *
 * 瓶颈是**单连接**而不是线路：同一份 blob 用 N 条 Range 请求并发，聚合吞吐随并发
 * 线性上升（实测 1/4/8/16/32 路 = 25/102/204/181/363KB/s）。因此这里把 zip 切成
 * N 段并发拉取再拼接，落盘后用 `unzip` 解开——对调用方而言与
 * `actions/download-artifact` 的结果布局一致（zip 内的顶层目录原样展开）。
 *
 * 只在自托管车道用；GitHub 托管 runner 的下载是秒级，没必要引入这层复杂度。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import project from '../project.config.cjs';

/**
 * GitHub API 要求的 User-Agent（产品名从定义处取，不写死）。
 * `src/config/project.json` 是唯一来源（docs/hosts/product-identity.md 第 1 节）。
 */
const USER_AGENT = `${project.extensionName}-ci`;

/** 并发分片数：实测 32 路到 363KB/s，再往上收益递减且容易被 CDN 限流 */
const DEFAULT_CONCURRENCY = 32;
/** 单次 HTTP 请求的超时（毫秒）；分片小，超时短即可判定「这条连接死了」 */
const REQUEST_TIMEOUT_MS = 120_000;
/** 每条分片的失败重试次数（CDN 偶发 5xx / 连接重置） */
const RETRIES = 3;

function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

/** 取 artifact 的元数据（id / 大小） */
async function findArtifact({ repo, runId, name, token }) {
  const url = `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`列举 artifact 失败：HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const found = (body.artifacts ?? []).find((item) => item.name === name && item.expired === false);
  if (found === undefined) {
    const names = (body.artifacts ?? []).map((item) => item.name).join(', ');
    throw new Error(`run ${runId} 里没有 artifact「${name}」（有：${names || '无'}）`);
  }
  return { id: found.id, size: found.size_in_bytes };
}

/** 用一次带鉴权的请求换取 blob 的签名 URL（302 的 Location，不再需要鉴权） */
async function resolveBlobUrl({ repo, artifactId, token }) {
  const url = `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const location = res.headers.get('location');
  if (location === null) throw new Error(`换取 blob URL 失败：HTTP ${res.status}（无 Location）`);
  return location;
}

/** 拉一段 [start, end] 的字节（含两端），带重试 */
async function fetchRange({ blobUrl, start, end }) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(blobUrl, {
        headers: { Range: `bytes=${start}-${end}`, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status !== 206) {
        // 206 = Partial Content；其它状态（403 过期签名 / 5xx）重试一次大概率仍失败
        throw new Error(`HTTP ${res.status}（期望 206）`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      const expected = end - start + 1;
      if (buffer.length !== expected) {
        throw new Error(`分片长度不符：拿到 ${buffer.length}，期望 ${expected}`);
      }
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error(`分片 [${start}-${end}] 拉取失败：${lastError?.message ?? lastError}`);
}

async function main() {
  const repo = env('GITHUB_REPOSITORY');
  const runId = env('GITHUB_RUN_ID');
  const name = env('ARTIFACT_NAME', 'e2e-artifacts');
  const dest = env('ARTIFACT_DEST', '.');
  const concurrency = Number(env('ARTIFACT_CONCURRENCY', String(DEFAULT_CONCURRENCY)));
  const token = env('GITHUB_TOKEN');

  const artifact = await findArtifact({ repo, runId, name, token });
  console.log(`[download] ${name} id=${artifact.id} size=${(artifact.size / 1048576).toFixed(1)}MB 并发=${concurrency}`);

  const blobUrl = await resolveBlobUrl({ repo, artifactId: artifact.id, token });

  // 按 concurrency 等分字节区间
  const total = artifact.size;
  const chunkSize = Math.ceil(total / concurrency);
  const ranges = [];
  for (let start = 0; start < total; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize - 1, total - 1) });
  }

  const startedAt = Date.now();
  const buffers = await Promise.all(
    ranges.map(({ start, end }) => fetchRange({ blobUrl, start, end })),
  );
  const zip = Buffer.concat(buffers, total);
  const seconds = (Date.now() - startedAt) / 1000;
  console.log(
    `[download] 完成 ${(total / 1048576).toFixed(1)}MB / ${seconds.toFixed(1)}s `
    + `= ${(total / 1024 / seconds).toFixed(0)}KB/s`,
  );

  const workDir = mkdtempSync(join(tmpdir(), 'artifact-'));
  const zipPath = join(workDir, `${name}.zip`);
  writeFileSync(zipPath, zip);
  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', dest], { stdio: 'inherit' });
  if (unzip.status !== 0) throw new Error(`解压失败（unzip exit ${unzip.status}）`);
  rmSync(workDir, { recursive: true, force: true });

  // 解压结果自检：调用方依赖这几个目录，缺了要在这里就报错，而不是让用例收集期才炸
  for (const required of ['dist', 'dist-electron', 'resources/core']) {
    const probe = spawnSync('test', ['-e', join(dest, required)]);
    if (probe.status !== 0) throw new Error(`解压后缺少 ${required}/（artifact 形状变了？）`);
  }
  console.log('[download] 解压完成，dist / dist-electron / resources/core 已就位');
}

main().catch((error) => {
  console.error(`[download] 失败：${error.message}`);
  process.exit(1);
});
