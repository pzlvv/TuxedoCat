/**
 * Core 平台矩阵一致性（见 docs/standalone-core.md 第 4.1 节）。
 *
 * 矩阵里的每个组合有三处登记，任何一处漏项都会让某个平台静默不可用：
 * 1. `scripts/build-core.mjs` 的 `TARGETS`（构建目标三元组 + 产物目录）；
 * 2. `src/host/standalone/coreBinary.ts` 的 `corePlatformDir()`（运行时定位）；
 * 3. `resources/<core.resourceDir>/<dir>/`（产物落位）。
 *
 * 本文件断言三处两两一致，并把「预留平台尚未产出产物」显式化为一条**允许为空**
 * 的检查（预留平台不产出不是错误，但目录命名与三元组必须已经对得上）。
 *
 * 运行方式：npm run test:all -- core-platform-matrix
 */

import * as fs from 'fs';
import * as path from 'path';
import { CORE_FINGERPRINT_FILE_NAME, bundledRipgrepFileName, bundledRipgrepPath, coreBinaryCandidates, coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
import { CORE_BINARY_NAME, CORE_RESOURCE_DIR } from '../config/project';
import { createChecker, runTests } from './helpers/harness';

/** `build-core.mjs` 里一条目标登记 */
interface TargetEntry {
  platform: string;
  arch: string;
  triple: string;
  dir: string;
  ext: string;
}

/** 从构建脚本里解析出 TARGETS（脚本是数据驱动的，正则足够稳） */
function parseTargets(): TargetEntry[] {
  const scriptPath = path.join(repoRoot(), 'scripts', 'build-core.mjs');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const entries: TargetEntry[] = [];
  const re =
    /platform:\s*'([^']+)',\s*arch:\s*'([^']+)',\s*triple:\s*'([^']+)',\s*dir:\s*'([^']+)',\s*ext:\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    entries.push({
      platform: match[1],
      arch: match[2],
      triple: match[3],
      dir: match[4],
      ext: match[5],
    });
  }
  return entries;
}

