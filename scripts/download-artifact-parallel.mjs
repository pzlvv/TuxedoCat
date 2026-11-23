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
 *
 * ## 跨 job 复用已下载的产物（`ARTIFACT_CACHE_DIR`）
 *
 * 自托管标签下只有一台 runner，四个 spec job **串行排队**在同一台机器上；每个 job 都
 * 重下一份一模一样的 28.8MB 产物，就是每轮 4 × 79–150s 的纯浪费（run `45177031308`：
 * 77.1s / 149.5s / 22.7s / 66.0s）。设置 `ARTIFACT_CACHE_DIR` 后，产物按
 * `run-<runId>-<attempt>` 落一份在该目录下，后续 job 直接复用；换 run（或同 run 重跑）
 * 时目录名不同，不会拿到旧产物。
 *
 * 复用的判据是**解压后的自检通过**，不是「目录存在」：上一次 job 被打断时可能只解压了
 * 一半，那时目录在、文件不全——直接复用会让用例收在「缺产物」上，看起来像构建漏了。
 * 因此先在临时目录解压 + 自检，通过后再整体 rename 到位（`rename` 在同一文件系统内是
 * 原子的，另一个 job 读到的要么不存在、要么完整）。
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** 产物解压后的必备目录（调用方依赖它们，缺一个就报错） */
const REQUIRED_DIRS = ['dist', 'dist-electron', 'resources/core'];

/** 目录里是否三个必备路径都在 */
function hasAllRequired(dest) {
  return REQUIRED_DIRS.every((required) => spawnSync('test', ['-e', join(dest, required)]).status === 0);
}

/**
 * 把已有产物目录搬进 `dest`（跨 job 复用）。
 *
 * `dest` 是仓库根的 `.`，不能整体替换——只搬三个必备目录，且先删再拷：
 * 上一轮 job 里 `dist/` 可能还留着 `test-results` 之外的东西，混进旧文件会让
 * 「本轮产物对不对」无从判断。
 */
function promote(fromDir, dest) {
  for (const required of REQUIRED_DIRS) {
    rmSync(join(dest, required), { recursive: true, force: true });
    cpSync(join(fromDir, required), join(dest, required), { recursive: true });
  }
}

async function main() {
  const repo = env('GITHUB_REPOSITORY');
  const runId = env('GITHUB_RUN_ID');
  const attempt = env('GITHUB_RUN_ATTEMPT', '1');
  const name = env('ARTIFACT_NAME', 'e2e-artifacts');
  const dest = env('ARTIFACT_DEST', '.');
  const concurrency = Number(env('ARTIFACT_CONCURRENCY', String(DEFAULT_CONCURRENCY)));
  const token = env('GITHUB_TOKEN');
  // 缓存目录是自托管机器上的本地路径（不是 actions/cache）：同 run 的四个 job 串行
  // 排队在同一台机器上，第一个 job 落盘、后三个直接复用。
  const cacheRoot = process.env.ARTIFACT_CACHE_DIR;

  if (cacheRoot !== undefined && cacheRoot !== '') {
    const slot = join(cacheRoot, `run-${runId}-${attempt}-${name}`);
    if (hasAllRequired(slot)) {
      const startedAt = Date.now();
      promote(slot, dest);
      console.log(`[download] 复用本地缓存 ${slot}（${Date.now() - startedAt}ms）`);
      return;
    }
    console.log(`[download] 本地缓存 ${slot} 不可用，改为下载`);
  }

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

  // 解压到临时目录而不是直接解到 dest：要落缓存时得先确认「这份产物是完整的」，
  // 否则被打断的那一轮会把半个目录留在缓存里给后面三个 job 用。
  const workDir = mkdtempSync(join(tmpdir(), 'artifact-'));
  const zipPath = join(workDir, `${name}.zip`);
  writeFileSync(zipPath, zip);
  const unpacked = cacheRoot !== undefined && cacheRoot !== ''
    ? join(workDir, `run-${runId}-${attempt}-${name}`)
    : dest;
  mkdirSync(unpacked, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', unpacked], { stdio: 'inherit' });
  if (unzip.status !== 0) throw new Error(`解压失败（unzip exit ${unzip.status}）`);

  if (!hasAllRequired(unpacked)) {
    throw new Error(`解压后缺少 ${REQUIRED_DIRS.join(' / ')}（artifact 形状变了？）`);
  }

  if (unpacked !== dest) {
    // `rename` 在同一文件系统内原子：另一个 job 读到的要么不存在、要么完整
    const slot = join(cacheRoot, `run-${runId}-${attempt}-${name}`);
    mkdirSync(cacheRoot, { recursive: true });
    rmSync(slot, { recursive: true, force: true });
    renameSync(unpacked, slot);
    promote(slot, dest);
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log('[download] 解压完成，dist / dist-electron / resources/core 已就位');
}

main().catch((error) => {
  console.error(`[download] 失败：${error.message}`);
  process.exit(1);
});
