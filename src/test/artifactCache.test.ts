/**
 * 并行分片下载脚本的**跨 job 复用**逻辑（`scripts/download-artifact-parallel.mjs` 的
 * `ARTIFACT_CACHE_DIR`）。
 *
 * 为什么要单独测这一段：自托管标签下只有一台机器，ssh 车道的四个矩阵 job 串行排队在
 * 同一台机器上。每个 job 都重下一份 28.8MB 产物是每轮 4 × 79–150s 的浪费（run
 * `45177031308` 实测 77.1s / 149.5s / 22.7s / 66.0s），而复用的正确性靠两件事：
 *
 * 1. **键含 run id + attempt**：换 run 或同 run 重跑不能拿到上一轮的产物——拿错了会
 *    让用例跑在旧构建上，结论与本次提交无关；
 * 2. **复用判据是三个必备目录齐全**：上一次 job 被打断时可能只解压了一半，目录在而
 *    文件不全；直接复用会让用例报「缺产物」，与「构建漏了产物」混在一起。
 *
 * 测法：真跑脚本，但把网络入口换成起在本地的一次性 HTTP 服务（`GITHUB_API_URL`
 * 不参与——脚本里是写死的 URL，因此这里改为**用缓存命中路径**验证，不触网）：
 * 命中路径不下载、只拷三个目录，正好是复用逻辑的全部行为。
 *
 * 运行方式：`npm run test:unit -- artifactCache`
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'download-artifact-parallel.mjs');

/** 在临时目录里造一份「已解压的产物」：三个必备目录各放一个标识文件 */
function makeArtifacts(root: string, marker: string): void {
  fs.mkdirSync(path.join(root, 'dist', 'webview'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist-electron'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources', 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'webview', 'index.html'), marker);
  fs.writeFileSync(path.join(root, 'dist-electron', 'main.cjs'), marker);
  fs.writeFileSync(path.join(root, 'resources', 'core', 'marker.txt'), marker);
}

function readMarkers(dest: string): string[] {
  return [
    fs.readFileSync(path.join(dest, 'dist', 'webview', 'index.html'), 'utf8'),
    fs.readFileSync(path.join(dest, 'dist-electron', 'main.cjs'), 'utf8'),
    fs.readFileSync(path.join(dest, 'resources', 'core', 'marker.txt'), 'utf8'),
  ];
}

runTests('artifactCache', () => {
  const { check, finish } = createChecker();
  check('存在并行分片下载脚本', fs.existsSync(SCRIPT));

  const runId = '990001';
  const attempt = '1';
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cache-'));
  const slot = path.join(cacheRoot, `run-${runId}-${attempt}-e2e-artifacts`);
  makeArtifacts(slot, 'cached-build');

  // RT-1：缓存命中时不下载，直接把三个目录搬进 ARTIFACT_DEST
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const hit = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // 命中路径不触网：这些值只在下下载分支里用；给个明显错误的值，一旦真去下载就红
      GITHUB_TOKEN: 'cache-hit-should-not-download',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: dest,
      ARTIFACT_CACHE_DIR: cacheRoot,
      https_proxy: '',
      http_proxy: '',
    },
  });
  check('缓存命中时脚本成功退出（不触网下载）', hit.status === 0);
  if (hit.status !== 0) console.error(`     stderr: ${hit.stderr.trim().split('\n').slice(-6).join('\n     ')}`);
  check('缓存命中时日志点名复用', /复用本地缓存/.test(hit.stdout));
  const copied = fs.existsSync(path.join(dest, 'dist', 'webview', 'index.html'))
    ? readMarkers(dest)
    : [];
  check(
    '缓存命中时三个必备目录都搬到 ARTIFACT_DEST',
    copied.length === 3 && copied.every((marker) => marker === 'cached-build'),
  );

  // RT-2：换 run 不命中——缓存键必须含 run id，否则会跑上一轮的构建。
  //
  // 为了在「键里漏了 run id」时**也**能红，这里额外放一份按旧口径（只含产物名）命名的
  // 完整槽位：正确实现按 `run-<runId>-<attempt>` 找、找不到就走下载并因凭据无效失败；
  // 键里漏掉 run id 的实现会命中那份旧槽位、打印「复用本地缓存」并成功——两种结果
  // 在同一个断言里分得开。只放正确命名的那份时，坏实现同样会走下载并失败，测不出区别。
  makeArtifacts(path.join(cacheRoot, 'run-e2e-artifacts'), 'stale-scheme-build');
  const otherDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const miss = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'not-a-real-token',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: '990002',
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: otherDest,
      ARTIFACT_CACHE_DIR: cacheRoot,
      https_proxy: '',
      http_proxy: '',
    },
  });
  check(
    '换 run id 时不复用别的 run 的缓存（走下载分支并因凭据无效而失败）',
    miss.status !== 0 && !/复用本地缓存/.test(miss.stdout),
  );

  // RT-3：槽位目录不完整时不复用（被打断的那一轮会留下半个目录）。
  //
  // 同上：另放一份按旧口径命名的**完整**槽位，好让「只判目录存在、不判内容齐全」的
  // 实现在这里红（它会复用那份完整旧槽位并成功）。
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cache-'));
  makeArtifacts(path.join(brokenRoot, 'run-e2e-artifacts'), 'stale-scheme-build');
  const brokenSlot = path.join(brokenRoot, `run-${runId}-${attempt}-e2e-artifacts`);
  fs.mkdirSync(path.join(brokenSlot, 'dist'), { recursive: true });
  const brokenDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const broken = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'not-a-real-token',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: brokenDest,
      ARTIFACT_CACHE_DIR: brokenRoot,
      https_proxy: '',
      http_proxy: '',
    },
  });
  check(
    '槽位缺必备目录时不复用（走下载分支而不是把半个目录当成产物）',
    broken.status !== 0 && !/复用本地缓存/.test(broken.stdout),
  );

  for (const dir of [cacheRoot, dest, otherDest, brokenRoot, brokenDest]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  finish();
});