/** 从构建脚本里解析出打包要携带的产物目录（`PACKAGE_DIRS`，与 verify-core-artifacts 同源） */
function parsePackageDirs(): string[] {
  const scriptPath = path.join(repoRoot(), 'scripts', 'build-core.mjs');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const list = /export const PACKAGE_DIRS = \[([^\]]*)\]/.exec(source);
  if (!list) return [];
  return [...list[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

/** 仓库根目录（编译产物在 out/src/test/） */
function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

/** 平台 / 架构 → 期望的目标三元组 */
const EXPECTED: ReadonlyArray<{ platform: string; arch: string; triple: string }> = [
  { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc' },
  { platform: 'win32', arch: 'arm64', triple: 'aarch64-pc-windows-msvc' },
  // Linux 一律 musl（静态，不依赖目标机器的 glibc），见 docs/standalone-core.md 第 4.3 节
  { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-musl' },
  { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-musl' },
];

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const targets = parseTargets();

  // ---------- 构建脚本：四个组合都在，三元组与目录都对 ----------
  check(`build-core.mjs 登记了 4 个目标（实际 ${targets.length}）`, targets.length === 4);
  for (const expected of EXPECTED) {
    const entry = targets.find(
      (item) => item.platform === expected.platform && item.arch === expected.arch,
    );
    const label = `${expected.platform}/${expected.arch}`;
    check(`${label} 有构建目标`, entry !== undefined);
    if (!entry) continue;
    check(`${label} 的目标三元组是 ${expected.triple}`, entry.triple === expected.triple);
    check(`${label} 的产物目录是 ${expected.arch}-${expected.platform}`, entry.dir === `${expected.arch}-${expected.platform}`);
    check(
      `${label} 的可执行名后缀正确`,
      entry.ext === (expected.platform === 'win32' ? '.exe' : ''),
    );
  }

  // ---------- 打包要携带的平台必须在矩阵内 ----------
  // 这份列表是构建与校验共用的唯一来源（verify-core-artifacts.mjs 直接 import 它），
  // 这里只断言它没写到矩阵外、且覆盖实际产出的三个平台。
  const packageDirs = parsePackageDirs();
  check(`build-core.mjs 登记了打包要携带的平台（实际 ${packageDirs.length}）`, packageDirs.length > 0);
  for (const dir of packageDirs) {
    check(`打包平台 ${dir} 在平台矩阵内`, targets.some((entry) => entry.dir === dir));
  }
  check(
    '打包平台含 Windows x64 与 Linux x64 / arm64',
    packageDirs.includes('x64-win32') &&
      packageDirs.includes('x64-linux') &&
      packageDirs.includes('arm64-linux'),
  );

  // ---------- 运行时定位：与构建脚本同一份口径 ----------
  for (const expected of EXPECTED) {
    const label = `${expected.platform}/${expected.arch}`;
    const dir = corePlatformDir(expected.platform as NodeJS.Platform, expected.arch);
    check(`${label} 运行时能解析出产物目录`, dir === `${expected.arch}-${expected.platform}`);
    const name = coreBinaryFileName(expected.platform as NodeJS.Platform);
    check(
      `${label} 的可执行文件名是 ${expected.platform === 'win32' ? CORE_BINARY_NAME + '.exe' : CORE_BINARY_NAME}`,
      name === (expected.platform === 'win32' ? `${CORE_BINARY_NAME}.exe` : CORE_BINARY_NAME),
    );
    const candidates = coreBinaryCandidates('/ext', expected.platform as NodeJS.Platform, expected.arch);
    check(`${label} 有 dist / 开发期两条候选路径`, candidates.length === 2);
    check(
      `${label} 优先 dist/resources`,
      candidates[0] ===
        path.join('/ext', 'dist', 'resources', CORE_RESOURCE_DIR, `${expected.arch}-${expected.platform}`, name),
    );
    check(
      `${label} 其次 resources`,
      candidates[1] ===
        path.join('/ext', 'resources', CORE_RESOURCE_DIR, `${expected.arch}-${expected.platform}`, name),
    );
    // Core 自带的 ripgrep 与可执行文件同级：`<产物目录>/ripgrep/<rg 名>`
    const productDir = path.join('/ext', 'resources', CORE_RESOURCE_DIR, `${expected.arch}-${expected.platform}`);
    check(
      `${label} 自带 ripgrep 落在 <产物目录>/ripgrep/ 下`,
      bundledRipgrepPath(path.join(productDir, name), expected.platform as NodeJS.Platform) ===
        path.join(productDir, 'ripgrep', bundledRipgrepFileName(expected.platform as NodeJS.Platform)),
    );
  }

  // ---------- Electron 打包：asar 内路径必须派生 app.asar.unpacked 变体并优先 ----------
  // spawn 不能从 asar 里启动可执行文件（fs 补丁不覆盖 child_process.spawn），
  // 所以打包后（extensionPath 以 app.asar 结尾）每条候选都要有解包目录副本且排在前面。
  {
    const asarRoot = path.join('/', 'programs', 'app', 'resources', 'app.asar');
    const candidates = coreBinaryCandidates(asarRoot, 'win32', 'x64');
    const coreDir = 'x64-win32';
    const exe = `${CORE_BINARY_NAME}.exe`;
    const rel = (...segments: string[]): string =>
      path.join(asarRoot, ...segments, CORE_RESOURCE_DIR, coreDir, exe);
    // 解包副本 = 同一条候选路径把 app.asar 改写为 app.asar.unpacked
    const unpacked = (candidate: string): string =>
      candidate.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked');
    check('asar 根目录下候选路径有 4 条（dist/resources 各派生解包 + 原路径）', candidates.length === 4);
    check(
      '优先 app.asar.unpacked 下的 dist/resources 产物',
      candidates[0] === unpacked(rel('dist', 'resources')),
    );
    check(
      '其次 asar 内 dist/resources（存在但 spawn 不了）',
      candidates[1] === rel('dist', 'resources'),
    );
    check(
      '再次 app.asar.unpacked 下的 resources 产物',
      candidates[2] === unpacked(rel('resources')),
    );
    check(
      '最后 asar 内 resources',
      candidates[3] === rel('resources'),
    );
  }

  // ---------- 矩阵之外的组合必须被拒绝，而不是猜一个目录 ----------
  check('darwin/x64 不在矩阵内', corePlatformDir('darwin' as NodeJS.Platform, 'x64') === null);
  check('win32/ia32 不在矩阵内', corePlatformDir('win32', 'ia32') === null);
  check(
    '矩阵外的平台没有候选路径',
    coreBinaryCandidates('/ext', 'darwin' as NodeJS.Platform, 'x64').length === 0,
  );

  // ---------- 产物落位目录 ----------
  // x64-win32 是开发机一定能构建的那个，必须在；x64-linux 与 arm64-linux 也属于打包
  // 要携带的平台（`npm run build:core` 默认会一起编，见 docs/standalone-core.md 第 4.3 节），
  // 但交叉编译需要 zig，没装时允许为空；arm64-win32 是预留。「允许为空」不等于允许
  // 半成品：目录在就必须有产物。「打包要带的产物齐不齐」由 scripts/verify-core-artifacts.mjs
  // 把关。
  const alwaysBuilt = new Set(['x64-win32']);
  for (const entry of targets) {
    const dir = path.join(repoRoot(), 'resources', CORE_RESOURCE_DIR, entry.dir);
    const binary = path.join(dir, `${CORE_BINARY_NAME}${entry.ext}`);
    // Core 自带的 ripgrep：与可执行文件同级（`tools.rs::ripgrep_path` 的定位基准）
    const ripgrep = bundledRipgrepPath(binary, entry.platform as NodeJS.Platform);
    // 构建指纹：与可执行文件同级（`build-core.mjs` 落位，docs/standalone-core.md 第 4.4 节）
    const fingerprint = path.join(dir, CORE_FINGERPRINT_FILE_NAME);
    if (alwaysBuilt.has(entry.dir)) {
      check(`${entry.dir} 已产出 ${CORE_BINARY_NAME}${entry.ext}`, fs.existsSync(binary));
      check(`${entry.dir} 已产出自带的 ripgrep`, fs.existsSync(ripgrep));
      check(`${entry.dir} 已产出构建指纹`, fs.existsSync(fingerprint));
    } else {
      // 预留平台：目录不存在是预期状态，这里只断言「没有半成品」（有目录就必须有产物）
      const hasDir = fs.existsSync(dir);
      check(
        `${entry.dir}（按需构建）没有半成品产物`,
        !hasDir || (fs.existsSync(binary) && fs.existsSync(ripgrep) && fs.existsSync(fingerprint)),
      );
    }
  }

  finish();
}

runTests('core-platform-matrix', run);
