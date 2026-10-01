#!/usr/bin/env node
/**
 * 打包前置校验：要携带的 Standalone Core 产物必须存在、且比 Rust 源码新。
 *
 * 为什么需要
 * ----------
 * `vscode:prepublish` 与 `package:app` 里的 `npm run build:core` 会构建打包要携带的
 * 全部平台（`PACKAGE_DIRS`：Windows x64 + Linux x64），Linux 那份在 Windows 上直接
 * 交叉编译（见 `build-core.mjs` 的 `crossToolchainEnv`）。但只要有人用 `--host` /
 * `--target` 单编过、或改了 Rust 源码没重编，`copy-assets` 就会把 `resources/` 里
 * 上一次的旧产物一起打进 vsix 与安装包：打包一路绿灯，Linux 用户却拿到一个认不出
 * 新动作 / 新协议的 core。
 *
 * 本脚本卡三件事：
 *   1. `resources/core/<平台>/` 里有可执行文件（缺失即报错，附带该平台的重建命令）；
 *   2. 它的修改时间不早于 `core-rs/src/**`、`core-rs/Cargo.toml`、`core-rs/Cargo.lock`
 *      里最新的一个（早于就是「源码改了但没重编」）；
 *   3. `dist/resources/core/` 里的副本与 `resources/` 里的**字节一致**（打包真正吃的是
 *      dist 里那份；`copy-assets` 漏跑过，或跑在重建之前就会不一致）。
 *
 * `resources/core/` 在 .gitignore 里：产物不入库，所以修改时间可以放心当判据。
 *
 * `TUXEDO_CAT_CORE=embedded` 变体不需要 Rust Core，直接跳过。
 *
 * 用法：node scripts/verify-core-artifacts.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PACKAGE_DIRS, TARGETS } from './build-core.mjs';

const require = createRequire(import.meta.url);
const project = require('../project.config.cjs');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Rust 侧源码根；只看 src 与两个清单，不碰 `target/`（构建产物永远更新） */
const RUST_SOURCES = ['core-rs/src', 'core-rs/Cargo.toml', 'core-rs/Cargo.lock'];

/**
 * 打包必须携带的 Core 产物（`resources/<core.resourceDir>/` 下的目录名）。
 *
 * 平台列表直接取构建脚本的 `PACKAGE_DIRS`（唯一一份），可执行名后缀取目标登记，
 * 这里不另写一份，免得「构建的」与「校验的」漂移。
 */
const REQUIRED_CORES = PACKAGE_DIRS.map((dir) => {
  const target = TARGETS.find((entry) => entry.dir === dir);
  if (!target) {
    throw new Error(`PACKAGE_DIRS 里的 ${dir} 不在 build-core.mjs 的平台矩阵内。`);
  }
  return {
    dir,
    file: `${project.core.binaryName}${target.ext}`,
    rebuild: 'npm run build:core',
  };
});

/** 目录（或文件）树里最新的修改时间；不存在的路径返回 0 */
function newestMtime(target) {
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
      } else {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  }
  return newest;
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
  if (project.coreKind === 'embedded') {
    console.log('[verify-core] TUXEDO_CAT_CORE=embedded：不需要 Rust Core，跳过。');
    return;
  }

  const sourceMtime = Math.max(...RUST_SOURCES.map((entry) => newestMtime(join(repoRoot, entry))));
  const problems = [];
  const checked = [];

  for (const core of REQUIRED_CORES) {
    const built = join(repoRoot, 'resources', project.core.resourceDir, core.dir, core.file);
    const shipped = join(repoRoot, 'dist', 'resources', project.core.resourceDir, core.dir, core.file);

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
    checked.push(core.dir);
  }

  if (problems.length > 0) {
    console.error('[verify-core] 打包要携带的 Core 产物不合格：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`[verify-core] 产物齐全且比 Rust 源码新：${checked.join(' / ')}`);
}

main();
