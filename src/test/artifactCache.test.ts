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
 * 测法：真跑脚本，网络入口按场景分两种——
 * - 命中 / 不命中类用例不下载，只拷三个目录（给个明显错误的凭据，一旦真去下载就红）；
 * - 下载类用例用 `--import` 预载 `fixtures/artifactDownloadCrossDevice.mjs`，它把
 *   `fetch` 换成假响应（含 Range 分片语义），并按真实 CI 拓扑复现「解压目录与缓存目录
 *   不在同一文件系统」——run `45292363880` 的四个 ssh job 就是撞在这里：
 *   `EXDEV: cross-device link not permitted, rename '/tmp/artifact-*' -> '<workspace>/.e2e-artifacts-cache/*'`。
 *
 * 运行方式：`npm run test:unit -- artifactCache`
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChecker, runTests } from './helpers/harness';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'download-artifact-parallel.mjs');
/**
 * 假产物 + 跨文件系统拓扑的预载模块（下载类用例专用）。
 *
 * `--import` 只认 URL：Windows 上直接给 `C:\...` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 */
const CROSS_DEVICE_FIXTURE = pathToFileURL(
  path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'artifactDownloadCrossDevice.mjs'),
).href;
/** 假产物里三个标识文件的统一内容；与预载模块里的 MARKER 一致 */
const FIXTURE_MARKER = 'cross-device-fixture-build';

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

  // RT-4：缓存目录与解压临时目录不在同一文件系统时，产物仍要落到位。
  //
  // 这是 run 45292363880 的现场：脚本把产物解压到 `/tmp`，再 `rename` 到 runner 工作区
  // 下的 `.e2e-artifacts-cache`，两者不同挂载点 → `EXDEV: cross-device link not permitted`，
  // 四个 ssh job 一条用例都没跑就全红。预载模块按这个拓扑把「跨进另一块盘」的 rename
  // 一律拒掉，因此只要脚本仍从 `os.tmpdir()` 搬运就必红。
  const cacheDevice = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-xdev-'));
  const xdevCache = path.join(cacheDevice, 'cache');
  const xdevRunId = '990003';
  const runOnOtherDevice = (destDir: string) => spawnSync(process.execPath, [
    '--import',
    CROSS_DEVICE_FIXTURE,
    SCRIPT,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'fixture-token',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: xdevRunId,
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: destDir,
      ARTIFACT_CACHE_DIR: xdevCache,
      // 缓存目录所在的「另一块盘」：从它外面搬进它里面的 rename 会抛 EXDEV
      EXDEV_TEST_OTHER_DEVICE_ROOT: cacheDevice,
      https_proxy: '',
      http_proxy: '',
    },
  });

  const xdevDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const xdev = runOnOtherDevice(xdevDest);
  check('缓存目录与临时目录不同文件系统时脚本仍成功退出', xdev.status === 0);
  if (xdev.status !== 0) {
    console.error(`     stderr: ${xdev.stderr.trim().split('\n').slice(-6).join('\n     ')}`);
  }
  const xdevMarkers = fs.existsSync(path.join(xdevDest, 'dist', 'webview', 'index.html'))
    ? readMarkers(xdevDest)
    : [];
  check(
    '跨文件系统时三个必备目录都落到 ARTIFACT_DEST（内容是本次下载的产物）',
    xdevMarkers.length === 3 && xdevMarkers.every((marker) => marker === FIXTURE_MARKER),
  );

  // RT-5：这次写入的槽位必须能被后续 job 复用——修复不能靠「干脆不落缓存」，
  // 那会把三份重复下载的墙钟重新加回关键路径（见本文件开头的浪费数据）。
  const xdevReuseDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const xdevReuse = runOnOtherDevice(xdevReuseDest);
  check('跨文件系统写入的槽位可被后续 job 复用（不重复下载）', xdevReuse.status === 0);
  check('复用时日志点名复用本地缓存', /复用本地缓存/.test(xdevReuse.stdout));
  const reuseMarkers = fs.existsSync(path.join(xdevReuseDest, 'dist', 'webview', 'index.html'))
    ? readMarkers(xdevReuseDest)
    : [];
  check(
    '复用时三个必备目录都搬到 ARTIFACT_DEST',
    reuseMarkers.length === 3 && reuseMarkers.every((marker) => marker === FIXTURE_MARKER),
  );

  // RT-6：暂存目录不许残留在缓存目录里。
  //
  // 修复把解压临时目录从 `os.tmpdir()` 挪进了缓存目录（同盘 rename 才成立），
  // 而缓存目录在自托管机器上是**持久**路径——清理漏一条路径就会每红一次多留一份
  // 半解压的产物，最终把 runner 的盘吃满。成功与失败两条路径都核对：
  const stagingDir = path.join(xdevCache, '.staging');
  const stagingEntries = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
  check('下载成功后暂存目录不留残渣', stagingEntries.length === 0);

  const shapeFailDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const brokenRun = spawnSync(process.execPath, ['--import', CROSS_DEVICE_FIXTURE, SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'fixture-token',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: '990004',
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: shapeFailDest,
      ARTIFACT_CACHE_DIR: xdevCache,
      EXDEV_TEST_OTHER_DEVICE_ROOT: cacheDevice,
      // 产物缺 resources/core → 自检失败
      EXDEV_TEST_BROKEN_ARTIFACT: '1',
      https_proxy: '',
      http_proxy: '',
    },
  });
  check(
    '产物自检失败时以非零退出并指名缺哪个目录',
    brokenRun.status !== 0
      && /解压后缺少 dist \/ dist-electron \/ resources\/core/.test(brokenRun.stderr),
  );
  const stagingAfterFail = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
  check('自检失败后暂存目录同样不留残渣', stagingAfterFail.length === 0);

  // RT-7：被强杀的 job 留下的暂存目录要能被清掉，正在用的那份不能被误删。
  //
  // 暂存目录从 `os.tmpdir()` 挪进了缓存目录（同盘 rename 才成立），而缓存目录是 runner
  // 上的**持久**路径——job 被 `timeout-minutes` 强杀时 `finally` 跑不到，残骸会一直躺着。
  // 清理按 mtime 判过期（一小时）：这里造一份 mtime 在两天前的残骸、一份刚建的目录，
  // 跑一次脚本后前者应消失、后者应完好——只判「目录存在就删」的实现会把正在用的那份删掉。
  const staleDir = path.join(stagingDir, 'job-stale');
  fs.mkdirSync(path.join(staleDir, 'unpacked'), { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);
  const freshDir = path.join(stagingDir, 'job-fresh');
  fs.mkdirSync(path.join(freshDir, 'unpacked'), { recursive: true });

  const pruneDest = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-dest-'));
  const pruneRun = spawnSync(process.execPath, ['--import', CROSS_DEVICE_FIXTURE, SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      GITHUB_TOKEN: 'fixture-token',
      GITHUB_REPOSITORY: 'invalid/invalid',
      GITHUB_RUN_ID: '990006',
      GITHUB_RUN_ATTEMPT: attempt,
      ARTIFACT_DEST: pruneDest,
      ARTIFACT_CACHE_DIR: xdevCache,
      EXDEV_TEST_OTHER_DEVICE_ROOT: cacheDevice,
      https_proxy: '',
      http_proxy: '',
    },
  });
  check('有过期暂存目录时脚本仍成功', pruneRun.status === 0);
  check('过期暂存目录被清掉', !fs.existsSync(staleDir));
  check('正在区间内的暂存目录不被误删', fs.existsSync(freshDir));

  for (const dir of [
    cacheRoot,
    dest,
    otherDest,
    brokenRoot,
    brokenDest,
    cacheDevice,
    xdevDest,
    xdevReuseDest,
    shapeFailDest,
    pruneDest,
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  finish();
});
