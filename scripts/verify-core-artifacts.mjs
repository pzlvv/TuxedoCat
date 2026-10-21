#!/usr/bin/env node
/**
 * 打包前置校验：要携带的 Standalone Core 产物必须存在、且比 Rust 源码新。
 *
 * 为什么需要
 * ----------
 * `vscode:prepublish` 与 `package:app` 里的 `npm run build:core` 会构建打包要携带的
 * 全部平台（`PACKAGE_DIRS`：Windows x64 / arm64 + Linux x64 / arm64），Linux 那份在
 * Windows 上直接交叉编译（见 `build-core.mjs` 的 `crossToolchainEnv`）。但只要有人用
 * `--host` / `--target` 单编过、或改了 Rust 源码没重编，`copy-assets` 就会把 `resources/`
 * 里上一次的旧产物一起打进 vsix 与安装包：打包一路绿灯，用户却拿到一个认不出新动作 /
 * 新协议的 core。
 *
 * 本脚本卡四件事：
 *   1. `resources/core/<平台>/` 里有可执行文件与自带的 `ripgrep/`（缺失即报错，附带该
 *      平台的重建命令）；
 *   2. 它的修改时间不早于 `core-rs/src/**`、`core-rs/Cargo.toml`、`core-rs/Cargo.lock`
 *      里最新的一个（早于就是「源码改了但没重编」）；`#[cfg(test)]` 专属文件不算
 *      （cargo 不会为它们重链产物）；
 *   3. 构建指纹文件存在、且与按当前源码重算的指纹一致（`build-core.mjs` 的
 *      `computeFingerprint`，见 docs/core/standalone-core.md 第 3.4 节）：指纹缺失或对不上
 *      意味着产物是旧构建或老版本脚本产的，SSH 部署会按错误的槽位落位；
 *   4. `dist/resources/core/` 里的副本与 `resources/` 里的**字节一致**（打包真正吃的是
 *      dist 里那份；`copy-assets` 漏跑过，或跑在重建之前就会不一致）。
 *
 * ASAN 变体（环境变量 `<envPrefix>_CORE_ASAN=1`，`npm run package:asan` 注入）校验
 * asan 默认构建集合（**本机平台 + Linux x64**，见 `build-core.mjs` 的
 * `asanDefaultTargets`），指纹按 asan profile 与 asan 三元组重算，且 Windows 产物要求
 * exe 同级带动态 ASAN 运行库（`clang_rt.asan_dynamic-<arch>.dll`，`build-core.mjs` 的
 * `copyAsanRuntime` 落位）。其余平台目录不进 asan 包的校验范围（asan 包是诊断用，
 * 不用于分发；其余目录要么缺失、要么是上次 release 构建的产物，随包携带但不作保证）。
 *
 * `resources/core/` 在 .gitignore 里：产物不入库，所以修改时间可以放心当判据。
 *
 *
 * 用法：node scripts/verify-core-artifacts.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  ASAN_PROFILE,
  PACKAGE_DIRS,
  TARGETS,
  asanDefaultTargets,
  asanEnabled,
  asanRuntimeFileName,
  asanTripleFor,
  computeFingerprint,
  FINGERPRINT_FILE_NAME,
} from './build-core.mjs';

const require = createRequire(import.meta.url);
const project = require('../project.config.cjs');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Rust 侧源码根；只看 src 与两个清单，不碰 `target/`（构建产物永远更新） */
const RUST_SOURCES = ['core-rs/src', 'core-rs/Cargo.toml', 'core-rs/Cargo.lock'];

/** asan 变体：只校验 asan 默认构建集合（本机平台 + Linux x64，见 build-core.mjs） */
const ASAN = asanEnabled();

/** 指纹重算用的 profile：普通打包链只吃 release 构建，asan 变体吃 asan 构建 */
const VERIFY_PROFILE = ASAN ? ASAN_PROFILE : 'release';

/**
 * 打包必须携带的 Core 产物（`resources/<core.resourceDir>/` 下的目录名）。
 *
 * 平台列表直接取构建脚本的 `PACKAGE_DIRS` / `asanDefaultTargets`（唯一一份），可执行名
 * 后缀与 asan 三元组取目标登记，这里不另写一份，免得「构建的」与「校验的」漂移。
 */
const REQUIRED_CORES = (ASAN ? asanDefaultTargets().map((target) => target.dir) : PACKAGE_DIRS).map(
  (dir) => {
    const target = TARGETS.find((entry) => entry.dir === dir);
    if (!target) {
      throw new Error(`PACKAGE_DIRS 里的 ${dir} 不在 build-core.mjs 的平台矩阵内。`);
    }
    // asan 变体的实际三元组可能与发布产物不同（Linux x64 是 gnu），指纹按它重算
    const triple = ASAN ? asanTripleFor(target) : target.triple;
    return {
      dir,
      triple,
      file: `${project.core.binaryName}${target.ext}`,
      // 自带 ripgrep：与可执行文件同级（`tools.rs::ripgrep_path` 的定位基准）
      ripgrep: `ripgrep/${target.platform === 'win32' ? 'rg.exe' : 'rg'}`,
      // asan 变体的 win32 产物：exe 同级必须带动态 ASAN 运行库（copyAsanRuntime 落位），
      // 少了它打包出去的 asan Core 一启动就报缺 DLL；release 变体没有这份文件
      asanRuntime: ASAN ? asanRuntimeFileName(triple) : null,
      rebuild: ASAN ? 'npm run build:core:asan' : 'npm run build:core',
    };
  },
);

/** 目录（或文件）树里最新的修改时间；不存在的路径返回 0。`include` 过滤文件名 */
function newestMtime(target, include = () => true) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (include(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  }
  return newest;
}

