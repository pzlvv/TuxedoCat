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
import { coreBinaryCandidates, coreBinaryFileName, corePlatformDir } from '../host/standalone/coreBinary';
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

/** 仓库根目录（编译产物在 out/src/test/） */
function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

/** 平台 / 架构 → 期望的目标三元组 */
const EXPECTED: ReadonlyArray<{ platform: string; arch: string; triple: string }> = [
  { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc' },
  { platform: 'win32', arch: 'arm64', triple: 'aarch64-pc-windows-msvc' },
  { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu' },
  { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu' },
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
  }

  // ---------- 矩阵之外的组合必须被拒绝，而不是猜一个目录 ----------
  check('darwin/x64 不在矩阵内', corePlatformDir('darwin' as NodeJS.Platform, 'x64') === null);
  check('win32/ia32 不在矩阵内', corePlatformDir('win32', 'ia32') === null);
  check(
    '矩阵外的平台没有候选路径',
    coreBinaryCandidates('/ext', 'darwin' as NodeJS.Platform, 'x64').length === 0,
  );

  // ---------- 产物落位目录：已产出的必须在，预留的允许为空 ----------
  const produced = new Set(['x64-win32']);
  for (const entry of targets) {
    const dir = path.join(repoRoot(), 'resources', CORE_RESOURCE_DIR, entry.dir);
    const binary = path.join(dir, `${CORE_BINARY_NAME}${entry.ext}`);
    if (produced.has(entry.dir)) {
      check(`${entry.dir} 已产出 ${CORE_BINARY_NAME}${entry.ext}`, fs.existsSync(binary));
    } else {
      // 预留平台：目录不存在是预期状态，这里只断言「没有半成品」（有目录就必须有产物）
      const hasDir = fs.existsSync(dir);
      check(
        `${entry.dir}（预留）没有半成品产物`,
        !hasDir || fs.existsSync(binary),
      );
    }
  }

  finish();
}

runTests('core-platform-matrix', run);
