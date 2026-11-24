/**
 * 一次性预载（`node --import`）：把 `scripts/download-artifact-parallel.mjs` 的外部依赖
 * 换成进程内的假响应，并模拟 CI 上的**跨文件系统**拓扑。
 *
 * 为什么需要这一层：
 * 1. 脚本的两个网络入口（列 artifact、换取 blob 签名 URL）指向 `api.github.com`，
 *    单测不能触网，也不能依赖真实凭据；
 * 2. 缺陷只在「临时解压目录与缓存目录不在同一个挂载点」时暴露
 *    （run `45292363880`：`EXDEV: cross-device link not permitted, rename
 *    '/tmp/artifact-44j1xO/...' -> '<work>/.e2e-artifacts-cache/...'`），
 *    而这种布局在开发机 / 单测机上未必存在，必须由这里**确定性地**复现。
 *
 * 拓扑口径：`EXDEV_TEST_OTHER_DEVICE_ROOT` 代表「另一块盘上的缓存目录」。凡是从该根
 * **之外**搬到该根**之内**的 `rename` 一律抛 `EXDEV`——`/tmp` 与 runner 工作区不在
 * 同一挂载点时内核就是这么拒的。
 */

import AdmZip from 'adm-zip';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative } from 'node:path';

/** 假产物里放的标识串：用例据此确认「拿到的是这次下载的内容」 */
export const MARKER = 'cross-device-fixture-build';

const ARTIFACT_NAME = process.env.ARTIFACT_NAME ?? 'e2e-artifacts';
/**
 * 造一份**形状不对**的产物（缺 `resources/core`）：用来验证失败路径也把暂存目录清掉，
 * 而不是每红一次就在缓存目录里留一份半解压的产物。
 */
const brokenShape = process.env.EXDEV_TEST_BROKEN_ARTIFACT === '1';

const zip = new AdmZip();
zip.addFile('dist/webview/index.html', Buffer.from(MARKER));
zip.addFile('dist-electron/main.cjs', Buffer.from(MARKER));
if (!brokenShape) zip.addFile('resources/core/marker.txt', Buffer.from(MARKER));
const zipBuffer = zip.toBuffer();

/** 换取签名 URL 之后真正取字节的地址（脚本只要求它能按 Range 返回 206） */
const BLOB_URL = 'https://fixture.invalid/e2e-artifacts.zip';
/** 每个分片响应的延迟（毫秒）：并行用例用它把「解压 → rename」这段窗口撑开 */
const fetchDelayMs = Number(process.env.EXDEV_TEST_FETCH_DELAY_MS ?? '0');

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input.url ?? input);
  if (url.endsWith('/artifacts')) {
    return new Response(
      JSON.stringify({
        artifacts: [
          { id: 1, name: ARTIFACT_NAME, expired: false, size_in_bytes: zipBuffer.length },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.endsWith('/zip')) {
    return new Response(null, { status: 302, headers: { location: BLOB_URL } });
  }
  if (url === BLOB_URL) {
    const headers = init.headers ?? {};
    const match = /bytes=(\d+)-(\d+)/.exec(String(headers.Range ?? headers.range ?? ''));
    // 脚本只接受 206；没有 Range 说明分片语义被改了，直接让它红
    if (match === null) return new Response('missing range', { status: 400 });
    // 故意拖慢分片响应：并行用例要在「暂存目录已建好、还没 rename 到位」这段窗口里
    // 让两个 job 真正重叠，否则几毫秒的实现在本机永远撞不上。
    if (fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
    const start = Number(match[1]);
    const end = Number(match[2]);
    return new Response(zipBuffer.subarray(start, end + 1), { status: 206 });
  }
  return new Response(`unexpected url in fixture: ${url}`, { status: 404 });
};

/** `child` 是否在 `root` 之内（`root` 自身算在内） */
function under(root, child) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const originalRename = fs.renameSync;
const otherDeviceRoot = process.env.EXDEV_TEST_OTHER_DEVICE_ROOT ?? '';

if (otherDeviceRoot !== '') {
  fs.renameSync = (src, dst) => {
    // 只有「跨进另一块盘」的搬运会被内核拒；同盘内的 rename 保持原样
    if (under(otherDeviceRoot, String(dst)) && !under(otherDeviceRoot, String(src))) {
      const error = new Error(
        `EXDEV: cross-device link not permitted, rename '${src}' -> '${dst}'`,
      );
      error.code = 'EXDEV';
      throw error;
    }
    return originalRename(src, dst);
  };
  // 脚本用的是 ESM 具名导入（`import { renameSync } from 'node:fs'`），只改 fs 对象上的
  // 属性不会影响已固定的绑定——必须让 Node 把改过的内置导出重新同步给 ESM 层。
  syncBuiltinESMExports();
}