/**
 * 参与「产物是否比源码新」判定的 Rust 源。
 *
 * `#[cfg(test)]` 专属文件（`*_tests.rs`、`test_support.rs`）不算：它们不进产物，
 * cargo 不会为它们的改动重链可执行文件，算进来会让校验永远失败。
 */
function isProductSource(fileName) {
  return !fileName.endsWith('_tests.rs') && fileName !== 'test_support.rs';
}

/** 展示用相对路径 */
function show(target) {
  return relative(repoRoot, target).split('\\').join('/');
}

/** 文件内容摘要；用于判断 dist 里的副本是不是当前那份产物 */
function fileDigest(target) {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

function main() {
  const sourceMtime = Math.max(
    ...RUST_SOURCES.map((entry) => newestMtime(join(repoRoot, entry), isProductSource)),
  );
  const problems = [];
  const checked = [];

  for (const core of REQUIRED_CORES) {
    const builtDir = join(repoRoot, 'resources', project.core.resourceDir, core.dir);
    const shippedDir = join(repoRoot, 'dist', 'resources', project.core.resourceDir, core.dir);
    const built = join(builtDir, core.file);
    const shipped = join(shippedDir, core.file);

    if (!existsSync(built)) {
      problems.push(`${show(built)} 不存在；先构建：${core.rebuild}`);
      continue;
    }
    const builtMtime = statSync(built).mtimeMs;
    if (builtMtime < sourceMtime) {
      problems.push(
        `${show(built)} 比 Rust 源码旧（源码 ${new Date(sourceMtime).toISOString()}，` +
          `产物 ${new Date(builtMtime).toISOString()}）；重新构建：${core.rebuild}`,
      );
      continue;
    }
    // Core 自带的 ripgrep：与可执行文件同级（Grep / Glob 在本地与远端都靠它）
    const builtRipgrep = join(builtDir, core.ripgrep);
    if (!existsSync(builtRipgrep)) {
      problems.push(`${show(builtRipgrep)} 不存在（Core 自带 ripgrep）；重新构建：${core.rebuild}`);
      continue;
    }
    // 构建指纹：缺失说明是老脚本产的产物；与重算值不一致说明产物之后源码又改了。
    // 重算 profile 见 VERIFY_PROFILE：普通打包链只吃 release 构建，asan 变体吃 asan 构建。
    const builtFingerprintPath = join(builtDir, FINGERPRINT_FILE_NAME);
    if (!existsSync(builtFingerprintPath)) {
      problems.push(`${show(builtFingerprintPath)} 不存在（构建指纹）；重新构建：${core.rebuild}`);
      continue;
    }
    const builtFingerprint = readFileSync(builtFingerprintPath, 'utf8').trim();
    if (builtFingerprint !== computeFingerprint(core.triple, VERIFY_PROFILE)) {
      problems.push(
        `${show(builtFingerprintPath)} 与当前 Rust 源码不一致（旧构建或源码已改）；` +
          `重新构建：${core.rebuild}`,
      );
      continue;
    }
    if (!existsSync(shipped)) {
      problems.push(`${show(shipped)} 不存在；先跑：npm run copy-assets`);
      continue;
    }
    if (fileDigest(shipped) !== fileDigest(built)) {
      problems.push(
        `${show(shipped)} 与 ${show(built)} 内容不一致（copy-assets 没跑，或跑在重建之前）；` +
          '先跑：npm run copy-assets',
      );
      continue;
    }
    const shippedRipgrep = join(shippedDir, core.ripgrep);
    if (!existsSync(shippedRipgrep)) {
      problems.push(`${show(shippedRipgrep)} 不存在；先跑：npm run copy-assets`);
      continue;
    }
    if (fileDigest(shippedRipgrep) !== fileDigest(builtRipgrep)) {
      problems.push(
        `${show(shippedRipgrep)} 与 ${show(builtRipgrep)} 内容不一致；先跑：npm run copy-assets`,
      );
      continue;
    }
    const shippedFingerprint = join(shippedDir, FINGERPRINT_FILE_NAME);
    if (!existsSync(shippedFingerprint)) {
      problems.push(`${show(shippedFingerprint)} 不存在；先跑：npm run copy-assets`);
      continue;
    }
    if (fileDigest(shippedFingerprint) !== fileDigest(builtFingerprintPath)) {
      problems.push(
        `${show(shippedFingerprint)} 与 ${show(builtFingerprintPath)} 内容不一致；` +
          '先跑：npm run copy-assets',
      );
      continue;
    }
    // asan 变体的 win32 产物：运行库两处都要在且一致（打包吃 dist 里那份）
    if (core.asanRuntime) {
      const builtRuntime = join(builtDir, core.asanRuntime);
      const shippedRuntime = join(shippedDir, core.asanRuntime);
      if (!existsSync(builtRuntime)) {
        problems.push(`${show(builtRuntime)} 不存在（asan 运行库）；重新构建：${core.rebuild}`);
        continue;
      }
      if (!existsSync(shippedRuntime)) {
        problems.push(`${show(shippedRuntime)} 不存在；先跑：npm run copy-assets`);
        continue;
      }
      if (fileDigest(shippedRuntime) !== fileDigest(builtRuntime)) {
        problems.push(
          `${show(shippedRuntime)} 与 ${show(builtRuntime)} 内容不一致；先跑：npm run copy-assets`,
        );
        continue;
      }
    }
    checked.push(core.dir);
  }

  if (problems.length > 0) {
    console.error('[verify-core] 打包要携带的 Core 产物不合格：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    `[verify-core] 产物齐全且比 Rust 源码新（profile ${VERIFY_PROFILE}）：${checked.join(' / ')}` +
      (ASAN ? '；asan 变体校验本机平台 + Linux x64' : ''),
  );
}

main();
